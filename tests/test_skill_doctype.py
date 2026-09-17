"""Intelligence Skill doctype: validation, curation and row-visibility rules."""

import importlib
import sys
from types import ModuleType

import pytest
from test_services import Row
from test_services import services as services

CONTROLLER = "frappe_intelligence.frappe_intelligence.doctype.intelligence_skill.intelligence_skill"


@pytest.fixture
def skills(services, monkeypatch):
    fake, _ = services
    fake.db.get_value = lambda dt, name, field: {
        "enabled": 1,
        "user_type": "System User",
    }.get(field)
    document_module = ModuleType("frappe.model.document")

    class Document(Row):
        def get_doc_before_save(self):
            return self.get("old")

    document_module.Document = Document
    monkeypatch.setitem(sys.modules, "frappe.model.document", document_module)
    monkeypatch.delitem(sys.modules, CONTROLLER, raising=False)
    module = importlib.import_module(CONTROLLER)
    yield module, fake
    sys.modules.pop(CONTROLLER, None)


def make_skill(module, **overrides):
    data = {
        "doctype": "Intelligence Skill",
        "title": "Chase overdue invoices",
        "description": "Find overdue invoices and propose reminder drafts.",
        "instructions": "List overdue Sales Invoices and draft a reminder for review.",
        "scope_read": "Sales Invoice\nCustomer",
        "scope_write": "Sales Invoice",
        "origin": "Learned",
        "shared": 0,
        "enabled": 0,
        "version": 1,
        "owner": "owner@example.test",
    }
    data.update(overrides)
    return module.IntelligenceSkill(data)


def manager(fake):
    fake.get_roles = lambda user=None: ["Intelligence Manager"]


def test_a_well_formed_personal_skill_validates(skills):
    module, _ = skills
    make_skill(module, scope_write="").validate()
    make_skill(module).validate()


def test_write_scope_must_be_a_subset_of_read_scope(skills):
    module, _ = skills
    with pytest.raises(ValueError, match="Purchase Invoice"):
        make_skill(module, scope_write="Purchase Invoice").validate()
    with pytest.raises(ValueError):
        make_skill(module, scope_read="", scope_write="Sales Invoice").validate()


@pytest.mark.parametrize(
    "field,limit,extra",
    [
        ("title", 140, {}),
        ("description", 500, {}),
        ("instructions", 8000, {}),
        ("scope_read", 2000, {"scope_write": ""}),
        ("scope_write", 2000, {"scope_read": "x" * 2000}),
    ],
)
def test_text_fields_are_length_bounded(skills, field, limit, extra):
    module, _ = skills
    make_skill(module, **{field: "x" * limit}, **extra).validate()
    with pytest.raises(ValueError, match=field):
        make_skill(module, **{field: "x" * (limit + 1)}, **extra).validate()


@pytest.mark.parametrize("field", ["title", "instructions"])
def test_title_and_instructions_are_required(skills, field):
    module, _ = skills
    with pytest.raises(ValueError, match=field):
        make_skill(module, **{field: ""}).validate()
    with pytest.raises(ValueError, match=field):
        make_skill(module, **{field: "   "}).validate()


@pytest.mark.parametrize("version", [0, -1, "abc", None])
def test_version_must_be_a_positive_whole_number(skills, version):
    module, _ = skills
    with pytest.raises(ValueError):
        make_skill(module, version=version).validate()


def test_origin_is_limited_and_immutable_once_saved(skills):
    module, fake = skills
    manager(fake)
    with pytest.raises(ValueError, match="origin"):
        make_skill(module, origin="Imported").validate()
    with pytest.raises(PermissionError):
        make_skill(module, origin="Seeded", old=Row(origin="Learned")).validate()
    make_skill(module, origin="Seeded", old=Row(origin="Seeded"), shared=1).validate()


def test_only_managers_can_save_shared_or_seeded_skills(skills):
    module, fake = skills
    with pytest.raises(PermissionError):
        make_skill(module, shared=1).validate()
    with pytest.raises(PermissionError):
        make_skill(module, origin="Seeded").validate()
    manager(fake)
    make_skill(module, shared=1).validate()
    make_skill(module, origin="Seeded").validate()


def test_permission_query_shows_own_and_shared_skills_only(skills):
    module, fake = skills
    condition = module.permission_query_conditions()
    assert condition == (
        "(`tabIntelligence Skill`.`owner` = 'owner@example.test' OR `tabIntelligence Skill`.`shared` = 1)"
    )
    manager(fake)
    assert module.permission_query_conditions() == "1=1"
    fake.get_roles = lambda user=None: []
    assert module.permission_query_conditions() == "1=0"


def test_has_permission_scopes_reads_and_writes(skills):
    module, fake = skills
    own = Row(doctype="Intelligence Skill", owner="owner@example.test", shared=0, origin="Learned")
    foreign = Row(doctype="Intelligence Skill", owner="other@example.test", shared=0, origin="Learned")
    shared = Row(doctype="Intelligence Skill", owner="other@example.test", shared=1, origin="Learned")
    assert module.has_permission(own, ptype="read") is True
    assert module.has_permission(own, ptype="write") is True
    assert module.has_permission(own, ptype="create") is True
    assert module.has_permission(foreign, ptype="read") is False
    assert module.has_permission(foreign, ptype="write") is False
    assert module.has_permission(shared, ptype="read") is True
    assert module.has_permission(shared, ptype="write") is False
    assert module.has_permission(shared, ptype="create") is False
    manager(fake)
    assert module.has_permission(foreign, ptype="write") is True
    assert module.has_permission(shared, ptype="write") is True


def test_internal_bookkeeping_and_guests(skills):
    module, fake = skills
    doc = Row(doctype="Intelligence Skill", owner="other@example.test", shared=0, origin="Seeded")
    fake.flags.intelligence_internal = True
    assert module.has_permission(doc, ptype="write") is True
    fake.flags.intelligence_internal = False
    assert module.has_permission(doc, ptype="write") is False
    fake.session.user = "Guest"
    fake.get_roles = lambda user=None: []
    assert module.has_permission(doc, ptype="read") is False


def test_hooks_wire_the_visibility_rules():
    """hooks.py must register the controller hooks or Desk lists and REST ignore them."""
    import frappe_intelligence.hooks as hooks

    controller = "frappe_intelligence.frappe_intelligence.doctype.intelligence_skill.intelligence_skill"
    assert (
        hooks.permission_query_conditions["Intelligence Skill"] == controller + ".permission_query_conditions"
    )
    assert hooks.has_permission["Intelligence Skill"] == controller + ".has_permission"
