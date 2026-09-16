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
