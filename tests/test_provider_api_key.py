"""Credential rotation from the native provider form: set_provider_api_key.

The endpoint exists so the Desk form can set or rotate a key without ever
reading one back: same actor rules as save_provider, a write of only the
Password field under the internal flag, and a response that carries no secret.
"""

import pytest
from test_provider_effort import KEY
from test_provider_effort import env as env


def test_owner_rotates_the_key_and_the_response_never_carries_it(env):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    result = env.service.set_provider_api_key("provider", "fresh-key")
    assert doc.api_key == "fresh-key"
    assert result["has_api_key"] is True
    assert "fresh-key" not in str(result)
    assert KEY not in str(result)


def test_rotation_is_owner_only_for_personal_providers(env):
    env.frappe.seed("User", "mallory", enabled=1, user_type="System User")
    env.frappe.roles["mallory"] = ["Intelligence User"]
    env.frappe.session.user = "mallory"
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    with pytest.raises(PermissionError):
        env.service.set_provider_api_key("provider", "stolen-key")
    assert doc.api_key == KEY


def test_shared_provider_rotation_requires_a_manager(env):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    doc.is_shared = 1
    with pytest.raises(PermissionError):
        env.service.set_provider_api_key("provider", "new-key")
    assert doc.api_key == KEY, "the non-manager owner cannot rotate a shared key"
    env.frappe.roles["alice"] = ["Intelligence User", "Intelligence Manager"]
    env.service.set_provider_api_key("provider", "rotated-key")
    assert doc.api_key == "rotated-key"


@pytest.mark.parametrize("key", ["", "   ", None, 42, "has\nnewline", "has\rreturn", "x" * 8193])
def test_blank_or_malformed_keys_are_rejected(env, key):
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    with pytest.raises(ValueError, match="API key"):
        env.service.set_provider_api_key("provider", key)
    assert doc.api_key == KEY


@pytest.mark.parametrize("name", [None, "", 42, ["provider"]])
def test_invalid_provider_names_are_rejected(env, name):
    with pytest.raises(ValueError, match="Invalid request data"):
        env.service.set_provider_api_key(name, "some-key")


def test_api_set_provider_api_key_passes_through(env):
    result = env.api.set_provider_api_key("provider", "via-api-key")
    assert result["has_api_key"] is True
    assert "via-api-key" not in str(result)
    doc = env.frappe.get_doc("Intelligence Provider", "provider")
    assert doc.api_key == "via-api-key"
