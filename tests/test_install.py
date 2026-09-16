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
