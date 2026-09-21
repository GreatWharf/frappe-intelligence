import importlib
import sys
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace

import pytest


class Row(dict):
    def __getattr__(self, key):
        if key.startswith("__"):
            raise AttributeError(key)
        return self.get(key)

    __setattr__ = dict.__setitem__

    def save(self, **kwargs):
        return self

    def insert(self, **kwargs):
        self.name = self.get("name") or f"record-{len(self.store)}"
        self.owner = "owner@example.test"
        self.store[self.name] = self
        return self

    def get_password(self, field, **kwargs):
        return self.get(field)

    def check_permission(self, *args):
        return None


@pytest.fixture
def services(monkeypatch):
    store = {}
    fake = ModuleType("frappe")
    fake.session = SimpleNamespace(user="owner@example.test")
    fake.PermissionError = PermissionError
    fake.ValidationError = ValueError
    fake.flags = Row()
    fake._dict = Row
    fake.throw = lambda message, exc=ValueError, **kw: (_ for _ in ()).throw(exc(message))
    fake.get_roles = lambda user=None: ["Intelligence User"]
    fake.db = SimpleNamespace(exists=lambda *a, **kw: False, escape=lambda s: repr(s))

    def get_doc(kind, name=None, **kwargs):
        if isinstance(kind, dict):
            doc = Row(kind)
            object.__setattr__(doc, "store", store)
            return doc
        return store[name]

    fake.get_doc = get_doc
    fake.get_all = lambda kind, **kw: [row for row in store.values() if row.doctype == kind]
    fake.delete_doc = lambda kind, name, **kw: store.pop(name)

    def share_add(doctype, name, user=None, read=1, write=0, everyone=0, **kw):
        for row in store.values():
            if (
                row.doctype == "DocShare"
                and row.share_doctype == doctype
                and row.share_name == name
                and row.get("user") == user
            ):
                return row
        row = Row(
            doctype="DocShare",
            name="ds-%d" % (len([r for r in store.values() if r.doctype == "DocShare"]) + 1),
            user=user,
            share_doctype=doctype,
            share_name=name,
            read=1 if read else 0,
            write=1 if write else 0,
            everyone=1 if everyone else 0,
        )
        store[row.name] = row
        return row

    def share_remove(doctype, name, user, flags=None):
        for key, row in list(store.items()):
            if (
                row.doctype == "DocShare"
                and row.share_doctype == doctype
                and row.share_name == name
                and row.get("user") == user
            ):
                store.pop(key)

    def share_get_users(doctype, name):
        return [
            row
            for row in store.values()
            if row.doctype == "DocShare" and row.share_doctype == doctype and row.share_name == name
        ]

    def share_get_shared(doctype, user=None, rights=None, **kw):
        user = user or fake.session.user
        rights = rights or ["read"]
        return [
            {"share_name": row.share_name}
            for row in store.values()
            if row.doctype == "DocShare"
            and row.share_doctype == doctype
            and (row.get("user") == user or row.get("everyone"))
            and all(row.get(right) for right in rights)
        ]

    fake.share = SimpleNamespace(
        add=share_add, remove=share_remove, get_users=share_get_users, get_shared=share_get_shared
    )
    access = ModuleType("frappe_intelligence.access")
    access.MANAGER_ROLES = frozenset({"Intelligence Manager", "System Manager"})
    access.USER_ROLES = frozenset({"Intelligence User", "Intelligence Manager", "System Manager"})
    access.require_user = lambda: fake.session.user

    def manager():
        if "System Manager" not in fake.get_roles():
            raise PermissionError("Manager required")
        return fake.session.user

    access.require_manager = manager
    access.get_settings = lambda: Row(allowed_custom_hosts="models.example.test", max_upload_mb=10)
    access.can_use_provider = lambda doc, user=None: bool(
        doc.enabled and (doc.owner == (user or fake.session.user) or doc.is_shared)
    )

    def conversation(name, write=False):
        doc = store[name]
        if doc.owner != fake.session.user:
            raise PermissionError("Not permitted")
        return doc

    access.get_conversation = conversation
    access.has_read_share = lambda name, user: bool(
        next(
            (
                row
                for row in store.values()
                if row.doctype == "DocShare"
                and row.share_doctype == "Intelligence Conversation"
                and row.share_name == name
                and row.get("read")
                and (row.get("user") == user or row.get("everyone"))
            ),
            None,
        )
    )
    access.shared_conversation_names = lambda user: [
        row.share_name
        for row in store.values()
        if row.doctype == "DocShare"
        and row.share_doctype == "Intelligence Conversation"
        and row.get("read")
        and (row.get("user") == user or row.get("everyone"))
    ]

    @contextmanager
    def internal():
        yield

    access.internal_write = internal
    utils = ModuleType("frappe.utils")
    utils.cint = lambda value: int(value or 0)
    utils.now_datetime = lambda: "2026-09-16 00:00:00"
    monkeypatch.setitem(sys.modules, "frappe", fake)
    monkeypatch.setitem(sys.modules, "frappe.utils", utils)
    monkeypatch.setitem(sys.modules, "frappe_intelligence.access", access)
    modules = [
        "frappe_intelligence.provider_service",
        "frappe_intelligence.memory",
        "frappe_intelligence.files",
        "frappe_intelligence.documents",
        "frappe_intelligence.rag",
    ]
    for name in modules:
        monkeypatch.delitem(sys.modules, name, raising=False)
    yield fake, store
    for name in modules:
        sys.modules.pop(name, None)


def test_personal_provider_cannot_be_read_or_edited_by_another_user(services):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner="other@example.test",
        enabled=1,
        is_shared=0,
        api_key="secret",
    )
    module = importlib.import_module("frappe_intelligence.provider_service")
    with pytest.raises(PermissionError):
        module.provider_details("p")
    with pytest.raises(PermissionError):
        module.save_provider(name="p", title="Changed", kind="OpenAI", model="test-model", api_key="new")


def test_provider_details_never_include_key_and_blank_update_preserves_key(services):
    _, store = services
    module = importlib.import_module("frappe_intelligence.provider_service")
    created = module.save_provider(title="Personal", kind="OpenAI", model="test-model", api_key="secret")
    assert "secret" not in str(created)
    assert created["has_api_key"] is True
    updated = module.save_provider(
        name=created["name"], title="Renamed", kind="OpenAI", model="test-model", api_key=""
    )
    assert store[created["name"]].api_key == "secret"
    assert "api_key" not in updated


def test_shared_provider_requires_manager_and_custom_host_is_allowlisted(services):
    module = importlib.import_module("frappe_intelligence.provider_service")
    with pytest.raises(PermissionError):
        module.save_provider(title="Shared", kind="OpenAI", model="m", api_key="secret", is_shared=1)
    with pytest.raises(ValueError):
        module.save_provider(
            title="Custom", kind="Custom", model="m", api_key="secret", base_url="https://evil.example/v1"
        )


def test_provider_routing_cannot_change_after_conversation_exists(services):
    fake, _ = services
    module = importlib.import_module("frappe_intelligence.provider_service")
    provider = module.save_provider(title="Personal", kind="OpenAI", model="test-model", api_key="secret")
    fake.db.exists = lambda *a, **kw: True
    with pytest.raises(ValueError, match="new provider"):
        module.save_provider(
            name=provider["name"], title="Personal", kind="Anthropic", model="new-model", api_key="new-key"
        )


def test_provider_update_preserves_omitted_role_restrictions_and_limits(services):
    fake, store = services
    fake.get_roles = lambda user=None: ["System Manager"]
    module = importlib.import_module("frappe_intelligence.provider_service")
    created = module.save_provider(
        title="Restricted",
        kind="OpenAI",
        model="m",
        api_key="secret",
        is_shared=1,
        enabled=0,
        allowed_roles="Intelligence Manager",
        max_tokens=2048,
        timeout=25,
    )
    module.save_provider(name=created["name"], title="Renamed", kind="OpenAI", model="m")
    doc = store[created["name"]]
    assert doc.allowed_roles == "Intelligence Manager"
    assert doc.max_tokens == 2048
    assert doc.timeout == 25
    assert doc.is_shared == 1
    assert doc.enabled == 0
    module.save_provider(name=created["name"], title="Renamed", kind="OpenAI", model="m", allowed_roles="")
    assert doc.allowed_roles == ""


def test_memory_cannot_cross_owners_or_conversations(services):
    _, store = services
    module = importlib.import_module("frappe_intelligence.memory")
    store["foreign"] = Row(doctype="Intelligence Conversation", name="foreign", owner="other@example.test")
    with pytest.raises(PermissionError):
        module.save_memory("Private", scope="conversation", conversation="foreign")
    store["memory"] = Row(
        doctype="Intelligence Memory",
        name="memory",
        scope="personal",
        owner="other@example.test",
        content="private",
        enabled=1,
    )
    with pytest.raises(PermissionError):
        module.delete_memory("memory")


def test_site_memory_is_manager_curated_and_content_is_bounded(services):
    module = importlib.import_module("frappe_intelligence.memory")
    with pytest.raises(PermissionError):
        module.save_memory("Global", scope="site")
    with pytest.raises(ValueError):
        module.save_memory("x" * 5001)
    saved = module.save_memory("Prefer concise answers.")
    assert saved["scope"] == "personal"
    assert saved["content"] == "Prefer concise answers."
