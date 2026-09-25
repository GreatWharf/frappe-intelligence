import importlib
import sys
from types import ModuleType

import pytest
from test_services import Row
from test_services import services as services


@pytest.fixture
def documents(services, monkeypatch):
    fake, _ = services
    document_module = ModuleType("frappe.model.document")

    class Document(Row):
        def get_doc_before_save(self):
            return self.get("old")

        def get_password(self, fieldname="password", raise_exception=True):
            return self.get(fieldname)

    document_module.Document = Document
    monkeypatch.setitem(sys.modules, "frappe.model.document", document_module)
    return importlib.import_module("frappe_intelligence.documents"), fake


def test_managed_records_reject_direct_create_edit_delete_and_rename(documents):
    module, fake = documents
    doc = module.ManagedDocument(owner="owner@example.test")
    for operation in (doc.validate, doc.on_trash, doc.before_rename):
        with pytest.raises(PermissionError):
            operation()
    fake.flags.intelligence_internal = True
    doc.validate()


@pytest.mark.parametrize("shared", [0, 1])
def test_native_password_access_cannot_decrypt_another_users_key(documents, monkeypatch, shared):
    _, fake = documents
    fake.get_roles = lambda user=None: ["System Manager"]
    name = "frappe_intelligence.frappe_intelligence.doctype.intelligence_provider.intelligence_provider"
    monkeypatch.delitem(sys.modules, name, raising=False)
    provider_class = importlib.import_module(name).IntelligenceProvider
    provider = provider_class(
        name="p", owner="other@example.test", enabled=1, is_shared=shared, api_key="private-key"
    )
    with pytest.raises(PermissionError):
        provider.get_password("api_key")
    fake.flags.intelligence_internal = True
    with pytest.raises(PermissionError):
        provider.get_password("api_key")
    if shared:
        fake.flags.intelligence_provider_secret = ("p", fake.session.user)
        assert provider.get_password("api_key") == "private-key"
        fake.flags.intelligence_provider_secret = ("different", fake.session.user)
        with pytest.raises(PermissionError):
            provider.get_password("api_key")
    monkeypatch.delitem(sys.modules, name, raising=False)


def test_internal_updates_cannot_transfer_record_ownership(documents):
    module, fake = documents
    fake.flags.intelligence_internal = True
    doc = module.ManagedDocument(owner="other@example.test", old=Row(owner="owner@example.test"))
    with pytest.raises(PermissionError):
        doc.validate()


PROVIDER_SAVED = dict(
    doctype="Intelligence Provider",
    name="p",
    owner="owner@example.test",
    title="Work",
    kind="OpenAI",
    model="test-model",
    thinking_effort="Auto",
    models="test-model",
    model_efforts="",
    api_key=None,
    base_url="",
    is_shared=0,
    enabled=1,
    allowed_roles="",
    max_tokens=16384,
    timeout=60,
)


def native_provider_edit(module, saved_fields=None, **changes):
    """A provider as the Desk form submits it, with its saved snapshot attached."""
    saved = Row(dict(PROVIDER_SAVED, **(saved_fields or {})))
    doc = module.ManagedDocument(dict(saved, **changes))
    doc["old"] = saved
    return doc


@pytest.mark.parametrize(
    "field,value",
    [
        ("title", "Renamed"),
        ("max_tokens", 262144),
        ("timeout", 90),
        ("thinking_effort", "High"),
        ("enabled", 0),
        ("models", "a-model\nb-model"),
    ],
)
def test_provider_form_save_allows_whitelisted_operational_fields(documents, field, value):
    module, _ = documents
    native_provider_edit(module, **{field: value}).validate()


@pytest.mark.parametrize(
    "field,value",
    [
        ("kind", "Anthropic"),
        ("model", "other-model"),
        ("base_url", "https://evil.example/v1"),
        ("api_key", "typed-key"),
        ("is_shared", 1),
        ("allowed_roles", "Intelligence User"),
        ("owner", "other@example.test"),
        ("model_efforts", '{"test-model": ["Low"]}'),
    ],
)
def test_provider_form_save_rejects_protected_fields(documents, field, value):
    module, _ = documents
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        native_provider_edit(module, **{field: value}).validate()


def test_provider_form_save_is_owner_only_for_personal_providers(documents):
    module, fake = documents
    fake.session.user = "other@example.test"
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        native_provider_edit(module, title="Stolen").validate()


def test_shared_provider_form_save_requires_a_manager(documents):
    module, fake = documents
    # The owner alone is not enough once the provider is shared.
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        native_provider_edit(module, saved_fields={"is_shared": 1}, title="Renamed").validate()
    fake.get_roles = lambda user=None: ["Intelligence Manager"]
    native_provider_edit(module, saved_fields={"is_shared": 1}, title="Renamed").validate()
    # A manager who is not the owner may edit a shared provider.
    fake.session.user = "manager@example.test"
    native_provider_edit(module, saved_fields={"is_shared": 1}, max_tokens=100000).validate()


def test_provider_form_create_stays_api_only(documents):
    module, _ = documents
    doc = module.ManagedDocument(dict(PROVIDER_SAVED))  # no saved snapshot: an insert
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        doc.validate()


def test_provider_form_save_rejects_users_without_intelligence_access(documents, monkeypatch):
    module, _ = documents
    access = sys.modules["frappe_intelligence.access"]
    monkeypatch.setattr(access, "require_user", lambda: (_ for _ in ()).throw(PermissionError()))
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        native_provider_edit(module, title="Renamed").validate()


def test_other_managed_doctypes_have_no_native_save(documents):
    module, _ = documents
    saved = Row(doctype="Intelligence Conversation", owner="owner@example.test", title="Old")
    doc = module.ManagedDocument(doctype="Intelligence Conversation", owner="owner@example.test", title="New")
    doc["old"] = saved
    with pytest.raises(PermissionError, match="Intelligence workspace"):
        doc.validate()


def test_provider_deletes_and_renames_stay_api_only(documents):
    module, _ = documents
    doc = native_provider_edit(module, title="Renamed")
    for operation in (doc.on_trash, doc.before_rename, doc.before_submit, doc.before_cancel):
        with pytest.raises(PermissionError, match="Intelligence workspace"):
            operation()


def test_settings_token_ceiling_allows_large_output_budgets(documents, monkeypatch):
    module, fake = documents
    fake.get_roles = lambda user=None: ["System Manager"]
    monkeypatch.setattr(module.SettingsDocument, "_validate_write_scope", lambda self: None)
    doc = module.SettingsDocument(
        max_steps=30,
        max_tokens=262144,
        max_run_seconds=600,
        approval_expiry_minutes=1440,
        max_upload_mb=10,
        max_file_chars=30000,
        daily_run_limit=100,
        allowed_custom_hosts="",
    )
    doc.validate()
    doc.max_tokens = 262145
    with pytest.raises(ValueError, match="max_tokens"):
        doc.validate()
