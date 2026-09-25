"""Provider model catalogs: service persistence rules and adapter URL/parse logic."""

import json
from unittest.mock import patch

import pytest
from test_provider_effort import KEY
from test_provider_effort import env as env

from frappe_intelligence.providers import ProviderConfig, ProviderError, adapters

CUSTOM_HOST = "models.example.test"
CUSTOM_BASE_URL = f"https://{CUSTOM_HOST}/v1"


def fetch(config, response):
    with patch.object(adapters, "get_json", return_value=response) as transport:
        result = adapters.list_models(config)
    return result, transport.call_args.kwargs


def fetch_catalog(config, response):
    with patch.object(adapters, "get_json", return_value=response):
        return adapters.list_catalog(config)


@pytest.mark.parametrize(
    "kind,url,host",
    [
        ("openai", "https://api.openai.com/v1/models", "api.openai.com"),
        ("anthropic", "https://api.anthropic.com/v1/models", "api.anthropic.com"),
        (
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta/models",
            "generativelanguage.googleapis.com",
        ),
        ("openrouter", "https://openrouter.ai/api/v1/models", "openrouter.ai"),
        ("xai", "https://api.x.ai/v1/models", "api.x.ai"),
    ],
)
def test_catalog_endpoint_per_kind(kind, url, host):
    response = {"models": []} if kind == "gemini" else {"data": []}
    _, call = fetch(ProviderConfig(kind, "configured-model", KEY), response)
    assert call["url"] == url
    assert call["allowed_hosts"] == (host,)
    assert KEY not in call["url"]


def test_catalog_uses_the_custom_base_url_with_its_allowlist():
    config = ProviderConfig(
        "custom", "configured-model", KEY, base_url=CUSTOM_BASE_URL + "/", allowed_hosts=(CUSTOM_HOST,)
    )
    _, call = fetch(config, {"data": []})
    assert call["url"] == CUSTOM_BASE_URL + "/models"
    assert call["allowed_hosts"] == (CUSTOM_HOST,)


def test_catalog_auth_header_matches_the_wire_protocol():
    _, call = fetch(ProviderConfig("openai", "m", KEY), {"data": []})
    assert call["headers"]["Authorization"] == f"Bearer {KEY}"
    _, call = fetch(ProviderConfig("xai", "m", KEY), {"data": []})
    assert call["headers"]["Authorization"] == f"Bearer {KEY}"
    _, call = fetch(ProviderConfig("anthropic", "m", KEY), {"data": []})
    assert call["headers"]["x-api-key"] == KEY
    assert "Authorization" not in call["headers"]
    _, call = fetch(ProviderConfig("gemini", "m", KEY), {"models": []})
    assert call["headers"]["x-goog-api-key"] == KEY
    assert "Authorization" not in call["headers"]


def test_openai_style_catalog_parsing_validates_dedupes_and_sorts():
    response = {
        "data": [
            {"id": "b-model"},
            {"id": "a-model"},
            {"id": "a-model"},
            {"id": "bad id"},
            {"id": ""},
            "junk",
            {},
        ]
    }
    models, _ = fetch(ProviderConfig("openai", "m", KEY), response)
    assert models == ["a-model", "b-model"]


def test_gemini_catalog_strips_the_models_prefix():
    response = {"models": [{"name": "models/gemini-pro"}, {"name": "models/gemini-flash"}]}
    models, _ = fetch(ProviderConfig("gemini", "m", KEY), response)
    assert models == ["gemini-flash", "gemini-pro"]


def test_catalog_is_capped_at_five_hundred_models():
    response = {"data": [{"id": f"model-{i}"} for i in range(600)]}
    models, _ = fetch(ProviderConfig("openai", "m", KEY), response)
    assert len(models) == 500


def test_a_non_list_catalog_is_an_invalid_response():
    with pytest.raises(ProviderError) as exc:
        fetch(ProviderConfig("openai", "m", KEY), {"data": {}})
    assert exc.value.code == "invalid_response"


def test_custom_catalog_requires_a_base_url():
    with pytest.raises(ProviderError) as exc:
        adapters.list_models(ProviderConfig("custom", "m", KEY))
    assert exc.value.code == "invalid_config"


def test_fetch_persists_the_catalog_on_a_saved_provider(env, monkeypatch):
    seen = []
    monkeypatch.setattr(adapters, "list_catalog", lambda config: seen.append(config) or (["b", "a"], {}))
    result = env.service.fetch_provider_models(name="provider")
    assert result == {"models": ["b", "a"], "efforts": {}}
    assert seen[0].api_key == KEY, "the stored key is used when none is typed"
    assert seen[0].kind == "openai"
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    assert doc.models == "b\na"
    assert doc.model_efforts == "", "no advertised efforts clears stale metadata"


def test_fetch_persists_advertised_efforts_on_a_saved_provider(env, monkeypatch):
    efforts = {"reasoning-model": ["Low", "Medium", "High", "Max"]}
    monkeypatch.setattr(adapters, "list_catalog", lambda config: (["reasoning-model"], efforts))
    result = env.service.fetch_provider_models(name="provider")
    assert result == {"models": ["reasoning-model"], "efforts": efforts}
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    assert json.loads(doc.model_efforts) == efforts


def test_fetch_for_a_new_provider_needs_a_key_and_never_persists(env, monkeypatch):
    with pytest.raises(ValueError, match="API key"):
        env.service.fetch_provider_models(kind="OpenAI")
    seen = []
    monkeypatch.setattr(adapters, "list_catalog", lambda config: seen.append(config) or (["m1"], {}))
    result = env.service.fetch_provider_models(kind="OpenAI", api_key="typed-key")
    assert result["models"] == ["m1"]
    assert result["efforts"] == {}
    assert seen[0].api_key == "typed-key"
    providers = env.frappe.get_all("Intelligence Provider")
    assert [row.name for row in providers] == ["provider"]
    saved = env.frappe.get_doc("Intelligence Provider", "provider")
    assert not saved.get("models")
    assert not saved.get("model_efforts")


def test_fetch_custom_requires_an_allowlisted_https_host(env, monkeypatch):
    monkeypatch.setattr(adapters, "list_catalog", lambda config: (["m1"], {}))
    with pytest.raises(ValueError, match="allowlist"):
        env.service.fetch_provider_models(kind="Custom", base_url=CUSTOM_BASE_URL, api_key="typed-key")
    env.frappe.settings.allowed_custom_hosts = CUSTOM_HOST
    with pytest.raises(ValueError, match="allowlist"):
        env.service.fetch_provider_models(
            kind="Custom", base_url="http://models.example.test/v1", api_key="typed-key"
        )
    result = env.service.fetch_provider_models(kind="Custom", base_url=CUSTOM_BASE_URL, api_key="typed-key")
    assert result["models"] == ["m1"]


def test_fetch_surfaces_a_safe_provider_error(env, monkeypatch):
    def failing(config):
        raise ProviderError("authentication_failed", "The provider rejected the credentials.")

    monkeypatch.setattr(adapters, "list_catalog", failing)
    with pytest.raises(ValueError, match="rejected"):
        env.service.fetch_provider_models(name="provider")
    assert not env.frappe.get_doc("Intelligence Provider", "provider").get("models")


def test_models_list_normalizes_dedupes_and_validates(env):
    service = env.service
    assert service._models_list(None) == ("", [])
    assert service._models_list("") == ("", [])
    text, lines = service._models_list("  a-model\n\na-model\nb-model\n")
    assert text == "a-model\nb-model"
    assert lines == ["a-model", "b-model"]
    for bad in ("bad id", "-leading", "x" * 300):
        with pytest.raises(ValueError, match="model ID"):
            service._models_list(bad)
    with pytest.raises(ValueError, match="500"):
        service._models_list("\n".join(f"model-{i}" for i in range(501)))


def test_save_provider_requires_the_model_within_a_nonempty_catalog(env):
    with pytest.raises(ValueError, match="model list"):
        env.service.save_provider(title="P", kind="OpenAI", model="other", api_key=KEY, models="a\nb")
    saved = env.service.save_provider(title="P", kind="OpenAI", model="a", api_key=KEY, models="a\nb\na")
    assert saved["models"] == "a\nb"


def test_public_provider_rows_expose_the_catalog(env):
    saved = env.service.save_provider(
        title="P", kind="OpenAI", model="a", api_key=KEY, models="a\nb", thinking_effort="Low"
    )
    assert saved["models"] == "a\nb"
    listed = env.service.list_providers()
    row = next(row for row in listed if row["name"] == saved["name"])
    assert row["models"] == "a\nb"
    assert "api_key" not in row


def test_api_save_provider_and_fetch_pass_models_through(env, monkeypatch):
    saved = env.api.save_provider(title="P", kind="OpenAI", model="a", api_key=KEY, models="a\nb")
    assert saved["models"] == "a\nb"
    monkeypatch.setattr(adapters, "list_catalog", lambda config: (["a", "b", "c"], {}))
    result = env.api.fetch_provider_models(name=saved["name"])
    assert result == {"models": ["a", "b", "c"], "efforts": {}}
    doc = env.frappe.get_doc("Intelligence Provider", saved["name"])
    assert doc.models == "a\nb\nc"


def test_openrouter_catalog_maps_reasoning_support_to_canonical_efforts():
    response = {
        "data": [
            {"id": "reasoning-model", "supported_parameters": ["tools", "reasoning"]},
            {"id": "plain-model", "supported_parameters": ["tools"]},
            {"id": "silent-model"},
            {"id": "odd-model", "supported_parameters": "reasoning"},
        ]
    }
    models, efforts = fetch_catalog(ProviderConfig("openrouter", "m", KEY), response)
    assert models == ["odd-model", "plain-model", "reasoning-model", "silent-model"]
    assert efforts == {"reasoning-model": ["Low", "Medium", "High", "Max"]}


def test_custom_catalog_reads_openrouter_shaped_capability_metadata():
    config = ProviderConfig("custom", "m", KEY, base_url=CUSTOM_BASE_URL, allowed_hosts=(CUSTOM_HOST,))
    response = {"data": [{"id": "thinker", "supported_parameters": ["reasoning"]}]}
    models, efforts = fetch_catalog(config, response)
    assert models == ["thinker"]
    assert efforts == {"thinker": ["Low", "Medium", "High", "Max"]}


@pytest.mark.parametrize(
    "kind,response",
    [
        ("openai", {"data": [{"id": "m", "supported_parameters": ["reasoning"]}]}),
        ("xai", {"data": [{"id": "m", "supported_parameters": ["reasoning"]}]}),
        ("anthropic", {"data": [{"id": "m"}]}),
        ("gemini", {"models": [{"name": "models/m"}]}),
    ],
)
def test_wires_without_capability_metadata_never_invent_efforts(kind, response):
    # supported_parameters is not part of the OpenAI/xAI catalog contract; it
    # must be ignored there rather than trusted from an unexpected shape.
    models, efforts = fetch_catalog(ProviderConfig(kind, "m", KEY), response)
    assert models == ["m"]
    assert efforts == {}


def test_save_provider_accepts_and_normalizes_model_efforts(env):
    saved = env.service.save_provider(
        title="P",
        kind="OpenAI",
        model="a",
        api_key=KEY,
        models="a\nb",
        model_efforts='{"a": ["High", "Low", "Low", "Auto"]}',
    )
    # Canonical order, deduplicated, Auto never stored.
    assert json.loads(saved["model_efforts"]) == {"a": ["Low", "High"]}
    doc = env.frappe.get_doc("Intelligence Provider", saved["name"])
    assert json.loads(doc.model_efforts) == {"a": ["Low", "High"]}
    updated = env.service.save_provider(name=saved["name"], title="P2", kind="OpenAI", model="a")
    assert json.loads(updated["model_efforts"]) == {"a": ["Low", "High"]}, "omitted means preserved"
    cleared = env.service.save_provider(
        name=saved["name"], title="P2", kind="OpenAI", model="a", model_efforts=""
    )
    assert cleared["model_efforts"] == ""


@pytest.mark.parametrize(
    "value",
    [
        "not json",
        '["not-a-dict"]',
        '{"a": "High"}',
        '{"a": ["Ultra"]}',
        '{"a": []}',
        '{"bad id": ["Low"]}',
    ],
)
def test_save_provider_rejects_malformed_model_efforts(env, value):
    with pytest.raises(ValueError, match="model effort"):
        env.service.save_provider(title="P", kind="OpenAI", model="a", api_key=KEY, model_efforts=value)


def test_public_provider_payload_includes_model_efforts(env):
    saved = env.service.save_provider(
        title="P",
        kind="OpenAI",
        model="a",
        api_key=KEY,
        models="a",
        model_efforts={"a": ["Max"]},
    )
    assert json.loads(saved["model_efforts"]) == {"a": ["Max"]}
    details = env.service.provider_details(saved["name"])
    assert json.loads(details["model_efforts"]) == {"a": ["Max"]}
    listed = env.service.list_providers()
    row = next(row for row in listed if row["name"] == saved["name"])
    assert json.loads(row["model_efforts"]) == {"a": ["Max"]}
    assert "api_key" not in row
