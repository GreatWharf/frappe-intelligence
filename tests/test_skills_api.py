"""api.skills() learned_skills contract: visibility, exact shape and ordering.

The endpoint feeds the skill editor, so it returns every Intelligence Skill
record visible to the caller (own or shared, enabled or not) with full
instructions, exact keys and a stable title ordering. No owner identity or
secret material is exposed.
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
        blocked = self.blocked_write if permission_type in ("write", "create") else self.blocked_read
        return [f.fieldname for f in self.fields if f.fieldname not in blocked]


class Document(Row):
    def check_permission(self, permtype="read"):
        if not self._fake.has_permission(self.doctype, permtype, doc=self):
            raise PermissionError("Denied")

    def set(self, key, value):
        self[key] = value

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
            allowed_read_doctypes="Customer\nToDo\nEvent\nCompany",
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
        self.add_meta("Customer", {"customer_name": "Data"}, module="Selling")
        self.add_meta("Company", {"company_name": "Data"}, module="Setup")
        self.add_meta("ToDo", {"description": "Text Editor", "status": "Select"}, module="Desk")
        self.add_meta("Event", {"subject": "Data"}, module="Desk")
        self.seed("User", "alice", enabled=1, user_type="System User")
        self.seed("Intelligence Conversation", "conversation", owner="alice")

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

    def skill(self, name, **values):
        defaults = dict(
            owner="alice",
            shared=0,
            enabled=1,
            title=name,
            description="",
            instructions="",
            origin="Learned",
            version=1,
        )
        defaults.update(values)
        return self.seed("Intelligence Skill", name, **defaults)

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
        "frappe_intelligence.frappe_intelligence.doctype.intelligence_skill.intelligence_skill",
    )
    old = {}
    for key in list(sys.modules):
        if key in owned or key.startswith("frappe_intelligence.tools"):
            old[key] = sys.modules.pop(key)
    importlib.import_module("frappe_intelligence.tools")
    api = importlib.import_module("frappe_intelligence.api")
    engine = importlib.import_module("frappe_intelligence.engine")
    monkeypatch.setattr(engine, "frappe", fake)
    yield fake, api
    for key in list(sys.modules):
        if key in owned or key.startswith("frappe_intelligence.tools"):
            del sys.modules[key]
    sys.modules.update(old)


def test_learned_skills_top_level_contract(stack):
    fake, api = stack
    result = api.skills()
    assert set(result) == {"tools", "scopes", "never_allow", "learned_skills"}
    assert isinstance(result["learned_skills"], list)
    assert "synthetic-secret" not in json.dumps(result)


def test_learned_skills_visibility_covers_own_and_shared_records(stack):
    fake, api = stack
    fake.skill("SKILL-OWN", title="Own draft")
    fake.skill("SKILL-SHARED", owner="bob", shared=1, title="Team skill")
    fake.skill("SKILL-DISABLED", enabled=0, title="Disabled draft")
    fake.skill("SKILL-FOREIGN", owner="bob", title="Bob's private skill")
    learned = api.skills()["learned_skills"]
    names = {entry["name"] for entry in learned}
    assert names == {"SKILL-OWN", "SKILL-SHARED", "SKILL-DISABLED"}
    for entry in learned:
        assert set(entry) == {
            "name",
            "title",
            "description",
            "instructions",
            "origin",
            "enabled",
            "shared",
            "version",
            "can_edit",
            "scope_read",
            "scope_write",
        }
        assert isinstance(entry["enabled"], int)
        assert isinstance(entry["shared"], int)
        assert isinstance(entry["version"], int)
        assert entry["can_edit"] in (0, 1)
        assert isinstance(entry["scope_read"], str)
        assert isinstance(entry["scope_write"], str)
    by_name = {entry["name"]: entry for entry in learned}
    assert by_name["SKILL-DISABLED"]["enabled"] == 0
    assert by_name["SKILL-SHARED"]["shared"] == 1
    # Owner identity stays server-side.
    assert "owner" not in json.dumps(learned)
    assert "bob" not in json.dumps(learned)


def test_learned_skills_are_sorted_by_title_with_full_instructions(stack):
    fake, api = stack
    long_instructions = "Step one.\n" + ("Detail line.\n" * 800)
    fake.skill("SKILL-Z", title="Zulu", instructions=long_instructions, version=3, origin="Seeded")
    fake.skill("SKILL-A", title="Alpha", description="First")
    fake.skill("SKILL-M", title="Mike")
    learned = api.skills()["learned_skills"]
    assert [entry["title"] for entry in learned] == ["Alpha", "Mike", "Zulu"]
    zulu = learned[-1]
    assert zulu["instructions"] == long_instructions
    assert zulu["version"] == 3
    assert zulu["origin"] == "Seeded"
    alpha = learned[0]
    assert alpha["description"] == "First"
    assert alpha["enabled"] == 1
    assert alpha["shared"] == 0


def test_learned_skills_requires_authentication(stack):
    fake, api = stack
    fake.session.user = "Guest"
    with pytest.raises(PermissionError):
        api.skills()


def test_learned_skills_scopes_feed_the_edit_form(stack):
    fake, api = stack
    fake.skill(
        "SKILL-SCOPED",
        title="Scoped",
        scope_read="Customer\nToDo",
        scope_write="ToDo",
    )
    (entry,) = [row for row in api.skills()["learned_skills"] if row["name"] == "SKILL-SCOPED"]
    assert entry["scope_read"] == "Customer\nToDo"
    assert entry["scope_write"] == "ToDo"


def test_learned_skills_can_edit_mirrors_the_server_write_rule(stack):
    """Managers edit everything; users edit only their own non-shared Learned rows."""
    fake, api = stack
    fake.skill("SKILL-OWN", title="Own draft")
    fake.skill("SKILL-OWN-SHARED", title="Own shared", shared=1)
    fake.skill("SKILL-SEEDED", title="Seeded", origin="Seeded", shared=1)
    fake.skill("SKILL-TEAM", title="Team", owner="bob", shared=1)

    manager_view = {row["name"]: row for row in api.skills()["learned_skills"]}
    assert all(entry["can_edit"] == 1 for entry in manager_view.values())

    fake.get_roles = lambda user=None: ["Intelligence User"]
    user_view = {row["name"]: row for row in api.skills()["learned_skills"]}
    assert user_view["SKILL-OWN"]["can_edit"] == 1
    assert user_view["SKILL-OWN-SHARED"]["can_edit"] == 0
    assert user_view["SKILL-SEEDED"]["can_edit"] == 0
    assert user_view["SKILL-TEAM"]["can_edit"] == 0
