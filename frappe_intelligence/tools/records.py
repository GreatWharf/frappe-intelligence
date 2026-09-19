"""Permission-aware scalar reads and narrow, normal-Document business mutations.

No child-table dump, arbitrary filters/joins, credential DocTypes, financial
posting, reassignment or generic document writes. Email/commerce/wiki reads use
the same configured DocType/field/record boundary. Email sending is draft-only.
"""

import re
from datetime import datetime

from . import ToolSpec, denied, json_value, policy_lines
from .validation import DATE, FIELD, MODIFIED, NAME, SCALAR, object_schema, string_schema

# Policy cannot turn the generic reader into a credential, code or internal-state
# extraction tool. Special-purpose file and memory tools enforce their own scope.
_BLOCKED_TYPES = {
    "User",
    "File",
    "DocType",
    "DocField",
    "DocPerm",
    "Custom Field",
    "Property Setter",
    "DocShare",
    "User Permission",
    "Has Role",
    "Role",
    "Report",
    "Server Script",
    "Client Script",
    "System Settings",
    "Email Account",
    "Email Domain",
    "Email Queue",
    "Email Queue Recipient",
    "OAuth Client",
    "OAuth Bearer Token",
    "OAuth Authorization Code",
    "Social Login Key",
    "Connected App",
    "Token Cache",
    "Integration Request",
    "Error Log",
    "Access Log",
    "Activity Log",
    "Scheduled Job Log",
    "Prepared Report",
    "Notification Log",
    "Google Settings",
    "Google Calendar",
    "Google Contacts",
    "Social Login Key",
}
_SENSITIVE = re.compile(
    r"password|passwd|secret|token|api_?key|private_?key|authorization|credential|session|cookie|otp|access_?key|refresh_?key|encryption_?key",
    re.I,
)
_SCALAR_TYPES = {
    "Data",
    "Link",
    "Dynamic Link",
    "Select",
    "Read Only",
    "ReadOnly",
    "Date",
    "Datetime",
    "Time",
    "Int",
    "Float",
    "Currency",
    "Percent",
    "Check",
    "Duration",
    "Small Text",
    "SmallText",
    "Text",
    "Long Text",
    "LongText",
    "Text Editor",
    "TextEditor",
    "Code",
    "Markdown Editor",
    "Autocomplete",
}
_STANDARD_FIELDS = ("name", "modified", "docstatus")
_FIELDS = {"type": "array", "items": FIELD, "minItems": 1, "maxItems": 30, "uniqueItems": True}
_FILTER = object_schema(
    {
        "field": FIELD,
        "operator": {"type": "string", "enum": ["=", "!=", ">", ">=", "<", "<=", "like", "in"]},
        "value": {"anyOf": [SCALAR, {"type": "array", "items": SCALAR, "minItems": 1, "maxItems": 20}]},
    },
    ("field", "operator", "value"),
)
_SEARCH = object_schema(
    {
        "doctype": NAME,
        "fields": _FIELDS,
        "filters": {"type": "array", "items": _FILTER, "maxItems": 12},
        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
    },
    ("doctype",),
)
_READ = object_schema({"doctype": NAME, "name": NAME, "fields": _FIELDS}, ("doctype", "name"))
_TODO_CHANGES = {
    "description": string_schema(8000),
    "status": {"type": "string", "enum": ["Open", "Closed", "Cancelled"]},
    "priority": {"type": "string", "enum": ["Low", "Medium", "High"]},
    "date": DATE,
}
_EVENT_CHANGES = {
    "subject": string_schema(140),
    "description": string_schema(8000),
    "starts_on": MODIFIED,
    "ends_on": {"anyOf": [MODIFIED, {"type": "null"}]},
    "all_day": {"type": "boolean"},
    "status": {"type": "string", "enum": ["Open", "Closed", "Cancelled"]},
}


def settings():
    from frappe_intelligence.access import get_settings

    return get_settings()


def allowed_meta(doctype):
    import frappe

    if doctype.startswith("Intelligence ") or doctype in _BLOCKED_TYPES or _SENSITIVE.search(doctype):
        denied()
    if doctype not in policy_lines(settings().get("allowed_read_doctypes")):
        denied()
    meta = frappe.get_meta(doctype)
    if meta.istable or meta.issingle or meta.is_virtual:
        denied()
    if not frappe.has_permission(doctype, "read"):
        denied()
    return meta


def safe_fields(meta, user, permission="read"):
    permitted = set(
        meta.get_permitted_fieldnames(user=user, permission_type=permission, with_virtual_fields=False)
    )
    return {
        df.fieldname
        for df in meta.fields
        if df.fieldname in permitted
        and df.fieldtype in _SCALAR_TYPES
        and not _SENSITIVE.search(df.fieldname)
        and not df.get("hidden")
        and not df.get("is_virtual")
    }


def child_fields(meta):
    """Scalar fields of a child table (istable) DocType.

    Child DocTypes carry no DocPerm rules of their own: in Frappe, access to
    child rows is inherited from the parent document, whose read/create gates
    have already run before child fields are described or written. A
    permitted-fieldname lookup against the child itself therefore returns
    nothing on a real site. Gate by field shape instead: permlevel-zero
    scalars, never sensitive, hidden or virtual.
    """
    return {
        df.fieldname
        for df in meta.fields
        if not df.get("permlevel")
        and df.fieldtype in _SCALAR_TYPES
        and not _SENSITIVE.search(df.fieldname)
        and not df.get("hidden")
        and not df.get("is_virtual")
    }


def selected_fields(meta, requested, user):
    allowed = safe_fields(meta, user) | set(_STANDARD_FIELDS)
    if requested is not None:
        if not set(requested) <= allowed:
            denied()
        return list(dict.fromkeys(["name", "modified", *requested]))
    return list(
        dict.fromkeys(
            [*_STANDARD_FIELDS, *[df.fieldname for df in meta.fields if df.fieldname in allowed][:27]]
        )
    )


def check_company(doc, meta=None):
    import frappe

    if meta is None:
        meta = frappe.get_meta(doc.doctype)
    for df in meta.fields:
        if df.fieldtype == "Link" and df.get("options") == "Company" and doc.get(df.fieldname):
            company = frappe.get_doc("Company", doc.get(df.fieldname))
            company.check_permission("read")


def checked_doc(doctype, name, *, lock=False, permission="read"):
    import frappe

    meta = allowed_meta(doctype)
    doc = frappe.get_doc(doctype, name, for_update=lock)
    doc.check_permission("read")
    if permission != "read":
        doc.check_permission(permission)
    check_company(doc, meta)
    return doc, meta


def _read_plan(context, args):
    doc, meta = checked_doc(args["doctype"], args["name"])
    fields = selected_fields(meta, args.get("fields"), context.user)
    return doc, fields


def preview_read(context, args):
    doc, fields = _read_plan(context, args)
    return {
        "summary": f"Read selected fields from {args['doctype']} {args['name']}.",
        "operation": "read",
        "target": {"doctype": args["doctype"], "name": args["name"]},
        "details": {"fields": fields, "modified": str(doc.modified)},
    }


def _project(doc, fields):
    result = {}
    truncated = []
    for name in fields:
        value = doc.get(name)
        if isinstance(value, (dict, list, tuple, bytes)):
            continue
        if isinstance(value, str) and len(value) > 8000:
            value = value[:8000]
            truncated.append(name)
        result[name] = value
    return result, truncated


def read_document(context, args):
    doc, fields = _read_plan(context, args)
    data, truncated = _project(doc, fields)
    return {"doctype": args["doctype"], "document": data, "truncated_fields": truncated}


def _search_plan(context, args):
    meta = allowed_meta(args["doctype"])
    fields = selected_fields(meta, args.get("fields"), context.user)
    allowed = safe_fields(meta, context.user) | set(_STANDARD_FIELDS)
    filters = []
    for item in args.get("filters", []):
        if item["field"] not in allowed:
            denied()
        value, operator = item["value"], item["operator"]
        if (operator == "in") != isinstance(value, list) or (
            operator == "like" and not isinstance(value, str)
        ):
            raise ValueError("Filter operator and value do not match.")
        if operator == "like" and "%" not in value:
            # Callers mean substring search; SQL LIKE without wildcards is an
            # exact match, so a bare "Acme" would silently find nothing.
            value = f"%{value}%"
        filters.append([item["field"], operator, value])
    return fields, filters


def preview_search(context, args):
    fields, filters = _search_plan(context, args)
    return {
        "summary": f"Search permitted {args['doctype']} records.",
        "operation": "search",
        "target": {"doctype": args["doctype"]},
        "details": {"fields": fields, "filters": filters, "limit": args.get("limit", 20)},
    }


def search_records(context, args):
    import frappe

    fields, filters = _search_plan(context, args)
    limit = args.get("limit", 20)
    # get_list, not get_all: applies role permissions, User Permissions, shares
    # and app permission_query_conditions. Recheck each Document for hooks whose
    # individual-record policy is stricter than the list policy.
    rows = frappe.get_list(
        args["doctype"],
        filters=filters,
        fields=fields,
        limit_page_length=limit,
        order_by="modified desc, name asc",
    )
    result, truncated = [], []
    for row in rows:
        try:
            doc, _ = checked_doc(args["doctype"], row["name"])
        except frappe.PermissionError:
            continue
        data, cut_fields = _project(doc, fields)
        result.append(data)
        if cut_fields:
            truncated.append({"name": row["name"], "fields": cut_fields})
    return {
        "doctype": args["doctype"],
        "records": result,
        "limit": limit,
        "has_more": len(rows) == limit,
        "truncated_fields": truncated,
    }


def _update_schema(fields):
    return object_schema(
        {"name": NAME, "expected_modified": MODIFIED, "changes": object_schema(fields, minProperties=1)},
        ("name", "expected_modified", "changes"),
    )


def _write_plan(context, args, doctype, lock=False):
    import frappe

    doc, meta = checked_doc(doctype, args["name"], lock=lock, permission="write")
    if str(doc.modified) != args["expected_modified"]:
        frappe.throw(
            "Record changed since it was read; read it again and request a new approval.",
            frappe.TimestampMismatchError,
        )
    if doc.get("docstatus", 0) != 0:
        denied()
    permitted = safe_fields(meta, context.user, "write") & safe_fields(meta, context.user)
    for field in args["changes"]:
        df = meta.get_field(field)
        if field not in permitted or not df or df.get("read_only"):
            denied()
    # These native hooks can affect another business record or call Google before
    # commit. Do not misrepresent them as a local single-record transaction.
    if doctype == "ToDo" and (doc.get("reference_type") or doc.get("reference_name")):
        denied()
    if doctype == "Event" and (doc.get("sync_with_google_calendar") or doc.get("event_participants")):
        denied()
    if doctype == "Wiki Document" and doc.get("is_group"):
        denied()
    if doctype == "Event":
        start = args["changes"].get("starts_on", doc.get("starts_on"))
        end = args["changes"].get("ends_on", doc.get("ends_on"))
        if start and end and datetime.fromisoformat(str(end)) <= datetime.fromisoformat(str(start)):
            raise ValueError("Event end must be later than its start.")
    changes = [
        {"field": key, "label": meta.get_field(key).label or key, "before": doc.get(key), "after": value}
        for key, value in sorted(args["changes"].items())
    ]
    # Preserve the complete before/after diff, never an invisible truncated edit.
    json_value(changes)
    return doc, changes


def preview_update(context, args, doctype):
    _, changes = _write_plan(context, args, doctype)
    return {
        "summary": f"Update {doctype} {args['name']}.",
        "operation": "update",
        "target": {"doctype": doctype, "name": args["name"]},
        "details": {"expected_modified": args["expected_modified"]},
        "changes": changes,
    }


def update_document(context, args, doctype):
    doc, _ = _write_plan(context, args, doctype, lock=True)
    for field, value in args["changes"].items():
        doc.set(field, value)
    doc.save()
    return {
        "doctype": doctype,
        "name": doc.name,
        "modified": str(doc.modified),
        "updated_fields": sorted(args["changes"]),
    }


def _create_plan(context, args):
    import frappe

    meta = allowed_meta("ToDo")
    if not frappe.has_permission("ToDo", "create"):
        denied()
    if not set(args) <= safe_fields(meta, context.user, "write"):
        denied()
    for field in args:
        if meta.get_field(field).get("read_only"):
            denied()
    return {
        "doctype": "ToDo",
        "description": args["description"],
        "priority": args.get("priority", "Medium"),
        "date": args.get("date"),
        "status": "Open",
        "allocated_to": context.user,
        "assigned_by": context.user,
    }


def preview_create(context, args):
    values = _create_plan(context, args)
    return {
        "summary": "Create a personal ToDo assigned only to you.",
        "operation": "create",
        "target": {"doctype": "ToDo"},
        "changes": [
            {"field": k, "label": k.replace("_", " ").title(), "before": None, "after": v}
            for k, v in sorted(values.items())
            if k != "doctype"
        ],
    }


def create_todo(context, args):
    import frappe

    values = _create_plan(context, args)
    doc = frappe.get_doc(values)
    doc.insert()
    return {"doctype": "ToDo", "name": doc.name, "modified": str(doc.modified)}


def specs(context):
    import frappe

    tools = [
        ToolSpec(
            "search_records",
            "Search configured DocTypes with current user's record and field permissions. All reads require approval.",
            _SEARCH,
            search_records,
            preview_search,
            operation="Read",
        ),
        ToolSpec(
            "read_document",
            "Read permitted scalar fields of one configured document, including email, wiki and commerce records. No secrets or child-table dumps.",
            _READ,
            read_document,
            preview_read,
            operation="Read",
        ),
        ToolSpec(
            "create_todo",
            "Create a personal unlinked ToDo assigned to you. Never send email or assign another user.",
            object_schema({k: v for k, v in _TODO_CHANGES.items() if k != "status"}, ("description",)),
            create_todo,
            preview_create,
            mutates=True,
            operation="Create",
        ),
    ]
    for name, doctype, fields in (
        ("update_todo", "ToDo", _TODO_CHANGES),
        ("update_event", "Event", _EVENT_CHANGES),
    ):
        tools.append(
            ToolSpec(
                name,
                f"Update an unlinked, local-only {doctype}; read first and supply its exact modified timestamp. No integrations or assignments.",
                _update_schema(fields),
                lambda c, a, dt=doctype: update_document(c, a, dt),
                lambda c, a, dt=doctype: preview_update(c, a, dt),
                mutates=True,
                operation="Update",
            )
        )
    # Wiki v3 uses Wiki Document. The legacy Wiki Page controller is deprecated
    # and rejects edits; do not advertise a tool that merely pretends to work.
    if (
        "wiki" in frappe.get_installed_apps()
        and frappe.db.exists("DocType", "Wiki Document")
        and "Wiki Document" in policy_lines(settings().get("allowed_read_doctypes"))
    ):
        tools.append(
            ToolSpec(
                "edit_wiki_page",
                "Edit only the content of an existing Wiki v3 leaf document, with version and native write permission checks. Cannot publish or move pages.",
                _update_schema({"content": string_schema(30000)}),
                lambda c, a: update_document(c, a, "Wiki Document"),
                lambda c, a: preview_update(c, a, "Wiki Document"),
                mutates=True,
                operation="Update",
            )
        )
    return tools
