import importlib
import sys
from types import ModuleType

import pytest
from test_services import Row
from test_services import services as services


@pytest.fixture
def api(services, monkeypatch):
    fake, store = services
    fake.whitelist = lambda *a, **kw: lambda f: f
    fake.log_error = lambda **kw: None
    fake.DoesNotExistError = LookupError
    monkeypatch.delitem(sys.modules, "frappe_intelligence.api", raising=False)
    module = importlib.import_module("frappe_intelligence.api")
    yield module, fake, store
    sys.modules.pop("frappe_intelligence.api", None)


def test_create_conversation_rejects_another_users_personal_provider(api):
    module, _, store = api
    store["p"] = Row(
        doctype="Intelligence Provider", name="p", owner="other@example.test", enabled=1, is_shared=0
    )
    with pytest.raises(PermissionError):
        module.create_conversation("p")


def test_create_conversation_returns_no_provider_credentials(api):
    module, _, store = api
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner="owner@example.test",
        enabled=1,
        is_shared=0,
        api_key="hidden-secret",
    )
    result = module.create_conversation("p", title="Quarterly review")
    assert result["title"] == "Quarterly review"
    assert result["provider"] == "p"
    assert "hidden-secret" not in str(result)


def test_rename_and_archive_cannot_target_another_users_conversation(api):
    module, _, store = api
    store["c"] = Row(doctype="Intelligence Conversation", name="c", owner="other@example.test", archived=0)
    with pytest.raises(PermissionError):
        module.rename_conversation("c", "Stolen")
    with pytest.raises(PermissionError):
        module.archive_conversation("c")


def test_request_body_decoder_rejects_wrong_shapes(api):
    module, _, _ = api
    with pytest.raises(ValueError):
        module._decode('["not-context"]', dict)
    with pytest.raises(ValueError):
        module._decode("{broken", dict)
    assert module._decode('{"doctype":"Event","name":"event"}', dict)["name"] == "event"


def test_conversation_approvals_carry_creation_for_chronological_rendering(api, monkeypatch):
    module, _, store = api
    store["c"] = Row(doctype="Intelligence Conversation", name="c", owner="owner@example.test", archived=0)
    store["r"] = Row(doctype="Intelligence Run", name="r", conversation="c")
    store["a"] = Row(
        doctype="Intelligence Approval",
        name="a",
        run="r",
        conversation="c",
        tool_name="search_records",
        preview_json="{}",
        status="succeeded",
        expires_at=None,
        creation="2026-09-17 09:01:00",
    )
    engine_stub = ModuleType("frappe_intelligence.engine")
    # The services fixture stubs the access module, so the real engine cannot
    # import here; get_conversation only needs its get_run serializer. When an
    # earlier test has already imported the real engine, the package attribute
    # shadows the sys.modules entry, so patch both.
    engine_stub.get_run = lambda name: {"name": name, "state": "completed"}
    monkeypatch.setitem(sys.modules, "frappe_intelligence.engine", engine_stub)
    import frappe_intelligence

    monkeypatch.setattr(frappe_intelligence, "engine", engine_stub, raising=False)
    files_stub = ModuleType("frappe_intelligence.files")
    # api.py binds `files` at module import time; whichever fixture ran first
    # decides which fake frappe it carries, so patch the api module's binding.
    files_stub.list_attachments = lambda conversation: []
    monkeypatch.setattr(module, "files", files_stub)
    result = module.get_conversation("c")
    # The chat renderer merge-sorts cards and messages on this timestamp.
    assert result["approvals"][0]["creation"] == "2026-09-17 09:01:00"
