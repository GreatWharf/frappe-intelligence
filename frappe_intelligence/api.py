"""Authenticated UI facade. Execution identity and provider secrets are never client inputs."""

import importlib
import json
from functools import wraps

import frappe

from . import files, memory, provider_service
from .access import (
    MANAGER_ROLES,
    can_use_provider,
    internal_write,
    require_manager,
    require_user,
)
from .access import (
    get_conversation as owned_conversation,
)
from .access import (
    get_settings as read_settings,
)

CONVERSATION_FIELDS = (
    "name",
    "title",
    "provider",
    "owner",
    "shared",
    "archived",
    "active_run",
    "modified",
    "message_count",
)
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
    settings = read_settings()
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
            "approval_mode": settings.get("approval_mode") or "Approve Every Step",
        },
    }


@frappe.whitelist()
@_safe
def list_conversations(search="", archived=0, shared=0):
    user = require_user()
    if not isinstance(search, str) or len(search) > 140:
        frappe.throw("Search must be no longer than 140 characters.")
    if archived not in (0, 1, "0", "1") or shared not in (0, 1, "0", "1"):
        frappe.throw("Invalid conversation filter.")
    if int(shared):
        # Conversations other users chose to share; read-only for this user.
        filters = {"shared": 1, "owner": ["!=", user], "archived": int(archived)}
    else:
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

    user = require_user()
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
        "can_post": doc.owner == user and not doc.archived,
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
    # A user-chosen name beats the generated title, now and on every later run.
    doc.title_manually_set = 1
    with internal_write():
        doc.save()
    return _conversation(doc)


@frappe.whitelist(methods=["POST"])
@_safe
def share_conversation(conversation, shared=1):
    doc = owned_conversation(conversation, write=True)
    if shared not in (0, 1, "0", "1"):
        frappe.throw("Invalid sharing setting.")
    doc.shared = int(shared)
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
    models=None,
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
        models,
    )


@frappe.whitelist(methods=["POST"])
@_safe
def fetch_provider_models(name=None, kind=None, base_url=None, api_key=None):
    return provider_service.fetch_provider_models(name, kind, base_url, api_key)


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
    settings = read_settings()
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


SETTINGS_FIELDS = (
    "enabled",
    "approval_mode",
    "max_steps",
    "max_tokens",
    "max_run_seconds",
    "approval_expiry_minutes",
    "max_upload_mb",
    "max_file_chars",
    "daily_run_limit",
    "allowed_read_doctypes",
    "allowed_write_doctypes",
    "allowed_reports",
    "enabled_tools",
    "allowed_custom_hosts",
)
SETTINGS_INT_FIELDS = (
    "max_steps",
    "max_tokens",
    "max_run_seconds",
    "approval_expiry_minutes",
    "max_upload_mb",
    "max_file_chars",
    "daily_run_limit",
)
SETTINGS_LINE_FIELDS = (
    "allowed_read_doctypes",
    "allowed_write_doctypes",
    "allowed_reports",
    "enabled_tools",
    "allowed_custom_hosts",
)
APPROVAL_MODES = ("Approve Every Step", "Approve Writes Only", "Automatic")


@frappe.whitelist()
@_safe
def get_settings():
    """The site policy any Intelligence user works under; no secrets."""
    require_user()
    settings = frappe.get_single("Intelligence Settings")
    return {
        field: settings.get(field) if settings.get(field) is not None else "" for field in SETTINGS_FIELDS
    }


def _lines(value):
    """Normalize a multiline string or list of strings: trimmed, de-duplicated, bounded."""
    if isinstance(value, str):
        items = value.splitlines()
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        frappe.throw("Invalid settings value.")
    cleaned = []
    for item in items:
        if not isinstance(item, str) or len(item) > 200:
            frappe.throw("Invalid settings value.")
        item = item.strip()
        if item and item not in cleaned:
            cleaned.append(item)
    if len(cleaned) > 500:
        frappe.throw("Too many entries.")
    return "\n".join(cleaned)


@frappe.whitelist(methods=["POST"])
@_safe
def save_settings(**values):
    """Manager-only policy update; the doctype's validate() stays the gate."""
    require_manager()
    settings = frappe.get_single("Intelligence Settings")
    updates = {}
    unknown = set(values) - set(SETTINGS_FIELDS)
    if unknown:
        frappe.throw("Unknown settings field.")
    if "enabled" in values:
        updates["enabled"] = 1 if str(values["enabled"]) in ("1", "true", "True") else 0
    if "approval_mode" in values:
        if values["approval_mode"] not in APPROVAL_MODES:
            frappe.throw("Unknown approval mode.")
        updates["approval_mode"] = values["approval_mode"]
    for field in SETTINGS_INT_FIELDS:
        if field in values and values[field] is not None:
            try:
                updates[field] = int(values[field])
            except (TypeError, ValueError):
                frappe.throw("Invalid numeric settings value.")
    for field in SETTINGS_LINE_FIELDS:
        if field in values and values[field] is not None:
            updates[field] = _lines(values[field])
    if not updates:
        frappe.throw("Nothing to save.")
    # Desk write permission on the settings DocType stays System Manager-only;
    # this endpoint is the manager path, so validation (limits, write scope
    # subset, never-allow set) runs but role permissions do not re-apply.
    settings.update(updates)
    settings.save(ignore_permissions=True)
    return {
        field: settings.get(field) if settings.get(field) is not None else "" for field in SETTINGS_FIELDS
    }


@frappe.whitelist()
@_safe
def list_grants():
    """Always-allow grants visible to the caller: own rows, or all for managers."""
    user = require_user()
    manager = bool(MANAGER_ROLES.intersection(frappe.get_roles(user)))
    rows = frappe.get_all(
        "Intelligence Tool Grant",
        fields=["name", "user", "tool", "scope_doctype", "creation", "modified"],
        order_by="modified desc",
        limit_page_length=500,
    )
    return [
        {
            "name": row.name,
            "user": row.get("user"),
            "tool": row.get("tool"),
            "scope_doctype": row.get("scope_doctype") or "",
            "creation": row.get("creation"),
            "modified": row.get("modified"),
        }
        for row in rows
        if manager or row.get("user") == user
    ]


@frappe.whitelist(methods=["POST"])
@_safe
def revoke_grant(name):
    user = require_user()
    doc = frappe.get_doc("Intelligence Tool Grant", name, for_update=True)
    if doc.get("user") != user and not MANAGER_ROLES.intersection(frappe.get_roles(user)):
        frappe.throw("You cannot revoke this grant.", frappe.PermissionError)
    with internal_write():
        frappe.delete_doc("Intelligence Tool Grant", name, ignore_permissions=True)
    return {"deleted": True}
