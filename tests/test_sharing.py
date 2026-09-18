"""Conversation sharing: owner-controlled, read-only for everyone else."""

import importlib
import sys
from types import ModuleType

import pytest
from test_engine_state import env as env


@pytest.fixture
def api(env, monkeypatch):
    monkeypatch.setattr(env.frappe, "whitelist", lambda *a, **kw: lambda fn: fn, raising=False)
    monkeypatch.delitem(sys.modules, "frappe_intelligence.api", raising=False)
    module = importlib.import_module("frappe_intelligence.api")
    files_stub = ModuleType("frappe_intelligence.files")
    files_stub.list_attachments = lambda conversation: []
    monkeypatch.setattr(module, "files", files_stub)
    yield module
    sys.modules.pop("frappe_intelligence.api", None)


def test_share_conversation_toggles_shared_for_the_owner(api, env):
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    assert not doc.get("shared")
    result = api.share_conversation("conversation", shared=1)
    assert result["shared"] == 1
    assert doc.shared == 1
    result = api.share_conversation("conversation", shared=0)
    assert result["shared"] == 0
    assert doc.shared == 0


def test_share_conversation_is_owner_only_and_validated(api, env):
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.share_conversation("conversation", shared=1)
    env.frappe.session.user = "alice"
    with pytest.raises(ValueError):
        api.share_conversation("conversation", shared=2)
    assert not env.frappe.get_doc("Intelligence Conversation", "conversation").get("shared")


def test_shared_conversation_is_read_only_for_other_users(api, env):
    api.share_conversation("conversation", shared=1)
    result = api.get_conversation("conversation")
    assert result["can_post"] is True
    assert result["conversation"]["owner"] == "alice"
    env.frappe.session.user = "bob"
    result = api.get_conversation("conversation")
    assert result["can_post"] is False
    assert result["conversation"]["owner"] == "alice"
    assert result["conversation"]["shared"] == 1


def test_unshared_conversation_stays_invisible_to_other_users(api, env):
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.get_conversation("conversation")


def test_list_conversations_shared_returns_only_other_users_shared(api, env):
    api.share_conversation("conversation", shared=1)
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    doc.update(title="Alice shared", archived=0)
    env.frappe.seed(
        "Intelligence Conversation",
        "bobs-shared",
        owner="bob",
        provider="provider",
        title="Bob shared",
        shared=1,
        archived=0,
    )
    env.frappe.seed(
        "Intelligence Conversation",
        "bobs-private",
        owner="bob",
        provider="provider",
        title="Bob private",
        shared=0,
        archived=0,
    )
    own = {row.title for row in api.list_conversations()}
    assert "Alice shared" in own
    env.frappe.session.user = "bob"
    shared = {row.title for row in api.list_conversations(shared=1)}
    assert shared == {"Alice shared"}
    for row in api.list_conversations(shared=1):
        assert row.owner == "alice" and row.shared == 1


def test_shared_conversation_permission_grants_read_not_write(env):
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    doc.shared = 1
    env.frappe.session.user = "bob"
    assert env.access.get_conversation("conversation").owner == "alice"
    with pytest.raises(PermissionError):
        env.access.get_conversation("conversation", write=True)
    with pytest.raises(PermissionError):
        env.engine.submit_message("conversation", "Posted through a share")


def test_conversation_permission_and_query_cover_shared_rows(env):
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    doc.shared = 1
    assert env.access.conversation_permission(doc, user="bob", permission_type="read")
    assert not env.access.conversation_permission(doc, user="bob", permission_type="write")
    doc.shared = 0
    assert not env.access.conversation_permission(doc, user="bob", permission_type="read")
    sql = env.access.conversation_query("bob")
    assert "'bob'" in sql
    assert "shared` = 1" in sql
