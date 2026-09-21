"""Authenticated UI facade. Execution identity and provider secrets are never client inputs."""

import importlib
import json
from functools import wraps

import frappe

from . import files, memory, provider_service
from .access import (
    MANAGER_ROLES,
    can_use_provider,
    has_read_share,
    internal_write,
    require_manager,
    require_user,
    shared_conversation_names,
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
    "model",
    "effort",
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

    payload = {
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
    try:
        from .rag import status as rag_status

        payload["rag"] = rag_status()
    except Exception:  # RAG is optional; a missing or failing probe never blocks boot.
        pass
    return payload


@frappe.whitelist()
@_safe
def list_conversations(search="", archived=0, shared=0):
    user = require_user()
    if not isinstance(search, str) or len(search) > 140:
        frappe.throw("Search must be no longer than 140 characters.")
    if archived not in (0, 1, "0", "1") or shared not in (0, 1, "0", "1"):
        frappe.throw("Invalid conversation filter.")
    if int(shared):
        # Conversations other users shared with this user (native DocShare); read-only here.
        names = shared_conversation_names(user)
        filters = {"name": ["in", names or ["-"]], "owner": ["!=", user], "archived": int(archived)}
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
            fields=[
                "name",
                "tool_name",
                "preview_json",
                "status",
                "expires_at",
                "creation",
                "source",
                "decided_by",
            ],
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
                    # policy:<name>/grant:<name> marks an automatic decision; a
                    # blank decided_by distinguishes it from a human's click.
                    "source": row.get("source") or "",
                    "decided_by": row.get("decided_by") or "",
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
def send_message(conversation, content, context=None, attachments=None, model=None, effort=None):
    from .engine import submit_message

    return submit_message(
        conversation,
        content,
        context=_decode(context, dict) or None,
        attachments=_decode(attachments, list),
        model=model,
        effort=effort,
    )


@frappe.whitelist(methods=["POST"])
@_safe
def approve(approval, decision, scope="Always"):
    from .engine import decide_approval

    return decide_approval(approval, decision, scope=scope)


@frappe.whitelist(methods=["POST"])
@_safe
def decide_approvals(names, decision, scope="Always"):
    """Grouped approvals: decide several pending approvals of one run at once."""
    from .engine import decide_approvals as decide

    return decide(_decode(names, list), decision, scope=scope)


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


def _share_manager_doc(conversation):
    """Load a conversation for sharing changes: owner or Intelligence Manager only."""
    user = require_user()
    doc = frappe.get_doc("Intelligence Conversation", conversation, for_update=True)
    if doc.owner != user and not MANAGER_ROLES.intersection(frappe.get_roles(user)):
        frappe.throw("Only the owner can manage sharing for this conversation.", frappe.PermissionError)
    return doc


def _share_target(user, must_be_enabled=True):
    if not isinstance(user, str) or not user.strip() or user.strip() == "Guest":
        frappe.throw("Choose a user to share with.", frappe.ValidationError)
    target = user.strip()
    row = frappe.db.get_value("User", target, ["name", "enabled", "user_type"], as_dict=True) or {}
    if not row.get("name"):
        frappe.throw("Unknown user.", frappe.ValidationError)
    if must_be_enabled and not row.get("enabled"):
        frappe.throw("That user is disabled.", frappe.ValidationError)
    if row.get("user_type") != "System User":
        frappe.throw("Only system users can open a shared conversation.", frappe.ValidationError)
    return target


def _share_rows(name):
    """Share list for the dialog: DocShare users with their display names."""
    users = []
    for row in frappe.share.get_users("Intelligence Conversation", name):
        target = row.get("user") if isinstance(row, dict) else getattr(row, "user", None)
        if not target:
            continue
        users.append(
            {"user": target, "full_name": frappe.db.get_value("User", target, "full_name") or ""}
        )
    return users


def _sync_shared_badge(doc):
    """The `shared` check is a list badge; DocShare rows are the access truth."""
    rows = frappe.share.get_users("Intelligence Conversation", doc.name)
    badge = 1 if any((row.get("user") if isinstance(row, dict) else getattr(row, "user", None)) for row in rows) else 0
    if int(doc.get("shared") or 0) != badge:
        doc.shared = badge
        with internal_write():
            doc.save()


@frappe.whitelist(methods=["POST"])
@_safe
def share_conversation(conversation, user):
    """Share a conversation with one Frappe user, read-only, via native DocShare."""
    doc = _share_manager_doc(conversation)
    target = _share_target(user)
    if target == doc.owner:
        frappe.throw("That user already owns the conversation.", frappe.ValidationError)
    frappe.share.add(
        "Intelligence Conversation",
        doc.name,
        user=target,
        read=1,
        write=0,
        everyone=0,
        notify=0,
        # Our own owner-or-manager check above is the gate; the row still saves
        # with ignore_permissions inside frappe.share, so this only skips the
        # generic "share" ptype the custom DocType never granted.
        flags={"ignore_share_permission": True},
    )
    _sync_shared_badge(doc)
    return {"conversation": _conversation(doc), "shares": _share_rows(doc.name)}


@frappe.whitelist(methods=["POST"])
@_safe
def unshare_conversation(conversation, user):
    doc = _share_manager_doc(conversation)
    target = _share_target(user, must_be_enabled=False)
    frappe.share.remove("Intelligence Conversation", doc.name, target)
    _sync_shared_badge(doc)
    return {"conversation": _conversation(doc), "shares": _share_rows(doc.name)}


@frappe.whitelist()
@_safe
def conversation_share_users(conversation):
    user = require_user()
    doc = frappe.get_doc("Intelligence Conversation", conversation)
    if (
        doc.owner != user
        and not MANAGER_ROLES.intersection(frappe.get_roles(user))
        and not has_read_share(doc.name, user)
    ):
        frappe.throw("Not permitted to access this Intelligence resource.", frappe.PermissionError)
    return _share_rows(doc.name)


@frappe.whitelist(methods=["POST"])
@_safe
def set_conversation_model(conversation, provider, model=None):
    """Persist the composer pick: the provider, and optionally a catalog model."""
    from . import engine

    user = require_user()
    doc = owned_conversation(conversation, write=True)
    if not isinstance(provider, str) or not provider.strip():
        frappe.throw("Choose a provider.", frappe.ValidationError)
    definition = frappe.get_doc("Intelligence Provider", provider.strip())
    if not can_use_provider(definition, user):
        frappe.throw("This provider is not available to you.", frappe.PermissionError)
    doc.provider = definition.name
    doc.model = engine._validate_model(definition.name, model)
    with internal_write():
        doc.save()
    return _conversation(doc)


@frappe.whitelist(methods=["POST"])
@_safe
def set_conversation_effort(conversation, effort):
    """Persist the per-conversation reasoning effort (Auto follows the provider)."""
    from . import engine

    doc = owned_conversation(conversation, write=True)
    doc.effort = engine._validate_effort(effort) or "Auto"
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
    # frappe.handler forwards all of form_dict to a **kwargs signature, so the
    # routed method name itself arrives here; it is not a settings field.
    values.pop("cmd", None)
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
        fields=["name", "user", "tool", "scope_doctype", "scope", "conversation", "creation", "modified"],
        order_by="modified desc",
        limit_page_length=500,
    )
    return [
        {
            "name": row.name,
            "user": row.get("user"),
            "tool": row.get("tool"),
            "scope_doctype": row.get("scope_doctype") or "",
            "scope": row.get("scope") or "Always",
            "conversation": row.get("conversation") or "",
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
    if not isinstance(name, str):
        frappe.throw("Invalid request data.", frappe.ValidationError)
    doc = frappe.get_doc("Intelligence Tool Grant", name, for_update=True)
    if doc.get("user") != user and not MANAGER_ROLES.intersection(frappe.get_roles(user)):
        frappe.throw("You cannot revoke this grant.", frappe.PermissionError)
    with internal_write():
        frappe.delete_doc("Intelligence Tool Grant", name, ignore_permissions=True)
    return {"deleted": True}
