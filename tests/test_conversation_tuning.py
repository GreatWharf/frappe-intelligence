"""Per-conversation provider, model and reasoning-effort preferences."""

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


def _finish_run(env, name):
    env.frappe.get_doc("Intelligence Run", name).state = "completed"


def test_set_conversation_model_stores_the_pick(api, env):
    result = api.set_conversation_model("conversation", "provider", "other-model")
    assert result["provider"] == "provider"
    assert result["model"] == "other-model"
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    assert doc.model == "other-model"
    # Picking the provider default stores no override.
    result = api.set_conversation_model("conversation", "provider", "test")
    assert result["model"] == ""
    assert doc.model == ""


def test_set_conversation_model_checks_ownership_provider_and_catalog(api, env):
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.set_conversation_model("conversation", "provider", "x")
    env.frappe.session.user = "alice"
    env.frappe.seed(
        "Intelligence Provider",
        "bobs-provider",
        owner="bob",
        enabled=1,
        kind="OpenAI",
        model="test",
        api_key="secret",
        is_shared=0,
    )
    with pytest.raises(PermissionError):
        # Bob's personal key is invisible to Alice, including for re-pointing.
        api.set_conversation_model("conversation", "bobs-provider", "x")
    env.frappe.seed(
        "Intelligence Provider",
        "catalog",
        owner="alice",
        enabled=1,
        kind="OpenAI",
        model="base",
        api_key="secret",
        is_shared=0,
        models="m1\nm2",
    )
    with pytest.raises(ValueError):
        api.set_conversation_model("conversation", "catalog", "m3")
    result = api.set_conversation_model("conversation", "catalog", "m2")
    assert result["provider"] == "catalog"
    assert result["model"] == "m2"


def test_set_conversation_effort_normalizes_and_validates(api, env):
    result = api.set_conversation_effort("conversation", "low")
    assert result["effort"] == "Low"
    result = api.set_conversation_effort("conversation", "MAX")
    assert result["effort"] == "Max"
    result = api.set_conversation_effort("conversation", "auto")
    assert result["effort"] == "Auto"
    with pytest.raises(ValueError):
        api.set_conversation_effort("conversation", "ludicrous")
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        api.set_conversation_effort("conversation", "low")


def test_submit_message_applies_and_persists_the_effort_pick(env):
    result = env.engine.submit_message("conversation", "Hi", effort="max")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert run.effort == "Max"
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    assert doc.effort == "Max"
    _finish_run(env, run.name)
    # A later message with no pick keeps the stored preference.
    result = env.engine.submit_message("conversation", "Again")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert run.effort == "Max"
    _finish_run(env, run.name)
    # Auto clears back to the provider default.
    result = env.engine.submit_message("conversation", "Reset", effort="auto")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert run.effort == ""
    assert doc.effort == "Auto"
    _finish_run(env, run.name)
    with pytest.raises(ValueError):
        env.engine.submit_message("conversation", "Bogus", effort="ludicrous")


def test_submit_message_falls_back_to_the_stored_model_pick(api, env):
    api.set_conversation_model("conversation", "provider", "other-model")
    result = env.engine.submit_message("conversation", "Hi")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert run.model == "other-model"
    _finish_run(env, run.name)
    # An explicit pick for one message wins and never rewrites the preference.
    result = env.engine.submit_message("conversation", "Hi", model="one-off")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert run.model == "one-off"
    doc = env.frappe.get_doc("Intelligence Conversation", "conversation")
    assert doc.model == "other-model"


def test_run_config_stamps_the_effort_override(env):
    result = env.engine.submit_message("conversation", "Hi", effort="high")
    run = env.frappe.get_doc("Intelligence Run", result["name"])
    assert env.engine._run_config(run).effort == "High"
    run.effort = ""
    assert env.engine._run_config(run).effort == ""


def test_bootstrap_omits_rag_when_the_probe_fails(api, env, monkeypatch):
    broken = ModuleType("frappe_intelligence.rag")

    def status():
        raise RuntimeError("gateway unreachable")

    broken.status = status
    monkeypatch.setitem(sys.modules, "frappe_intelligence.rag", broken)
    result = api.bootstrap()
    assert result["user"] == "alice"
    assert "rag" not in result, "a failing RAG probe must never block boot"
