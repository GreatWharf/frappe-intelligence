"""Reviewed tool registry. Only the approval engine may call execute.

None of these functions is whitelisted. prepare returns HUMAN-ONLY previews;
never put them in provider messages. Every execute (including reads) requires the
engine's durable approval check. Tools never commit or create their own approval.

An installed app may declare intelligence_tools = ["app.tools.register"]. That
server-owned hook receives a Registry and explicitly calls register(spec,
reviewed=True, transaction_safe=True, roles=(...)). Registration is a security
review assertion, not a sandbox: administrators must audit extension code and
Document hooks for commits, privilege escalation and external side effects.
"""

import copy
import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Callable

from .validation import check_schema, validate


@dataclass(frozen=True)
class ToolContext:
    site: str
    user: str
    conversation: str
    run: str


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict
    execute: Callable
    preview: Callable
    mutates: bool = False
    external: bool = False
    version: str = "1"


class Registry:
    """Only explicit reviewed, transaction-safe extension registration is accepted."""

    def __init__(self, builtins, user_roles):
        self.tools = dict(builtins)
        self.names = set(builtins)
        self.user_roles = set(user_roles)

    def register(self, spec, *, reviewed=False, transaction_safe=False, roles=()):
        if reviewed is not True or transaction_safe is not True or not isinstance(spec, ToolSpec):
            raise ValueError("Tool extensions require explicit security and transaction review.")
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", spec.name) or spec.name in self.names:
            raise ValueError("Duplicate or invalid tool registration.")
        if not callable(spec.execute) or not callable(spec.preview) or not spec.version:
            raise ValueError("Invalid tool registration.")
        if spec.external:
            raise ValueError("External extension actions are not enabled in this release.")
        if not isinstance(roles, (list, tuple)) or any(not isinstance(role, str) for role in roles):
            raise ValueError("Invalid extension roles.")
        check_schema(spec.parameters)
        self.names.add(spec.name)
        if not roles or self.user_roles.intersection(roles):
            self.tools[spec.name] = spec


def denied():
    import frappe

    frappe.throw("Not permitted to use this Intelligence tool or resource.", frappe.PermissionError)


def policy_lines(value):
    return {line.strip() for line in (value or "").splitlines() if line.strip()}


def _context_settings(context):
    import frappe

    from frappe_intelligence.access import get_conversation, get_settings, require_user

    if require_user() != context.user or frappe.local.site != context.site or not context.run:
        denied()
    get_conversation(context.conversation)
    settings = get_settings()
    if not settings.get("enabled"):
        denied()
    return settings


def _assemble(context):
    import frappe

    from . import adaptive, attachments, memory, records, reports

    builtins = {}
    for module in (records, reports, attachments, memory, adaptive):
        for spec in module.specs(context):
            builtins[spec.name] = spec
    registry = Registry(builtins, frappe.get_roles(context.user))
    installed = set(frappe.get_installed_apps())
    for path in frappe.get_hooks("intelligence_tools", []):
        if (
            not isinstance(path, str)
            or not re.fullmatch(r"[A-Za-z_]\w*(\.[A-Za-z_]\w*)+", path)
            or path.split(".")[0] not in installed
        ):
            raise ValueError("Invalid installed-app tool registration hook.")
        frappe.get_attr(path)(registry)
    return registry


def get_tools(context):
    settings = _context_settings(context)
    enabled = policy_lines(settings.get("enabled_tools"))
    registry = _assemble(context)
    return {name: spec for name, spec in sorted(registry.tools.items()) if name in enabled}


def _version_number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def skill_scopes(user, settings):
    """Registered-tool metadata (with enabled state) and DocType scopes.

    Lists every assembled tool, not only enabled ones, so the Scope editor can
    turn tools on as well as off. Carries no execution authority: names,
    descriptions, flags and scope lists only, never secrets or record data.
    Does not bind a conversation or run.
    """
    import frappe

    from . import adaptive

    enabled = policy_lines(settings.get("enabled_tools"))
    context = ToolContext(frappe.local.site, user, "", "")
    registry = _assemble(context)
    tools = [
        {
            "name": spec.name,
            "description": spec.description,
            "mutates": bool(spec.mutates),
            "external": bool(spec.external),
            "version": _version_number(spec.version),
            "enabled": name in enabled,
        }
        for name, spec in sorted(registry.tools.items())
    ]
    return {
        "tools": tools,
        "scopes": {
            "read": sorted(policy_lines(settings.get("allowed_read_doctypes"))),
            "write": sorted(policy_lines(settings.get("allowed_write_doctypes"))),
        },
        "never_allow": sorted(adaptive.never_write_names()),
    }


def schemas(context):
    return [
        {
            "type": "function",
            "function": {
                "name": spec.name,
                "description": spec.description,
                "parameters": copy.deepcopy(spec.parameters),
            },
        }
        for spec in get_tools(context).values()
    ]


def _resolve(context, name, arguments):
    spec = get_tools(context).get(name)
    if spec is None:
        denied()
    validate(arguments, spec.parameters)
    return spec


def prepare(context, name, arguments):
    spec = _resolve(context, name, arguments)
    return json_value(spec.preview(context, copy.deepcopy(arguments)))


def execute(context, name, arguments):
    # Deliberately not an approval bypass API: the engine authorizes, locks the
    # receipt, establishes current identity, and owns commit/rollback and audit.
    spec = _resolve(context, name, arguments)
    return json_value(spec.execute(context, copy.deepcopy(arguments)))


def json_value(value):
    def encode(item):
        if isinstance(item, (date, datetime)):
            return item.isoformat(sep=" ") if isinstance(item, datetime) else item.isoformat()
        if isinstance(item, Decimal):
            return str(item)
        raise TypeError("Tool output is not JSON serializable.")

    encoded = json.dumps(value, default=encode, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > 512_000:
        raise ValueError("Tool result exceeds the disclosure limit; narrow the request.")
    return json.loads(encoded)
