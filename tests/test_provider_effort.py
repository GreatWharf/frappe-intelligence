"""Thinking-effort configuration: validation, public exposure and wire mapping.

The provider DocType stores one of Auto/Low/Medium/High/Max. The engine passes
it through on ProviderConfig ("" for Auto/blank) and only the OpenAI-compatible
wires (openai/custom) serialize it as reasoning_effort; every other adapter
ignores it for now.
"""

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest

from frappe_intelligence import providers

KEY = "effort-test-secret"
HOST = "models.example.test"
CUSTOM_BASE_URL = f"https://{HOST}/v1"
EFFORTS = ["Auto", "Low", "Medium", "High", "Max"]


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
        self.whitelist = lambda *a, **kw: lambda f: f
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
    monkeypatch.delitem(sys.modules, "frappe_intelligence.api", raising=False)
    api = importlib.import_module("frappe_intelligence.api")
    monkeypatch.setattr(engine, "frappe", fake)
    monkeypatch.setattr(access, "frappe", fake)
    monkeypatch.setattr(service, "frappe", fake)
    monkeypatch.setattr(api, "frappe", fake)
    return Record(frappe=fake, engine=engine, access=access, service=service, api=api)


def complete(config, reply):
    with patch("frappe_intelligence.providers.adapters.post_json", return_value=reply) as transport:
        result = providers.complete(config, [{"role": "user", "content": "Hi"}], [])
    return result, transport.call_args.kwargs


def provider_doc(env, kind="OpenAI", effort=None):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    doc.kind = kind
    if kind == "Custom":
        doc.base_url = CUSTOM_BASE_URL
        env.frappe.settings.allowed_custom_hosts = HOST
    if effort is not None:
        doc.thinking_effort = effort
    return doc


@pytest.mark.parametrize("effort", EFFORTS)
def test_save_provider_accepts_each_supported_effort(env, effort):
    saved = env.service.save_provider(
        title=f"Provider {effort}", kind="OpenAI", model="test-model", api_key=KEY, thinking_effort=effort
    )
    assert saved["thinking_effort"] == effort


def test_save_provider_defaults_to_auto_and_treats_blank_as_auto(env):
    saved = env.service.save_provider(title="Default", kind="OpenAI", model="test-model", api_key=KEY)
    assert saved["thinking_effort"] == "Auto"
    saved = env.service.save_provider(
        title="Blank", kind="OpenAI", model="test-model", api_key=KEY, thinking_effort=""
    )
    assert saved["thinking_effort"] == "Auto"


@pytest.mark.parametrize("effort", ["Ultra", "low", "AUTO", "Maximum", "None", 5])
def test_save_provider_rejects_unsupported_effort(env, effort):
    with pytest.raises(ValueError, match="thinking effort"):
        env.service.save_provider(
            title="Invalid", kind="OpenAI", model="test-model", api_key=KEY, thinking_effort=effort
        )


def test_save_provider_update_preserves_existing_effort_when_omitted(env):
    provider_doc(env, effort="High")
    saved = env.service.save_provider("provider", title="Renamed", kind="OpenAI", model="test-model")
    assert saved["thinking_effort"] == "High"


def test_api_save_provider_passes_thinking_effort_through(env):
    saved = env.api.save_provider(
        title="Via API", kind="OpenAI", model="test-model", api_key=KEY, thinking_effort="Max"
    )
    assert saved["thinking_effort"] == "Max"
    doc = env.frappe.get_doc("Intelligence Provider", saved["name"])
    assert doc.thinking_effort == "Max"


def test_get_provider_config_passes_effort_through(env):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    # A legacy document without the field behaves as Auto.
    assert env.engine.get_provider_config("provider").effort == ""
    doc.thinking_effort = "Low"
    assert env.engine.get_provider_config("provider").effort == "Low"
    doc.thinking_effort = "Max"
    assert env.engine.get_provider_config("provider").effort == "Max"
    doc.thinking_effort = "Auto"
    assert env.engine.get_provider_config("provider").effort == ""
    doc.thinking_effort = ""
    assert env.engine.get_provider_config("provider").effort == ""


@pytest.mark.parametrize("kind", ["OpenAI", "Custom"])
@pytest.mark.parametrize(
    "effort,wire", [("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "high")]
)
def test_openai_compatible_wires_map_effort_to_reasoning_effort(env, kind, effort, wire):
    provider_doc(env, kind=kind, effort=effort)
    config = env.engine.get_provider_config("provider")
    reply, request = complete(config, canned_reply(config.kind))
    assert reply.text == "Done"
    assert request["payload"]["reasoning_effort"] == wire


@pytest.mark.parametrize("kind", ["OpenAI", "Custom"])
@pytest.mark.parametrize("effort", ["Auto", ""])
def test_auto_and_blank_effort_are_omitted_from_the_wire(env, kind, effort):
    provider_doc(env, kind=kind, effort=effort)
    config = env.engine.get_provider_config("provider")
    assert config.effort == ""
    _, request = complete(config, canned_reply(config.kind))
    assert "reasoning_effort" not in request["payload"]


@pytest.mark.parametrize("kind", ["Anthropic", "Gemini", "OpenRouter", "xAI"])
def test_other_wires_ignore_effort_for_now(env, kind):
    provider_doc(env, kind=kind, effort="High")
    config = env.engine.get_provider_config("provider")
    assert config.effort == "High"
    reply, request = complete(config, canned_reply(config.kind))
    assert reply.text == "Done"
    assert "reasoning_effort" not in request["payload"]
