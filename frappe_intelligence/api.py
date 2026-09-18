"""Authenticated UI facade. Execution identity and provider secrets are never client inputs."""

import importlib
import json
from functools import wraps

import frappe

from . import files, memory, provider_service
from .access import (
    MANAGER_ROLES,
    can_use_provider,
    get_settings,
    internal_write,
    require_user,
)
from .access import (
    get_conversation as owned_conversation,
)

CONVERSATION_FIELDS = ("name", "title", "provider", "archived", "active_run", "modified", "message_count")
ACTIVE_STATES = frozenset({"queued", "running", "awaiting_approval"})


def _safe(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        frappe.flags.disable_traceback = True
        return function(*args, **kwargs)

    return wrapped


def _decode(value, kind):
    if value is None or value == "":
        return kind()
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            frappe.throw("Invalid request data.")
    if not isinstance(value, kind):
        frappe.throw("Invalid request data.")
    return value


def _conversation(doc):
    return {key: doc.get(key) for key in CONVERSATION_FIELDS}


def has_permission():
    try:
        require_user()
    except frappe.PermissionError:
        return False
    return True


@frappe.whitelist()
@_safe
def bootstrap():
    user = require_user()
    settings = get_settings()
    manager = bool(MANAGER_ROLES.intersection(frappe.get_roles(user)))
    from .limits import upload_limit_bytes

    full_name = frappe.db.get_value("User", user, "full_name") or ""
    first_name = full_name.split(" ", 1)[0].strip() if full_name else ""

    return {
        "enabled": bool(settings.get("enabled")),
        "user": user,
        "user_name": first_name,
        "is_manager": manager,
        "providers": provider_service.list_providers(),
        "managed_providers": provider_service.list_providers(managed=True),
        "capabilities": {
            "attachments": True,
            "memory": True,
            "shared_memory": manager,
            "provider_management": True,
            "streaming": False,
        },
        "defaults": {
            "max_upload_mb": upload_limit_bytes(settings) // (1024 * 1024),
            "approval_expiry_minutes": settings.get("approval_expiry_minutes") or 1440,
        },
    }


@frappe.whitelist()
@_safe
def list_conversations(search="", archived=0):
    user = require_user()
    if not isinstance(search, str) or len(search) > 140:
        frappe.throw("Search must be no longer than 140 characters.")
    if archived not in (0, 1, "0", "1"):
        frappe.throw("Invalid archive filter.")
    filters = {"owner": user, "archived": int(archived)}
    if search.strip():
        filters["title"] = ["like", "%" + search.strip() + "%"]
    return frappe.get_all(
        "Intelligence Conversation",
        filters=filters,
        fields=list(CONVERSATION_FIELDS),
        order_by="modified desc",
        limit_page_length=200,
    )


@frappe.whitelist(methods=["POST"])
@_safe
def create_conversation(provider, title="New chat"):
    user = require_user()
    definition = frappe.get_doc("Intelligence Provider", provider)
    if not can_use_provider(definition, user):
        frappe.throw("This provider is not available to you.", frappe.PermissionError)
    if not isinstance(title, str) or not title.strip() or len(title) > 140:
        frappe.throw("Conversation titles must be 1–140 characters.")
    doc = frappe.get_doc(
        {
            "doctype": "Intelligence Conversation",
            "title": title.strip(),
            "provider": provider,
            "archived": 0,
            "message_count": 0,
        }
    )
    with internal_write():
        doc.insert()
    return _conversation(doc)


@frappe.whitelist()
@_safe
def get_conversation(conversation, before_sequence=None):
    from . import engine

    doc = owned_conversation(conversation)
    filters = {"conversation": doc.name}
    if before_sequence is not None:
        try:
            filters["sequence"] = ["<", int(before_sequence)]
        except (TypeError, ValueError):
            frappe.throw("Invalid message cursor.")
    messages = frappe.get_all(
        "Intelligence Message",
        filters=filters,
        fields=["name", "role", "content", "status", "creation", "sequence", "run"],
        order_by="sequence desc",
        limit_page_length=200,
    )
    messages.reverse()
    latest = frappe.get_all(
        "Intelligence Run",
        filters={"conversation": doc.name},
        fields=["name"],
        order_by="creation desc",
        limit_page_length=1,
    )
    run = engine.get_run(latest[0].name) if latest else None
    approvals = []
    if run:
        for row in frappe.get_all(
            "Intelligence Approval",
            filters={"run": run["name"], "conversation": doc.name},
            fields=["name", "tool_name", "preview_json", "status", "expires_at", "creation"],
            order_by="creation asc",
            limit_page_length=256,
        ):
            approvals.append(
                {
                    "name": row.name,
                    "tool_name": row.tool_name,
                    "preview": _decode(row.preview_json, dict),
                    "status": row.status,
                    "expires_at": row.expires_at,
                    "creation": row.creation,
                }
            )
    return {
        "conversation": _conversation(doc),
        "messages": messages,
        "run": run,
        "approvals": approvals,
        "files": files.list_attachments(doc.name),
        "has_earlier_messages": bool(messages and messages[0].sequence > 1),
    }


@frappe.whitelist(methods=["POST"])
@_safe
def send_message(conversation, content, context=None, attachments=None):
    from .engine import submit_message

    return submit_message(
        conversation, content, context=_decode(context, dict) or None, attachments=_decode(attachments, list)
    )


@frappe.whitelist(methods=["POST"])
@_safe
def approve(approval, decision):
    from .engine import decide_approval

    return decide_approval(approval, decision)


@frappe.whitelist(methods=["POST"])
@_safe
def cancel(run):
    from .engine import cancel_run

    return cancel_run(run)


@frappe.whitelist(methods=["POST"])
@_safe
def rename_conversation(conversation, title):
    doc = owned_conversation(conversation, write=True)
    if not isinstance(title, str) or not title.strip() or len(title) > 140:
        frappe.throw("Conversation titles must be 1–140 characters.")
    doc.title = title.strip()
    with internal_write():
        doc.save()
    return _conversation(doc)


@frappe.whitelist(methods=["POST"])
@_safe
def archive_conversation(conversation, archived=1):
    doc = owned_conversation(conversation, write=True)
    if archived not in (0, 1, "0", "1"):
        frappe.throw("Invalid archive setting.")
    if doc.active_run:
        from .engine import get_run

        if get_run(doc.active_run)["state"] in ACTIVE_STATES:
            frappe.throw("Cancel or finish the active run before archiving this conversation.")
    doc.archived = int(archived)
    with internal_write():
        doc.save()
    return _conversation(doc)


@frappe.whitelist(methods=["POST"])
@_safe
def upload_attachment(conversation):
    return files.upload_attachment(conversation)


@frappe.whitelist()
@_safe
def list_memories(scope="personal", conversation=None):
    return memory.list_memories(scope, conversation)


@frappe.whitelist(methods=["POST"])
@_safe
def save_memory(content, scope="personal", conversation=None, name=None):
    return memory.save_memory(content, scope, conversation, name)


@frappe.whitelist(methods=["POST"])
@_safe
def delete_memory(name):
    return memory.delete_memory(name)


@frappe.whitelist(methods=["POST"])
@_safe
def save_provider(
    name=None,
    title="",
    kind="",
    model="",
    api_key=None,
    base_url="",
    is_shared=None,
    enabled=None,
    allowed_roles=None,
    max_tokens=None,
    timeout=None,
    thinking_effort=None,
):
    return provider_service.save_provider(
        name,
        title,
        kind,
        model,
        api_key,
        base_url,
        is_shared,
        enabled,
        allowed_roles,
        max_tokens,
        timeout,
        thinking_effort,
    )


@frappe.whitelist(methods=["POST"])
@_safe
def delete_provider(name):
    return provider_service.delete_provider(name)


@frappe.whitelist()
@_safe
def provider_details(name):
    return provider_service.provider_details(name)


@frappe.whitelist()
@_safe
def skills():
    """Read-only catalog of enabled tools, DocType scopes and visible skills; no secrets."""
    user = require_user()
    settings = get_settings()
    from . import engine
    from .tools import skill_scopes

    result = skill_scopes(user, settings)
    # Feeds the skill editor: every visible record with full instructions and
    # scopes, sorted by title. can_edit mirrors the doctype's write rule so the
    # client can gate its controls; owner identity never leaves the server.
    # importlib (not a from-import) so a stale package attribute can never bind
    # a previously loaded copy of the controller in long-lived processes.
    skill_controller = importlib.import_module(
        "frappe_intelligence.frappe_intelligence.doctype.intelligence_skill.intelligence_skill"
    )

    result["learned_skills"] = [
        {
            "name": row.name,
            "title": row.get("title") or "",
            "description": row.get("description") or "",
            "instructions": row.get("instructions") or "",
            "origin": row.get("origin") or "",
            "enabled": int(row.get("enabled") or 0),
            "shared": int(row.get("shared") or 0),
            "version": int(row.get("version") or 0),
            "can_edit": int(bool(skill_controller.has_permission(row, user=user, ptype="write"))),
            "scope_read": row.get("scope_read") or "",
            "scope_write": row.get("scope_write") or "",
        }
        for row in sorted(engine.visible_skills(user), key=lambda row: (row.get("title") or "", row.name))
    ]
    return result
