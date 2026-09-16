"""Provider administration; secrets never leave the server-side connection boundary."""

from urllib.parse import urlsplit

import frappe

from .access import can_use_provider, get_settings, internal_write, require_manager, require_user

KINDS = frozenset({"OpenAI", "Anthropic", "Gemini", "OpenRouter", "xAI", "Custom"})
PUBLIC_FIELDS = (
    "name",
    "title",
    "kind",
    "model",
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
    if is_shared is None:
        is_shared = doc.get("is_shared") if name else 0
    if enabled is None:
        enabled = doc.get("enabled") if name else 1
    if allowed_roles is None:
        allowed_roles = (doc.get("allowed_roles") or "") if name else ""
    if max_tokens is None:
        max_tokens = (doc.get("max_tokens") or 4096) if name else 4096
    if timeout is None:
        timeout = (doc.get("timeout") or 60) if name else 60
    title = _text(title, "provider title", 140)
    model = _text(model, "model ID", 140)
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
    if not 128 <= max_tokens <= 32768 or not 5 <= timeout <= 120:
        frappe.throw("Provider limits must be 128–32768 tokens and 5–120 seconds.")
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
