"""Ownership, role and key boundary regressions (no live Frappe required)."""

import pytest
from test_engine_state import env as engine_env

env = engine_env


def test_internal_write_is_nested_and_restored_after_exception(env):
    assert not env.frappe.flags.get("intelligence_internal")
    with pytest.raises(RuntimeError), env.access.internal_write():
        assert env.frappe.flags.intelligence_internal
        with env.access.internal_write():
            assert env.frappe.flags.intelligence_internal
        assert env.frappe.flags.intelligence_internal
        raise RuntimeError()
    assert not env.frappe.flags.get("intelligence_internal")


def test_guest_disabled_and_unassigned_users_are_rejected(env):
    for user in ("Guest", "unknown"):
        env.frappe.session.user = user
        with pytest.raises(PermissionError):
            env.access.require_user()
    env.frappe.session.user = "alice"
    env.frappe.get_doc("User", "alice").enabled = 0
    with pytest.raises(PermissionError):
        env.access.require_user()


def test_managers_do_not_gain_personal_conversation_or_key_access(env):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    env.frappe.session.user = "manager"
    assert env.access.require_manager() == "manager"
    assert not env.access.can_use_provider(provider)
    with pytest.raises(PermissionError):
        env.access.get_conversation("conversation")
    with pytest.raises(PermissionError):
        env.engine.get_provider_config("provider", "alice")


def test_shared_provider_requires_owner_manager_and_allowed_role(env):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.is_shared = 1
    assert not env.access.can_use_provider(provider)
    provider.owner = "manager"
    provider.allowed_roles = "Accounts User"
    assert not env.access.can_use_provider(provider)
    env.frappe.roles["alice"].append("Accounts User")
    assert env.access.can_use_provider(provider)
    provider.enabled = 0
    assert not env.access.can_use_provider(provider)


def test_provider_config_is_allowlisted_not_doc_or_environment_dump(env):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.extra_secret = "not-for-model"
    config = env.engine.get_provider_config("provider", "alice")
    assert config.api_key == "secret"
    assert "extra_secret" not in config
    assert config.timeout <= 120


def test_token_limit_uses_lower_provider_and_site_setting_up_to_32768(env):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.max_tokens = 32768
    env.frappe.settings.max_tokens = 32768
    assert env.engine.get_provider_config("provider").max_tokens == 32768
    env.frappe.settings.max_tokens = 1024
    assert env.engine.get_provider_config("provider").max_tokens == 1024


def test_internal_permission_is_only_for_application_bookkeeping(env):
    env.frappe.session.user = "manager"
    conversation = env.frappe.get_doc("Intelligence Conversation", "conversation")
    run = env.frappe.seed("Intelligence Run", "run", conversation="conversation", user="alice")
    business = env.frappe.seed("Sales Invoice", "invoice", owner="alice", conversation="conversation")
    with env.access.internal_write():
        assert env.access.conversation_permission(conversation)
        assert env.access.private_record_permission(run)
        assert not env.access.private_record_permission(business)
    assert not env.access.conversation_permission(conversation)
    assert not env.access.private_record_permission(run)


def test_provider_secret_grant_is_nested_and_restored_after_exception(env):
    assert not env.frappe.flags.get("intelligence_provider_secret")
    with pytest.raises(RuntimeError), env.access.provider_secret_access("provider", "alice"):
        assert env.frappe.flags.intelligence_provider_secret == ("provider", "alice")
        with env.access.provider_secret_access("provider", "alice"):
            assert env.frappe.flags.intelligence_provider_secret == ("provider", "alice")
        assert env.frappe.flags.intelligence_provider_secret == ("provider", "alice")
        raise RuntimeError("decryption failed")
    assert not env.frappe.flags.get("intelligence_provider_secret")


def test_provider_secret_grant_rejects_actor_mismatch_and_nonowner_manager(env):
    with pytest.raises(PermissionError), env.access.provider_secret_access("provider", "bob"):
        pytest.fail("A grant was issued for another actor")
    env.frappe.session.user = "manager"
    with env.access.internal_write():
        with pytest.raises(PermissionError), env.access.provider_secret_access("provider", "manager"):
            pytest.fail("An internal write must not grant access to another user's key")
    assert not env.frappe.flags.get("intelligence_provider_secret")


def test_provider_secret_grant_checks_shared_provider_roles_and_enabled(env):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.update(owner="manager", is_shared=1, allowed_roles="Accounts User")
    with pytest.raises(PermissionError), env.access.provider_secret_access("provider", "alice"):
        pytest.fail("Role-restricted key was accessible")
    env.frappe.roles["alice"].append("Accounts User")
    with env.access.provider_secret_access("provider", "alice"):
        assert env.frappe.flags.intelligence_provider_secret == ("provider", "alice")
    provider.enabled = 0
    with pytest.raises(PermissionError), env.access.provider_secret_access("provider", "alice"):
        pytest.fail("Disabled provider key was accessible")


def test_engine_decrypts_only_inside_exact_provider_actor_grant(env, monkeypatch):
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.update(owner="manager", is_shared=1)

    def decrypt(doc, field):
        assert env.frappe.flags.intelligence_provider_secret == (doc.name, "alice")
        assert field == "api_key"
        return "secret"

    monkeypatch.setattr(type(provider), "get_password", decrypt)
    assert env.engine.get_provider_config("provider").api_key == "secret"
    assert not env.frappe.flags.get("intelligence_provider_secret")

    def failing_decrypt(doc, field):
        assert env.frappe.flags.intelligence_provider_secret == (doc.name, "alice")
        raise RuntimeError("decryption failed")

    monkeypatch.setattr(type(provider), "get_password", failing_decrypt)
    with pytest.raises(RuntimeError):
        env.engine.get_provider_config("provider")
    assert not env.frappe.flags.get("intelligence_provider_secret")


def test_ownership_is_additional_to_frappe_document_permissions(env):
    env.frappe.get_doc("Intelligence Conversation", "conversation").no_permission = True
    with pytest.raises(PermissionError):
        env.access.get_conversation("conversation", write=True)
