"""Curate Intelligence Skills: propose, update and retire, all approval-gated.

A skill bundles instructions with read/write DocType scope lists. Proposals
always land DISABLED with origin Learned and the caller as owner: a human
reviews and enables skills in Desk, never this tool. Updates are locked on the
skill's integer version and never touch origin or enabled. Edit authority is
re-derived at execute time, never inherited from an earlier preview: owners
edit their own non-shared skills, managers edit shared ones, and another
user's non-shared skill is invisible to these tools even for managers.
"""

from . import ToolSpec, denied
from .validation import NAME, object_schema, string_schema

_DOCTYPE = "Intelligence Skill"
_LABELS = {
    "title": "Title",
    "description": "Description",
    "instructions": "Instructions",
    "scope_read": "Scope Read",
    "scope_write": "Scope Write",
}
# Bounds mirror the Intelligence Skill doctype contract exactly.
_BOUNDS = {
    "title": (1, 140),
    "description": (1, 500),
    "instructions": (1, 8000),
    "scope_read": (0, 2000),
    "scope_write": (0, 2000),
}
_DIFF_LIMIT = 400
_SCOPE = {"type": "string", "maxLength": 2000}

_PROPOSE = object_schema(
    {
        "title": string_schema(140),
        "description": string_schema(500),
        "instructions": string_schema(8000),
        "scope_read": _SCOPE,
        "scope_write": _SCOPE,
    },
    ("title", "description", "instructions"),
)
_UPDATE = object_schema(
    {
        "name": NAME,
        "expected_version": {"type": "integer", "minimum": 1, "maximum": 1000000},
        "title": string_schema(140),
        "description": string_schema(500),
        "instructions": string_schema(8000),
        "scope_read": _SCOPE,
        "scope_write": _SCOPE,
    },
    ("name", "expected_version"),
    minProperties=3,
)
_RETIRE = object_schema({"name": NAME}, ("name",))


def _scope_lines(value):
    """Canonical scope list: stripped, blank lines dropped, duplicates removed."""
    lines = []
    for line in (value or "").splitlines():
        line = line.strip()
        if line and line not in lines:
            lines.append(line)
    return lines


def _check_bounds(field, value):
    low, high = _BOUNDS[field]
    if not low <= len(value) <= high:
        raise ValueError(f"Skill {field} must be between {low} and {high} characters.")
    return value


def _check_scope_subset(scope_read, scope_write):
    if not set(_scope_lines(scope_write)) <= set(_scope_lines(scope_read)):
        raise ValueError("Skill scope_write must be a subset of its scope_read.")


def _clip(value):
    """Readable preview value: long text is truncated with an explicit marker."""
    text = str(value or "")
    if len(text) <= _DIFF_LIMIT:
        return text
    return text[:_DIFF_LIMIT] + f"... (+{len(text) - _DIFF_LIMIT} chars)"


def _get_skill(context, name, lock=False):
    import frappe

    doc = frappe.get_doc(_DOCTYPE, name, for_update=lock)
    # Non-shared skills are visible to their owner only, even for managers.
    if doc.get("owner") != context.user and not doc.get("shared"):
        denied()
    return doc


def _check_editable(context, doc):
    import frappe

    from frappe_intelligence.access import MANAGER_ROLES

    if doc.get("shared"):
        if not MANAGER_ROLES.intersection(frappe.get_roles(context.user)):
            denied()
    elif doc.get("owner") != context.user:
        denied()


def _propose_values(args):
    values = {
        "title": args["title"].strip(),
        "description": args["description"].strip(),
        "instructions": args["instructions"].strip(),
        "scope_read": "\n".join(_scope_lines(args.get("scope_read"))),
        "scope_write": "\n".join(_scope_lines(args.get("scope_write"))),
    }
    for field, value in values.items():
        _check_bounds(field, value)
    _check_scope_subset(values["scope_read"], values["scope_write"])
    return values


def preview_propose_skill(context, args):
    values = _propose_values(args)
    return {
        "summary": f"Propose new skill '{values['title']}'.",
        "operation": "propose_skill",
        "target": {"doctype": _DOCTYPE, "name": None},
        "details": {
            "skill": {
                **values,
                "enabled": 0,
                "origin": "Learned",
                "version": 1,
                "owner": context.user,
            },
            "note": "The skill will be created DISABLED with origin Learned; a human reviews and enables it in Desk.",
        },
    }


def propose_skill(context, args):
    import frappe

    values = _propose_values(args)
    doc = frappe.new_doc(_DOCTYPE)
    for field, value in values.items():
        doc.set(field, value)
    # Hard provenance: learned proposals are born disabled, owned by the caller.
    doc.set("enabled", 0)
    doc.set("origin", "Learned")
    doc.set("version", 1)
    doc.set("owner", context.user)
    # Native insert: doctype validation, create permission and hooks, no bypass.
    doc.insert()
    return {
        "name": doc.name,
        "enabled": doc.get("enabled"),
        "origin": doc.get("origin"),
        "version": doc.get("version"),
    }


def _update_plan(context, args, lock=False):
    import frappe

    doc = _get_skill(context, args["name"], lock=lock)
    _check_editable(context, doc)
    if int(doc.get("version") or 0) != args["expected_version"]:
        frappe.throw(
            "Skill changed since it was read; read it again and request a new approval.",
            frappe.TimestampMismatchError,
        )
    changes = []
    for field in ("title", "description", "instructions"):
        if field in args:
            after = _check_bounds(field, args[field].strip())
            before = doc.get(field) or ""
            if after != before:
                changes.append({"field": field, "label": _LABELS[field], "before": before, "after": after})
    for field in ("scope_read", "scope_write"):
        if field in args:
            after = _check_bounds(field, "\n".join(_scope_lines(args[field])))
            before = doc.get(field) or ""
            if after != before:
                changes.append({"field": field, "label": _LABELS[field], "before": before, "after": after})
    if not changes:
        raise ValueError("Skill update supplied no effective field changes.")
    # The subset invariant must hold for the merged post-update state, even
    # when only one of the two scope lists is being changed.
    scope_read = args["scope_read"] if "scope_read" in args else doc.get("scope_read")
    scope_write = args["scope_write"] if "scope_write" in args else doc.get("scope_write")
    _check_scope_subset(scope_read, scope_write)
    return doc, changes


def preview_update_skill(context, args):
    doc, changes = _update_plan(context, args)
    return {
        "summary": f"Update skill '{doc.get('title')}' ({doc.name}).",
        "operation": "update_skill",
        "target": {"doctype": _DOCTYPE, "name": doc.name},
        "details": {
            "expected_version": args["expected_version"],
            "origin": doc.get("origin"),
            "enabled": bool(doc.get("enabled")),
        },
        "changes": [
            {
                "field": change["field"],
                "label": change["label"],
                "before": _clip(change["before"]),
                "after": _clip(change["after"]),
            }
            for change in changes
        ],
    }


def update_skill(context, args):
    doc, changes = _update_plan(context, args, lock=True)
    for change in changes:
        doc.set(change["field"], change["after"])
    doc.set("version", int(doc.get("version") or 0) + 1)
    # Never origin, never enabled: provenance and activation stay human-owned.
    doc.save()
    return {
        "name": doc.name,
        "version": doc.get("version"),
        "updated_fields": sorted(change["field"] for change in changes),
        "origin": doc.get("origin"),
        "enabled": doc.get("enabled"),
    }


def _summary(doc):
    return {
        "name": doc.name,
        "title": doc.get("title"),
        "description": doc.get("description"),
        "origin": doc.get("origin"),
        "version": doc.get("version"),
        "enabled": bool(doc.get("enabled")),
        "shared": bool(doc.get("shared")),
        "owner": doc.get("owner"),
    }


def preview_retire_skill(context, args):
    doc = _get_skill(context, args["name"])
    _check_editable(context, doc)
    warning = None
    if doc.get("origin") == "Seeded":
        warning = "This is a Seeded skill shipped with the app; retiring it removes managed behaviour."
    return {
        "summary": f"Retire skill '{doc.get('title')}' ({doc.name}).",
        "operation": "retire_skill",
        "target": {"doctype": _DOCTYPE, "name": doc.name},
        "details": {"skill": _summary(doc), "warning": warning},
    }


def retire_skill(context, args):
    doc = _get_skill(context, args["name"], lock=True)
    _check_editable(context, doc)
    # Native delete: delete permission and reference checks run, no bypass.
    doc.delete()
    return {"retired": doc.name}


def specs(context):
    return [
        ToolSpec(
            "propose_skill",
            "Propose a new Intelligence Skill from learned behaviour. Always created DISABLED with origin Learned and you as owner; a human reviews and enables it in Desk.",
            _PROPOSE,
            propose_skill,
            preview_propose_skill,
            mutates=True,
            operation="Create",
        ),
        ToolSpec(
            "update_skill",
            "Update the title, description, instructions or scope lists of one skill you may edit, locked on its exact version. Never changes origin or enabled; shared skills need manager authority.",
            _UPDATE,
            update_skill,
            preview_update_skill,
            mutates=True,
            operation="Update",
        ),
        ToolSpec(
            "retire_skill",
            "Delete one skill you may edit after approval. Owners retire their own non-shared skills; shared skills need manager authority. Seeded skills carry a warning.",
            _RETIRE,
            retire_skill,
            preview_retire_skill,
            mutates=True,
            operation="Delete",
        ),
    ]
