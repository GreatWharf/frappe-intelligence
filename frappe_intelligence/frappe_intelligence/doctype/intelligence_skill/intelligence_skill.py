"""Prompt-level playbooks owned by users; managers curate shared and seeded skills.

Skills are ordinary user records, not engine bookkeeping, so this controller does
NOT extend ManagedDocument: owners edit their own skills through the normal Desk
and RPC paths, bounded by validate() plus the row-visibility hooks below. Wire
them in hooks.py as permission_query_conditions / has_permission for
"Intelligence Skill" (see frappe_intelligence/permissions.py for the pattern).
"""

import frappe
from frappe.model.document import Document

from frappe_intelligence.access import MANAGER_ROLES, USER_ROLES

TITLE_LIMIT = 140
DESCRIPTION_LIMIT = 500
INSTRUCTIONS_LIMIT = 8000
SCOPE_LIMIT = 2000
ORIGINS = ("Seeded", "Learned")


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


class IntelligenceSkill(Document):
    def validate(self):
        self._bounded("title", TITLE_LIMIT, required=True)
        self._bounded("description", DESCRIPTION_LIMIT)
        self._bounded("instructions", INSTRUCTIONS_LIMIT, required=True)
        self._bounded("scope_read", SCOPE_LIMIT)
        self._bounded("scope_write", SCOPE_LIMIT)
        self._validate_version()
        self._validate_origin()
        self._validate_scopes()
        self._validate_curator()

    def _bounded(self, field, limit, required=False):
        value = (self.get(field) or "").strip()
        if required and not value:
            frappe.throw(f"{field} is required.")
        if len(value) > limit:
            frappe.throw(f"{field} must be at most {limit} characters.")

    def _validate_version(self):
        try:
            version = int(self.get("version"))
        except (TypeError, ValueError):
            frappe.throw("Enter a whole number for version.")
        if version < 1:
            frappe.throw("version must be a positive whole number.")

    def _validate_origin(self):
        if self.get("origin") not in ORIGINS:
            frappe.throw("origin must be Seeded or Learned.")
        old = self.get_doc_before_save()
        if old and old.get("origin") != self.get("origin"):
            frappe.throw("Skill origin cannot be changed.", frappe.PermissionError)

    def _validate_scopes(self):
        """scope_write ⊆ scope_read, same policy_lines convention as the settings."""
        from frappe_intelligence.tools import policy_lines

        read = policy_lines(self.get("scope_read"))
        for name in sorted(policy_lines(self.get("scope_write"))):
            if name not in read:
                frappe.throw(f"{name} must be listed in Scope Read before it can be writable.")

    def _validate_curator(self):
        """Shared and Seeded skills are manager-curated.

        Install runs as Administrator (a System Manager), so seeding passes this
        check through the normal server path without any flag.
        """
        if (self.get("shared") or self.get("origin") == "Seeded") and not _manager(frappe.session.user):
            frappe.throw(
                "Only Intelligence Managers may share a skill or set its origin to Seeded.",
                frappe.PermissionError,
            )


def permission_query_conditions(user=None, doctype=None):
    """Users see their own skills plus shared ones; managers see every skill."""
    user = user or frappe.session.user
    if not _eligible(user):
        return "1=0"
    if _manager(user):
        return "1=1"
    return (
        "(`tabIntelligence Skill`.`owner` = "
        + frappe.db.escape(user)
        + " OR `tabIntelligence Skill`.`shared` = 1)"
    )


def has_permission(doc, user=None, ptype=None):
    """Read own + shared; write only own non-shared skills unless a manager."""
    if doc.doctype == "Intelligence Skill" and frappe.flags.get("intelligence_internal"):
        return True
    user = user or frappe.session.user
    if not _eligible(user):
        return False
    if _manager(user):
        return True
    if ptype in {"write", "create", "delete"}:
        return bool(doc.owner == user and not doc.get("shared") and doc.get("origin") != "Seeded")
    return bool(doc.owner == user or doc.get("shared"))
