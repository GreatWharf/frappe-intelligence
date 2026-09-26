"""Controllers for API-managed application records, not business documents."""

import frappe
from frappe.model.document import Document

# Operational fields a native Desk form save may change on Intelligence Provider.
# Everything else (credentials, routing, sharing, identity) stays writable only
# through the app API, which validates it. When the doctype JSON gains a field,
# decide deliberately which list it joins; locked is the default for safety.
PROVIDER_FORM_FIELDS = frozenset({"title", "max_tokens", "timeout", "thinking_effort", "enabled", "models"})
PROVIDER_LOCKED_FIELDS = (
    "kind",
    "model",
    "model_efforts",
    "api_key",
    "base_url",
    "is_shared",
    "allowed_roles",
    "owner",
)


class ManagedDocument(Document):
    def _guard(self):
        if not frappe.flags.get("intelligence_internal"):
            frappe.throw("Use the Intelligence workspace to change this record.", frappe.PermissionError)

    def _guard_save(self):
        """Internal writes pass; native saves are limited to safe provider and memory edits."""
        if frappe.flags.get("intelligence_internal"):
            return
        if self.doctype == "Intelligence Provider" and self._provider_form_save():
            return
        if self.doctype == "Intelligence Memory" and self._memory_form_save():
            return
        self._guard()

    def _provider_form_save(self):
        """True for a Desk-form save that save_provider's rules would also allow.

        The actor rules mirror provider_service.save_provider exactly: personal
        providers are owner-only (even against managers), shared providers
        additionally require a manager. Edits may only touch whitelisted
        operational fields; creates run the service's own create-time
        validation, so the native form and the API accept the same records.
        """
        old = self.get_doc_before_save()
        from .access import MANAGER_ROLES, require_user
        from .provider_service import can_manage, validate_new_provider, validate_operational_fields

        try:
            user = require_user()
        except frappe.PermissionError:
            return False
        if old is None:
            validate_new_provider(self, user)
            return True
        if not can_manage(self, user):
            return False
        if self.get("is_shared") and not MANAGER_ROLES.intersection(frappe.get_roles(user)):
            return False
        if not all(old.get(field) == self.get(field) for field in PROVIDER_LOCKED_FIELDS):
            return False
        validate_operational_fields(self)
        return True

    def _memory_form_save(self):
        """True for a Desk-form save that the memory service's rules would allow.

        Mirrors memory.py: scope and conversation are immutable once saved, site
        memory is manager-curated, conversation memory needs write access to the
        conversation, and personal memory is owner-only. Content bounds match
        the service exactly.
        """
        from .access import MANAGER_ROLES, get_conversation, require_user

        try:
            user = require_user()
        except frappe.PermissionError:
            return False
        scope = self.get("scope") or "personal"
        conversation = self.get("conversation") or None
        if scope not in ("personal", "conversation", "site"):
            frappe.throw("Select personal, conversation or site memory.")
        old = self.get_doc_before_save()
        if old and (old.get("scope") != scope or (old.get("conversation") or None) != conversation):
            frappe.throw("A memory's scope cannot be changed. Create a new memory instead.")
        if scope == "site":
            if not MANAGER_ROLES.intersection(frappe.get_roles(user)):
                return False
        elif old is not None and old.owner != user:
            return False
        if scope == "conversation":
            if not conversation:
                frappe.throw("Select a conversation.")
            get_conversation(conversation, write=True)
        elif conversation:
            frappe.throw("Only conversation memory may be linked to a conversation.")
        content = self.get("content")
        if not isinstance(content, str) or not content.strip() or len(content) > 5000:
            frappe.throw("Memory must contain between 1 and 5000 characters.")
        return True

    def _memory_form_trash(self):
        """Native deletes follow the same rules as the memory service's delete."""
        from .access import MANAGER_ROLES, get_conversation, require_user

        try:
            user = require_user()
        except frappe.PermissionError:
            self._guard()
        if self.get("scope") == "site":
            if not MANAGER_ROLES.intersection(frappe.get_roles(user)):
                self._guard()
        elif self.owner != user:
            self._guard()
        if self.get("scope") == "conversation":
            get_conversation(self.get("conversation"), write=True)

    def validate(self):
        self._guard_save()
        old = self.get_doc_before_save()
        if old and old.owner != self.owner:
            frappe.throw("Intelligence record ownership cannot be transferred.", frappe.PermissionError)
        if old and self.doctype == "Intelligence Run":
            for field in ("site", "user", "conversation", "provider"):
                if old.get(field) != self.get(field):
                    frappe.throw("Run identity cannot be changed.", frappe.PermissionError)

    def on_trash(self):
        if frappe.flags.get("intelligence_internal"):
            return
        if self.doctype == "Intelligence Memory":
            self._memory_form_trash()
        else:
            self._guard()

    def before_rename(self, *args, **kwargs):
        self._guard()

    def before_submit(self):
        self._guard()

    def before_cancel(self):
        self._guard()


class SettingsDocument(Document):
    def validate(self):
        from .access import MANAGER_ROLES

        if not MANAGER_ROLES.intersection(frappe.get_roles(frappe.session.user)):
            frappe.throw(
                "Only Intelligence Managers may change Intelligence Settings.", frappe.PermissionError
            )
        limits = {
            "max_steps": (1, 30),
            "max_tokens": (128, 1048576),
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
        self._validate_write_scope()

    def _validate_write_scope(self):
        """allowed_write_doctypes ⊆ allowed_read_doctypes, minus the never-allow set.

        Catches misconfiguration at settings-save time; the runtime write gate in
        tools/adaptive.py re-checks the same invariant on every call.
        """
        from .tools import policy_lines
        from .tools.adaptive import write_blocked

        read = policy_lines(self.get("allowed_read_doctypes"))
        for name in sorted(policy_lines(self.get("allowed_write_doctypes"))):
            if write_blocked(name):
                frappe.throw(f"{name} can never be written by Intelligence tools.")
            if name not in read:
                frappe.throw(f"{name} must be listed in Allowed Read Doctypes before it can be writable.")
