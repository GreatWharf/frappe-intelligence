"""Offline contract/security tests for the Intelligence Skill curation tools.

Covers propose_skill (always DISABLED, origin Learned, caller-owned),
update_skill (optimistic version lock, owner/manager edit authority, origin and
enabled immutable) and retire_skill (Seeded warning, execute-time permission
re-derivation), plus schema closedness and registry integration.
"""

import importlib
import json
import sys
import types

import pytest


class Row(dict):
    __getattr__ = dict.get
    __setattr__ = dict.__setitem__


class Document(Row):
    def check_permission(self, permtype="read"):
        if not self._fake.has_permission(self.doctype, permtype, doc=self):
            raise PermissionError("Denied")

    def set(self, key, value):
        self[key] = value

    def save(self, **kwargs):
        assert not kwargs, "Normal Document save must not bypass permissions"
        self.check_permission("write")
        self.modified = "2026-09-17 12:01:00.000000"
        self._fake.saved.append((self.doctype, self.name))
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def insert(self, **kwargs):
        assert not kwargs, "Normal Document insert must not bypass permissions"
        self.check_permission("create")
        self.name = self.get("name") or f"SKILL-{len(self._fake.rows):04d}"
        self.owner = self._fake.session.user
        self.modified = "2026-09-17 12:01:00.000000"
        self._fake.saved.append((self.doctype, self.name))
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def delete(self, **kwargs):
        assert not kwargs, "Normal Document delete must not bypass permissions"
        self.check_permission("delete")
        self._fake.deleted.append((self.doctype, self.name))
        del self._fake.rows[(self.doctype, self.name)]


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self.session = Row(user="alice")
        self.local = Row(site="site.test")
        self.flags = Row()
        self.rows = {}
        self.saved = []
        self.deleted = []
        self.locks = []
        self.denied = set()
        self.hooks = {}
        self.attrs = {}
        self.installed = ["frappe", "erpnext"]
        self.roles_map = {"alice": ["System Manager"], "bob": ["Intelligence User"]}
        self.settings = Row(
            enabled=1,
            allowed_read_doctypes="Customer\nToDo",
            allowed_write_doctypes="ToDo",
            enabled_tools="propose_skill\nupdate_skill\nretire_skill\nread_document",
            allowed_reports="",
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
        self.seed("User", "alice", enabled=1, user_type="System User")
        self.seed("User", "bob", enabled=1, user_type="System User")
        self.seed("Intelligence Conversation", "conversation", owner="alice")
        self.seed(
            "Intelligence Skill",
            "SKILL-OWN",
            title="Own Skill",
            description="Alice's own skill.",
            instructions="Own instructions.",
            scope_read="Customer\nToDo",
            scope_write="ToDo",
            enabled=1,
            shared=0,
            origin="Learned",
            version=3,
        )
        self.seed(
            "Intelligence Skill",
            "SKILL-SHARED",
            owner="bob",
            title="Shared Skill",
            description="Shared with everyone.",
            instructions="Shared instructions.",
            scope_read="Customer",
            scope_write="",
            enabled=1,
            shared=1,
            origin="Learned",
            version=5,
        )
        self.seed(
            "Intelligence Skill",
            "SKILL-SEEDED",
            owner="bob",
            title="Seeded Skill",
            description="Shipped with the app.",
            instructions="Seeded instructions.",
            scope_read="Customer",
            scope_write="",
            enabled=1,
            shared=1,
            origin="Seeded",
            version=1,
        )
        self.seed(
            "Intelligence Skill",
            "SKILL-PRIVATE",
            owner="bob",
            title="Bob Private",
            description="Bob only.",
            instructions="Private instructions.",
            scope_read="Customer",
            scope_write="",
            enabled=0,
            shared=0,
            origin="Learned",
            version=2,
        )

    def seed(self, doctype, name, **values):
        doc = Document(
            doctype=doctype,
            name=name,
            owner="alice",
            modified="2026-09-17 12:00:00.000000",
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

    def get_value(self, doctype, name, field="name", **kwargs):
        doc = self.rows.get((doctype, name))
        return doc.get(field) if doc else None

    def exists(self, doctype, name):
        return (doctype, name) in self.rows

    def get_single(self, doctype):
        return self.settings

    def get_roles(self, user=None):
        return list(self.roles_map.get(user or self.session.user, []))

    def has_permission(self, doctype, ptype="read", doc=None, user=None, **kwargs):
        return (doctype, ptype) not in self.denied and not (doc and doc.get("denied"))

    def get_hooks(self, key, default=None):
        return self.hooks.get(key, default or [])

    def get_attr(self, path):
        return self.attrs[path]

    def get_installed_apps(self):
        return self.installed

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
    context = tools.ToolContext("site.test", "alice", "conversation", "run")
    yield tools, context, fake, api
    for key in list(sys.modules):
        if key in owned or key.startswith("frappe_intelligence.tools"):
            del sys.modules[key]
    sys.modules.update(old)


SKILL_TOOLS = ("propose_skill", "update_skill", "retire_skill")
PROPOSE_ARGS = {
    "title": "Follow-up drafter",
    "description": "Drafts customer follow-up notes.",
    "instructions": "Summarise the thread, then draft a note.",
    "scope_read": "Customer\nToDo",
    "scope_write": "ToDo",
}


def test_skill_tools_are_registered_and_policy_filtered(stack):
    tools, context, fake, _ = stack
    registered = tools.get_tools(context)
    assert set(SKILL_TOOLS) <= set(registered)
    for name in SKILL_TOOLS:
        spec = registered[name]
        assert spec.mutates is True
        assert spec.external is False
        assert spec.version == "1"
        assert spec.parameters["type"] == "object"
        assert spec.parameters["additionalProperties"] is False
    fake.settings.enabled_tools = "propose_skill"
    assert set(tools.get_tools(context)) == {"propose_skill"}


def test_skills_module_appears_in_assembled_registry_and_skills_api(stack):
    tools, context, _, api = stack
    assembled = tools._assemble(context).tools
    assert set(SKILL_TOOLS) <= set(assembled)
    skills = importlib.import_module("frappe_intelligence.tools.skills")
    assert {spec.name for spec in skills.specs(context)} == set(SKILL_TOOLS)
    catalog = {tool["name"]: tool for tool in api.skills()["tools"]}
    for name in SKILL_TOOLS:
        assert catalog[name] == {
            "name": name,
            "description": assembled[name].description,
            "mutates": True,
            "external": False,
            "version": 1,
            "enabled": True,
        }


@pytest.mark.parametrize("missing", ["title", "description", "instructions"])
def test_propose_skill_requires_core_fields(stack, missing):
    tools, context, _, _ = stack
    args = {key: value for key, value in PROPOSE_ARGS.items() if key != missing}
    with pytest.raises(ValueError):
        tools.execute(context, "propose_skill", args)


@pytest.mark.parametrize(
    "patch",
    [
        {"title": ""},
        {"title": "x" * 141},
        {"description": "x" * 501},
        {"instructions": "x" * 8001},
        {"scope_read": "x" * 2001},
        {"scope_write": "x" * 2001},
        {"enabled": 1},
        {"origin": "Seeded"},
        {"shared": 1},
        {"version": 9},
    ],
)
def test_propose_skill_schema_is_closed_and_bounded(stack, patch):
    tools, context, _, _ = stack
    with pytest.raises(ValueError):
        tools.execute(context, "propose_skill", {**PROPOSE_ARGS, **patch})


@pytest.mark.parametrize(
    "args",
    [
        {"name": "SKILL-OWN", "expected_version": 3},
        {"name": "SKILL-OWN", "title": "Renamed"},
        {"expected_version": 3, "title": "Renamed"},
        {"name": "", "expected_version": 3, "title": "Renamed"},
        {"name": "SKILL-OWN", "expected_version": 0, "title": "Renamed"},
        {"name": "SKILL-OWN", "expected_version": "3", "title": "Renamed"},
        {"name": "SKILL-OWN", "expected_version": 3, "enabled": 0},
        {"name": "SKILL-OWN", "expected_version": 3, "origin": "Seeded"},
        {"name": "SKILL-OWN", "expected_version": 3, "shared": 1},
        {"name": "SKILL-OWN", "expected_version": 3, "title": "x" * 141},
        {"name": "SKILL-OWN", "expected_version": 3, "instructions": "x" * 8001},
        {"name": "SKILL-OWN", "expected_version": 3, "scope_read": "x" * 2001},
    ],
)
def test_update_skill_schema_is_closed_and_bounded(stack, args):
    tools, context, _, _ = stack
    with pytest.raises(ValueError):
        tools.execute(context, "update_skill", args)


@pytest.mark.parametrize(
    "args",
    [
        {},
        {"name": ""},
        {"name": "x" * 141},
        {"name": "SKILL-OWN", "force": True},
    ],
)
def test_retire_skill_schema_is_closed(stack, args):
    tools, context, _, _ = stack
    with pytest.raises(ValueError):
        tools.execute(context, "retire_skill", args)


def test_propose_skill_preview_discloses_full_skill_and_disabled_note(stack):
    tools, context, fake, _ = stack
    preview = tools.prepare(context, "propose_skill", dict(PROPOSE_ARGS))
    assert preview["operation"] == "propose_skill"
    assert preview["target"] == {"doctype": "Intelligence Skill", "name": None}
    skill = preview["details"]["skill"]
    assert skill["title"] == PROPOSE_ARGS["title"]
    assert skill["description"] == PROPOSE_ARGS["description"]
    assert skill["instructions"] == PROPOSE_ARGS["instructions"]
    assert skill["scope_read"] == "Customer\nToDo"
    assert skill["scope_write"] == "ToDo"
    assert skill["enabled"] == 0
    assert skill["origin"] == "Learned"
    assert skill["version"] == 1
    assert skill["owner"] == "alice"
    note = preview["details"]["note"].lower()
    assert "disabled" in note
    assert "learned" in note
    assert fake.saved == []


def test_propose_skill_execute_creates_disabled_learned_owned_skill(stack):
    tools, context, fake, _ = stack
    args = {**PROPOSE_ARGS, "scope_read": "Customer\n\n ToDo \nCustomer", "scope_write": " ToDo "}
    result = tools.execute(context, "propose_skill", args)
    assert result["enabled"] == 0
    assert result["origin"] == "Learned"
    assert result["version"] == 1
    doc = fake.rows[("Intelligence Skill", result["name"])]
    assert doc.owner == "alice"
    assert doc.get("enabled") == 0
    assert doc.get("origin") == "Learned"
    assert doc.get("version") == 1
    assert doc.get("title") == PROPOSE_ARGS["title"]
    assert doc.get("docstatus", 0) == 0
    # Scope lists are normalised: trimmed, blank lines dropped, duplicates removed.
    assert doc.get("scope_read") == "Customer\nToDo"
    assert doc.get("scope_write") == "ToDo"


def test_propose_skill_rejects_scope_write_outside_scope_read(stack):
    tools, context, fake, _ = stack
    with pytest.raises(ValueError):
        tools.prepare(context, "propose_skill", {**PROPOSE_ARGS, "scope_write": "ToDo\nEvent"})
    with pytest.raises(ValueError):
        tools.execute(context, "propose_skill", {**PROPOSE_ARGS, "scope_read": "", "scope_write": "ToDo"})
    assert fake.saved == []


def test_propose_skill_execute_rechecks_create_permission(stack):
    tools, context, fake, _ = stack
    tools.prepare(context, "propose_skill", dict(PROPOSE_ARGS))
    fake.denied.add(("Intelligence Skill", "create"))
    with pytest.raises(PermissionError):
        tools.execute(context, "propose_skill", dict(PROPOSE_ARGS))
    assert fake.saved == []


def test_update_skill_preview_shows_readable_diff_and_truncates_long_values(stack):
    tools, context, fake, _ = stack
    args = {
        "name": "SKILL-OWN",
        "expected_version": 3,
        "title": "Renamed skill",
        "instructions": "x" * 7000,
    }
    preview = tools.prepare(context, "update_skill", args)
    assert preview["operation"] == "update_skill"
    assert preview["target"] == {"doctype": "Intelligence Skill", "name": "SKILL-OWN"}
    assert preview["details"]["expected_version"] == 3
    changes = {change["field"]: change for change in preview["changes"]}
    assert set(changes) == {"title", "instructions"}
    assert changes["title"]["before"] == "Own Skill"
    assert changes["title"]["after"] == "Renamed skill"
    assert len(changes["instructions"]["after"]) < 7000
    assert "x" * 7000 not in json.dumps(preview)
    assert fake.saved == []
    assert fake.rows[("Intelligence Skill", "SKILL-OWN")].title == "Own Skill"


def test_update_skill_execute_bumps_version_and_preserves_origin_and_enabled(stack):
    tools, context, fake, _ = stack
    args = {
        "name": "SKILL-OWN",
        "expected_version": 3,
        "description": "New description.",
        "scope_write": "",
    }
    result = tools.execute(context, "update_skill", args)
    assert result == {
        "name": "SKILL-OWN",
        "version": 4,
        "updated_fields": ["description", "scope_write"],
        "origin": "Learned",
        "enabled": 1,
    }
    doc = fake.rows[("Intelligence Skill", "SKILL-OWN")]
    assert doc.get("version") == 4
    assert doc.get("description") == "New description."
    assert doc.get("scope_write") == ""
    # Origin and enabled are never touched by the tool.
    assert doc.get("origin") == "Learned"
    assert doc.get("enabled") == 1
    assert ("Intelligence Skill", "SKILL-OWN") in fake.locks


def test_update_skill_rejects_supplied_but_unchanged_fields(stack):
    tools, context, fake, _ = stack
    with pytest.raises(ValueError):
        tools.execute(
            context, "update_skill", {"name": "SKILL-OWN", "expected_version": 3, "title": "Own Skill"}
        )
    assert fake.saved == []


def test_update_skill_rejects_stale_version(stack):
    tools, context, fake, _ = stack
    args = {"name": "SKILL-OWN", "expected_version": 3, "title": "Renamed"}
    tools.prepare(context, "update_skill", args)
    fake.rows[("Intelligence Skill", "SKILL-OWN")].version = 4
    with pytest.raises((RuntimeError, ValueError)):
        tools.execute(context, "update_skill", args)
    assert fake.saved == []
    assert fake.rows[("Intelligence Skill", "SKILL-OWN")].title == "Own Skill"


def test_update_skill_scope_write_subset_uses_merged_state(stack):
    tools, context, fake, _ = stack
    base = {"name": "SKILL-OWN", "expected_version": 3}
    # Widening write beyond the kept read scope fails.
    with pytest.raises(ValueError):
        tools.execute(context, "update_skill", {**base, "scope_write": "Event"})
    # Narrowing read while keeping the old write scope also fails.
    with pytest.raises(ValueError):
        tools.execute(context, "update_skill", {**base, "scope_read": "Customer"})
    # Adjusting both together is accepted.
    result = tools.execute(
        context,
        "update_skill",
        {**base, "scope_read": "Customer\nToDo\nEvent", "scope_write": "Event"},
    )
    assert result["version"] == 4
    assert fake.rows[("Intelligence Skill", "SKILL-OWN")].scope_write == "Event"


def test_manager_updates_shared_skill(stack):
    tools, context, fake, _ = stack
    result = tools.execute(
        context, "update_skill", {"name": "SKILL-SHARED", "expected_version": 5, "title": "Shared v2"}
    )
    assert result["version"] == 6
    assert fake.rows[("Intelligence Skill", "SKILL-SHARED")].title == "Shared v2"


def test_owner_edits_own_skill_without_manager_role(stack):
    tools, context, fake, _ = stack
    fake.roles_map["alice"] = ["Intelligence User"]
    result = tools.execute(
        context, "update_skill", {"name": "SKILL-OWN", "expected_version": 3, "title": "Still mine"}
    )
    assert result["version"] == 4


def test_update_skill_forbidden_for_non_manager_on_shared_skill(stack):
    tools, context, fake, _ = stack
    fake.roles_map["alice"] = ["Intelligence User"]
    args = {"name": "SKILL-SHARED", "expected_version": 5, "title": "Nope"}
    with pytest.raises(PermissionError):
        tools.prepare(context, "update_skill", args)
    with pytest.raises(PermissionError):
        tools.execute(context, "update_skill", args)
    assert fake.saved == []


def test_private_skill_of_another_user_is_invisible_even_to_managers(stack):
    tools, context, fake, _ = stack
    # Alice is a manager in this fixture, but non-shared skills are owner-only.
    for action in (tools.prepare, tools.execute):
        with pytest.raises(PermissionError):
            action(context, "update_skill", {"name": "SKILL-PRIVATE", "expected_version": 2, "title": "Nope"})
        with pytest.raises(PermissionError):
            action(context, "retire_skill", {"name": "SKILL-PRIVATE"})
    assert fake.saved == []
    assert fake.deleted == []


def test_update_skill_execute_rederives_permission_after_preview(stack):
    tools, context, fake, _ = stack
    args = {"name": "SKILL-SHARED", "expected_version": 5, "title": "Approved title"}
    tools.prepare(context, "update_skill", args)
    # The manager role is revoked between approval and execution.
    fake.roles_map["alice"] = ["Intelligence User"]
    with pytest.raises(PermissionError):
        tools.execute(context, "update_skill", args)
    assert fake.saved == []
    assert fake.rows[("Intelligence Skill", "SKILL-SHARED")].title == "Shared Skill"


def test_update_skill_execute_rederives_ownership_after_preview(stack):
    tools, context, fake, _ = stack
    args = {"name": "SKILL-OWN", "expected_version": 3, "title": "Approved title"}
    tools.prepare(context, "update_skill", args)
    # Ownership changed between approval and execution.
    fake.rows[("Intelligence Skill", "SKILL-OWN")].owner = "bob"
    with pytest.raises(PermissionError):
        tools.execute(context, "update_skill", args)
    assert fake.saved == []
    assert fake.rows[("Intelligence Skill", "SKILL-OWN")].title == "Own Skill"


def test_retire_skill_preview_warns_for_seeded_origin(stack):
    tools, context, fake, _ = stack
    preview = tools.prepare(context, "retire_skill", {"name": "SKILL-SEEDED"})
    assert preview["operation"] == "retire_skill"
    assert preview["target"] == {"doctype": "Intelligence Skill", "name": "SKILL-SEEDED"}
    skill = preview["details"]["skill"]
    assert skill["origin"] == "Seeded"
    assert skill["title"] == "Seeded Skill"
    assert "seeded" in preview["details"]["warning"].lower()
    learned = tools.prepare(context, "retire_skill", {"name": "SKILL-SHARED"})
    assert learned["details"]["warning"] is None
    assert fake.deleted == []


def test_retire_skill_execute_deletes_after_permission_recheck(stack):
    tools, context, fake, _ = stack
    args = {"name": "SKILL-SHARED"}
    tools.prepare(context, "retire_skill", args)
    # The manager role is revoked between approval and execution: no delete.
    fake.roles_map["alice"] = ["Intelligence User"]
    with pytest.raises(PermissionError):
        tools.execute(context, "retire_skill", args)
    assert ("Intelligence Skill", "SKILL-SHARED") in fake.rows
    assert fake.deleted == []
    fake.roles_map["alice"] = ["System Manager"]
    result = tools.execute(context, "retire_skill", args)
    assert result == {"retired": "SKILL-SHARED"}
    assert ("Intelligence Skill", "SKILL-SHARED") not in fake.rows
    assert ("Intelligence Skill", "SKILL-SHARED") in fake.deleted


def test_owner_retires_own_non_shared_skill(stack):
    tools, context, fake, _ = stack
    result = tools.execute(context, "retire_skill", {"name": "SKILL-OWN"})
    assert result == {"retired": "SKILL-OWN"}
    assert ("Intelligence Skill", "SKILL-OWN") not in fake.rows


def test_skill_tools_do_not_run_without_a_run_context(stack):
    tools, _, fake, _ = stack
    context = tools.ToolContext("site.test", "alice", "conversation", "")
    for name in SKILL_TOOLS:
        with pytest.raises(PermissionError):
            tools.execute(context, name, {})
