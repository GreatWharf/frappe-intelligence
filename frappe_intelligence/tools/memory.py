"""Explicit approved memory disclosure and append-only scoped memory saving.

The scoped service owns access/internal-write policy. No memory content is read
while preparing an approval, and memory is never automatically injected into a
prompt. Updating/deleting existing memory stays in the user-managed UI; the tool
only creates new notes, avoiding unversioned overwrites.
"""

from . import ToolSpec
from .validation import object_schema, string_schema

_SCOPE = {"type": "string", "enum": ["personal", "conversation", "site"]}
_READ = object_schema(
    {"scope": _SCOPE, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}, ("scope",)
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
    return {
        "summary": f"Recall {args['scope']} memory into this conversation.",
        "operation": "recall_memory",
        "target": scope,
        "details": {"limit": args.get("limit", 20)},
    }


def recall_memory(context, args):
    from frappe_intelligence.memory import list_memories

    rows = list_memories(**_scope(context, args))
    limit = args.get("limit", 20)
    result = [
        {key: row.get(key) for key in ("name", "scope", "conversation", "content", "modified")}
        for row in rows[:limit]
    ]
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
            "Explicitly recall personal, current-conversation, or site memory. Never recall another user's memory.",
            _READ,
            recall_memory,
            preview_recall,
            operation="Read",
        ),
        ToolSpec(
            "save_memory",
            "Save a new memory note. Personal/current-conversation notes are owner scoped; site notes require manager authority. Does not overwrite existing memory.",
            _SAVE,
            save_memory,
            preview_save,
            mutates=True,
            operation="Create",
        ),
    ]
