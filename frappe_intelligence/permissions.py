"""Permission hooks also cover Desk lists, generic REST and private attachments."""

import frappe

from .access import MANAGER_ROLES, USER_ROLES, can_use_provider

CHILD_TYPES = frozenset(
    {"Intelligence Message", "Intelligence Run", "Intelligence Approval", "Intelligence Tool Execution"}
)
APP_TYPES = CHILD_TYPES | {"Intelligence Conversation", "Intelligence Provider", "Intelligence Memory"}


def _eligible(user):
    return bool(
        user
        and user != "Guest"
        and USER_ROLES.intersection(frappe.get_roles(user))
        and frappe.db.get_value("User", user, "enabled")
        and frappe.db.get_value("User", user, "user_type") == "System User"
    )


def _internal(doc):
    return bool(doc.doctype in APP_TYPES and frappe.flags.get("intelligence_internal"))


def conversation_query(user=None, doctype=None):
    user = user or frappe.session.user
    if not _eligible(user):
        return "1=0"
    return (
        "(`tabIntelligence Conversation`.`owner` = "
        + frappe.db.escape(user)
        + " OR `tabIntelligence Conversation`.`shared` = 1)"
    )


def private_query(user=None, doctype=None):
    user = user or frappe.session.user
    if doctype not in CHILD_TYPES or not _eligible(user):
        return "1=0"
    return (
        f"`tab{doctype}`.`conversation` IN (SELECT name FROM `tabIntelligence Conversation` "
        "WHERE owner = " + frappe.db.escape(user) + " OR shared = 1)"
    )


def private_permission(doc, user=None, ptype=None):
    if _internal(doc):
        return True
    user = user or frappe.session.user
    if not _eligible(user):
        return False
    if doc.doctype == "Intelligence Conversation":
        if doc.owner == user:
            return True
        return ptype == "read" and bool(doc.get("shared"))
    if not (doc.doctype in CHILD_TYPES and doc.get("conversation")):
        return False
    row = frappe.db.get_value("Intelligence Conversation", doc.conversation, ["owner", "shared"])
    if not row:
        return False
    owner, shared = row
    if owner == user:
        return True
    return ptype == "read" and bool(shared)


def provider_permission(doc, user=None, ptype=None):
    if _internal(doc):
        return True
    user = user or frappe.session.user
    if not _eligible(user):
        return False
    manager = bool(MANAGER_ROLES.intersection(frappe.get_roles(user)))
    if ptype in {"write", "create", "delete"}:
        return doc.owner == user or (bool(doc.is_shared) and manager)
    return doc.owner == user or (bool(doc.is_shared) and manager) or can_use_provider(doc, user)


def provider_query(user=None, doctype=None):
    user = user or frappe.session.user
    if not _eligible(user):
        return "1=0"
    rows = frappe.get_all(
        "Intelligence Provider",
        fields=["name", "owner", "is_shared", "enabled", "allowed_roles"],
        limit_page_length=1000,
    )
    names = [row.name for row in rows if provider_permission(row, user=user)]
    if not names:
        return "1=0"
    return "`tabIntelligence Provider`.`name` IN (" + ",".join(frappe.db.escape(name) for name in names) + ")"


def memory_query(user=None, doctype=None):
    user = user or frappe.session.user
    if not _eligible(user):
        return "1=0"
    return (
        "(`tabIntelligence Memory`.`owner` = "
        + frappe.db.escape(user)
        + " OR `tabIntelligence Memory`.`scope` = 'site')"
    )


def memory_permission(doc, user=None, ptype=None):
    if _internal(doc):
        return True
    user = user or frappe.session.user
    if not _eligible(user):
        return False
    if doc.scope == "site":
        return ptype not in {"write", "create", "delete"} or bool(
            MANAGER_ROLES.intersection(frappe.get_roles(user))
        )
    if doc.owner != user:
        return False
    return (
        doc.scope != "conversation"
        or frappe.db.get_value("Intelligence Conversation", doc.conversation, "owner") == user
    )
