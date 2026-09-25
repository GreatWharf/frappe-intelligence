"""Provider administration; secrets never leave the server-side connection boundary."""

import json
import re
from urllib.parse import urlsplit

import frappe

from .access import (
    can_use_provider,
    get_settings,
    internal_write,
    require_manager,
    require_user,
)

KINDS = frozenset({"OpenAI", "Anthropic", "Gemini", "OpenRouter", "xAI", "Custom"})
EFFORTS = ("Auto", "Low", "Medium", "High", "Max")
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}\Z")
PUBLIC_FIELDS = (
    "name",
    "title",
    "kind",
    "model",
    "thinking_effort",
    "models",
    "model_efforts",
    "base_url",
    "is_shared",
    "enabled",
    "max_tokens",
    "timeout",
    "allowed_roles",
)


def _manager(user):
    return bool({"Intelligence Manager", "System Manager"}.intersection(frappe.get_roles(user)))


def can_manage(doc, user):
    return doc.owner == user or (bool(doc.get("is_shared")) and _manager(user))


def public_provider(doc, user=None):
    user = user or require_user()
    result = {field: doc.get(field) for field in PUBLIC_FIELDS}
    result["can_edit"] = can_manage(doc, user)
    result["has_api_key"] = bool(doc.get("api_key"))
    return result


def list_providers(managed=False):
    user = require_user()
    rows = frappe.get_all(
        "Intelligence Provider",
        fields=["name", "owner", *PUBLIC_FIELDS[1:]],
        order_by="title asc",
        limit_page_length=500,
    )
    result = []
    for row in rows:
        doc = frappe.get_doc("Intelligence Provider", row.name)
        if can_manage(doc, user) if managed else can_use_provider(doc, user):
            result.append(public_provider(doc, user))
    return result


def provider_details(name):
    user = require_user()
    doc = frappe.get_doc("Intelligence Provider", name)
    if not can_manage(doc, user):
        frappe.throw("You cannot manage this provider.", frappe.PermissionError)
    return public_provider(doc, user)


def _text(value, label, maximum, required=True):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        frappe.throw(f"Enter a valid {label} (maximum {maximum} characters).")
    return value.strip()


def _check(value, label):
    if value not in (0, 1, "0", "1", False, True):
        frappe.throw(f"Invalid {label}.")
    return int(value)


def _models_list(value):
    """Normalize a model catalog: one valid, unique model ID per line."""
    if value in (None, ""):
        return "", []
    if not isinstance(value, str) or len(value) > 40000:
        frappe.throw("Invalid model list.")
    lines = []
    for line in value.splitlines():
        line = line.strip()
        if not line:
            continue
        if not MODEL_ID.fullmatch(line):
            frappe.throw(f"Invalid model ID: {line[:80]}")
        if line not in lines:
            lines.append(line)
        if len(lines) > 500:
            frappe.throw("The model list is limited to 500 entries.")
    return "\n".join(lines), lines


def _model_efforts(value):
    """Normalize per-model effort metadata into its canonical JSON string.

    The stored shape maps a model ID to the efforts that model's catalog row
    advertised. Only canonical efforts survive, deduplicated in canonical
    order; malformed claims are rejected rather than trusted. Auto is implied
    everywhere, so it is never stored.
    """
    if value in (None, ""):
        return ""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            frappe.throw("Invalid model effort data.")
    if not isinstance(value, dict) or len(value) > 500:
        frappe.throw("Invalid model effort data.")
    result = {}
    for model, efforts in value.items():
        if not isinstance(model, str) or not MODEL_ID.fullmatch(model) or not isinstance(efforts, list):
            frappe.throw("Invalid model effort data.")
        chosen = [effort for effort in EFFORTS[1:] if effort in efforts]
        if not chosen:
            frappe.throw("Invalid model effort data.")
        result[model] = chosen
    return json.dumps(result, sort_keys=True)


def save_provider(
    name=None,
    title="",
    kind="",
    model="",
    api_key=None,
    base_url="",
    is_shared=None,
    enabled=None,
    allowed_roles=None,
    max_tokens=None,
    timeout=None,
    thinking_effort=None,
    models=None,
    model_efforts=None,
):
    user = require_user()
    doc = (
        frappe.get_doc("Intelligence Provider", name, for_update=True)
        if name
        else frappe.get_doc({"doctype": "Intelligence Provider"})
    )
    if name and not can_manage(doc, user):
        frappe.throw("You cannot manage this provider.", frappe.PermissionError)
    if name and doc.get("is_shared"):
        require_manager()
    if models is None:
        models = (doc.get("models") or "") if name else ""
    if model_efforts is None:
        model_efforts = (doc.get("model_efforts") or "") if name else ""
    if is_shared is None:
        is_shared = doc.get("is_shared") if name else 0
    if enabled is None:
        enabled = doc.get("enabled") if name else 1
    if allowed_roles is None:
        allowed_roles = (doc.get("allowed_roles") or "") if name else ""
    if max_tokens is None:
        max_tokens = (doc.get("max_tokens") or 16384) if name else 16384
    if timeout is None:
        timeout = (doc.get("timeout") or 60) if name else 60
    if thinking_effort is None:
        thinking_effort = (doc.get("thinking_effort") or "Auto") if name else "Auto"
    if thinking_effort == "":
        thinking_effort = "Auto"
    if thinking_effort not in EFFORTS:
        frappe.throw("Select a supported thinking effort.")
    title = _text(title, "provider title", 140)
    model = _text(model, "model ID", 140)
    models, catalog = _models_list(models)
    if catalog and model not in catalog:
        frappe.throw("Choose a model from this provider's model list.")
    if kind not in KINDS:
        frappe.throw("Select a supported provider.")
    shared, enabled = _check(is_shared, "sharing setting"), _check(enabled, "enabled setting")
    if shared:
        require_manager()
    base_url = _text(base_url or "", "API base URL", 1000, required=False)
    if kind == "Custom":
        parsed = urlsplit(base_url)
        allowed = {
            host.strip().lower()
            for host in (get_settings().get("allowed_custom_hosts") or "").splitlines()
            if host.strip()
        }
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.hostname.lower() not in allowed
        ):
            frappe.throw("A manager must allowlist this HTTPS custom provider host in Intelligence Settings.")
    elif base_url:
        frappe.throw("Built-in providers use fixed API endpoints. Choose Custom for an approved endpoint.")
    if not isinstance(allowed_roles, str) or len(allowed_roles) > 4000:
        frappe.throw("Invalid provider role list.")
    try:
        max_tokens, timeout = int(max_tokens), int(timeout)
    except (TypeError, ValueError):
        frappe.throw("Invalid provider limits.")
    if not 128 <= max_tokens <= 262144 or not 5 <= timeout <= 120:
        frappe.throw("Provider limits must be 128–262144 tokens and 5–120 seconds.")
    if api_key is not None and (
        not isinstance(api_key, str) or len(api_key) > 8192 or "\n" in api_key or "\r" in api_key
    ):
        frappe.throw("Invalid API key.")
    if name and frappe.db.exists("Intelligence Conversation", {"provider": name}):
        if any(
            doc.get(field) != value
            for field, value in (("kind", kind), ("model", model), ("base_url", base_url))
        ):
            frappe.throw(
                "Create a new provider to change the model or endpoint used by existing conversations."
            )
    if not name and not api_key:
        frappe.throw("Enter the provider API key.")
    for key, value in {
        "title": title,
        "kind": kind,
        "model": model,
        "thinking_effort": thinking_effort,
        "models": models,
        "model_efforts": _model_efforts(model_efforts),
        "base_url": base_url,
        "is_shared": shared,
        "enabled": enabled,
        "allowed_roles": allowed_roles,
        "max_tokens": max_tokens,
        "timeout": timeout,
    }.items():
        setattr(doc, key, value)
    if api_key:
        doc.api_key = api_key
    with internal_write():
        doc.save() if name else doc.insert()
    return public_provider(doc, user)


def delete_provider(name):
    user = require_user()
    doc = frappe.get_doc("Intelligence Provider", name, for_update=True)
    if not can_manage(doc, user):
        frappe.throw("You cannot manage this provider.", frappe.PermissionError)
    if frappe.db.exists("Intelligence Conversation", {"provider": name}):
        frappe.throw("This provider has conversation history. Disable it instead of deleting it.")
    with internal_write():
        frappe.delete_doc("Intelligence Provider", name, ignore_permissions=True)
    return {"deleted": True}


def set_provider_api_key(name, api_key):
    """Set or rotate a provider credential from the native Desk form.

    The same actor rules as save_provider apply (personal is owner-only, shared
    needs a manager). Only the Password field is written, under the internal
    flag, and the key is never returned or logged.
    """
    user = require_user()
    if not isinstance(name, str) or not name:
        frappe.throw("Invalid request data.")
    doc = frappe.get_doc("Intelligence Provider", name, for_update=True)
    if not can_manage(doc, user):
        frappe.throw("You cannot manage this provider.", frappe.PermissionError)
    if doc.get("is_shared"):
        require_manager()
    if (
        not isinstance(api_key, str)
        or not api_key.strip()
        or len(api_key) > 8192
        or "\n" in api_key
        or "\r" in api_key
    ):
        frappe.throw("Enter a valid API key.")
    doc.api_key = api_key
    with internal_write():
        doc.save()
    return public_provider(doc, user)


def fetch_provider_models(name=None, kind=None, base_url=None, api_key=None):
    """Fetch the model catalog from the provider API for the dialog's dropdown.

    For a saved provider the stored key is used when no key is typed; for a new
    provider the key comes from the dialog input and is never stored here. When
    the provider is saved, the catalog is persisted so the dropdown works
    offline afterwards. Providers whose catalog advertises per-model reasoning
    support also return that metadata ({"model-id": [efforts]}); it is stored
    on the saved provider so the form can narrow the effort choices.
    """
    user = require_user()
    settings = get_settings()
    doc = None
    if name:
        doc = frappe.get_doc("Intelligence Provider", name, for_update=True)
        if not can_manage(doc, user):
            frappe.throw("You cannot manage this provider.", frappe.PermissionError)
        kind = doc.kind
        base_url = doc.base_url or ""
        if api_key in (None, ""):
            from .access import provider_secret_access

            with provider_secret_access(name, user):
                api_key = doc.get_password("api_key")
    if kind not in KINDS:
        frappe.throw("Select a supported provider.")
    base_url = _text(base_url or "", "API base URL", 1000, required=False)
    if kind == "Custom":
        parsed = urlsplit(base_url)
        allowed = {
            host.strip().lower()
            for host in (settings.get("allowed_custom_hosts") or "").splitlines()
            if host.strip()
        }
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.hostname.lower() not in allowed
        ):
            frappe.throw("A manager must allowlist this HTTPS custom provider host in Intelligence Settings.")
    elif base_url:
        frappe.throw("Built-in providers use fixed API endpoints. Choose Custom for an approved endpoint.")
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > 8192:
        frappe.throw("Enter the provider API key to fetch its models.")
    from .providers import ProviderConfig, ProviderError
    from .providers.adapters import list_catalog

    config = ProviderConfig(
        kind=kind.lower(),
        model="catalog",
        api_key=api_key.strip(),
        base_url=base_url,
        max_tokens=1,
        timeout=30,
        allowed_hosts=tuple(
            host.strip() for host in (settings.get("allowed_custom_hosts") or "").splitlines() if host.strip()
        ),
        effort="",
    )
    try:
        models, efforts = list_catalog(config)
    except ProviderError as exc:
        frappe.throw(exc.message)
    if not models:
        frappe.throw("The provider returned no models for these credentials.")
    if doc is not None:
        doc.models = "\n".join(models)
        doc.model_efforts = json.dumps(efforts, sort_keys=True) if efforts else ""
        with internal_write():
            doc.save()
    return {"models": models, "efforts": efforts}
