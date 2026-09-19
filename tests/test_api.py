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


def stub_engine_and_files(module, monkeypatch):
    """get_conversation needs only get_run and the attachment list."""
    engine_stub = ModuleType("frappe_intelligence.engine")
    engine_stub.get_run = lambda name: {"name": name, "state": "completed"}
    monkeypatch.setitem(sys.modules, "frappe_intelligence.engine", engine_stub)
    import frappe_intelligence

    monkeypatch.setattr(frappe_intelligence, "engine", engine_stub, raising=False)
    files_stub = ModuleType("frappe_intelligence.files")
    files_stub.list_attachments = lambda conversation: []
    monkeypatch.setattr(module, "files", files_stub)


def test_conversation_approvals_expose_the_auto_decision_source(api, monkeypatch):
    """The audit tag needs source/decided_by: policy:x or grant:y, blank decider."""
    module, _, store = api
    store["c"] = Row(doctype="Intelligence Conversation", name="c", owner="owner@example.test", archived=0)
    store["r"] = Row(doctype="Intelligence Run", name="r", conversation="c")
    store["auto"] = Row(
        doctype="Intelligence Approval",
        name="auto",
        run="r",
        conversation="c",
        tool_name="create_document",
        preview_json="{}",
        status="approved",
        expires_at=None,
        creation="2026-09-19 09:00:00",
        source="policy:p-auto",
        decided_by=None,
    )
    store["human"] = Row(
        doctype="Intelligence Approval",
        name="human",
        run="r",
        conversation="c",
        tool_name="update_document",
        preview_json="{}",
        status="approved",
        expires_at=None,
        creation="2026-09-19 09:05:00",
        decided_by="owner@example.test",
    )
    stub_engine_and_files(module, monkeypatch)
    result = module.get_conversation("c")
    by_name = {row["name"]: row for row in result["approvals"]}
    assert by_name["auto"]["source"] == "policy:p-auto"
    assert by_name["auto"]["decided_by"] == "", "policy approvals stay unattributed to a human"
    assert by_name["human"]["source"] == "", "a human decision carries no policy marker"
    assert by_name["human"]["decided_by"] == "owner@example.test"


def test_bootstrap_returns_first_name_only(api):
    module, fake, _ = api
    fake.db.get_value = lambda *a, **kw: "Rishi Sharma"
    fake.get_roles = lambda user: ["System Manager"]
    out = module.bootstrap()
    assert out["user_name"] == "Rishi"
    fake.db.get_value = lambda *a, **kw: None
    assert module.bootstrap()["user_name"] == ""


def test_get_settings_returns_the_full_policy_without_secrets(api, monkeypatch):
    module, fake, _ = api
    settings = Row(
        enabled=1,
        approval_mode="Approve Writes Only",
        max_steps=30,
        allowed_read_doctypes="Customer\nSupplier",
        allowed_write_doctypes="ToDo",
        enabled_tools="search_records",
        api_key="never-exposed",
    )
    fake.get_single = lambda kind: settings
    out = module.get_settings()
    assert out["approval_mode"] == "Approve Writes Only"
    assert out["allowed_read_doctypes"] == "Customer\nSupplier"
    assert out["allowed_write_doctypes"] == "ToDo"
    assert out["enabled_tools"] == "search_records"
    assert out["enabled"] == 1
    assert out["max_steps"] == 30
    assert set(out) == set(module.SETTINGS_FIELDS)
    assert "never-exposed" not in str(out)


def test_save_settings_is_manager_only_and_normalizes_lines(api):
    module, fake, _ = api
    settings = Row(approval_mode="Approve Every Step", allowed_read_doctypes="")
    fake.get_single = lambda kind: settings
    with pytest.raises(PermissionError):
        module.save_settings(approval_mode="Automatic")
    fake.get_roles = lambda user=None: ["System Manager"]
    out = module.save_settings(
        approval_mode="Automatic",
        allowed_read_doctypes=["Customer", " Supplier ", "Customer", ""],
    )
    assert settings.approval_mode == "Automatic"
    assert out["allowed_read_doctypes"] == "Customer\nSupplier"
    out = module.save_settings(enabled_tools="search_records\nsearch_records\nread_record\n")
    assert out["enabled_tools"] == "search_records\nread_record"


def test_save_settings_rejects_bad_input_and_noops(api):
    module, fake, _ = api
    fake.get_roles = lambda user=None: ["System Manager"]
    fake.get_single = lambda kind: Row()
    with pytest.raises(ValueError, match="Unknown approval mode"):
        module.save_settings(approval_mode="Trust the model")
    with pytest.raises(ValueError, match="Invalid settings value"):
        module.save_settings(allowed_read_doctypes=42)
    with pytest.raises(ValueError, match="Nothing to save"):
        module.save_settings()
    with pytest.raises(ValueError, match="Unknown settings field"):
        module.save_settings(approval_expiry_days=3)
    with pytest.raises(ValueError, match="Invalid numeric"):
        module.save_settings(max_steps="many")


def test_save_settings_round_trips_ints_and_checks(api):
    module, fake, _ = api
    settings = Row(enabled=1, max_steps=30)
    fake.get_single = lambda kind: settings
    fake.get_roles = lambda user=None: ["System Manager"]
    out = module.save_settings(enabled="0", max_steps="12", daily_run_limit=50)
    assert settings.enabled == 0
    assert out["max_steps"] == 12
    assert out["daily_run_limit"] == 50


def test_save_settings_tolerates_the_routed_cmd_kwarg(api):
    """frappe.handler forwards all of form_dict to a **kwargs signature."""
    module, fake, _ = api
    settings = Row(approval_mode="Approve Writes Only")
    fake.get_single = lambda kind: settings
    fake.get_roles = lambda user=None: ["System Manager"]
    out = module.save_settings(
        cmd="frappe_intelligence.api.save_settings", approval_mode="Approve Every Step"
    )
    assert settings.approval_mode == "Approve Every Step"
    assert out["approval_mode"] == "Approve Every Step"


def test_list_grants_shows_own_rows_or_everything_for_managers(api):
    module, fake, store = api
    store["g1"] = Row(
        doctype="Intelligence Tool Grant",
        name="g1",
        user="owner@example.test",
        tool="write",
        scope_doctype="",
    )
    store["g2"] = Row(
        doctype="Intelligence Tool Grant",
        name="g2",
        user="other@example.test",
        tool="read",
        scope_doctype="Customer",
    )
    out = module.list_grants()
    assert [row["name"] for row in out] == ["g1"], "users see only their own grants"
    assert out[0]["scope_doctype"] == ""
    fake.get_roles = lambda user=None: ["Intelligence Manager"]
    out = module.list_grants()
    assert {row["name"] for row in out} == {"g1", "g2"}
    assert {row["name"]: row["scope_doctype"] for row in out}["g2"] == "Customer"


def test_revoke_grant_is_owner_or_manager_only(api):
    module, fake, store = api
    store["g1"] = Row(doctype="Intelligence Tool Grant", name="g1", user="owner@example.test")
    store["g2"] = Row(doctype="Intelligence Tool Grant", name="g2", user="other@example.test")
    with pytest.raises(PermissionError):
        module.revoke_grant("g2"), "users cannot revoke another user's grant"
    assert module.revoke_grant("g1") == {"deleted": True}
    assert "g1" not in store
    fake.get_roles = lambda user=None: ["Intelligence Manager"]
    module.revoke_grant("g2")
    assert "g2" not in store, "managers can revoke any grant"


def test_rename_conversation_marks_the_title_as_manual(api):
    module, _, store = api
    store["c"] = Row(
        doctype="Intelligence Conversation", name="c", owner="owner@example.test", title="New chat"
    )
    module.rename_conversation("c", "Quarterly close")
    assert store["c"].title == "Quarterly close"
    assert store["c"].title_manually_set == 1, "generated titles must never overwrite this name"
