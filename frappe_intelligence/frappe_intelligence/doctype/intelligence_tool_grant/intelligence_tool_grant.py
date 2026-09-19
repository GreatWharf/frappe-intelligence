"""Standing per-user "always allow" grants for reviewed tools.

A grant tells the engine to auto-approve matching proposals for that user, with
the same durable approval, digest, preview and execution receipts as any other
auto-approval, so the audit trail is identical to a human click. Grants are
ordinary user records (like skills), so this controller does NOT extend
ManagedDocument: owners manage their own grants through the normal Desk and RPC
paths, bounded by validate() plus the row-visibility hooks below.
"""

import re

import frappe
from frappe.model.document import Document

from frappe_intelligence.access import MANAGER_ROLES, USER_ROLES

TOOL_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")
DOCTYPE_LIMIT = 140
SCOPES = ("Always", "This Conversation")


def _eligible(user):
    return bool(
        user
        and user != "Guest"
        and USER_ROLES.intersection(frappe.get_roles(user))
        and frappe.db.get_value("User", user, "enabled")
        and frappe.db.get_value("User", user, "user_type") == "System User"
    )


def _manager(user):
    return bool(MANAGER_ROLES.intersection(frappe.get_roles(user)))


def _normalized_scope(row):
    """Pre-0.6.0 rows predate the scope field; they are Always grants."""
    return row.get("scope") or "Always"


class IntelligenceToolGrant(Document):
    def validate(self):
        if not self.get("user"):
            self.user = frappe.session.user
        if not TOOL_NAME.fullmatch(self.get("tool") or ""):
            frappe.throw("Enter a valid tool name (lowercase letters, digits and underscores).")
        self.scope_doctype = (self.get("scope_doctype") or "").strip()
        if len(self.scope_doctype) > DOCTYPE_LIMIT:
            frappe.throw(f"scope_doctype must be at most {DOCTYPE_LIMIT} characters.")
        if self.scope_doctype and not frappe.db.exists("DocType", self.scope_doctype):
            frappe.throw(f"{self.scope_doctype} is not a DocType on this site.")
        scope = self.get("scope") or "Always"
        if scope not in SCOPES:
            frappe.throw("Unknown grant scope.")
        self.scope = scope
        conversation = (self.get("conversation") or "").strip() or None
        if scope == "This Conversation":
            if not conversation:
                frappe.throw("A conversation-scoped grant needs a conversation.")
            if not frappe.db.exists("Intelligence Conversation", conversation):
                frappe.throw("That conversation does not exist on this site.")
        else:
            conversation = None
        self.conversation = conversation
        if self.get("user") != frappe.session.user and not _manager(frappe.session.user):
            frappe.throw("You can only manage your own tool grants.", frappe.PermissionError)
        siblings = frappe.get_all(
            "Intelligence Tool Grant",
            filters={"user": self.user, "tool": self.tool, "scope_doctype": self.scope_doctype},
            fields=["name", "scope", "conversation"],
            limit_page_length=20,
        )
        for row in siblings:
            if row.name == self.name:
                continue
            if _normalized_scope(row) == scope and (row.get("conversation") or None) == conversation:
                frappe.throw("This tool is already always allowed for you.")


def permission_query_conditions(user=None, doctype=None):
    """Users see only their own grants; managers see every grant."""
    user = user or frappe.session.user
    if not _eligible(user):
        return "1=0"
    if _manager(user):
        return "1=1"
    return "`tabIntelligence Tool Grant`.`user` = " + frappe.db.escape(user)


def has_permission(doc, user=None, ptype=None):
    """Own rows for users; every row for managers; engine bookkeeping bypass."""
    if doc.doctype == "Intelligence Tool Grant" and frappe.flags.get("intelligence_internal"):
        return True
    user = user or frappe.session.user
    if not _eligible(user):
        return False
    if _manager(user):
        return True
    return doc.get("user") == user
