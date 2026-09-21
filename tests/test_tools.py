"""Offline contract/security tests; no live Frappe records or provider calls."""

import copy
import importlib
import json
import re
import sys
import types
from pathlib import Path

import pytest


class Row(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__


class Meta:
    def __init__(self, name, fields):
        self.name = name
        self.fields = [
            Row(fieldname=k, label=k.title(), fieldtype=v, permlevel=0, read_only=0, hidden=0, is_virtual=0)
            for k, v in fields.items()
        ]
        self.istable = self.issingle = self.is_virtual = False
        self.title_field = next(iter(fields), None)
        self.blocked_read = set()
        self.blocked_write = set()

    def get_field(self, key):
        return next((f for f in self.fields if f.fieldname == key), None)

    def get_permitted_fieldnames(self, *, user=None, permission_type="read", **kwargs):
        blocked = self.blocked_write if permission_type == "write" else self.blocked_read
        return [f.fieldname for f in self.fields if f.fieldname not in blocked]

    def has_field(self, key):
        return self.get_field(key) is not None


class Document(Row):
    def check_permission(self, permtype="read"):
        if not self._fake.has_permission(self.doctype, permtype, doc=self):
            raise PermissionError("Denied")

    def set(self, key, value):
        self[key] = value

    def save(self, **kwargs):
        assert not kwargs, "Normal Document save must not bypass permissions"
        self.check_permission("write")
        self._fake.saved.append((self.doctype, self.name))
        self.modified = "2026-09-16 12:01:00.000000"
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def insert(self, **kwargs):
        assert not kwargs, "Normal Document insert must not bypass permissions"
        self.check_permission("create")
        self.name = "new-todo"
        self.owner = self._fake.session.user
        self.modified = "2026-09-16 12:01:00.000000"
        self._fake.saved.append((self.doctype, self.name))
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def get_full_path(self):
        return self.file_path

    def is_permitted(self):
        return not self.get("report_denied")


class FakeFrappe(types.ModuleType):
    def __init__(self, tmp_path):
        super().__init__("frappe")
        self.session = Row(user="alice")
        self.local = Row(site="site.test")
        self.flags = Row()
        self.rows = {}
        self.meta = {}
        self.saved = []
        self.locks = []
        self.queries = []
        self.denied = set()
        self.hooks = {}
        self.user_permissions = {}
        self.permissions = Row(get_user_permissions=lambda user: self.user_permissions)
        self.installed = ["frappe", "erpnext"]
        self.root = tmp_path
        self.settings = Row(
            enabled=1,
            allowed_read_doctypes="Customer\nToDo\nEvent\nCompany\nCommunication\nWiki Page",
            enabled_tools="search_records\nread_document\nrun_report\nread_attachment\nupdate_event\nupdate_todo\ncreate_todo\nrecall_memory\nsave_memory\nedit_wiki_page",
            allowed_reports="Trial Balance\nGeneral Ledger\nAccounts Receivable\nBalance Sheet",
            max_upload_mb=10,
            max_file_chars=30000,
        )
        self.PermissionError = PermissionError
        self.ValidationError = ValueError
        self.TimestampMismatchError = RuntimeError
        self.DoesNotExistError = LookupError
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
        )
        self.meta["Customer"].get_field("company").options = "Company"
        self.meta["Customer"].blocked_read.add("private_notes")
        self.add_meta("Company", {"company_name": "Data"})
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
        )
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
        )
        self.add_meta("Communication", {"subject": "Data", "content": "Text Editor", "sender": "Data"})
        self.add_meta("Wiki Page", {"title": "Data", "content": "Text Editor", "published": "Check"})
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
            api_key="secret",
            password="secret",
            secret_token="secret",
            private_notes="classified",
        )
        self.seed("ToDo", "T-1", description="Old", status="Open", priority="Medium", allocated_to="alice")
        self.seed("Event", "E-1", subject="Meeting", description="Old", status="Open")
        self.seed(
            "Report",
            "Trial Balance",
            report_type="Script Report",
            is_standard="Yes",
            ref_doctype="GL Entry",
            module="Accounts",
        )

    def add_meta(self, doctype, fields):
        self.meta[doctype] = Meta(doctype, fields)

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

    def get_value(self, doctype, name, field="name", **kwargs):
        doc = self.rows.get((doctype, name))
        return doc.get(field) if doc else None

    def exists(self, doctype, name):
        if isinstance(name, dict):
            for row in self.rows.values():
                if row.doctype == doctype and all(row.get(key) == value for key, value in name.items()):
                    return row.name
            return None
        return name in self.meta if doctype == "DocType" else (doctype, name) in self.rows

    def get_meta(self, doctype):
        return self.meta[doctype]

    def get_single(self, doctype):
        return self.settings

    def get_roles(self, user=None):
        return ["Intelligence User"] if (user or self.session.user) == "alice" else ["System Manager"]

    def has_permission(self, doctype, ptype="read", doc=None, user=None, **kwargs):
        return (doctype, ptype) not in self.denied and not (doc and doc.get("denied"))

    def get_list(self, doctype, filters=None, fields=None, **kwargs):
        self.queries.append((doctype, copy.deepcopy(filters), fields, kwargs))
        output = []
        for (dt, _), row in self.rows.items():
            if dt != doctype or not self.has_permission(dt, "read", doc=row):
                continue
            matched = True
            for key, op, value in filters or []:
                actual = row.get(key)
                if op == "=" and actual != value:
                    matched = False
                if op == "in" and actual not in value:
                    matched = False
                if op == "like":
                    # Real SQL LIKE: % and _ are wildcards; without them the
                    # match is exact. Mirroring that here keeps filter tests
                    # honest about what a real site would return.
                    pattern = "^" + re.escape(str(value)).replace("%", ".*").replace("_", ".") + "$"
                    if not re.match(pattern, str(actual or ""), re.S):
                        matched = False
            if matched:
                output.append(Row({key: row.get(key) for key in fields}))
        return output[: kwargs.get("limit_page_length", 20)]

    def get_hooks(self, key, default=None):
        return self.hooks.get(key, default or [])

    def get_attr(self, path):
        return self.attrs[path]

    def get_installed_apps(self):
        return self.installed

    def get_site_path(self, *parts):
        return str(self.root.joinpath(*parts))

    @staticmethod
    def throw(message, exc=ValueError):
        raise exc(message)


@pytest.fixture
def tools(monkeypatch, tmp_path):
    fake = FakeFrappe(tmp_path)
    monkeypatch.setitem(sys.modules, "frappe", fake)
    old = {
        k: v
        for k, v in sys.modules.items()
        if k == "frappe_intelligence.access" or k.startswith("frappe_intelligence.tools")
    }
    for key in old:
        del sys.modules[key]
    module = importlib.import_module("frappe_intelligence.tools")
    context = module.ToolContext("site.test", "alice", "conversation", "run")
    yield module, context, fake
    for key in list(sys.modules):
        if key == "frappe_intelligence.access" or key.startswith("frappe_intelligence.tools"):
            del sys.modules[key]
    sys.modules.update(old)


def test_tools_package_exists():
    assert Path(__file__).parents[1].joinpath("frappe_intelligence/tools/__init__.py").exists()


def test_registry_schema_names_and_policy(tools):
    m, c, f = tools
    names = set(m.get_tools(c))
    assert {
        "search_records",
        "read_document",
        "run_report",
        "read_attachment",
        "update_event",
        "update_todo",
        "create_todo",
        "recall_memory",
        "save_memory",
    } <= names
    assert "send_email" not in names
    assert "edit_wiki_page" not in names
    assert all(x["type"] == "function" for x in m.schemas(c))
    f.settings.enabled_tools = "read_document\nunknown"
    assert set(m.get_tools(c)) == {"read_document"}
    f.settings.enabled_tools = ""
    assert m.get_tools(c) == {}


@pytest.mark.parametrize("change", ["user", "site", "owner", "disabled", "guest"])
def test_registry_rejects_wrong_execution_identity(tools, change):
    m, c, f = tools
    if change == "user":
        f.session.user = "bob"
    elif change == "site":
        f.local.site = "elsewhere"
    elif change == "owner":
        f.rows[("Intelligence Conversation", "conversation")].owner = "bob"
    elif change == "disabled":
        f.settings.enabled = 0
    else:
        f.session.user = "Guest"
    with pytest.raises(PermissionError):
        m.get_tools(c)


@pytest.mark.parametrize(
    "args",
    [
        {"doctype": "Customer", "name": "C-1", "extra": True},
        {"doctype": "Customer"},
        {"doctype": "Customer", "name": 1},
        {"doctype": "Customer", "name": "C-1", "fields": ["name"] * 60},
    ],
)
def test_input_schema_rejects_unknown_missing_wrong_or_oversized_fields(tools, args):
    m, c, _ = tools
    with pytest.raises(ValueError):
        m.prepare(c, "read_document", args)


def test_unknown_tools_fail_closed(tools):
    m, c, _ = tools
    with pytest.raises(PermissionError):
        m.execute(c, "frappe.delete_doc", {})


def test_unknown_tool_error_names_available_tools(tools):
    m, c, _ = tools
    with pytest.raises(PermissionError) as excinfo:
        m.execute(c, "list_todos", {})
    message = str(excinfo.value)
    assert "Unknown tool" in message
    assert "search_records" in message


def test_reads_only_return_approved_content_and_never_secrets(tools):
    m, c, f = tools
    args = {"doctype": "Customer", "name": "C-1"}
    preview = m.prepare(c, "read_document", args)
    assert "Acme" not in json.dumps(preview)
    result = m.execute(c, "read_document", args)
    assert result["document"]["customer_name"] == "Acme"
    for key in ("api_key", "password", "secret_token", "private_notes", "items"):
        assert key not in result["document"]
    assert f.saved == []


@pytest.mark.parametrize(
    "field",
    ["password", "api_key", "secret_token", "private_notes", "items", "*", "count(name)", "Customer.name"],
)
def test_explicit_sensitive_or_unpermitted_fields_fail_closed(tools, field):
    m, c, _ = tools
    with pytest.raises((PermissionError, ValueError)):
        m.execute(c, "read_document", {"doctype": "Customer", "name": "C-1", "fields": [field]})


def test_reads_recheck_document_and_company_permissions(tools):
    m, c, f = tools
    args = {"doctype": "Customer", "name": "C-1"}
    m.prepare(c, "read_document", args)
    f.rows[("Customer", "C-1")].denied = True
    with pytest.raises(PermissionError):
        m.execute(c, "read_document", args)
    f.rows[("Customer", "C-1")].denied = False
    f.rows[("Customer", "C-1")].company = "Other"
    with pytest.raises(PermissionError):
        m.execute(c, "read_document", args)


def test_doctype_allowlist_and_child_internal_types(tools):
    m, c, f = tools
    for dt in ("User", "File", "Intelligence Memory", "DocType", "Email Account"):
        f.settings.allowed_read_doctypes += "\n" + dt
        with pytest.raises(PermissionError):
            m.execute(c, "read_document", {"doctype": dt, "name": "x"})
    f.meta["Customer"].istable = True
    with pytest.raises(PermissionError):
        m.execute(c, "read_document", {"doctype": "Customer", "name": "C-1"})


def test_search_uses_permission_query_and_no_content_in_preview(tools):
    m, c, f = tools
    args = {
        "doctype": "Customer",
        "fields": ["customer_name"],
        "filters": [{"field": "customer_name", "operator": "=", "value": "Acme"}],
        "limit": 5,
    }
    assert "records" not in m.prepare(c, "search_records", args)
    result = m.execute(c, "search_records", args)
    assert result["records"][0]["customer_name"] == "Acme"
    query = f.queries[-1]
    assert query[0] == "Customer"
    assert query[3]["limit_page_length"] == 5
    assert not query[3].get("ignore_permissions")
    assert query[1] == [["customer_name", "=", "Acme"]]


def test_search_cannot_filter_sensitive_fields_or_join(tools):
    m, c, _ = tools
    for field in ("password", "private_notes", "Customer.name", "api_key"):
        with pytest.raises((PermissionError, ValueError)):
            m.execute(
                c,
                "search_records",
                {"doctype": "Customer", "filters": [{"field": field, "operator": "=", "value": "x"}]},
            )


def test_search_like_filter_matches_substrings(tools):
    m, c, f = tools
    f.seed("Customer", "C-NW", customer_name="Northwind Components")
    args = {
        "doctype": "Customer",
        "fields": ["customer_name"],
        "filters": [{"field": "customer_name", "operator": "like", "value": "Northwind"}],
    }
    # Models (and Desk list filters) mean substring search by "like"; SQL LIKE
    # without % wildcards matches only the exact string, so the tool wraps.
    result = m.execute(c, "search_records", args)
    assert [row["customer_name"] for row in result["records"]] == ["Northwind Components"]
    assert f.queries[-1][1] == [["customer_name", "like", "%Northwind%"]]


def test_search_like_filter_respects_explicit_wildcards(tools):
    m, c, f = tools
    f.seed("Customer", "C-NW", customer_name="Northwind Components")
    args = {
        "doctype": "Customer",
        "fields": ["customer_name"],
        "filters": [{"field": "customer_name", "operator": "like", "value": "North%"}],
    }
    result = m.execute(c, "search_records", args)
    assert [row["customer_name"] for row in result["records"]] == ["Northwind Components"]
    assert f.queries[-1][1] == [["customer_name", "like", "North%"]]


def test_versioned_write_preview_is_deterministic_and_does_not_mutate(tools):
    m, c, f = tools
    args = {
        "name": "T-1",
        "expected_modified": "2026-09-16 12:00:00.000000",
        "changes": {"description": "New", "priority": "High"},
    }
    preview = m.prepare(c, "update_todo", args)
    assert preview == m.prepare(c, "update_todo", args)
    assert any(x["before"] == "Old" and x["after"] == "New" for x in preview["changes"])
    assert f.rows[("ToDo", "T-1")].description == "Old"
    assert f.saved == []
    result = m.execute(c, "update_todo", args)
    assert result["name"] == "T-1"
    assert ("ToDo", "T-1") in f.locks
    assert f.rows[("ToDo", "T-1")].description == "New"


def test_write_rejects_stale_revision_and_permission_revocation(tools):
    m, c, f = tools
    args = {"name": "T-1", "expected_modified": "2026-09-16 12:00:00.000000", "changes": {"status": "Closed"}}
    m.prepare(c, "update_todo", args)
    f.rows[("ToDo", "T-1")].modified = "2026-09-16 12:00:01.000000"
    with pytest.raises((RuntimeError, ValueError)):
        m.execute(c, "update_todo", args)
    f.rows[("ToDo", "T-1")].modified = args["expected_modified"]
    f.denied.add(("ToDo", "write"))
    with pytest.raises(PermissionError):
        m.execute(c, "update_todo", args)
    assert f.saved == []


def test_write_field_permissions_and_fixed_change_allowlist(tools):
    m, c, f = tools
    args = {
        "name": "T-1",
        "expected_modified": "2026-09-16 12:00:00.000000",
        "changes": {"description": "New"},
    }
    f.meta["ToDo"].blocked_write.add("description")
    with pytest.raises(PermissionError):
        m.prepare(c, "update_todo", args)
    args["changes"] = {"allocated_to": "bob"}
    with pytest.raises(ValueError):
        m.prepare(c, "update_todo", args)
    args["changes"] = {"docstatus": 1}
    with pytest.raises(ValueError):
        m.execute(c, "update_todo", args)


def test_event_sync_and_linked_todo_side_effects_fail_closed(tools):
    m, c, f = tools
    f.rows[("Event", "E-1")].sync_with_google_calendar = 1
    with pytest.raises(PermissionError):
        m.execute(
            c,
            "update_event",
            {"name": "E-1", "expected_modified": "2026-09-16 12:00:00.000000", "changes": {"subject": "New"}},
        )
    f.rows[("ToDo", "T-1")].reference_type = "Sales Invoice"
    f.rows[("ToDo", "T-1")].reference_name = "INV-1"
    with pytest.raises(PermissionError):
        m.execute(
            c,
            "update_todo",
            {
                "name": "T-1",
                "expected_modified": "2026-09-16 12:00:00.000000",
                "changes": {"status": "Closed"},
            },
        )


def test_create_todo_is_self_owned_without_generic_link_or_assignment(tools):
    m, c, f = tools
    args = {"description": "Follow up", "priority": "High"}
    m.prepare(c, "create_todo", args)
    assert f.saved == []
    result = m.execute(c, "create_todo", args)
    saved = f.rows[("ToDo", result["name"])]
    assert saved.allocated_to == "alice"
    assert saved.assigned_by == "alice"
    assert saved.status == "Open"
    with pytest.raises(ValueError):
        m.execute(c, "create_todo", {**args, "allocated_to": "bob"})


def test_report_allowlist_and_company_permissions_precede_native_execution(tools, monkeypatch):
    m, c, f = tools
    calls = []
    report = types.ModuleType("frappe.desk.query_report")
    report.run = lambda **kw: (
        calls.append(kw)
        or {
            "columns": [{"fieldname": "account", "label": "Account", "fieldtype": "Data"}],
            "result": [{"account": "Cash", "hidden": "secret"}],
            "chart": {"secret": "secret"},
        }
    )
    monkeypatch.setitem(sys.modules, "frappe.desk.query_report", report)
    args = {
        "report_name": "Trial Balance",
        "filters": {
            "company": "Allowed",
            "fiscal_year": "2026",
            "from_date": "2026-01-01",
            "to_date": "2026-09-16",
        },
    }
    f.seed("Fiscal Year", "2026")
    m.prepare(c, "run_report", args)
    assert calls == []
    result = m.execute(c, "run_report", args)
    assert result["rows"] == [{"account": "Cash"}]
    assert "secret" not in json.dumps(result)
    assert calls[0]["ignore_prepared_report"] is True
    assert calls[0]["are_default_filters"] is False
    assert calls[0]["filters"]["company"] == "Allowed"
    for changed in (
        {"company": "Other"},
        {"company": ["Allowed", "Other"]},
        {"company": "Allowed", "prepared_report_name": "p"},
    ):
        with pytest.raises((PermissionError, ValueError)):
            m.execute(c, "run_report", {**args, "filters": {**args["filters"], **changed}})
    assert len(calls) == 1


def test_report_permissions_custom_reports_and_unknown_reports_fail_closed(tools):
    m, c, f = tools
    args = {
        "report_name": "Trial Balance",
        "filters": {
            "company": "Allowed",
            "fiscal_year": "2026",
            "from_date": "2026-01-01",
            "to_date": "2026-09-16",
        },
    }
    f.seed("Fiscal Year", "2026")
    f.rows[("Report", "Trial Balance")].report_denied = True
    with pytest.raises(PermissionError):
        m.prepare(c, "run_report", args)
    f.rows[("Report", "Trial Balance")].report_denied = False
    f.rows[("Report", "Trial Balance")].report_type = "Custom Report"
    with pytest.raises(PermissionError):
        m.prepare(c, "run_report", args)
    f.settings.allowed_reports += "\nExecute Anything"
    with pytest.raises((PermissionError, ValueError)):
        m.execute(c, "run_report", {**args, "report_name": "Execute Anything"})


@pytest.mark.parametrize("filename", ["note.txt", "note.json"])
def test_attachment_is_conversation_private_bounded_and_only_read_after_approval(tools, filename):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    path = folder / filename
    path.write_text("approved private text", encoding="utf-8")
    doc = f.seed(
        "File",
        "F-1",
        file_name=filename,
        file_path=str(path),
        file_url=f"/private/files/{filename}",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=21,
        content_hash="abc",
    )
    preview = m.prepare(c, "read_attachment", {"file": "F-1"})
    assert "approved private text" not in json.dumps(preview)
    result = m.execute(c, "read_attachment", {"file": "F-1"})
    assert result["content"] == "approved private text"
    doc.attached_to_name = "other-conversation"
    with pytest.raises(PermissionError):
        m.execute(c, "read_attachment", {"file": "F-1"})
    doc.attached_to_name = "conversation"
    doc.is_private = 0
    with pytest.raises(PermissionError):
        m.execute(c, "read_attachment", {"file": "F-1"})


def test_json_attachment_is_bounded_plain_text_without_evaluation(tools):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    path = folder / "data.json"
    content = '{"code": "__import__(\\"os\\").system(\\"never-run\\")"}'
    path.write_text(content, encoding="utf-8")
    f.seed(
        "File",
        "JSON-1",
        file_name="data.json",
        file_path=str(path),
        file_url="/private/files/data.json",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=len(content),
    )
    assert m.execute(c, "read_attachment", {"file": "JSON-1"})["content"] == content
    f.settings.max_file_chars = 8
    result = m.execute(c, "read_attachment", {"file": "JSON-1"})
    assert result["content"] == content[:8]
    assert result["truncated"] is True
    path.write_bytes(b"binary\x00content")
    with pytest.raises(ValueError, match="binary"):
        m.execute(c, "read_attachment", {"file": "JSON-1"})
    path.write_bytes(b"\xff\xfe")
    with pytest.raises(ValueError, match="UTF-8"):
        m.execute(c, "read_attachment", {"file": "JSON-1"})


@pytest.mark.parametrize(
    "configured,expected_mb", [(None, 10), (0, 10), (-1, 1), (1, 1), (10, 10), (20, 20), (40, 20)]
)
def test_shared_upload_limit_matches_reader(configured, expected_mb):
    assert importlib.util.find_spec("frappe_intelligence.limits") is not None
    from frappe_intelligence.limits import MAX_UPLOAD_BYTES, upload_limit_bytes
    from frappe_intelligence.tools.attachments import _limits

    settings = {"max_upload_mb": configured}
    assert MAX_UPLOAD_BYTES == 20 * 1024 * 1024
    assert upload_limit_bytes(settings) == expected_mb * 1024 * 1024
    assert _limits(settings)[0] == upload_limit_bytes(settings)


@pytest.mark.parametrize("configured,allowed", [(10, False), (20, True)])
def test_eleven_mb_attachment_prepare_and_execute_share_configured_limit(tools, configured, allowed):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    path = folder / "large.txt"
    size = 11 * 1024 * 1024
    path.write_bytes(b"a" * size)
    f.settings.max_upload_mb = configured
    f.seed(
        "File",
        "LARGE",
        file_name="large.txt",
        file_path=str(path),
        file_url="/private/files/large.txt",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=size,
    )
    args = {"file": "LARGE"}
    if not allowed:
        with pytest.raises(ValueError, match="file size"):
            m.prepare(c, "read_attachment", args)
        with pytest.raises(ValueError, match="file size"):
            m.execute(c, "read_attachment", args)
    else:
        from frappe_intelligence.limits import upload_limit_bytes

        preview = m.prepare(c, "read_attachment", args)
        assert preview["details"]["max_bytes"] == upload_limit_bytes(f.settings)
        result = m.execute(c, "read_attachment", args)
        assert len(result["content"]) == 30000
        assert result["truncated"] is True


def test_attachment_rejects_over_twenty_mb_in_metadata_and_actual_file(tools):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    path = folder / "oversize.txt"
    size = 20 * 1024 * 1024 + 1
    with path.open("wb") as stream:
        stream.truncate(size)
    f.settings.max_upload_mb = 40
    doc = f.seed(
        "File",
        "LARGE",
        file_name="oversize.txt",
        file_path=str(path),
        file_url="/private/files/oversize.txt",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=size,
    )
    with pytest.raises(ValueError, match="file size"):
        m.prepare(c, "read_attachment", {"file": "LARGE"})
    with pytest.raises(ValueError, match="file size"):
        m.execute(c, "read_attachment", {"file": "LARGE"})
    doc.file_size = 1
    with pytest.raises(ValueError, match="file size"):
        m.execute(c, "read_attachment", {"file": "LARGE"})


def test_attachment_rejects_remote_path_symlink_size_and_non_text(tools):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    external = f.root / "secret.txt"
    external.write_text("not an attachment")
    path = folder / "note.txt"
    path.symlink_to(external)
    doc = f.seed(
        "File",
        "F-1",
        file_name="note.txt",
        file_path=str(path),
        file_url="/private/files/note.txt",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=17,
    )
    with pytest.raises((PermissionError, ValueError)):
        m.execute(c, "read_attachment", {"file": "F-1"})
    doc.file_url = "https://example.com/note.txt"
    with pytest.raises((PermissionError, ValueError)):
        m.prepare(c, "read_attachment", {"file": "F-1"})
    doc.file_url = "/private/files/note.txt"
    doc.file_size = 11 * 1024 * 1024
    with pytest.raises(ValueError):
        m.execute(c, "read_attachment", {"file": "F-1"})


def test_memory_service_only_called_after_approval_and_scope_is_bound(tools, monkeypatch):
    m, c, f = tools
    service = types.ModuleType("frappe_intelligence.memory")
    calls = []
    service.list_memories = lambda **kw: (
        calls.append(("read", kw)) or [{"name": "M-1", "content": "remembered", "scope": "personal"}]
    )
    service.save_memory = lambda **kw: calls.append(("save", kw)) or {"name": "M-2", **kw}
    monkeypatch.setitem(sys.modules, "frappe_intelligence.memory", service)
    m.prepare(c, "recall_memory", {"scope": "personal"})
    assert calls == []
    assert m.execute(c, "recall_memory", {"scope": "personal"})["memories"][0]["content"] == "remembered"
    m.prepare(c, "save_memory", {"scope": "conversation", "content": "Keep"})
    assert len(calls) == 1
    m.execute(c, "save_memory", {"scope": "conversation", "content": "Keep"})
    assert calls[-1][1]["conversation"] == c.conversation
    with pytest.raises(PermissionError):
        m.prepare(c, "save_memory", {"scope": "site", "content": "Keep"})
    with pytest.raises(ValueError):
        m.execute(c, "recall_memory", {"scope": "conversation", "conversation": "other"})


def test_optional_wiki_edits_content_only_on_installed_modern_wiki(tools):
    m, c, f = tools
    f.installed.append("wiki")
    f.settings.allowed_read_doctypes += "\nWiki Document"
    f.add_meta("Wiki Document", {"content": "Code", "title": "Data"})
    f.seed("Wiki Document", "W-1", title="Page", content="Old", is_group=0)
    assert "edit_wiki_page" in m.get_tools(c)
    args = {"name": "W-1", "expected_modified": "2026-09-16 12:00:00.000000", "changes": {"content": "New"}}
    m.prepare(c, "edit_wiki_page", args)
    assert f.saved == []
    m.execute(c, "edit_wiki_page", args)
    assert f.rows[("Wiki Document", "W-1")].content == "New"
    with pytest.raises(ValueError):
        m.execute(c, "edit_wiki_page", {**args, "changes": {"is_published": 1}})


def test_report_execute_denies_before_loading_native_executor(tools):
    m, c, f = tools
    f.rows[("Report", "Trial Balance")].report_denied = True
    with pytest.raises(PermissionError):
        m.execute(c, "run_report", {"report_name": "Trial Balance", "filters": {"company": "Allowed"}})


def test_memory_preview_matches_service_limit_and_normalization(tools):
    m, c, _ = tools
    with pytest.raises(ValueError):
        m.prepare(c, "save_memory", {"scope": "personal", "content": "x" * 5001})
    preview = m.prepare(c, "save_memory", {"scope": "personal", "content": "  Keep this  "})
    assert preview["changes"][0]["after"] == "Keep this"


def test_reports_deny_non_company_user_permissions_and_disallowed_company_scope(tools):
    m, c, f = tools
    args = {
        "report_name": "Trial Balance",
        "filters": {
            "company": "Allowed",
            "fiscal_year": "2026",
            "from_date": "2026-01-01",
            "to_date": "2026-09-16",
        },
    }
    f.user_permissions = {"Account": [{"doc": "Cash"}]}
    with pytest.raises(PermissionError):
        m.prepare(c, "run_report", args)
    f.user_permissions = {"Company": [{"doc": "Different"}]}
    with pytest.raises(PermissionError):
        m.prepare(c, "run_report", args)


def test_attachment_marks_truncation_and_preview_never_opens_bytes(tools, monkeypatch):
    m, c, f = tools
    folder = f.root / "private/files"
    folder.mkdir(parents=True)
    path = folder / "note.txt"
    path.write_text("abcdefghij")
    f.seed(
        "File",
        "F-1",
        file_name="note.txt",
        file_path=str(path),
        file_url="/private/files/note.txt",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_size=10,
    )
    f.settings.max_file_chars = 5
    attachments = importlib.import_module("frappe_intelligence.tools.attachments")
    original = attachments._read_local
    monkeypatch.setattr(
        attachments, "_read_local", lambda *args: pytest.fail("Preview must not load content")
    )
    m.prepare(c, "read_attachment", {"file": "F-1"})
    monkeypatch.setattr(attachments, "_read_local", original)
    result = m.execute(c, "read_attachment", {"file": "F-1"})
    assert result["content"] == "abcde"
    assert result["truncated"] is True


def test_search_skips_records_outside_company_permission(tools):
    m, c, f = tools
    f.rows[("Customer", "C-1")].company = "Other"
    assert m.execute(c, "search_records", {"doctype": "Customer"})["records"] == []


def test_mutations_need_expected_modified_and_never_allow_submission(tools):
    m, c, f = tools
    with pytest.raises(ValueError):
        m.execute(c, "update_event", {"name": "E-1", "changes": {"subject": "x"}})
    f.rows[("ToDo", "T-1")].docstatus = 1
    with pytest.raises(PermissionError):
        m.execute(
            c,
            "update_todo",
            {
                "name": "T-1",
                "expected_modified": "2026-09-16 12:00:00.000000",
                "changes": {"status": "Closed"},
            },
        )


def test_tools_do_not_commit_execute_sql_or_bypass_permissions():
    import ast

    folder = Path(__file__).parents[1] / "frappe_intelligence/tools"
    for path in folder.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                assert not (
                    isinstance(node.func, ast.Attribute) and node.func.attr in {"commit", "sql", "db_set"}
                ), path
                assert not any(
                    kw.arg in {"ignore_permissions", "ignore_mandatory", "ignore_links"}
                    for kw in node.keywords
                ), path


def test_extension_registration_requires_explicit_review_and_no_collision(tools):
    m, c, f = tools
    params = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    spec = m.ToolSpec(
        "reviewed_example", "Example", params, lambda c, a: {"ok": True}, lambda c, a: {"summary": "Example"}
    )

    def register(registry):
        registry.register(spec, reviewed=True, transaction_safe=True, roles=("Intelligence User",))

    f.attrs = {"example.tools.register": register}
    f.hooks["intelligence_tools"] = ["example.tools.register"]
    f.installed.append("example")
    f.settings.enabled_tools += "\nreviewed_example"
    assert m.execute(c, "reviewed_example", {}) == {"ok": True}
    f.attrs["example.tools.register"] = lambda r: r.register(spec)
    with pytest.raises((PermissionError, ValueError)):
        m.get_tools(c)
    f.attrs["example.tools.register"] = lambda r: r.register(
        m.ToolSpec("read_document", "Collision", params, spec.execute, spec.preview),
        reviewed=True,
        transaction_safe=True,
    )
    with pytest.raises((PermissionError, ValueError)):
        m.get_tools(c)
