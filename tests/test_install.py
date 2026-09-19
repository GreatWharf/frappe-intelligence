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


def test_after_migrate_backfills_empty_defaults_and_keeps_chosen_values(migrator):
    module, fake, _ = migrator
    settings = fake.get_single("Intelligence Settings")
    settings.set("approval_mode", "Automatic")
    settings.set("max_steps", None)
    module.after_migrate()
    assert settings.get("approval_mode") == "Automatic"
    assert settings.get("max_steps") == module.DEFAULTS["max_steps"]


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
    fake.flags = SimpleNamespace(in_import=False)

    # The app's own doctypes autoname by hash. Real Frappe naming discards a
    # name passed in the document dict unless the insert runs under
    # frappe.flags.in_import (the fixture-sync path), then generates a random
    # hash name; framework doctypes seeded here (Workspace, Desktop Icon, ...)
    # keep their prompt/field-derived names either way.
    HASH_NAMED = {
        "Intelligence Skill",
        "Intelligence Policy",
        "Intelligence Conversation",
        "Intelligence Message",
        "Intelligence Run",
        "Intelligence Approval",
        "Intelligence Tool Execution",
        "Intelligence Tool Grant",
        "Intelligence Memory",
        "Intelligence Provider",
    }

    class Doc:
        def __init__(self, **data):
            self.__dict__.update(data)

        def get(self, key, default=None):
            return self.__dict__.get(key, default)

        def set(self, key, value):
            self.__dict__[key] = value

        def append(self, field, value):
            self.__dict__.setdefault(field, []).append(value)

        def save(self, **kwargs):
            store[(self.doctype, self.__dict__.get("name", self.doctype))] = self
            return self

        def insert(self, **kwargs):
            name = self.__dict__.get("name")
            if self.doctype in HASH_NAMED and not fake.flags.in_import:
                name = None  # hash autoname wipes the dict-passed name
            if not name:
                name = (
                    self.__dict__.get("title")
                    or self.__dict__.get("label")
                    or self.__dict__.get("role_name")
                    or f"doc-{len(store)}"
                )
            self.__dict__["name"] = name
            store[(self.doctype, name)] = self
            return self

    jobs = []
    fake.db = SimpleNamespace(
        db_type="mariadb",
        exists=lambda doctype, name: (doctype, name) in store,
        add_index=lambda *args: None,
    )
    fake.enqueue = lambda method, **kwargs: jobs.append((method, kwargs))
    fake.jobs = jobs

    def get_doc(data, name=None, **kwargs):
        if isinstance(data, dict):
            return Doc(**data)
        return store[(data, name)]

    fake.get_doc = get_doc
    singles = {}

    def get_single(doctype):
        if doctype not in singles:
            singles[doctype] = Doc(doctype=doctype, name=doctype)
        return singles[doctype]

    fake.get_single = get_single
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


def test_hash_named_doctypes_discard_dict_names_outside_the_import_context(migrator):
    """Pin the real-Frappe naming rule the seed idempotency relies on.

    Both seeded doctypes autoname by hash: a name passed in the document dict
    is discarded on insert unless frappe.flags.in_import is set (the fixture
    sync mechanism). If the fake ever stops emulating this, the seed
    idempotency tests silently assert the mock instead of the behavior.
    """
    _, fake, _ = migrator
    doc = fake.get_doc({"doctype": "Intelligence Policy", "name": "chosen", "decision": "Deny"}).insert()
    assert doc.name != "chosen", "hash autoname mints its own name outside the import context"
    fake.flags.in_import = True
    try:
        doc = fake.get_doc({"doctype": "Intelligence Policy", "name": "chosen", "decision": "Deny"}).insert()
        assert doc.name == "chosen", "the import context preserves the provided name"
    finally:
        fake.flags.in_import = False


def test_seed_inserts_keep_deterministic_names_and_restore_the_import_flag(migrator):
    module, fake, store = migrator
    module.after_migrate()
    assert fake.flags.in_import is False, "the import context never leaks past a seed insert"
    assert ("Intelligence Policy", "example-read-auto-approve") in store
    assert ("Intelligence Policy", "example-delete-require-approval") in store
    assert ("Intelligence Skill", "ingest-invoice") in store
    module.after_migrate()
    assert len([key for key in store if key[0] == "Intelligence Policy"]) == 2
    assert len([key for key in store if key[0] == "Intelligence Skill"]) == 6


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


EXPECTED_SIDEBAR = [
    {"type": "Link", "label": "Chat", "link_type": "Page", "link_to": "intelligence"},
    {
        "type": "Link",
        "label": "Conversations",
        "link_type": "DocType",
        "link_to": "Intelligence Conversation",
    },
    {
        "type": "Link",
        "label": "Always-allowed tools",
        "link_type": "DocType",
        "link_to": "Intelligence Tool Grant",
    },
    {"type": "Link", "label": "Providers", "link_type": "DocType", "link_to": "Intelligence Provider"},
    {"type": "Link", "label": "Skills", "link_type": "DocType", "link_to": "Intelligence Skill"},
    {"type": "Link", "label": "Memory", "link_type": "DocType", "link_to": "Intelligence Memory"},
    {"type": "Link", "label": "Settings", "link_type": "DocType", "link_to": "Intelligence Settings"},
]

EXPECTED_V15_LINKS = [
    {"label": "Chat", "type": "Card Break"},
    {"label": "Chat", "type": "Link", "link_type": "Page", "link_to": "intelligence"},
    {"label": "Manage", "type": "Card Break"},
    {
        "label": "Conversations",
        "type": "Link",
        "link_type": "DocType",
        "link_to": "Intelligence Conversation",
    },
    {
        "label": "Always-allowed tools",
        "type": "Link",
        "link_type": "DocType",
        "link_to": "Intelligence Tool Grant",
    },
    {"label": "Providers", "type": "Link", "link_type": "DocType", "link_to": "Intelligence Provider"},
    {"label": "Skills", "type": "Link", "link_type": "DocType", "link_to": "Intelligence Skill"},
    {"label": "Memory", "type": "Link", "link_type": "DocType", "link_to": "Intelligence Memory"},
    {"label": "Settings", "type": "Link", "link_type": "DocType", "link_to": "Intelligence Settings"},
]


def by_title(docs):
    return {doc.title: doc for doc in docs}


def test_navigation_creates_sidebar_and_desktop_icon_and_drops_the_legacy_workspace(migrator):
    module, fake, store = migrator
    fake.get_doc({"doctype": "Workspace", "name": "Intelligence", "for_user": None}).insert()
    module.after_migrate()
    assert ("Workspace", "Intelligence") not in store, "the middleman workspace is deleted"
    sidebars = by_title(navigation_docs(store, "Workspace Sidebar"))
    assert set(sidebars) == {"Intelligence", "Frappe Intelligence"}
    sidebar = sidebars["Intelligence"]
    assert sidebar.standard == 1 and sidebar.app == "frappe_intelligence"
    assert sidebar.module == "Frappe Intelligence", (
        "sidebar title labels Desk; module stays the DocType group"
    )
    assert sidebar.items == EXPECTED_SIDEBAR
    sentinel = sidebars["Frappe Intelligence"]
    assert sentinel.items == [] and sentinel.app == "frappe_intelligence" and sentinel.standard == 1
    icons = navigation_docs(store, "Desktop Icon")
    assert len(icons) == 1
    assert icons[0].label == "Intelligence"
    assert icons[0].logo_url == "/assets/frappe_intelligence/images/intelligence.svg"
    assert icons[0].link_to == "Intelligence"


def test_navigation_is_idempotent_across_migrates(migrator):
    module, _, store = migrator
    module.after_migrate()
    module.after_migrate()
    sidebars = navigation_docs(store, "Workspace Sidebar")
    assert len(sidebars) == 2
    assert by_title(sidebars)["Intelligence"].items == EXPECTED_SIDEBAR
    assert len(navigation_docs(store, "Desktop Icon")) == 1


def test_navigation_converges_the_seeded_sidebar_in_place(migrator):
    module, fake, store = migrator
    old = fake.get_doc(
        {
            "doctype": "Workspace Sidebar",
            "title": "Intelligence",
            "standard": 1,
            "app": "frappe_intelligence",
            "items": [
                {"type": "Link", "label": "Conversations", "link_type": "Page", "link_to": "intelligence"}
            ],
        }
    ).insert()
    module.after_migrate()
    sidebar = store[("Workspace Sidebar", "Intelligence")]
    assert sidebar is old, "the seeded sidebar is updated in place, not replaced"
    assert sidebar.items == EXPECTED_SIDEBAR
    assert sidebar.module == "Frappe Intelligence"


def test_navigation_preserves_existing_and_user_owned_entries(migrator):
    module, fake, store = migrator
    sidebar = fake.get_doc(
        {"doctype": "Workspace Sidebar", "name": "Intelligence", "title": "Customized"}
    ).insert()
    fake.get_doc({"doctype": "Workspace", "name": "Intelligence", "for_user": "alice"}).insert()
    module.after_migrate()
    sidebars = navigation_docs(store, "Workspace Sidebar")
    assert sidebar in sidebars and sidebar.get("items") is None, "a site's own sidebar is untouched"
    assert any(doc.title == "Frappe Intelligence" and not doc.items for doc in sidebars), (
        "the module-name sentinel still suppresses the auto-generated sidebar"
    )
    assert ("Workspace", "Intelligence") in store, "a user's own workspace is left untouched"


def test_navigation_claims_a_same_named_legacy_desktop_icon(migrator):
    """Pre-0.4 seeds left an untagged icon that shadowed the app on the apps screen."""
    module, fake, store = migrator
    icon = fake.get_doc({"doctype": "Desktop Icon", "name": "Intelligence", "hidden": 1}).insert()
    module.after_migrate()
    icons = navigation_docs(store, "Desktop Icon")
    assert icons == [icon], "the legacy icon is claimed in place, never duplicated"
    assert icon.label == "Intelligence"
    assert icon.icon_type == "App" and icon.standard == 1
    assert icon.app == "frappe_intelligence"
    assert icon.link_type == "Workspace Sidebar" and icon.link_to == "Intelligence"
    assert icon.logo_url == "/assets/frappe_intelligence/images/intelligence.svg"
    assert icon.hidden == 0
    assert [row["role"] for row in icon.roles] == list(module.USER_ROLES)
    module.after_migrate()
    assert navigation_docs(store, "Desktop Icon") == [icon], "convergence is idempotent"


def test_navigation_hides_the_legacy_module_named_app_icon(migrator):
    """The auto module icon is a second, wrongly labeled way in; it goes hidden."""
    module, fake, store = migrator
    legacy = fake.get_doc(
        {
            "doctype": "Desktop Icon",
            "name": "Frappe Intelligence",
            "label": "Frappe Intelligence",
            "icon_type": "App",
            "app": "frappe_intelligence",
            "hidden": 0,
        }
    ).insert()
    module.after_migrate()
    assert store[("Desktop Icon", "Frappe Intelligence")] is legacy
    assert legacy.hidden == 1
    visible = [doc for doc in navigation_docs(store, "Desktop Icon") if not doc.get("hidden")]
    assert [doc.label for doc in visible] == ["Intelligence"]


def test_navigation_never_touches_another_apps_icon(migrator):
    module, fake, store = migrator
    foreign = fake.get_doc(
        {"doctype": "Desktop Icon", "name": "Intelligence", "app": "other_app", "hidden": 0}
    ).insert()
    module.after_migrate()
    assert foreign.hidden == 0 and foreign.get("standard") is None, (
        "an icon named Intelligence owned by another app is left alone"
    )


def test_v15_workspace_links_chat_and_manage_groups(migrator):
    module, fake, store = migrator
    fake.__version__ = "15.0.0"
    module.after_migrate()
    workspace = store[("Workspace", "Intelligence Chat")]
    assert workspace.module == "Frappe Intelligence"
    assert workspace.links == EXPECTED_V15_LINKS
    assert not navigation_docs(store, "Workspace Sidebar"), "v15 has no Workspace Sidebar doctype"


def test_v15_workspace_links_converge_on_migrate(migrator):
    module, fake, store = migrator
    fake.__version__ = "15.0.0"
    fake.get_doc(
        {
            "doctype": "Workspace",
            "label": "Intelligence Chat",
            "title": "Intelligence Chat",
            "module": "Frappe Intelligence",
            "public": 1,
            "links": [
                {"label": "Conversations", "type": "Link", "link_type": "Page", "link_to": "intelligence"}
            ],
        }
    ).insert()
    module.after_migrate()
    assert store[("Workspace", "Intelligence Chat")].links == EXPECTED_V15_LINKS
    module.after_migrate()
    assert len(navigation_docs(store, "Workspace")) == 1


def test_default_approval_mode_is_writes_only_and_backfill_preserves_choice(migrator):
    module, fake, _ = migrator
    assert module.DEFAULTS["approval_mode"] == "Approve Writes Only"
    settings = fake.get_single("Intelligence Settings")
    module.after_migrate()
    assert settings.get("approval_mode") == "Approve Writes Only"
    settings.set("approval_mode", "Approve Every Step")
    module.after_migrate()
    assert settings.get("approval_mode") == "Approve Every Step", "a site's choice is never overwritten"


def test_global_search_registers_conversations_once(migrator):
    module, fake, store = migrator
    fake.get_doc({"doctype": "DocType", "name": "Intelligence Conversation"}).insert()
    module.after_migrate()
    settings = fake.get_single("Global Search Settings")
    rows = [row["document_type"] for row in settings.get("allowed_in_global_search")]
    assert rows == ["Intelligence Conversation"]
    rebuilds = [job for job in fake.jobs if job[0] == "frappe.utils.global_search.rebuild_for_doctype"]
    assert len(rebuilds) == 1 and rebuilds[0][1]["doctype"] == "Intelligence Conversation"
    module.after_migrate()
    rows = [row["document_type"] for row in settings.get("allowed_in_global_search")]
    assert rows == ["Intelligence Conversation"], "no duplicate row on the next migrate"
    assert len([job for job in fake.jobs if job[0] == "frappe.utils.global_search.rebuild_for_doctype"]) == 1
