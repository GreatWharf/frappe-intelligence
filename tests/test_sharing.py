"""Conversation sharing: owner-managed, per-user, read-only (native DocShare)."""

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


def test_share_conversation_adds_a_user_and_sets_the_badge(api, env):
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    assert not doc.get("shared")
    result = api.share_conversation("conversation", user="bob")
    assert result["conversation"]["shared"] == 1
    assert [row["user"] for row in result["shares"]] == ["bob"]
    assert doc.shared == 1
    result = api.unshare_conversation("conversation", user="bob")
    assert result["conversation"]["shared"] == 0
    assert result["shares"] == []
    assert doc.shared == 0


def test_share_conversation_is_owner_or_manager_only_and_validated(api, env):
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.share_conversation("conversation", user="manager")
    env.frappe.session.user = "alice"
    with pytest.raises(ValueError):
        api.share_conversation("conversation", user="nobody")
    with pytest.raises(ValueError):
        api.share_conversation("conversation", user="")
    with pytest.raises(ValueError):
        # The owner already has full access; a share row would be noise.
        api.share_conversation("conversation", user="alice")
    assert env.frappe.share.get_users("Intelligence Conversation", "conversation") == []
    assert not env.frappe.get_doc("Intelligence Conversation", "conversation").get("shared")


def test_a_manager_can_share_someone_elses_conversation(api, env):
    env.frappe.session.user = "manager"
    result = api.share_conversation("conversation", user="bob")
    assert [row["user"] for row in result["shares"]] == ["bob"]
    result = api.unshare_conversation("conversation", user="bob")
    assert result["shares"] == []


def test_shared_conversation_is_read_only_for_the_target_user(api, env):
    api.share_conversation("conversation", user="bob")
    result = api.get_conversation("conversation")
    assert result["can_post"] is True
    assert result["conversation"]["owner"] == "alice"
    env.frappe.session.user = "bob"
    result = api.get_conversation("conversation")
    assert result["can_post"] is False
    assert result["conversation"]["owner"] == "alice"
    assert result["conversation"]["shared"] == 1
    env.frappe.session.user = "manager"
    with pytest.raises(PermissionError):
        # Managers administer sharing; they do not gain read access to content.
        api.get_conversation("conversation")


def test_unshared_conversation_stays_invisible_to_other_users(api, env):
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.get_conversation("conversation")
    api_share = api  # keep the fixture alive across the user switch
    env.frappe.session.user = "alice"
    api_share.share_conversation("conversation", user="bob")
    api_share.unshare_conversation("conversation", user="bob")
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.get_conversation("conversation")


def test_conversation_share_users_lists_targets_for_the_owner(api, env):
    api.share_conversation("conversation", user="bob")
    assert api.conversation_share_users("conversation") == [{"user": "bob", "full_name": ""}]
    env.frappe.session.user = "manager"
    assert api.conversation_share_users("conversation") == [{"user": "bob", "full_name": ""}]
    env.frappe.session.user = "alice"
    api.unshare_conversation("conversation", user="bob")
    assert api.conversation_share_users("conversation") == []


def test_list_conversations_shared_returns_docshare_rows_only(api, env):
    api.share_conversation("conversation", user="bob")
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
    env.frappe.share.add("Intelligence Conversation", "conversation", user="bob", read=1)
    env.frappe.session.user = "bob"
    assert env.access.get_conversation("conversation").owner == "alice"
    with pytest.raises(PermissionError):
        env.access.get_conversation("conversation", write=True)
    with pytest.raises(PermissionError):
        env.engine.submit_message("conversation", "Posted through a share")


def test_conversation_permission_and_query_follow_docshare(env):
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    env.frappe.share.add("Intelligence Conversation", "conversation", user="bob", read=1)
    assert env.access.conversation_permission(doc, user="bob", permission_type="read")
    assert not env.access.conversation_permission(doc, user="bob", permission_type="write")
    sql = env.access.conversation_query("bob")
    assert "'bob'" in sql
    assert "'conversation'" in sql
    env.frappe.share.remove("Intelligence Conversation", "conversation", "bob")
    assert not env.access.conversation_permission(doc, user="bob", permission_type="read")
    sql = env.access.conversation_query("bob")
    assert "'conversation'" not in sql
