"""Boundary tests: engine.get_provider_config feeds the REAL provider adapters.

The DocType stores capitalized Select labels ("OpenAI", "Custom", ...) while the
Frappe-independent protocol adapters key on lowercase kinds. These tests pin the
normalization at that boundary: the real serializers run and only the
lowest-level HTTP function is stubbed.
"""

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest

from frappe_intelligence import providers

KEY = "boundary-test-secret"
HOST = "models.example.test"
CUSTOM_BASE_URL = f"https://{HOST}/v1"
DOCTYPE_KINDS = ["Anthropic", "Custom", "Gemini", "OpenAI", "OpenRouter", "xAI"]


def canned_reply(kind):
    if kind == "anthropic":
        return {"content": [{"type": "text", "text": "Done"}], "stop_reason": "end_turn"}
    if kind == "gemini":
        return {"candidates": [{"content": {"parts": [{"text": "Done"}]}, "finishReason": "STOP"}]}
    return {
        "choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
    }


class Record(dict):
    def __getattr__(self, name):
        return self.get(name)

    __setattr__ = dict.__setitem__

    def check_permission(self, permission):
        if self.get("no_permission"):
            raise PermissionError(permission)

    def get_password(self, field):
        return self.get(field)


class Document(Record):
    def insert(self, **kwargs):
        schema = (
            Path(__file__).resolve().parents[1]
            / "frappe_intelligence"
            / "frappe_intelligence"
            / "doctype"
            / self.doctype.lower().replace(" ", "_")
        )
        path = schema / (schema.name + ".json")
        if path.exists():
            for field in json.loads(path.read_text())["fields"]:
                if field.get("reqd"):
                    assert self.get(field["fieldname"]) not in (None, ""), (
                        f"Missing mandatory {self.doctype}.{field['fieldname']}"
                    )
        self.setdefault("name", f"doc-{len(self._fake.rows) + 1}")
        self.setdefault("owner", self._fake.session.user)
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def save(self, **kwargs):
        self._fake.rows[(self.doctype, self.name)] = self
        return self


class Database:
    def __init__(self, fake):
        self.fake = fake

    def get_value(self, doctype, name, field="name", **kwargs):
        rows = (
            self.fake.get_all(doctype, filters=name)
            if isinstance(name, dict)
            else [self.fake.rows.get((doctype, name))]
        )
        row = next((r for r in rows if r), None)
        if row is None:
            return None
        if isinstance(field, (tuple, list)):
            values = Record({key: row.get(key) for key in field})
            return values if kwargs.get("as_dict") else tuple(values.values())
        return row.get(field)

    def exists(self, doctype, name):
        return self.get_value(doctype, name)


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self.rows = {}
        self.session = Record(user="alice")
        self.flags = Record()
        self.db = Database(self)
        self.PermissionError = PermissionError
        self.ValidationError = ValueError
        self.DoesNotExistError = LookupError
        self.roles = {"alice": ["Intelligence User"]}
        self.settings = Record(enabled=1, max_tokens=4096, allowed_custom_hosts="")
        self.seed("User", "alice", enabled=1, user_type="System User")
        self.seed(
            "Intelligence Provider",
            "provider",
            owner="alice",
            enabled=1,
            kind="OpenAI",
            model="test-model",
            api_key=KEY,
            base_url="",
            is_shared=0,
            timeout=30,
            max_tokens=256,
        )

    def seed(self, doctype, name, **values):
        record = Document(dict(values, doctype=doctype, name=name, _fake=self))
        self.rows[(doctype, name)] = record
        return record

    def get_doc(self, doctype, name=None, **kwargs):
        if isinstance(doctype, dict):
            return Document(dict(doctype, _fake=self))
        record = self.rows.get((doctype, name))
        if record is None:
            raise LookupError(name)
        return record

    def get_single(self, doctype):
        return self.settings

    def get_roles(self, user=None):
        return self.roles.get(user or self.session.user, [])

    def throw(self, message, exc=ValueError, **kwargs):
        raise exc(message)

    def get_all(self, doctype, filters=None, **kwargs):
        def matches(row):
            return all(row.get(field) == expected for field, expected in (filters or {}).items())

        return [row for (dt, _), row in self.rows.items() if dt == doctype and matches(row)]


@pytest.fixture
def env(monkeypatch):
    fake = FakeFrappe()
    monkeypatch.setitem(sys.modules, "frappe", fake)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    engine = importlib.import_module("frappe_intelligence.engine")
    access = importlib.import_module("frappe_intelligence.access")
    service = importlib.import_module("frappe_intelligence.provider_service")
    monkeypatch.setattr(engine, "frappe", fake)
    monkeypatch.setattr(access, "frappe", fake)
    monkeypatch.setattr(service, "frappe", fake)
    return Record(frappe=fake, engine=engine, access=access, service=service)


def complete(config, reply):
    with patch("frappe_intelligence.providers.adapters.post_json", return_value=reply) as transport:
        result = providers.complete(config, [{"role": "user", "content": "Hi"}], [])
    return result, transport.call_args.kwargs


def test_saved_provider_kind_drives_the_real_adapter(env):
    """Regression: the saved DocType kind ("OpenAI") must reach the lowercase adapter."""
    config = env.engine.get_provider_config("provider")
    reply, request = complete(config, canned_reply(config.kind))
    assert reply.text == "Done"
    assert request["url"] == "https://api.openai.com/v1/chat/completions"
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert reply.usage == {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}


@pytest.mark.parametrize("kind", DOCTYPE_KINDS)
def test_every_doctype_kind_maps_to_a_working_adapter_kind(env, kind):
    assert kind in env.service.KINDS
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    doc.kind = kind
    if kind == "Custom":
        doc.base_url = CUSTOM_BASE_URL
        env.frappe.settings.allowed_custom_hosts = HOST
    config = env.engine.get_provider_config("provider")
    assert config.kind == kind.lower()
    assert config.kind in providers.KINDS
    reply, _ = complete(config, canned_reply(kind.lower()))
    assert reply.text == "Done"


def test_doctype_kinds_lowercase_exactly_to_the_adapter_kinds(env):
    assert {kind.lower() for kind in env.service.KINDS} == providers.KINDS
    assert set(DOCTYPE_KINDS) == set(env.service.KINDS)


def test_custom_provider_posts_to_base_url_with_bearer_auth_and_no_stream(env):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    doc.kind = "Custom"
    doc.base_url = CUSTOM_BASE_URL
    env.frappe.settings.allowed_custom_hosts = HOST
    config = env.engine.get_provider_config("provider")
    reply, request = complete(config, canned_reply("custom"))
    assert reply.text == "Done"
    assert request["url"] == f"{CUSTOM_BASE_URL}/chat/completions"
    assert request["allowed_hosts"] == (HOST,)
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert not request["payload"].get("stream")
    assert KEY not in json.dumps(request["payload"])
    assert KEY not in request["url"]


def test_custom_provider_save_requires_an_allowlisted_host(env):
    env.frappe.settings.allowed_custom_hosts = ""
    with pytest.raises(ValueError, match="allowlist"):
        env.service.save_provider(
            title="Custom", kind="Custom", model="test-model", api_key=KEY, base_url=CUSTOM_BASE_URL
        )
    env.frappe.settings.allowed_custom_hosts = HOST
    saved = env.service.save_provider(
        title="Custom", kind="Custom", model="test-model", api_key=KEY, base_url=CUSTOM_BASE_URL
    )
    assert saved["kind"] == "Custom"
    assert saved["base_url"] == CUSTOM_BASE_URL
    assert "api_key" not in saved
