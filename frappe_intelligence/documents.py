"""Controllers for API-managed application records, not business documents."""

import frappe
from frappe.model.document import Document


class ManagedDocument(Document):
    def _guard(self):
        if not frappe.flags.get("intelligence_internal"):
            frappe.throw("Use the Intelligence workspace to change this record.", frappe.PermissionError)

    def validate(self):
        self._guard()
        old = self.get_doc_before_save()
        if old and old.owner != self.owner:
            frappe.throw("Intelligence record ownership cannot be transferred.", frappe.PermissionError)
        if old and self.doctype == "Intelligence Run":
            for field in ("site", "user", "conversation", "provider"):
                if old.get(field) != self.get(field):
                    frappe.throw("Run identity cannot be changed.", frappe.PermissionError)

    def on_trash(self):
        self._guard()

    def before_rename(self, *args, **kwargs):
        self._guard()

    def before_submit(self):
        self._guard()

    def before_cancel(self):
        self._guard()


class SettingsDocument(Document):
    def validate(self):
        frappe.only_for("System Manager")
        limits = {
            "max_steps": (1, 30),
            "max_tokens": (128, 32768),
            "max_run_seconds": (30, 1800),
            "approval_expiry_minutes": (5, 10080),
            "max_upload_mb": (1, 20),
            "max_file_chars": (1000, 100000),
            "daily_run_limit": (1, 10000),
        }
        for field, (minimum, maximum) in limits.items():
            try:
                value = int(self.get(field))
            except (TypeError, ValueError):
                frappe.throw(f"Enter a whole number for {field}.")
            if not minimum <= value <= maximum:
                frappe.throw(f"{field} must be between {minimum} and {maximum}.")
        for host in (self.get("allowed_custom_hosts") or "").splitlines():
            if host.strip() and any(value in host for value in ("/", ":", "*", "@", "?", "#", " ")):
                frappe.throw(
                    "Custom provider hosts must be exact hostnames, one per line, without URLs or wildcards."
                )
