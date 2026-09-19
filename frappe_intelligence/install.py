"""Standard Frappe lifecycle hooks; no customer-specific SQL or shell setup."""

import frappe

USER_ROLES = ("Intelligence User", "Intelligence Manager", "System Manager")
MODULE = "Frappe Intelligence"
DEFAULTS = {
    "enabled": 1,
    "max_steps": 30,
    "max_tokens": 4096,
    "max_run_seconds": 600,
    "approval_expiry_minutes": 1440,
    "max_upload_mb": 10,
    "max_file_chars": 30000,
    "daily_run_limit": 100,
    "approval_mode": "Approve Writes Only",
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
    # Blank by default: no DocType is writable through the adaptive tools until a
    # System Manager opts in per DocType (subset of allowed_read_doctypes).
    "allowed_write_doctypes": "",
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
            "list_doctypes",
            "describe_doctype",
            "create_document",
            "update_document",
            "propose_skill",
            "update_skill",
            "retire_skill",
        )
    ),
}

# Prompt-level playbooks seeded for every site. They compose the reviewed
# meta-tools and built-ins only: every write stays a draft behind explicit user
# approval, and they never submit, post, send email or auto-reconcile.
SEED_SKILLS = (
    {
        "name": "ingest-invoice",
        "title": "Ingest a supplier invoice",
        "description": "Extract an attached supplier invoice PDF and propose a draft Purchase Invoice.",
        "scope_read": "Supplier\nPurchase Invoice\nItem",
        "scope_write": "Supplier\nPurchase Invoice",
        "instructions": """When the user attaches a supplier invoice PDF, read it with read_attachment and extract the supplier name and address, the invoice number, invoice date and due date, the currency, each line item with quantity, rate and amount, the tax lines and the grand total. Restate what you found in chat so the user can confirm the extraction. Find the supplier with search_records on Supplier by name and tax identifiers. If there is no match, propose a draft Supplier with create_document and wait for the user's approval. Check for an existing draft Purchase Invoice for the same supplier and invoice number with search_records so the same bill is never captured twice; if one exists, show it and stop. Map every extracted field to the Purchase Invoice fields that describe_doctype allows, and list anything you could not map. Propose a DRAFT Purchase Invoice with create_document only after the user approves the mapping. Every write stays a draft behind the user's explicit approval. Never submit the invoice, never post it, never create payment entries and never write child table rows yourself. Finish by reporting the mapping confidence and the fields that still need a human.""",
    },
    {
        "name": "draft-email-reply",
        "title": "Draft an email reply",
        "description": "Read an inbound Communication and prepare an approved draft reply.",
        "scope_read": "Communication\nContact\nCustomer\nSupplier\nLead",
        "scope_write": "Communication",
        "instructions": """For an inbound Communication the user asks about, read it with read_document and gather context: open the linked Customer, Supplier or Lead and any referenced records with read_document so the reply addresses the actual situation. Summarize the thread and the open questions in chat. Draft a professional reply in chat in the user's voice: acknowledge what the sender asked, answer from the records you read, and flag anything you are unsure about instead of guessing. Ask the user to review and edit the draft. Only when the user explicitly approves, create a draft Communication with create_document so it waits in the queue for a human to review and send. Never send the email yourself, never mark the thread as read or closed, and never promise a follow-up the records do not support. If the Communication links to records you are not allowed to read, say so and draft only from what you could see. Every write stays a draft behind the user's explicit approval.""",
    },
    {
        "name": "daily-briefing",
        "title": "Daily briefing",
        "description": "Answer what is up for the user today and propose the next actions in priority order.",
        "scope_read": "ToDo\nBank Transaction\nCommunication\nSales Invoice\nPurchase Invoice",
        "scope_write": "",
        "instructions": """Answer "what is up for me today" by collecting the user's day. Pull open ToDos with search_records, ordered by priority and due date, and surface what is overdue first. List unreconciled Bank Transactions so cash movements stay visible. Check unread inbound Communications that wait on a reply. Gather the approvals that are pending the user's decision. Find overdue draft Sales Invoices and Purchase Invoices that need attention. Present the briefing as a short, prioritized plan in chat: what is late, what is waiting on the user and what can wait. For each item, cite the record you used so the user can open it. Propose next actions in priority order and offer to draft the replies or documents behind them. Create or change records only when the user asks, and then only as drafts behind the user's explicit approval. Never submit, post, reconcile or send anything while preparing the briefing.""",
    },
    {
        "name": "company-summary",
        "title": "Company summary",
        "description": "Explain how a company is doing from the reviewed financial reports and invoices.",
        "scope_read": "Company\nAccount\nCustomer\nSupplier\nSales Invoice\nPurchase Invoice",
        "scope_write": "",
        "instructions": """Summarize how a company is doing instead of reciting numbers. Run the reviewed financial reports with run_report: Trial Balance, Balance Sheet, Profit and Loss Statement, and Accounts Receivable and Accounts Payable, staying inside the report filters the site allows. Complement them with search_records over Sales Invoices and Purchase Invoices to see recent volume, overdue balances and concentration on a few customers or suppliers. Compare the current period with the previous one when the reports allow it, and explain what changed: revenue shifts, margin pressure, growing receivables, unusual balances. Call out what needs attention and why, in plain language, and name the reports and filters behind every claim so the user can verify. Propose follow-up actions in chat, such as reviewing overdue customers or checking an expense line. Reports and records are read-only here: never create or change documents while summarizing unless the user separately asks for a draft, which then goes through the normal approval.""",
    },
    {
        "name": "bank-reconciliation",
        "title": "Bank reconciliation",
        "description": "Propose matches for unreconciled Bank Transactions with evidence; never auto-reconcile.",
        "scope_read": "Bank Account\nBank Transaction\nSales Invoice\nPurchase Invoice",
        "scope_write": "",
        "instructions": """Help the user reconcile their bank without ever reconciling anything yourself. List unreconciled Bank Transactions with search_records. For each one, find candidate Sales Invoices, Purchase Invoices and payments by matching amount, date proximity and the reference text on the transaction. Rank the candidates and explain the evidence for each: exact amount match, matching reference, expected date window. Present the proposals in chat as a list the user can accept, reject or adjust, and be explicit when a transaction has no good match instead of forcing one. Only when the user approves a proposal do you record anything, and then only as a draft through create_document or update_document behind the user's explicit approval. Never auto-reconcile, never mark invoices as paid, never create payment entries yourself and never submit or post documents. Close with a summary of what was matched, what was skipped and what still needs a human decision.""",
    },
    {
        "name": "quote-request",
        "title": "Answer a quote request",
        "description": "Answer inbound price and lead-time questions from Item data with an approved draft reply.",
        "scope_read": "Communication\nItem\nCustomer\nLead\nQuotation",
        "scope_write": "Communication",
        "instructions": """Answer inbound price and lead-time questions from customers. Read the inbound Communication with read_document and identify the Items and quantities the sender asked about. Look up each Item with search_records and read_document: current price, availability signals and anything the record says about lead time, using only fields you are allowed to see. If an Item or price is missing, say so plainly instead of inventing numbers. Draft a clear, professional reply in chat that quotes the prices and lead times you found, notes any validity or caveats the records mention and asks for details that are still needed. Let the user review and edit the draft. Only when the user explicitly approves, create a draft Communication with create_document so a human reviews and sends it. Never send the reply yourself, never create or submit a Quotation unless the user separately asks for a draft through the normal approval, and never promise stock or dates the records do not support.""",
    },
)


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


# v16 Workspace Sidebar rows: chat first, then Desk list views for every record
# type an Intelligence user manages. The seeded sidebar is app-managed, so
# after_migrate converges it to exactly this set on every release.
SIDEBAR_ITEMS = (
    ("Chat", "Page", "intelligence"),
    ("Conversations", "DocType", "Intelligence Conversation"),
    ("Always-allowed tools", "DocType", "Intelligence Tool Grant"),
    ("Providers", "DocType", "Intelligence Provider"),
    ("Skills", "DocType", "Intelligence Skill"),
    ("Memory", "DocType", "Intelligence Memory"),
    ("Settings", "DocType", "Intelligence Settings"),
)

# v15 navigates by workspaces; the same entries become one card per group.
V15_CARDS = (
    ("Chat", SIDEBAR_ITEMS[:1]),
    ("Manage", SIDEBAR_ITEMS[1:]),
)


def _shape(row):
    return (row.get("type"), row.get("label"), row.get("link_type"), row.get("link_to"))


def _replace_rows(doc, field, wanted):
    """Rewrite a child table to exactly `wanted`, returning whether it changed."""
    current = [_shape(row) for row in doc.get(field) or []]
    if current == [_shape(row) for row in wanted]:
        return False
    doc.set(field, [])
    for row in wanted:
        doc.append(field, dict(row))
    return True


def _sidebar_rows():
    return [
        {"type": "Link", "label": label, "link_type": link_type, "link_to": link_to}
        for label, link_type, link_to in SIDEBAR_ITEMS
    ]


def _v16_sidebar():
    wanted = _sidebar_rows()
    if frappe.db.exists("Workspace Sidebar", "Intelligence"):
        sidebar = frappe.get_doc("Workspace Sidebar", "Intelligence")
        # Converge only the record this app owns (standard, app-tagged, not a
        # per-user copy); a same-named site record is left exactly as it is.
        if sidebar.get("app") == "frappe_intelligence" and not sidebar.get("for_user"):
            changed = _replace_rows(sidebar, "items", wanted)
            if sidebar.get("module") != MODULE:
                # ERPNext pattern: the sidebar title labels the Desk header while
                # module keeps the DocType grouping intact (no Module Def rename).
                sidebar.set("module", MODULE)
                changed = True
            if changed:
                sidebar.save(ignore_permissions=True)
    else:
        frappe.get_doc(
            {
                "doctype": "Workspace Sidebar",
                "title": "Intelligence",
                "module": MODULE,
                "standard": 1,
                "app": "frappe_intelligence",
                "items": wanted,
            }
        ).insert(ignore_permissions=True)
    # v16 auto-generates a sidebar titled after every Module Def that lacks a
    # same-named sidebar; that generated "Frappe Intelligence" sidebar shadowed
    # ours in Desk resolution. This empty, app-owned sentinel takes the name;
    # boot drops sidebars with no visible items, so it never renders.
    if not frappe.db.exists("Workspace Sidebar", MODULE):
        frappe.get_doc(
            {
                "doctype": "Workspace Sidebar",
                "title": MODULE,
                "module": MODULE,
                "standard": 1,
                "app": "frappe_intelligence",
                "items": [],
            }
        ).insert(ignore_permissions=True)


def _v15_workspace():
    links = []
    for card, entries in V15_CARDS:
        links.append({"label": card, "type": "Card Break"})
        for label, link_type, link_to in entries:
            links.append({"label": label, "type": "Link", "link_type": link_type, "link_to": link_to})
    if frappe.db.exists("Workspace", "Intelligence Chat"):
        workspace = frappe.get_doc("Workspace", "Intelligence Chat")
        if workspace.get("for_user"):
            return
        if _replace_rows(workspace, "links", links):
            workspace.save(ignore_permissions=True)
        return
    frappe.get_doc(
        {
            "doctype": "Workspace",
            "label": "Intelligence Chat",
            "title": "Intelligence Chat",
            "module": MODULE,
            "public": 1,
            "is_hidden": 0,
            "icon": "message",
            "roles": [{"role": role} for role in USER_ROLES],
            "links": links,
        }
    ).insert(ignore_permissions=True)


def _navigation():
    """Own the Desk entry: the sidebar leads into chat and the app's records.

    On v16 there is deliberately no Workspace: a one-shortcut workspace only
    inserts a middleman page between the app icon and the chat. The Workspace
    Sidebar resolves the left sidebar for /desk/intelligence, and the standard
    Desktop Icon carries the logo that the sidebar header and apps screen
    resolve. Workspace Sidebar and Desktop Icon do not exist on v15, which
    still navigates by workspaces; there the seeded workspace links straight to
    the page and is named "Intelligence Chat" because a workspace named
    "Intelligence" route-conflicts with the standard page.
    """
    # Drop the middleman workspace created by releases before 0.4. A user's own
    # customized workspace is left untouched; only the seeded shortcut page goes.
    if frappe.db.exists("Workspace", "Intelligence"):
        workspace = frappe.get_doc("Workspace", "Intelligence")
        if not workspace.get("for_user"):
            frappe.delete_doc("Workspace", "Intelligence", ignore_permissions=True, force=True)
    if frappe.__version__.split(".")[0] == "15":
        _v15_workspace()
        return
    _v16_sidebar()
    _v16_icon()


# Canonical Desktop Icon: the apps screen offers exactly one way in, labeled
# after the app rather than the module.
ICON_FIELDS = {
    "label": "Intelligence",
    "icon_type": "App",
    "standard": 1,
    "app": "frappe_intelligence",
    "link_type": "Workspace Sidebar",
    "link_to": "Intelligence",
    "logo_url": "/assets/frappe_intelligence/images/intelligence.svg",
    "hidden": 0,
}


def _replace_roles(doc):
    wanted = list(USER_ROLES)
    if [row.get("role") for row in doc.get("roles") or []] == wanted:
        return False
    doc.set("roles", [])
    for role in wanted:
        doc.append("roles", {"role": role})
    return True


def _v16_icon():
    if frappe.db.exists("Desktop Icon", "Intelligence"):
        icon = frappe.get_doc("Desktop Icon", "Intelligence")
        # The icon named after this app is its identity: converge app-owned
        # rows, and claim legacy untagged rows, which otherwise shadow the app
        # on the apps screen (pre-0.4 seeds were neither tagged nor standard,
        # so the grid fell back to the module name "Frappe Intelligence").
        if icon.get("app") in (None, "", "frappe_intelligence"):
            changed = _replace_roles(icon)
            for field, value in ICON_FIELDS.items():
                if icon.get(field) != value:
                    icon.set(field, value)
                    changed = True
            if changed:
                icon.save(ignore_permissions=True)
    else:
        frappe.get_doc(
            {
                "doctype": "Desktop Icon",
                **ICON_FIELDS,
                "roles": [{"role": role} for role in USER_ROLES],
            }
        ).insert(ignore_permissions=True)
    # The module-named auto app icon predates the Intelligence branding; left
    # visible it renders a second, wrongly labeled way in on the apps screen.
    if frappe.db.exists("Desktop Icon", MODULE):
        legacy = frappe.get_doc("Desktop Icon", MODULE)
        if legacy.get("app") == "frappe_intelligence" and not legacy.get("hidden"):
            legacy.set("hidden", 1)
            legacy.save(ignore_permissions=True)


def _global_search():
    """Register conversations with Desk global search (the awesomebar).

    Surgical by design: frappe's update_global_search_doctypes() rewrites the
    whole settings table from every app's hooks and discards rows an
    administrator added by hand, so we append our one row ourselves. Runs on
    install and migrate so upgraded sites gain the entry, then a background
    rebuild indexes conversations saved before registration.
    """
    if not frappe.db.exists("DocType", "Intelligence Conversation"):
        return
    settings = frappe.get_single("Global Search Settings")
    rows = settings.get("allowed_in_global_search") or []
    if any(row.get("document_type") == "Intelligence Conversation" for row in rows):
        return
    settings.append("allowed_in_global_search", {"document_type": "Intelligence Conversation"})
    settings.save(ignore_permissions=True)
    frappe.enqueue(
        "frappe.utils.global_search.rebuild_for_doctype",
        doctype="Intelligence Conversation",
        enqueue_after_commit=True,
    )


# Two DISABLED example policies document the policy matrix shape on every site.
# Defaults never weaken a site's stance: both rows are inert until a manager
# deliberately enables one, and an enabled auto-approve row is never seeded.
SEED_POLICIES = (
    {
        "name": "example-read-auto-approve",
        "enabled": 0,
        "priority": 100,
        "operation": "Read",
        "amount_condition": "Any amount",
        "decision": "Auto-approve",
        "reason": "Example: auto-approve read-only tools. Enable deliberately.",
    },
    {
        "name": "example-delete-require-approval",
        "enabled": 0,
        "priority": 100,
        "operation": "Delete",
        "amount_condition": "Any amount",
        "decision": "Require approval",
        "reason": "Example: destructive operations always ask. Enable deliberately.",
    },
)


def _insert_seeded(fields):
    """Insert a seed record under its deterministic name.

    Both seeded doctypes autoname by hash: on a real site the naming layer
    discards a name passed in the document dict unless the insert runs in the
    import context (the same mechanism fixture sync relies on), so a plain
    insert would mint a random hash name and the exists() guards above could
    never match - every migrate would add duplicates. Flag the insert as
    import-like, keep the name, restore the flag exactly as found.
    """
    doc = frappe.get_doc(fields)
    previous = getattr(frappe.flags, "in_import", False)
    frappe.flags.in_import = True
    try:
        doc.insert(ignore_permissions=True)
    finally:
        frappe.flags.in_import = previous
    return doc


def _seed_skills():
    """Insert the reviewed seed skills once; never overwrite a site's copy.

    Idempotent by skill name: a record the user edited (or deliberately
    disabled) is left exactly as it is on every migrate.
    """
    for skill in SEED_SKILLS:
        if frappe.db.exists("Intelligence Skill", skill["name"]):
            continue
        _insert_seeded(
            {
                "doctype": "Intelligence Skill",
                "origin": "Seeded",
                "enabled": 1,
                "shared": 1,
                "version": 1,
                **skill,
            }
        )


def _seed_policies():
    """Insert the two disabled example policies once; never overwrite or enable.

    Idempotent by policy name: a row the site edited (or deliberately enabled)
    is left exactly as it is on every migrate.
    """
    for policy in SEED_POLICIES:
        if frappe.db.exists("Intelligence Policy", policy["name"]):
            continue
        _insert_seeded({"doctype": "Intelligence Policy", **policy})


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
    settings = frappe.get_single("Intelligence Settings")
    # Backfill defaults introduced after a site's install; never overwrite a
    # value the site already chose.
    changed = False
    for key, value in DEFAULTS.items():
        if settings.get(key) in (None, ""):
            settings.set(key, value)
            changed = True
    if changed:
        settings.save(ignore_permissions=True)
    for doctype, fields, name in (
        ("Intelligence Message", ["conversation", "sequence"], "intelligence_message_order"),
        ("Intelligence Run", ["state", "lease_expires"], "intelligence_run_recovery"),
        ("Intelligence Run", ["user", "creation"], "intelligence_user_run_quota"),
        ("Intelligence Approval", ["run", "status"], "intelligence_approval_run"),
        ("Intelligence Conversation", ["owner", "archived", "modified"], "intelligence_conversation_owner"),
        ("Intelligence Memory", ["owner", "scope"], "intelligence_memory_owner"),
        ("Intelligence Skill", ["owner", "shared"], "intelligence_skill_owner"),
        ("Intelligence Tool Grant", ["user", "tool"], "intelligence_tool_grant_user"),
        ("Intelligence Policy", ["enabled", "priority"], "intelligence_policy_priority"),
    ):
        frappe.db.add_index(doctype, fields, name)
    _navigation()
    _seed_skills()
    _seed_policies()
    _global_search()


def before_uninstall():
    if frappe.db.exists("Intelligence Run", {"state": ["in", ["queued", "running", "awaiting_approval"]]}):
        frappe.throw(
            "Cancel or finish active Intelligence runs before uninstalling. Export required chat history first."
        )
