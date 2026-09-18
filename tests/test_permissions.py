import importlib
import inspect
import sys

import pytest
from test_services import Row
from test_services import services as services


@pytest.fixture
def permissions(services, monkeypatch):
    fake, _ = services
    fake.db.get_value = lambda dt, name, field: {
        "enabled": 1,
        "user_type": "System User",
        "owner": "owner@example.test",
    }.get(field)
    monkeypatch.delitem(sys.modules, "frappe_intelligence.permissions", raising=False)
    module = importlib.import_module("frappe_intelligence.permissions")
    yield module, fake
    sys.modules.pop("frappe_intelligence.permissions", None)


def dispatch(function, doc, ptype):
    arguments = {"doc": doc, "user": "owner@example.test", "ptype": ptype, "debug": False}
    return function(
        **{key: value for key, value in arguments.items() if key in inspect.signature(function).parameters}
    )


def test_native_permission_dispatch_does_not_grant_shared_provider_writes(permissions):
    module, _ = permissions
    doc = Row(
        doctype="Intelligence Provider", name="shared", owner="manager@example.test", is_shared=1, enabled=1
    )
    assert dispatch(module.provider_permission, doc, "read") is True
    assert dispatch(module.provider_permission, doc, "write") is False


def test_native_permission_dispatch_keeps_site_memory_manager_curated(permissions):
    module, _ = permissions
    doc = Row(doctype="Intelligence Memory", scope="site", owner="manager@example.test")
    assert dispatch(module.memory_permission, doc, "read") is True
    assert dispatch(module.memory_permission, doc, "write") is False


def test_internal_write_never_grants_business_document_permissions(permissions):
    module, fake = permissions
    fake.flags.intelligence_internal = True
    doc = Row(doctype="Sales Invoice", owner="other@example.test")
    assert module.private_permission(doc) is False


def test_shared_conversation_grants_non_owners_read_only(permissions):
    module, _ = permissions
    doc = Row(doctype="Intelligence Conversation", name="c", owner="someone@example.test", shared=1)
    assert dispatch(module.private_permission, doc, "read") is True
    assert dispatch(module.private_permission, doc, "write") is False
    doc.shared = 0
    assert dispatch(module.private_permission, doc, "read") is False


def test_child_records_follow_a_shared_parent_read_only(permissions):
    module, fake = permissions
    conversations = {"c": {"owner": "someone@example.test", "shared": 1}}
    original = fake.db.get_value

    def get_value(doctype, name, field):
        if doctype == "Intelligence Conversation" and name in conversations:
            row = conversations[name]
            if isinstance(field, (list, tuple)):
                return tuple(row.get(key) for key in field)
            return row.get(field)
        return original(doctype, name, field)

    fake.db.get_value = get_value
    for doctype in (
        "Intelligence Message",
        "Intelligence Run",
        "Intelligence Approval",
        "Intelligence Tool Execution",
    ):
        doc = Row(doctype=doctype, name="child", conversation="c")
        assert dispatch(module.private_permission, doc, "read") is True, doctype
        assert dispatch(module.private_permission, doc, "write") is False, doctype
    conversations["c"]["shared"] = 0
    doc = Row(doctype="Intelligence Message", name="child", conversation="c")
    assert dispatch(module.private_permission, doc, "read") is False


def test_private_and_conversation_queries_include_shared_conversations(permissions):
    module, _ = permissions
    sql = module.private_query("owner@example.test", doctype="Intelligence Message")
    assert "owner@example.test" in sql
    assert "shared = 1" in sql
    sql = module.conversation_query("owner@example.test")
    assert "owner@example.test" in sql
    assert "shared` = 1" in sql
    assert module.private_query("owner@example.test", doctype="Intelligence Provider") == "1=0"
