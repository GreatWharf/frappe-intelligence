"""Authentication and private-record boundaries; never grants business permissions."""

from contextlib import contextmanager

import frappe

USER_ROLES = frozenset({"Intelligence User", "Intelligence Manager", "System Manager"})
MANAGER_ROLES = frozenset({"Intelligence Manager", "System Manager"})


def _denied():
    frappe.throw("Not permitted to access this Intelligence resource.", frappe.PermissionError)


def _enabled_user(user):
    return bool(user and user != "Guest" and frappe.db.get_value("User", user, "enabled"))


def require_user():
    """Return the authenticated enabled Desk user; callers cannot choose this identity."""
    user = frappe.session.user
    if not _enabled_user(user) or not USER_ROLES.intersection(frappe.get_roles(user)):
        _denied()
    if frappe.db.get_value("User", user, "user_type") != "System User":
        _denied()
    return user


def require_manager():
    user = require_user()
    if not MANAGER_ROLES.intersection(frappe.get_roles(user)):
        _denied()
    return user


@contextmanager
def internal_write():
    """Allow app-record controllers to persist state, not arbitrary tool operations.

    Server-only helper; not whitelisted. Restore the prior value even on failure.
    This flag is NEVER held while a business tool runs.
    """
    previous = frappe.flags.get("intelligence_internal")
    frappe.flags.intelligence_internal = True
    try:
        yield
    finally:
        frappe.flags.intelligence_internal = previous


def get_settings():
    require_user()
    return frappe.get_single("Intelligence Settings")


def get_conversation(name, write=False):
    user = require_user()
    doc = frappe.get_doc("Intelligence Conversation", name, for_update=write)
    # Sharing is read-only: only the owner may write, post or attach.
    if doc.owner != user and (write or not doc.get("shared")):
        _denied()
    doc.check_permission("write" if write else "read")
    return doc


def can_use_provider(doc, user=None):
    """Personal keys are owner-only, including against managers.

    Shared credentials must still belong to an enabled manager, and allowed_roles
    is enforced on every use. This is permission to USE a key, never to disclose it.
    """
    user = user or frappe.session.user
    if not _enabled_user(user) or not USER_ROLES.intersection(frappe.get_roles(user)):
        return False
    if not doc.get("enabled"):
        return False
    if not doc.get("is_shared"):
        return doc.owner == user
    if not _enabled_user(doc.owner) or not MANAGER_ROLES.intersection(frappe.get_roles(doc.owner)):
        return False
    allowed = {role.strip() for role in (doc.get("allowed_roles") or "").splitlines() if role.strip()}
    return not allowed or bool(allowed.intersection(frappe.get_roles(user)))


@contextmanager
def provider_secret_access(provider_name, user):
    """Server-only, exact-provider/current-actor decryption grant.

    Native password RPCs must not inherit Intelligence bookkeeping authority.
    The provider controller additionally verifies this tuple and current provider
    eligibility; this context is held only around the engine's key decryption.
    """
    current = require_user()
    if user != current or not isinstance(provider_name, str) or not provider_name:
        _denied()
    provider = frappe.get_doc("Intelligence Provider", provider_name, for_update=True)
    if not can_use_provider(provider, current):
        _denied()
    previous = frappe.flags.get("intelligence_provider_secret")
    frappe.flags.intelligence_provider_secret = (provider_name, current)
    try:
        yield
    finally:
        frappe.flags.intelligence_provider_secret = previous


def conversation_query(user=None):
    user = user or frappe.session.user
    if not _enabled_user(user) or not USER_ROLES.intersection(frappe.get_roles(user)):
        return "1=0"
    return (
        "(`tabIntelligence Conversation`.`owner` = "
        + frappe.db.escape(user)
        + " OR `tabIntelligence Conversation`.`shared` = 1)"
    )


def conversation_permission(doc, user=None, permission_type=None):
    user = user or frappe.session.user
    if doc.doctype != "Intelligence Conversation":
        return False
    if frappe.flags.get("intelligence_internal") and user == frappe.session.user:
        return True
    if not (_enabled_user(user) and USER_ROLES.intersection(frappe.get_roles(user))):
        return False
    if doc.owner == user:
        return True
    return permission_type == "read" and bool(doc.get("shared"))


def private_record_permission(doc, user=None, permission_type=None):
    user = user or frappe.session.user
    if doc.doctype not in {
        "Intelligence Message",
        "Intelligence Run",
        "Intelligence Approval",
        "Intelligence Tool Execution",
    }:
        return False
    if frappe.flags.get("intelligence_internal") and user == frappe.session.user:
        return True
    return bool(
        _enabled_user(user)
        and USER_ROLES.intersection(frappe.get_roles(user))
        and doc.get("conversation")
        and frappe.db.get_value("Intelligence Conversation", doc.conversation, "owner") == user
    )
