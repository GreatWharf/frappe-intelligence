"""Intelligence Tool Grant doctype: validation and row-visibility rules."""

import importlib
import sys
from types import ModuleType

import pytest
from test_services import Row
from test_services import services as services

CONTROLLER = "frappe_intelligence.frappe_intelligence.doctype.intelligence_tool_grant.intelligence_tool_grant"


@pytest.fixture
def grants(services, monkeypatch):
    fake, store = services
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
    yield module, fake, store
    sys.modules.pop(CONTROLLER, None)


def make_grant(module, **overrides):
    data = {
        "doctype": "Intelligence Tool Grant",
        "user": "owner@example.test",
        "tool": "search_records",
        "scope_doctype": "",
    }
    data.update(overrides)
    return module.IntelligenceToolGrant(data)


def manager(fake):
    fake.get_roles = lambda user=None: ["Intelligence Manager"]


def test_a_well_formed_own_grant_validates_and_defaults_the_user(grants):
    module, fake, _ = grants
    make_grant(module).validate()
    grant = make_grant(module, user=None)
    grant.validate()
    assert grant.user == "owner@example.test", "the caller is the default grantee"


@pytest.mark.parametrize("tool", ["Search Records", "tool name", "tool!", "", None, "x" * 65])
def test_tool_names_must_be_lowercase_tool_identifiers(grants, tool):
    module, _, _ = grants
    with pytest.raises(ValueError, match="tool"):
        make_grant(module, tool=tool).validate()


def test_scope_doctype_must_resolve_to_a_real_doctype(grants):
    module, fake, _ = grants
    with pytest.raises(ValueError, match="Customer"):
        make_grant(module, scope_doctype="Customer").validate()
    fake.db.exists = lambda dt, name: dt == "DocType" and name == "Customer"
    grant = make_grant(module, scope_doctype="  Customer ")
    grant.validate()
    assert grant.scope_doctype == "Customer"
    with pytest.raises(ValueError, match="scope_doctype"):
        make_grant(module, scope_doctype="x" * 141).validate()


def test_only_managers_can_grant_for_another_user(grants):
    module, fake, _ = grants
    with pytest.raises(PermissionError):
        make_grant(module, user="other@example.test").validate()
    manager(fake)
    make_grant(module, user="other@example.test").validate()


def test_duplicate_grants_are_rejected_but_self_edits_pass(grants):
    module, _, store = grants
    store["g1"] = Row(
        doctype="Intelligence Tool Grant",
        name="g1",
        user="owner@example.test",
        tool="search_records",
        scope_doctype="",
    )
    with pytest.raises(ValueError, match="already always allowed"):
        make_grant(module).validate()
    make_grant(module, name="g1").validate(), "saving the same record is not a duplicate"


def test_query_conditions_scope_users_to_own_rows(grants):
    module, fake, _ = grants
    assert module.permission_query_conditions() == (
        "`tabIntelligence Tool Grant`.`user` = 'owner@example.test'"
    )
    manager(fake)
    assert module.permission_query_conditions() == "1=1"
    fake.get_roles = lambda user=None: []
    assert module.permission_query_conditions() == "1=0"


def test_has_permission_is_own_rows_for_users_and_everything_for_managers(grants):
    module, fake, _ = grants
    own = Row(doctype="Intelligence Tool Grant", user="owner@example.test")
    foreign = Row(doctype="Intelligence Tool Grant", user="other@example.test")
    assert module.has_permission(own)
    assert not module.has_permission(foreign)
    manager(fake)
    assert module.has_permission(foreign)
    fake.get_roles = lambda user=None: []
    fake.flags.intelligence_internal = True
    assert module.has_permission(foreign), "engine bookkeeping bypasses row rules"
