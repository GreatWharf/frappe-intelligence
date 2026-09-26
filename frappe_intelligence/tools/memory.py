"""Explicit approved memory disclosure and append-only scoped memory saving.

The scoped service owns access/internal-write policy. No memory content is read
while preparing an approval, and memory is never automatically injected into a
prompt. Updating/deleting existing memory stays in the user-managed UI; the
tool only creates new notes (an identical re-save refreshes the existing note
in place), avoiding unversioned overwrites. Recall ranks semantically when an
embeddings endpoint exists and by keyword otherwise.
"""

from . import ToolSpec
from .validation import object_schema, string_schema

_SCOPE = {"type": "string", "enum": ["personal", "conversation", "site"]}
_READ = object_schema(
    {
        "scope": _SCOPE,
        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        "query": string_schema(2000),
    },
    ("scope",),
)
_SAVE = object_schema({"scope": _SCOPE, "content": string_schema(5000)}, ("scope", "content"))


def _scope(context, args, write=False):
    from frappe_intelligence.access import get_conversation, require_manager

    if args["scope"] == "conversation":
        get_conversation(context.conversation, write=write)
    if write and args["scope"] == "site":
        require_manager()
    return {
        "scope": args["scope"],
        "conversation": context.conversation if args["scope"] == "conversation" else None,
    }


def preview_recall(context, args):
    scope = _scope(context, args)
    details = {"limit": args.get("limit", 20)}
    if isinstance(args.get("query"), str) and args["query"].strip():
        details["query"] = args["query"].strip()
    return {
        "summary": f"Recall {args['scope']} memory into this conversation.",
        "operation": "recall_memory",
        "target": scope,
        "details": details,
    }


def recall_memory(context, args):
    from frappe_intelligence.memory import list_memories

    scope = _scope(context, args)
    limit = args.get("limit", 20)
    query = args.get("query")
    rows = None
    if isinstance(query, str) and query.strip():
        from frappe_intelligence.memory import search_memories

        rows = search_memories(**scope, query=query)
    if rows is None:
        rows = list_memories(**scope)
    result = []
    for row in rows[:limit]:
        item = {key: row.get(key) for key in ("name", "scope", "conversation", "content", "modified")}
        if "score" in row:
            item["score"] = row["score"]
        result.append(item)
    return {"memories": result, "truncated": len(rows) > limit, "untrusted_content": True}


def preview_save(context, args):
    scope = _scope(context, args, write=True)
    if not args["content"].strip():
        raise ValueError("Memory content must not be empty.")
    return {
        "summary": f"Save a new {args['scope']} memory note.",
        "operation": "save_memory",
        "target": scope,
        "changes": [
            {"field": "content", "label": "Content", "before": None, "after": args["content"].strip()}
        ],
    }


def save_memory(context, args):
    from frappe_intelligence.memory import save_memory as save

    preview_save(context, args)
    result = save(content=args["content"], **_scope(context, args, write=True))
    return {key: result.get(key) for key in ("name", "scope", "conversation", "modified")}


def specs(context):
    return [
        ToolSpec(
            "recall_memory",
            "Explicitly recall personal, current-conversation, or site memory. Pass a focused query describing what you are looking for to rank the most relevant memories first; ranking works semantically when an embeddings endpoint is available and by keyword matching otherwise. Omit the query to list the most recent. Never recall another user's memory.",
            _READ,
            recall_memory,
            preview_recall,
            operation="Read",
        ),
        ToolSpec(
            "save_memory",
            "Save a new memory note. Personal/current-conversation notes are owner scoped; site notes require manager authority. Saving identical content again refreshes the existing note instead of duplicating it; differing content never overwrites existing memory.",
            _SAVE,
            save_memory,
            preview_save,
            mutates=True,
            operation="Create",
        ),
    ]
