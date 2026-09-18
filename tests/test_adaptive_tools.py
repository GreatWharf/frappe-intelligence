"""Offline contract/security tests for the adaptive DocType meta-tools.

Covers list_doctypes/describe_doctype read scoping, create_document/
update_document never-allow and write-scope gating, optimistic locking, the
skills() API contract and the SettingsDocument write-scope subset invariant.
"""

import importlib
import json
import sys
import types

import pytest


class Row(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__


class Meta:
    def __init__(self, name, fields, *, module="Desk", istable=False, is_submittable=False, autoname=None):
        self.name = name
        self.module = module
        self.fields = [
            Row(
                fieldname=k,
                label=k.replace("_", " ").title(),
                fieldtype=v,
                permlevel=0,
                read_only=0,
                hidden=0,
                is_virtual=0,
                reqd=0,
            )
            for k, v in fields.items()
        ]
        self.istable = istable
        self.issingle = False
        self.is_virtual = False
        self.is_submittable = is_submittable
        self.autoname = autoname
        self.title_field = next(iter(fields), None)
        self.blocked_read = set()
        self.blocked_write = set()

    def get_field(self, key):
        return next((f for f in self.fields if f.fieldname == key), None)

    def get_permitted_fieldnames(self, *, user=None, permission_type="read", **kwargs):
        # Real child (istable) DocTypes carry no DocPerm rows of their own, so a
        # permitted-fieldname lookup against them returns nothing; access is
        # inherited from the parent document. Mirror that or the tests approve
        # field sets a real site never would.
        if self.istable:
            return []
        blocked = self.blocked_write if permission_type in ("write", "create") else self.blocked_read
        return [f.fieldname for f in self.fields if f.fieldname not in blocked]


class Document(Row):
    def check_permission(self, permtype="read"):
        if not self._fake.has_permission(self.doctype, permtype, doc=self):
            raise PermissionError("Denied")

    def set(self, key, value):
        self[key] = value

    def append(self, field, values):
        child = Document(_fake=self._fake)
        child.update(values)
        self.setdefault(field, []).append(child)
        return child

    def save(self, **kwargs):
        assert not kwargs, "Normal Document save must not bypass permissions"
        self.check_permission("write")
        self.modified = "2026-09-16 12:01:00.000000"
        self._fake.saved.append((self.doctype, self.name))
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def insert(self, **kwargs):
        assert not kwargs, "Normal Document insert must not bypass permissions"
        self.check_permission("create")
        self.name = self.get("name") or f"NEW-{len(self._fake.rows)}"
        self.owner = self._fake.session.user
        self.modified = "2026-09-16 12:01:00.000000"
        self._fake.saved.append((self.doctype, self.name))
        self._fake.rows[(self.doctype, self.name)] = self
        return self


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self.session = Row(user="alice")
        self.local = Row(site="site.test")
        self.flags = Row()
        self.rows = {}
        self.meta = {}
        self.saved = []
        self.locks = []
        self.denied = set()
        self.hooks = {}
        self.attrs = {}
        self.installed = ["frappe", "erpnext"]
        self.settings = Row(
            enabled=1,
            allowed_read_doctypes="Customer\nToDo\nEvent\nCompany\nSales Invoice\nUser\nPassword Store\nIntelligence Memory",
            allowed_write_doctypes="ToDo\nEvent",
            enabled_tools="search_records\nread_document\nlist_doctypes\ndescribe_doctype\ncreate_document\nupdate_document",
            allowed_reports="Trial Balance",
            max_upload_mb=10,
            max_file_chars=30000,
        )
        self.PermissionError = PermissionError
        self.ValidationError = ValueError
        self.TimestampMismatchError = RuntimeError
        self.DoesNotExistError = LookupError
        self.whitelist = lambda *a, **kw: lambda f: f
        self.db = Row(
            get_value=self.get_value,
            exists=self.exists,
            commit=lambda: pytest.fail("Tools must never commit"),
            sql=lambda *a, **kw: pytest.fail("Tools must not use raw SQL"),
        )
        self.add_meta(
            "Customer",
            {
                "customer_name": "Data",
                "company": "Link",
                "credit_limit": "Currency",
                "api_key": "Data",
                "password": "Password",
                "private_notes": "Text",
                "items": "Table",
                "secret_token": "Data",
            },
            module="Selling",
            autoname="field:customer_name",
        )
        self.meta["Customer"].get_field("company").options = "Company"
        self.meta["Customer"].get_field("items").options = "Customer Item"
        self.meta["Customer"].get_field("customer_name").reqd = 1
        self.meta["Customer"].blocked_read.add("private_notes")
        self.add_meta(
            "Customer Item",
            {"item_code": "Data", "qty": "Float", "secret_note": "Data"},
            module="Selling",
            istable=True,
        )
        self.add_meta("Company", {"company_name": "Data"}, module="Setup")
        self.add_meta(
            "ToDo",
            {
                "description": "Text Editor",
                "status": "Select",
                "priority": "Select",
                "date": "Date",
                "allocated_to": "Link",
                "reference_type": "Link",
                "reference_name": "Dynamic Link",
            },
            module="Desk",
            autoname="hash",
        )
        self.meta["ToDo"].get_field("status").options = "Open\nClosed\nCancelled"
        self.meta["ToDo"].get_field("allocated_to").options = "User"
        self.add_meta(
            "Event",
            {
                "subject": "Data",
                "description": "Text Editor",
                "starts_on": "Datetime",
                "ends_on": "Datetime",
                "all_day": "Check",
                "status": "Select",
            },
            module="Desk",
        )
        self.meta["Event"].get_field("subject").reqd = 1
        self.add_meta(
            "Sales Invoice",
            {"customer": "Link", "posting_date": "Date", "grand_total": "Currency", "items": "Table"},
            module="Accounts",
            is_submittable=True,
        )
        self.meta["Sales Invoice"].get_field("customer").options = "Customer"
        self.meta["Sales Invoice"].get_field("posting_date").reqd = 1
        self.meta["Sales Invoice"].get_field("items").options = "Sales Invoice Item"
        self.add_meta(
            "Sales Invoice Item",
            {"item_code": "Data", "qty": "Float", "rate": "Currency", "secret_note": "Data"},
            module="Accounts",
            istable=True,
        )
        self.add_meta("GL Entry", {"account": "Data"}, module="Accounts")
        self.add_meta("Workflow", {"workflow_name": "Data"}, module="Workflow")
        self.add_meta("User", {"email": "Data"}, module="Core")
        self.add_meta("Password Store", {"value": "Data"}, module="Core")
        self.add_meta("Intelligence Memory", {"content": "Data"}, module="Frappe Intelligence")
        self.seed("User", "alice", enabled=1, user_type="System User")
        self.seed("Intelligence Conversation", "conversation", owner="alice")
        self.seed("Company", "Allowed", company_name="Allowed")
        self.seed("Company", "Other", company_name="Other", denied=True)
        self.seed(
            "Customer",
            "C-1",
            customer_name="Acme",
            company="Allowed",
            credit_limit=100,
            api_key="synthetic-secret",
            password="synthetic-secret",
            secret_token="synthetic-secret",
            private_notes="classified",
        )
        self.seed("ToDo", "T-1", description="Old", status="Open", priority="Medium", allocated_to="alice")
        self.seed("Event", "E-1", subject="Meeting", description="Old", status="Open")
        self.seed("Sales Invoice", "SI-1", customer="Acme", posting_date="2026-09-16")
        self.seed("Sales Invoice", "SI-2", customer="Acme", posting_date="2026-09-16", docstatus=1)

    def add_meta(self, doctype, fields, **kwargs):
        self.meta[doctype] = Meta(doctype, fields, **kwargs)

    def seed(self, doctype, name, **values):
        doc = Document(
            doctype=doctype,
            name=name,
            owner="alice",
            modified="2026-09-16 12:00:00.000000",
            docstatus=0,
            _fake=self,
        )
        doc.update(values)
        self.rows[(doctype, name)] = doc
        return doc

    def get_doc(self, doctype, name=None, **kwargs):
        if isinstance(doctype, dict):
            return Document(**doctype, _fake=self)
        if kwargs.get("for_update"):
            self.locks.append((doctype, name))
        original = self.rows[(doctype, name)]
        return Document({**original, "_fake": self})

    def new_doc(self, doctype):
        return Document(doctype=doctype, name=None, docstatus=0, _fake=self)

    def get_all(self, doctype, filters=None, fields=None, **kwargs):
        assert not kwargs.get("ignore_permissions"), "get_all must not bypass permissions"
        output = []
        if doctype == "DocType":
            for name, meta in self.meta.items():
                if filters:
                    if filters.get("istable") == 0 and meta.istable:
                        continue
                    if filters.get("issingle") == 0 and meta.issingle:
                        continue
                    if filters.get("is_virtual") == 0 and meta.is_virtual:
                        continue
                output.append(Row({key: getattr(meta, key, None) for key in fields or ("name", "module")}))
        else:
            for (dt, _), row in self.rows.items():
                if dt == doctype:
                    output.append(Row({key: row.get(key) for key in fields or ("name",)}))
        return output

    def get_value(self, doctype, name, field="name", **kwargs):
        doc = self.rows.get((doctype, name))
        return doc.get(field) if doc else None

    def exists(self, doctype, name):
        return name in self.meta if doctype == "DocType" else (doctype, name) in self.rows

    def get_meta(self, doctype):
        return self.meta[doctype]

    def get_single(self, doctype):
        return self.settings

    def get_roles(self, user=None):
        return ["System Manager"]

    def has_permission(self, doctype, ptype="read", doc=None, user=None, **kwargs):
        return (doctype, ptype) not in self.denied and not (doc and doc.get("denied"))

    def get_hooks(self, key, default=None):
        return self.hooks.get(key, default or [])

    def get_attr(self, path):
        return self.attrs[path]

    def get_installed_apps(self):
        return self.installed

    def only_for(self, role):
        if role not in self.get_roles():
            raise PermissionError("System Manager required")

    @staticmethod
    def throw(message, exc=ValueError):
        raise exc(message)


@pytest.fixture
def stack(monkeypatch):
    fake = FakeFrappe()
    document_module = types.ModuleType("frappe.model.document")

    class BaseDocument(Row):
        def get_doc_before_save(self):
            return self.get("old")

    document_module.Document = BaseDocument
    monkeypatch.setitem(sys.modules, "frappe", fake)
    monkeypatch.setitem(sys.modules, "frappe.model.document", document_module)
    owned = (
        "frappe_intelligence.access",
        "frappe_intelligence.api",
        "frappe_intelligence.documents",
        "frappe_intelligence.files",
        "frappe_intelligence.limits",
        "frappe_intelligence.memory",
        "frappe_intelligence.provider_service",
    )
    old = {}
    for key in list(sys.modules):
        if key in owned or key.startswith("frappe_intelligence.tools"):
            old[key] = sys.modules.pop(key)
    tools = importlib.import_module("frappe_intelligence.tools")
    api = importlib.import_module("frappe_intelligence.api")
    documents = importlib.import_module("frappe_intelligence.documents")
    context = tools.ToolContext("site.test", "alice", "conversation", "run")
    yield tools, context, fake, api, documents
    for key in list(sys.modules):
        if key in owned or key.startswith("frappe_intelligence.tools"):
            del sys.modules[key]
    sys.modules.update(old)


def _settings(documents, **overrides):
    values = {
        "max_steps": 12,
        "max_tokens": 4096,
        "max_run_seconds": 600,
        "approval_expiry_minutes": 1440,
        "max_upload_mb": 10,
        "max_file_chars": 30000,
        "daily_run_limit": 100,
        "allowed_custom_hosts": "",
        "allowed_read_doctypes": "Customer\nToDo\nEvent",
        "allowed_write_doctypes": "ToDo",
    }
    values.update(overrides)
    return documents.SettingsDocument(**values)


UPDATE_ARGS = {
    "doctype": "ToDo",
    "name": "T-1",
    "expected_modified": "2026-09-16 12:00:00.000000",
    "changes": [{"field": "description", "value": "New"}, {"field": "priority", "value": "High"}],
}


def test_adaptive_tools_are_registered_and_policy_filtered(stack):
    tools, context, fake, _, _ = stack
    names = set(tools.get_tools(context))
    assert {"list_doctypes", "describe_doctype", "create_document", "update_document"} <= names
    fake.settings.enabled_tools = "list_doctypes"
    assert set(tools.get_tools(context)) == {"list_doctypes"}


def test_list_doctypes_respects_allowlist_and_excludes_never_allow(stack):
    tools, context, _, _, _ = stack
    result = tools.execute(context, "list_doctypes", {})
    names = {entry["name"] for entry in result["doctypes"]}
    assert {"Customer", "ToDo", "Event", "Company", "Sales Invoice"} <= names
    # Configured for read but hard-blocked, sensitive-named or internal: never listed.
    assert "User" not in names
    assert "Password Store" not in names
    assert "Intelligence Memory" not in names
    # Child table doctypes are never listed as readable documents.
    assert "Customer Item" not in names
    # Not in the read allow-list at all.
    assert "GL Entry" not in names
    assert result["truncated"] is False
    assert all(set(entry) == {"name", "module"} for entry in result["doctypes"])
    assert [entry["name"] for entry in result["doctypes"]] == sorted(names)


def test_list_doctypes_query_module_and_truncation(stack, monkeypatch):
    tools, context, _, _, _ = stack
    adaptive = importlib.import_module("frappe_intelligence.tools.adaptive")
    result = tools.execute(context, "list_doctypes", {"query": "todo"})
    assert {entry["name"] for entry in result["doctypes"]} == {"ToDo"}
    result = tools.execute(context, "list_doctypes", {"module": "Selling"})
    assert {entry["name"] for entry in result["doctypes"]} == {"Customer"}
    monkeypatch.setattr(adaptive, "_MAX_DOCTYPES", 2)
    result = tools.execute(context, "list_doctypes", {})
    assert result["truncated"] is True
    assert len(result["doctypes"]) == 2


def test_list_doctypes_preview_discloses_no_metadata(stack):
    tools, context, _, _, _ = stack
    preview = tools.prepare(context, "list_doctypes", {"query": "cust"})
    assert preview["operation"] == "list_doctypes"
    assert "Customer" not in json.dumps(preview)


def test_describe_doctype_returns_meta_and_strips_sensitive_fields(stack):
    tools, context, _, _, _ = stack
    result = tools.execute(context, "describe_doctype", {"doctype": "Customer"})
    assert result["doctype"] == "Customer"
    assert result["autoname"] == "field:customer_name"
    by_name = {field["fieldname"]: field for field in result["fields"]}
    assert {"customer_name", "company", "credit_limit"} <= set(by_name)
    for sensitive in ("api_key", "password", "secret_token", "private_notes", "items"):
        assert sensitive not in by_name
    assert "synthetic-secret" not in json.dumps(result)
    assert by_name["customer_name"]["reqd"] is True
    assert by_name["credit_limit"]["reqd"] is False
    assert by_name["company"]["options"] == "Company"
    assert by_name["credit_limit"]["options"] is None
    assert result["writable"] is False


def test_describe_doctype_marks_writable_per_write_scope(stack):
    tools, context, fake, _, _ = stack
    assert tools.execute(context, "describe_doctype", {"doctype": "ToDo"})["writable"] is True
    fake.settings.allowed_write_doctypes += "\nSales Invoice"
    # Submittable doctypes are writable as drafts when configured; submission stays impossible.
    assert tools.execute(context, "describe_doctype", {"doctype": "Sales Invoice"})["writable"] is True
    fake.settings.allowed_write_doctypes += "\nGL Entry"
    fake.settings.allowed_read_doctypes += "\nGL Entry"
    # Never-allow types are never writable, even when configured for read and write.
    assert tools.execute(context, "describe_doctype", {"doctype": "GL Entry"})["writable"] is False


def test_describe_doctype_rejects_blocked_and_unlisted_types(stack):
    tools, context, fake, _, _ = stack
    for doctype in ("User", "Password Store", "Intelligence Memory"):
        with pytest.raises(PermissionError):
            tools.execute(context, "describe_doctype", {"doctype": doctype})
    with pytest.raises(PermissionError):
        tools.execute(context, "describe_doctype", {"doctype": "GL Entry"})
    with pytest.raises(PermissionError):
        tools.prepare(context, "describe_doctype", {"doctype": "User"})


def test_describe_doctype_discloses_child_tables_read_only(stack):
    tools, context, _, _, _ = stack
    result = tools.execute(context, "describe_doctype", {"doctype": "Customer"})
    children = {entry["fieldname"]: entry for entry in result["child_tables"]}
    assert set(children) == {"items"}
    items = children["items"]
    assert items["child_doctype"] == "Customer Item"
    child_names = {field["fieldname"] for field in items["child_fields"]}
    assert child_names == {"item_code", "qty"}
    assert "secret_note" not in json.dumps(items)


@pytest.mark.parametrize(
    "args",
    [
        {"doctype": "ToDo"},
        {"doctype": "ToDo", "fields": []},
        {"doctype": "ToDo", "fields": [{"field": "status"}]},
        {"doctype": "ToDo", "fields": [{"field": "9bad", "value": "x"}]},
        {"doctype": "ToDo", "fields": [{"field": "status", "value": "x" * 1001}]},
        {"doctype": "ToDo", "fields": [{"field": "status", "value": "Open"}], "extra": 1},
    ],
)
def test_create_document_schema_is_closed_and_bounded(stack, args):
    tools, context, _, _, _ = stack
    with pytest.raises(ValueError):
        tools.execute(context, "create_document", args)


def test_create_document_creates_draft_only(stack):
    tools, context, fake, _, _ = stack
    args = {
        "doctype": "ToDo",
        "fields": [
            {"field": "description", "value": "Follow up"},
            {"field": "priority", "value": "High"},
        ],
    }
    preview = tools.prepare(context, "create_document", args)
    assert preview["summary"] == "Create a new ToDo."
    assert preview["operation"] == "create_document"
    assert preview["target"] == {"doctype": "ToDo", "name": None}
    assert preview["details"]["fields"] == args["fields"]
    assert preview["details"]["missing_required"] == []
    assert fake.saved == []
    result = tools.execute(context, "create_document", args)
    assert result["created"] is True
    doc = fake.rows[("ToDo", result["name"])]
    assert doc.description == "Follow up"
    assert doc.priority == "High"
    assert doc.get("docstatus", 0) == 0
    # docstatus is a standard field outside the writable meta fields: never settable.
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "ToDo", "fields": [{"field": "docstatus", "value": 1}]},
        )


def test_create_document_preview_surfaces_missing_required_fields(stack):
    tools, context, fake, _, _ = stack
    preview = tools.prepare(
        context, "create_document", {"doctype": "Event", "fields": [{"field": "description", "value": "x"}]}
    )
    assert preview["details"]["missing_required"] == ["subject"]
    assert fake.saved == []


def test_create_document_rejects_never_allow_even_when_configured(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_read_doctypes += "\nGL Entry\nWorkflow"
    fake.settings.allowed_write_doctypes += "\nGL Entry\nWorkflow"
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "GL Entry", "fields": [{"field": "account", "value": "x"}]},
        )
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "Workflow", "fields": [{"field": "workflow_name", "value": "x"}]},
        )
    assert fake.saved == []


def test_create_document_rejects_unlisted_and_never_allow_types(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nSales Invoice"
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "Customer", "fields": [{"field": "customer_name", "value": "Beta"}]},
        )
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "GL Entry", "fields": [{"field": "account", "value": "x"}]},
        )
    assert fake.saved == []


def test_create_document_drafts_submittable_in_write_scope(stack):
    """Submittable DocTypes in the write scope may be drafted, never submitted."""
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nSales Invoice"
    args = {
        "doctype": "Sales Invoice",
        "fields": [
            {"field": "customer", "value": "Acme"},
            {"field": "posting_date", "value": "2026-09-17"},
        ],
    }
    preview = tools.prepare(context, "create_document", args)
    assert preview["details"]["missing_required"] == []
    assert fake.saved == []
    result = tools.execute(context, "create_document", args)
    assert result["created"] is True
    doc = fake.rows[("Sales Invoice", result["name"])]
    assert doc.customer == "Acme"
    assert doc.get("docstatus", 0) == 0
    # docstatus is outside the writable meta fields even on a submittable draft.
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "Sales Invoice", "fields": [{"field": "docstatus", "value": 1}]},
        )


def test_create_document_appends_validated_child_rows(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nSales Invoice"
    args = {
        "doctype": "Sales Invoice",
        "fields": [{"field": "customer", "value": "Acme"}],
        "children": [
            {
                "field": "items",
                "rows": [
                    [
                        {"field": "item_code", "value": "WID"},
                        {"field": "qty", "value": 5},
                        {"field": "rate", "value": 89},
                    ],
                    [{"field": "item_code", "value": "SHP"}, {"field": "qty", "value": 1}],
                ],
            }
        ],
    }
    preview = tools.prepare(context, "create_document", args)
    children = preview["details"]["children"]
    assert children == [{"field": "items", "child_doctype": "Sales Invoice Item", "rows": 2}]
    assert fake.saved == []
    result = tools.execute(context, "create_document", args)
    doc = fake.rows[("Sales Invoice", result["name"])]
    assert len(doc["items"]) == 2
    first = doc["items"][0]
    assert first.item_code == "WID"
    assert first.qty == 5
    assert doc.get("docstatus", 0) == 0


@pytest.mark.parametrize(
    "children",
    [
        [{"field": "items", "rows": []}],
        [{"field": "items"}],
        [{"field": "customer", "rows": [[{"field": "x", "value": 1}]]}],
        [{"field": "items", "rows": [[{"field": "item_code", "value": "x"}]], "extra": 1}],
        [{"field": "items", "rows": [[{"field": "item_code", "value": "x"}]]}] * 11,
        [{"field": "items", "rows": [[{"field": "item_code", "value": "x"}]] * 51}],
    ],
)
def test_create_document_children_schema_is_closed_and_bounded(stack, children):
    tools, context, _, _, _ = stack
    with pytest.raises(ValueError):
        tools.execute(
            context,
            "create_document",
            {
                "doctype": "Sales Invoice",
                "fields": [{"field": "customer", "value": "Acme"}],
                "children": children,
            },
        )


def test_create_document_rejects_bad_child_tables_and_fields(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nSales Invoice\nCustomer"
    base = {"doctype": "Sales Invoice", "fields": [{"field": "customer", "value": "Acme"}]}
    # Sensitive child fields stay unwritable even inside an allowed table.
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {**base, "children": [{"field": "items", "rows": [[{"field": "secret_note", "value": "x"}]]}]},
        )
    # Unknown child field.
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {**base, "children": [{"field": "items", "rows": [[{"field": "nope", "value": "x"}]]}]},
        )
    # The same table field twice is a duplicate, not a merge.
    with pytest.raises(ValueError):
        tools.execute(
            context,
            "create_document",
            {
                **base,
                "children": [
                    {"field": "items", "rows": [[{"field": "item_code", "value": "x"}]]},
                    {"field": "items", "rows": [[{"field": "item_code", "value": "y"}]]},
                ],
            },
        )
    # A Table field on a non-table doctype never passes as a scalar either.
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "create_document",
            {"doctype": "Customer", "fields": [{"field": "items", "value": "x"}]},
        )
    assert fake.saved == []


def test_create_document_rejects_sensitive_and_table_fields(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nCustomer"
    for field in ("api_key", "password", "secret_token", "private_notes", "items", "nonexistent"):
        with pytest.raises(PermissionError):
            tools.execute(
                context,
                "create_document",
                {"doctype": "Customer", "fields": [{"field": field, "value": "x"}]},
            )
    assert fake.saved == []


def test_update_document_diff_preview_and_execute(stack):
    tools, context, fake, _, _ = stack
    args = dict(UPDATE_ARGS)
    preview = tools.prepare(context, "update_document", args)
    assert preview == tools.prepare(context, "update_document", args)
    assert preview["summary"] == "Update ToDo T-1."
    assert preview["operation"] == "update_document"
    assert preview["target"] == {"doctype": "ToDo", "name": "T-1"}
    changes = {change["field"]: change for change in preview["changes"]}
    assert changes["description"]["before"] == "Old"
    assert changes["description"]["after"] == "New"
    assert changes["priority"]["before"] == "Medium"
    assert changes["priority"]["after"] == "High"
    assert fake.rows[("ToDo", "T-1")].description == "Old"
    assert fake.saved == []
    result = tools.execute(context, "update_document", args)
    assert result["doctype"] == "ToDo"
    assert result["name"] == "T-1"
    assert result["updated_fields"] == ["description", "priority"]
    assert result["modified"] == "2026-09-16 12:01:00.000000"
    assert ("ToDo", "T-1") in fake.locks
    assert fake.rows[("ToDo", "T-1")].description == "New"


def test_update_document_rejects_stale_revision(stack):
    tools, context, fake, _, _ = stack
    args = dict(UPDATE_ARGS)
    tools.prepare(context, "update_document", args)
    fake.rows[("ToDo", "T-1")].modified = "2026-09-16 12:00:01.000000"
    with pytest.raises((RuntimeError, ValueError)):
        tools.execute(context, "update_document", args)
    assert fake.saved == []


def test_update_document_execute_rederives_permissions(stack):
    tools, context, fake, _, _ = stack
    args = dict(UPDATE_ARGS)
    tools.prepare(context, "update_document", args)
    fake.denied.add(("ToDo", "write"))
    with pytest.raises(PermissionError):
        tools.execute(context, "update_document", args)
    assert fake.saved == []


def test_update_document_rejects_sensitive_blocked_and_table_fields(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nCustomer"
    base = {"doctype": "Customer", "name": "C-1", "expected_modified": "2026-09-16 12:00:00.000000"}
    for field in ("api_key", "password", "secret_token", "private_notes", "items", "docstatus"):
        with pytest.raises(PermissionError):
            tools.execute(context, "update_document", {**base, "changes": [{"field": field, "value": "x"}]})
    fake.meta["Customer"].blocked_write.add("credit_limit")
    with pytest.raises(PermissionError):
        tools.execute(
            context, "update_document", {**base, "changes": [{"field": "credit_limit", "value": 5}]}
        )
    assert fake.saved == []


def test_update_document_rejects_duplicate_fields_and_bad_input(stack):
    tools, context, fake, _, _ = stack
    args = dict(UPDATE_ARGS)
    args["changes"] = [
        {"field": "status", "value": "Open"},
        {"field": "status", "value": "Closed"},
    ]
    with pytest.raises(ValueError):
        tools.execute(context, "update_document", args)
    with pytest.raises(ValueError):
        tools.execute(
            context,
            "update_document",
            {"doctype": "ToDo", "name": "T-1", "changes": [{"field": "status", "value": "Open"}]},
        )
    assert fake.saved == []


def test_update_document_rejects_never_allow_and_unlisted(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_read_doctypes += "\nGL Entry"
    fake.settings.allowed_write_doctypes += "\nGL Entry\nSales Invoice"
    base = {"expected_modified": "2026-09-16 12:00:00.000000"}
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "update_document",
            {**base, "doctype": "GL Entry", "name": "x", "changes": [{"field": "account", "value": "x"}]},
        )
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "update_document",
            {
                **base,
                "doctype": "Customer",
                "name": "C-1",
                "changes": [{"field": "customer_name", "value": "Beta"}],
            },
        )
    assert fake.saved == []


def test_update_document_allows_submittable_draft_but_never_submitted(stack):
    """Drafts of submittable DocTypes stay editable; submitted documents are frozen."""
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nSales Invoice"
    base = {"expected_modified": "2026-09-16 12:00:00.000000"}
    result = tools.execute(
        context,
        "update_document",
        {
            **base,
            "doctype": "Sales Invoice",
            "name": "SI-1",
            "changes": [{"field": "customer", "value": "Beta"}],
        },
    )
    assert result["updated_fields"] == ["customer"]
    assert fake.rows[("Sales Invoice", "SI-1")].customer == "Beta"
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "update_document",
            {
                **base,
                "doctype": "Sales Invoice",
                "name": "SI-2",
                "changes": [{"field": "customer", "value": "Beta"}],
            },
        )


def test_update_document_rechecks_company_scope(stack):
    tools, context, fake, _, _ = stack
    fake.settings.allowed_write_doctypes += "\nCustomer"
    fake.rows[("Customer", "C-1")].company = "Other"
    with pytest.raises(PermissionError):
        tools.execute(
            context,
            "update_document",
            {
                "doctype": "Customer",
                "name": "C-1",
                "expected_modified": "2026-09-16 12:00:00.000000",
                "changes": [{"field": "customer_name", "value": "Beta"}],
            },
        )
    assert fake.saved == []


def test_skills_returns_the_pinned_contract(stack):
    tools, context, fake, api, _ = stack
    result = api.skills()
    assert set(result) == {"tools", "scopes", "never_allow", "learned_skills"}
    assert isinstance(result["learned_skills"], list)
    registered = tools.get_tools(context)
    assembled = tools._assemble(context).tools
    by_name = {tool["name"]: tool for tool in result["tools"]}
    assert set(registered) <= set(by_name)
    assert set(by_name) == set(assembled)
    assert {name for name, tool in by_name.items() if tool["enabled"]} == set(registered)
    assert any(not tool["enabled"] for tool in result["tools"])
    for tool in result["tools"]:
        assert set(tool) == {"name", "description", "mutates", "external", "version", "enabled"}
        assert isinstance(tool["description"], str) and tool["description"]
        assert isinstance(tool["mutates"], bool)
        assert isinstance(tool["external"], bool)
        assert isinstance(tool["version"], int)
        assert isinstance(tool["enabled"], bool)
        spec = assembled[tool["name"]]
        assert tool["mutates"] == spec.mutates
        assert tool["external"] == spec.external
    adaptive = {tool["name"]: tool for tool in result["tools"]}
    assert adaptive["list_doctypes"]["mutates"] is False
    assert adaptive["describe_doctype"]["mutates"] is False
    assert adaptive["create_document"] == {
        "name": "create_document",
        "description": registered["create_document"].description,
        "mutates": True,
        "external": False,
        "version": 1,
        "enabled": True,
    }
    assert adaptive["update_document"]["mutates"] is True
    assert adaptive["update_document"]["external"] is False
    read_scope = result["scopes"]["read"]
    write_scope = result["scopes"]["write"]
    assert read_scope == sorted(
        {
            "Customer",
            "ToDo",
            "Event",
            "Company",
            "Sales Invoice",
            "User",
            "Password Store",
            "Intelligence Memory",
        }
    )
    assert write_scope == ["Event", "ToDo"]
    never = result["never_allow"]
    assert never == sorted(set(never))
    for name in ("GL Entry", "Workflow", "Journal Entry", "User", "DocType"):
        assert name in never
    assert not set(write_scope) & set(never)
    assert "synthetic-secret" not in json.dumps(result)


def test_skills_reflects_enabled_tools_policy(stack):
    tools, context, fake, api, _ = stack
    fake.settings.enabled_tools = "describe_doctype"
    result = api.skills()
    assert set(result) == {"tools", "scopes", "never_allow", "learned_skills"}
    names = [tool["name"] for tool in result["tools"]]
    assert len(names) > 1
    assert [tool["name"] for tool in result["tools"] if tool["enabled"]] == ["describe_doctype"]


def test_skills_requires_authentication(stack):
    _, _, fake, api, _ = stack
    fake.session.user = "Guest"
    with pytest.raises(PermissionError):
        api.skills()


def test_settings_write_scope_must_be_a_subset_of_read_scope(stack):
    _, _, _, _, documents = stack
    _settings(documents).validate()
    _settings(documents, allowed_write_doctypes="ToDo\nCustomer").validate()
    _settings(documents, allowed_write_doctypes="").validate()
    with pytest.raises(ValueError):
        _settings(documents, allowed_write_doctypes="ToDo\nLead").validate()


def test_settings_write_scope_cannot_include_never_allow(stack):
    _, _, _, _, documents = stack
    for doctype in ("GL Entry", "Workflow", "User", "Intelligence Memory", "Password Store"):
        with pytest.raises(ValueError):
            _settings(
                documents,
                allowed_read_doctypes=f"Customer\nToDo\n{doctype}",
                allowed_write_doctypes=doctype,
            ).validate()


def test_settings_validation_requires_an_intelligence_manager(stack):
    _, _, fake, _, documents = stack
    fake.get_roles = lambda user=None: ["Intelligence User"]
    with pytest.raises(PermissionError):
        _settings(documents).validate()
    fake.get_roles = lambda user=None: ["Intelligence Manager"]
    _settings(documents).validate()
