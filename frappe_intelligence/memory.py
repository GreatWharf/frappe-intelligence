"""Explicit saved preferences, never an implicit cross-user memory store."""

import frappe

from .access import get_conversation, internal_write, require_manager, require_user

SCOPES = frozenset({"personal", "conversation", "site"})
FIELDS = ["name", "scope", "conversation", "content", "modified", "owner", "enabled"]


def _scope(scope, conversation, writing=False):
    user = require_user()
    if scope not in SCOPES:
        frappe.throw("Select personal, conversation or site memory.")
    if scope == "conversation":
        if not conversation:
            frappe.throw("Select a conversation.")
        get_conversation(conversation, write=writing)
    elif conversation:
        frappe.throw("Only conversation memory may be linked to a conversation.")
    if scope == "site" and writing:
        require_manager()
    return user


def _visible(row, user, scope, conversation):
    return bool(
        row.scope == scope
        and row.get("enabled")
        and (
            scope == "site"
            or (row.owner == user and (scope != "conversation" or row.conversation == conversation))
        )
    )


def _public(row):
    return {key: row.get(key) for key in ("name", "scope", "conversation", "content", "modified")}


def list_memories(scope="personal", conversation=None):
    user = _scope(scope, conversation)
    filters = {"scope": scope, "enabled": 1}
    if scope != "site":
        filters["owner"] = user
    if scope == "conversation":
        filters["conversation"] = conversation
    rows = frappe.get_all(
        "Intelligence Memory", filters=filters, fields=FIELDS, order_by="modified desc", limit_page_length=100
    )
    return [_public(row) for row in rows if _visible(row, user, scope, conversation)]


def save_memory(content, scope="personal", conversation=None, name=None):
    user = _scope(scope, conversation, writing=True)
    if not isinstance(content, str) or not content.strip() or len(content) > 5000:
        frappe.throw("Memory must contain between 1 and 5000 characters.")
    doc = (
        frappe.get_doc("Intelligence Memory", name, for_update=True)
        if name
        else frappe.get_doc({"doctype": "Intelligence Memory"})
    )
    if name:
        if doc.scope == "site":
            require_manager()
        elif doc.owner != user:
            frappe.throw("You cannot edit this memory.", frappe.PermissionError)
        if doc.scope != scope or (doc.get("conversation") or None) != (conversation or None):
            frappe.throw("A memory's scope cannot be changed. Create a new memory instead.")
    doc.scope, doc.conversation, doc.content, doc.enabled = scope, conversation, content.strip(), 1
    with internal_write():
        doc.save() if name else doc.insert()
    try:
        from . import rag

        rag.index_memory(doc)
    except Exception:
        # Indexing is best-effort: saving a memory never fails on embeddings.
        pass
    return _public(doc)


def delete_memory(name):
    user = require_user()
    doc = frappe.get_doc("Intelligence Memory", name, for_update=True)
    if doc.scope == "site":
        require_manager()
    elif doc.owner != user:
        frappe.throw("You cannot delete this memory.", frappe.PermissionError)
    if doc.scope == "conversation":
        get_conversation(doc.conversation, write=True)
    from . import rag

    with internal_write():
        rag.drop_memory(name)
        frappe.delete_doc("Intelligence Memory", name, ignore_permissions=True)
    return {"deleted": True}


def search_memories(scope="personal", conversation=None, query=None):
    """Visible memories ranked by similarity to query, or None to keep recency order.

    The candidate set is exactly what list_memories returns for this user and
    scope; ranking only reorders it, so semantic recall can never widen
    visibility. Any retrieval gap (no query, no usable provider, no scored
    vectors) returns None so callers fall back to the honest recency list.
    """
    if not isinstance(query, str) or not query.strip():
        return None
    rows = list_memories(scope, conversation)
    if not rows:
        return None
    try:
        from . import rag

        scores = rag.score_memories(rows, query)
    except Exception:
        return None
    if not scores:
        return None
    ranked = [dict(row, score=scores[row["name"]]) for row in rows if row.get("name") in scores]
    ranked.sort(key=lambda row: row["score"], reverse=True)
    return ranked
