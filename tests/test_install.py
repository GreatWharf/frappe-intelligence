import importlib
import sys
from types import ModuleType, SimpleNamespace

import pytest


@pytest.fixture
def installer(monkeypatch):
    fake = ModuleType("frappe")
    fake.__version__ = "16.0.0"
    created = []
    fake.db = SimpleNamespace(db_type="mariadb", exists=lambda doctype, name: name in created)
    fake.get_doc = lambda data: SimpleNamespace(insert=lambda **kw: created.append(data["role_name"]))
    fake.throw = lambda message: (_ for _ in ()).throw(ValueError(message))
    monkeypatch.setitem(sys.modules, "frappe", fake)
    monkeypatch.delitem(sys.modules, "frappe_intelligence.install", raising=False)
    module = importlib.import_module("frappe_intelligence.install")
    yield module, fake, created
    sys.modules.pop("frappe_intelligence.install", None)


def test_required_roles_exist_before_doctype_sync_and_creation_is_idempotent(installer):
    module, _, created = installer
    module.before_install()
    module.before_install()
    assert created == ["Intelligence User", "Intelligence Manager"]


def test_unsupported_stack_fails_before_creating_roles(installer):
    module, fake, created = installer
    fake.__version__ = "14.0.0"
    with pytest.raises(ValueError):
        module.before_install()
    assert created == []


EXPECTED_SKILLS = {
    "ingest-invoice": "Ingest a supplier invoice",
    "draft-email-reply": "Draft an email reply",
    "daily-briefing": "Daily briefing",
    "company-summary": "Company summary",
    "bank-reconciliation": "Bank reconciliation",
    "quote-request": "Answer a quote request",
}


@pytest.fixture
def migrator(monkeypatch):
    fake = ModuleType("frappe")
    fake.__version__ = "16.0.0"
    store = {}

    class Doc:
        def __init__(self, **data):
            self.__dict__.update(data)

        def get(self, key, default=None):
            return self.__dict__.get(key, default)

        def insert(self, **kwargs):
            name = self.__dict__.get("name") or self.__dict__.get("role_name") or f"doc-{len(store)}"
            self.__dict__.setdefault("name", name)
            store[(self.doctype, name)] = self
            return self

    fake.db = SimpleNamespace(
        db_type="mariadb",
        exists=lambda doctype, name: (doctype, name) in store,
        add_index=lambda *args: None,
    )

    def get_doc(data, name=None, **kwargs):
        if isinstance(data, dict):
            return Doc(**data)
        return store[(data, name)]

    fake.get_doc = get_doc
    fake.delete_doc = lambda doctype, name, **kw: store.pop((doctype, name), None)
    fake.throw = lambda message, exc=ValueError, **kw: (_ for _ in ()).throw(exc(message))
    monkeypatch.setitem(sys.modules, "frappe", fake)
    monkeypatch.delitem(sys.modules, "frappe_intelligence.install", raising=False)
    module = importlib.import_module("frappe_intelligence.install")
    yield module, fake, store
    sys.modules.pop("frappe_intelligence.install", None)


def seeded(store):
    return {name: doc for (doctype, name), doc in store.items() if doctype == "Intelligence Skill"}


def test_after_migrate_seeds_exactly_six_skills_idempotently(migrator):
    module, _, store = migrator
    module.after_migrate()
    module.after_migrate()
    skills = seeded(store)
    assert set(skills) == set(EXPECTED_SKILLS)
    for name, title in EXPECTED_SKILLS.items():
        doc = skills[name]
        assert doc.title == title
        assert doc.origin == "Seeded"
        assert doc.enabled == 1
        assert doc.shared == 1
        assert doc.version == 1


def test_after_migrate_preserves_user_edits_to_seeded_skills(migrator):
    module, _, store = migrator
    module.after_migrate()
    store[("Intelligence Skill", "daily-briefing")].instructions = "User-customized playbook."
    module.after_migrate()
    assert len(seeded(store)) == 6
    doc = store[("Intelligence Skill", "daily-briefing")]
    assert doc.instructions == "User-customized playbook."


def test_seed_scopes_keep_write_inside_read_and_playbooks_bounded(migrator):
    module, _, store = migrator
    module.after_migrate()
    for name in EXPECTED_SKILLS:
        doc = store[("Intelligence Skill", name)]
        read = {line.strip() for line in doc.scope_read.splitlines() if line.strip()}
        write = {line.strip() for line in doc.scope_write.splitlines() if line.strip()}
        assert write <= read
        assert 120 <= len(doc.instructions.split()) <= 300


def test_defaults_enable_the_skill_management_tools(migrator):
    module, _, _ = migrator
    tools = module.DEFAULTS["enabled_tools"].splitlines()
    for name in ("propose_skill", "update_skill", "retire_skill"):
        assert name in tools
    assert "search_records" in tools
    assert len(tools) == len(set(tools))


def navigation_docs(store, doctype):
    return [doc for (dt, _), doc in store.items() if dt == doctype]


def test_navigation_creates_sidebar_and_desktop_icon_and_drops_the_legacy_workspace(migrator):
    module, fake, store = migrator
    fake.get_doc({"doctype": "Workspace", "name": "Intelligence", "for_user": None}).insert()
    module.after_migrate()
    assert ("Workspace", "Intelligence") not in store, "the middleman workspace is deleted"
    sidebars = navigation_docs(store, "Workspace Sidebar")
    assert len(sidebars) == 1
    assert sidebars[0].title == "Intelligence" and sidebars[0].standard == 1
    assert sidebars[0].items == [
        {"type": "Link", "label": "Conversations", "link_type": "Page", "link_to": "intelligence"}
    ]
    icons = navigation_docs(store, "Desktop Icon")
    assert len(icons) == 1
    assert icons[0].label == "Intelligence"
    assert icons[0].logo_url == "/assets/frappe_intelligence/images/intelligence.svg"
    assert icons[0].link_to == "Intelligence"


def test_navigation_preserves_existing_and_user_owned_entries(migrator):
    module, fake, store = migrator
    sidebar = fake.get_doc(
        {"doctype": "Workspace Sidebar", "name": "Intelligence", "title": "Customized"}
    ).insert()
    icon = fake.get_doc({"doctype": "Desktop Icon", "name": "Intelligence", "hidden": 1}).insert()
    fake.get_doc({"doctype": "Workspace", "name": "Intelligence", "for_user": "alice"}).insert()
    module.after_migrate()
    assert navigation_docs(store, "Workspace Sidebar") == [sidebar]
    assert navigation_docs(store, "Desktop Icon") == [icon]
    assert ("Workspace", "Intelligence") in store, "a user's own workspace is left untouched"
