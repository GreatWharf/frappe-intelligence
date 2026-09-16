"""Standard Frappe lifecycle hooks; no customer-specific SQL or shell setup."""

import json

import frappe

USER_ROLES = ("Intelligence User", "Intelligence Manager", "System Manager")
DEFAULTS = {
    "enabled": 1,
    "max_steps": 12,
    "max_tokens": 4096,
    "max_run_seconds": 600,
    "approval_expiry_minutes": 1440,
    "max_upload_mb": 10,
    "max_file_chars": 30000,
    "daily_run_limit": 100,
    "allowed_read_doctypes": "\n".join(
        (
            "Customer",
            "Supplier",
            "Contact",
            "Address",
            "Lead",
            "Opportunity",
            "Quotation",
            "Sales Order",
            "Sales Invoice",
            "Purchase Order",
            "Purchase Invoice",
            "Item",
            "Warehouse",
            "Bin",
            "Bank Account",
            "Bank Transaction",
            "Company",
            "Account",
            "Event",
            "ToDo",
            "Communication",
            "Wiki Page",
            "Wiki Document",
        )
    ),
    "allowed_reports": "\n".join(
        (
            "Balance Sheet",
            "Profit and Loss Statement",
            "Cash Flow",
            "Trial Balance",
            "Accounts Receivable",
            "Accounts Payable",
            "General Ledger",
        )
    ),
    "enabled_tools": "\n".join(
        (
            "search_records",
            "read_document",
            "run_report",
            "read_attachment",
            "update_event",
            "update_todo",
            "create_todo",
            "recall_memory",
            "save_memory",
            "edit_wiki_page",
        )
    ),
}


def check_versions():
    if frappe.__version__.split(".")[0] not in {"15", "16"}:
        frappe.throw("Frappe Intelligence targets Frappe v15 and v16.")
    if frappe.db.db_type != "mariadb":
        frappe.throw("This release targets MariaDB-backed sites.")


def _roles():
    for name in USER_ROLES[:2]:
        if not frappe.db.exists("Role", name):
            frappe.get_doc({"doctype": "Role", "role_name": name, "desk_access": 1}).insert(
                ignore_permissions=True
            )


def _navigation():
    if frappe.db.exists("Workspace", "Intelligence"):
        return
    frappe.get_doc(
        {
            "doctype": "Workspace",
            "name": "Intelligence",
            "label": "Intelligence",
            "title": "Intelligence",
            "module": "Frappe Intelligence",
            "public": 1,
            "is_hidden": 0,
            "icon": "message",
            "roles": [{"role": role} for role in USER_ROLES],
            "shortcuts": [{"label": "Open Intelligence", "type": "Page", "link_to": "intelligence-chat"}],
            "content": json.dumps(
                [
                    {
                        "id": "intelligence-chat",
                        "type": "shortcut",
                        "data": {"shortcut_name": "Open Intelligence", "col": 12},
                    }
                ]
            ),
        }
    ).insert(ignore_permissions=True)


def before_install():
    check_versions()
    _roles()


def after_install():
    check_versions()
    _roles()
    settings = frappe.get_single("Intelligence Settings")
    settings.update(DEFAULTS)
    settings.save(ignore_permissions=True)
    after_migrate()


def after_migrate():
    check_versions()
    _roles()
    for doctype, fields, name in (
        ("Intelligence Message", ["conversation", "sequence"], "intelligence_message_order"),
        ("Intelligence Run", ["state", "lease_expires"], "intelligence_run_recovery"),
        ("Intelligence Run", ["user", "creation"], "intelligence_user_run_quota"),
        ("Intelligence Approval", ["run", "status"], "intelligence_approval_run"),
        ("Intelligence Conversation", ["owner", "archived", "modified"], "intelligence_conversation_owner"),
        ("Intelligence Memory", ["owner", "scope"], "intelligence_memory_owner"),
    ):
        frappe.db.add_index(doctype, fields, name)
    _navigation()


def before_uninstall():
    if frappe.db.exists("Intelligence Run", {"state": ["in", ["queued", "running", "awaiting_approval"]]}):
        frappe.throw(
            "Cancel or finish active Intelligence runs before uninstalling. Export required chat history first."
        )
