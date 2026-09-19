"""Site policy matrix for approval decisions.

Managers describe which tool calls auto-approve, require approval or deny by
tool, target DocType, operation class, role and amount threshold. The engine
evaluates enabled rows by (priority desc, specificity desc, name asc) before
falling back to the approval-mode setting. Policies are site policy, not user
records: doctype permissions restrict them to managers, and validate()
re-asserts that here so RPC writes cannot bypass the Desk permission map.
"""

import re

import frappe
from frappe.model.document import Document

from frappe_intelligence.access import MANAGER_ROLES

TOOL_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")
OPERATIONS = ("Any", "Read", "Create", "Update", "Delete", "Submit", "Report")
DECISIONS = ("Require approval", "Auto-approve", "Deny")
AMOUNT_CONDITIONS = ("Any amount", "At or below limit", "Above limit")
REASON_LIMIT = 500


class IntelligencePolicy(Document):
    def validate(self):
        if not MANAGER_ROLES.intersection(frappe.get_roles()):
            frappe.throw("Only Intelligence managers may edit policies.", frappe.PermissionError)
        self.enabled = 1 if self.get("enabled") in (1, "1", True) else 0
        try:
            self.priority = int(self.get("priority") if self.get("priority") is not None else 100)
        except (TypeError, ValueError):
            frappe.throw("Priority must be an integer.")
        tool = (self.get("tool") or "").strip()
        if tool:
            if not TOOL_NAME.fullmatch(tool):
                frappe.throw("Enter a valid tool name (lowercase letters, digits and underscores).")
            from frappe_intelligence.tools import registered_tool_names

            if tool not in registered_tool_names(frappe.session.user):
                frappe.throw(f"{tool} is not a reviewed Intelligence tool.")
        self.tool = tool
        self.target_doctype = (self.get("target_doctype") or "").strip() or None
        self.role = (self.get("role") or "").strip() or None
        self.currency = (self.get("currency") or "").strip() or None
        self.operation = self.get("operation") or "Any"
        if self.operation not in OPERATIONS:
            frappe.throw("Unknown policy operation.")
        if self.get("decision") not in DECISIONS:
            frappe.throw("Unknown policy decision.")
        self.amount_condition = self.get("amount_condition") or "Any amount"
        if self.amount_condition not in AMOUNT_CONDITIONS:
            frappe.throw("Unknown amount condition.")
        if self.amount_condition == "Any amount":
            self.amount_limit = None
        else:
            try:
                self.amount_limit = float(self.get("amount_limit"))
            except (TypeError, ValueError):
                frappe.throw("Set an amount limit for this amount condition.")
        reason = (self.get("reason") or "").strip()
        if len(reason) > REASON_LIMIT:
            frappe.throw(f"Reason must be at most {REASON_LIMIT} characters.")
        self.reason = reason
