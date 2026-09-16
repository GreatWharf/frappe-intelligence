import frappe

from frappe_intelligence.access import can_use_provider, require_user
from frappe_intelligence.documents import ManagedDocument


class IntelligenceProvider(ManagedDocument):
    def get_password(self, fieldname="password", raise_exception=True):
        user = require_user()
        if self.owner != user:
            grant = frappe.flags.get("intelligence_provider_secret")
            if fieldname != "api_key" or grant != (self.name, user) or not can_use_provider(self, user):
                frappe.throw("Provider credentials are private to their owner.", frappe.PermissionError)
        return super().get_password(fieldname=fieldname, raise_exception=raise_exception)
