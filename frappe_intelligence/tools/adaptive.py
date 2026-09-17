"""Generic, meta-driven DocType tools over the configured read/write scope.

list_doctypes and describe_doctype expose the allowed data model itself;
create_document and update_document write scalar fields (plus create-time
child rows) of explicitly write-scoped DocTypes. The never-allow set
(hardcoded, settings-independent) keeps ledger posting, payment, stock and
workflow-bypass surfaces out of a generic field setter. Submittable DocTypes
in the write scope may be created and edited as drafts only: docstatus is
never a writable field and the docstatus != 0 guard freezes submitted
documents, so a human always reviews and submits in Desk.
"""

from . import ToolSpec, denied, json_value, policy_lines
from .records import _BLOCKED_TYPES, _SENSITIVE, allowed_meta, checked_doc, safe_fields, settings
from .validation import FIELD, MODIFIED, NAME, SCALAR, object_schema, string_schema

# Hard write ceiling: _BLOCKED_TYPES plus financial/stock posting, workflow
# bypass and approval-evasion surfaces. Settings can never widen this.
_NEVER_WRITE = _BLOCKED_TYPES | {
    "GL Entry",
    "Payment Entry",
    "Payment Entry Reference",
    "Journal Entry",
    "Journal Entry Account",
    "Stock Entry",
    "Stock Entry Detail",
    "Stock Reconciliation",
    "Stock Reconciliation Item",
    "Stock Ledger Entry",
    "Payment Ledger Entry",
    "Bank Transaction",
    "Bank Clearance",
    "Asset",
    "Asset Depreciation Schedule",
    "Salary Slip",
    "Payroll Entry",
    "Tax Withholding Category",
    "Workflow",
    "Workflow State",
    "Workflow Action",
    "Workflow Action Master",
    "Assignment Rule",
    "Energy Point Log",
}
_MAX_DOCTYPES = 100
_MAX_FIELDS_DESCRIBED = 150
_MAX_CHILD_TABLES = 10
_MAX_CHILD_ROWS = 50
_MAX_CHILD_FIELDS = 40

_LIST_DOCTYPES = object_schema(
    {
        "query": string_schema(140),
        "module": string_schema(140, pattern=r"^[A-Za-z][A-Za-z0-9 ]*$"),
    },
    (),
)
_DESCRIBE = object_schema({"doctype": NAME}, ("doctype",))
# check_schema forbids open objects, so field values travel as an array of
# {field, value} pairs, reusing the same FIELD/SCALAR building blocks as the
# search filter shape in records.py.
_FIELD_VALUE = object_schema({"field": FIELD, "value": SCALAR}, ("field", "value"))
_FIELD_LIST = {"type": "array", "items": _FIELD_VALUE, "minItems": 1, "maxItems": 30, "uniqueItems": True}
# Child rows ride along at create time only: a closed list of table fields,
# each a bounded list of rows in the same {field, value} pair shape.
_CHILD_TABLE = object_schema(
    {
        "field": FIELD,
        "rows": {"type": "array", "items": _FIELD_LIST, "minItems": 1, "maxItems": _MAX_CHILD_ROWS},
    },
    ("field", "rows"),
)
_CHILDREN = {
    "type": "array",
    "items": _CHILD_TABLE,
    "minItems": 1,
    "maxItems": _MAX_CHILD_TABLES,
    "uniqueItems": True,
}
_CREATE_DOCUMENT = object_schema(
    {"doctype": NAME, "fields": _FIELD_LIST, "children": _CHILDREN}, ("doctype", "fields")
)
_UPDATE_DOCUMENT = object_schema(
    {
        "doctype": NAME,
        "name": NAME,
        "expected_modified": MODIFIED,
        "changes": _FIELD_LIST,
    },
    ("doctype", "name", "expected_modified", "changes"),
)


def never_write_names():
    """DocType names adaptive write tools can never target, regardless of settings."""
    return set(_NEVER_WRITE)


def write_blocked(doctype):
    """Hard write prohibition: never-allow names, Intelligence internals, sensitive names."""
    return doctype in _NEVER_WRITE or doctype.startswith("Intelligence ") or bool(_SENSITIVE.search(doctype))


def _write_scope(doctype):
    """Settings-independent never-allow, then the configured write scope."""
    if write_blocked(doctype):
        denied()
    if doctype not in policy_lines(settings().get("allowed_write_doctypes")):
        denied()


def _writable(doctype, meta):
    return not write_blocked(doctype) and doctype in policy_lines(settings().get("allowed_write_doctypes"))


def _reject_field(doctype, field):
    import frappe

    frappe.throw(
        f"Field '{field}' on {doctype} is not writable by Intelligence tools.", frappe.PermissionError
    )


def _checked_pairs(meta, writable, pairs):
    """Fail closed on unknown, unwritable, duplicated or child-table fields."""
    seen = set()
    for pair in pairs:
        field = pair["field"]
        if field in seen:
            raise ValueError(f"Field '{field}' was supplied more than once.")
        seen.add(field)
        df = meta.get_field(field)
        if df is None or field not in writable or df.get("read_only") or df.fieldtype == "Table":
            _reject_field(meta.name, field)
    return [dict(pair) for pair in pairs]


def _checked_children(meta, context, entries):
    """Fail closed on non-table fields and on unwritable child rows.

    Table names that are not child tables of this DocType are a contract
    error (ValueError, like the schema bounds); field-level problems inside a
    real table are permission denials, mirroring _checked_pairs. Nested
    tables and sensitive child fields never pass.
    """
    import frappe

    seen = set()
    checked = []
    for entry in entries:
        field = entry["field"]
        if field in seen:
            raise ValueError(f"Child table '{field}' was supplied more than once.")
        seen.add(field)
        df = meta.get_field(field)
        if df is None or df.fieldtype != "Table" or not df.get("options"):
            raise ValueError(f"Field '{field}' on {meta.name} is not a child table.")
        child_meta = frappe.get_meta(df.options)
        # Child rows inherit the parent's permission; gate fields with the same
        # create-and-read-back scalar/sensitive rules as the parent fields.
        writable = safe_fields(child_meta, context.user, "create") & safe_fields(child_meta, context.user)
        rows = [_checked_pairs(child_meta, writable, row) for row in entry["rows"]]
        checked.append({"field": field, "child_doctype": df.options, "rows": rows})
    return checked


def _describe_field(df):
    return {
        "fieldname": df.fieldname,
        "label": df.get("label") or df.fieldname,
        "fieldtype": df.fieldtype,
        "reqd": bool(df.get("reqd")),
        # Options disclose link targets/select choices only; other fieldtypes can
        # carry eval strings and must never leave the server.
        "options": df.get("options") if df.fieldtype in ("Link", "Select") else None,
    }


def list_doctypes(context, args):
    import frappe

    rows = frappe.get_all(
        "DocType",
        filters={"istable": 0, "issingle": 0, "is_virtual": 0},
        fields=["name", "module"],
        limit_page_length=0,
    )
    query = (args.get("query") or "").lower()
    module = args.get("module")
    matches = []
    for row in rows:
        name = row.get("name")
        if not isinstance(name, str):
            continue
        try:
            # The exact read gate used by every other record tool: hard blocks,
            # sensitive names, read allow-list, table/single/virtual and native
            # read permission. Enumeration skips anything the gate rejects.
            allowed_meta(name)
        except Exception:
            continue
        # Query/module narrowing happens only after the permission gate.
        if query and query not in name.lower():
            continue
        if module and row.get("module") != module:
            continue
        matches.append({"name": name, "module": row.get("module")})
    matches.sort(key=lambda item: item["name"])
    return {"doctypes": matches[:_MAX_DOCTYPES], "truncated": len(matches) > _MAX_DOCTYPES}


def preview_list_doctypes(context, args):
    return {
        "summary": "List readable DocTypes.",
        "operation": "list_doctypes",
        "details": {"query": args.get("query"), "module": args.get("module")},
    }


def describe_doctype(context, args):
    import frappe

    doctype = args["doctype"]
    meta = allowed_meta(doctype)
    readable = safe_fields(meta, context.user, "read")
    fields, truncated = [], False
    for df in meta.fields:
        if df.fieldname not in readable:
            continue
        if len(fields) >= _MAX_FIELDS_DESCRIBED:
            truncated = True
            break
        fields.append(_describe_field(df))
    child_tables = []
    for df in meta.fields:
        if df.fieldtype != "Table" or not df.get("options"):
            continue
        if len(child_tables) >= _MAX_CHILD_TABLES:
            truncated = True
            break
        # Child rows inherit the parent's permission; gate fields with the same
        # scalar/sensitive rules instead of the top-level doctype allow-list.
        child_meta = frappe.get_meta(df.options)
        child_readable = safe_fields(child_meta, context.user, "read")
        child_fields = []
        for cdf in child_meta.fields:
            if cdf.fieldname not in child_readable:
                continue
            if len(child_fields) >= _MAX_CHILD_FIELDS:
                truncated = True
                break
            child_fields.append(_describe_field(cdf))
        child_tables.append(
            {"fieldname": df.fieldname, "child_doctype": df.options, "child_fields": child_fields}
        )
    return {
        "doctype": doctype,
        "autoname": getattr(meta, "autoname", None),
        "title_field": getattr(meta, "title_field", None),
        "fields": fields,
        "child_tables": child_tables,
        "writable": _writable(doctype, meta),
        "truncated": truncated,
    }


def preview_describe_doctype(context, args):
    allowed_meta(args["doctype"])
    return {
        "summary": f"Describe schema of {args['doctype']}.",
        "operation": "describe_doctype",
        "target": {"doctype": args["doctype"]},
    }


def _create_generic_plan(context, args):
    """Shared by preview_create_document and create_document.

    Returns (doc, children, missing): the staged but un-inserted document,
    the validated child-table payloads and the advisory missing-required list.
    """
    import frappe

    doctype = args["doctype"]
    if write_blocked(doctype):
        denied()
    meta = allowed_meta(doctype)
    # Payload shape is validated ahead of the write gates: contract errors
    # (duplicated or non-table children) are ValueErrors, never 403s.
    children = _checked_children(meta, context, args.get("children") or [])
    if doctype not in policy_lines(settings().get("allowed_write_doctypes")):
        denied()
    if not frappe.has_permission(doctype, "create"):
        denied()
    # Never write a field the user could not also read back (mirrors _write_plan).
    writable = safe_fields(meta, context.user, "create") & safe_fields(meta, context.user)
    pairs = _checked_pairs(meta, writable, args["fields"])
    doc = frappe.new_doc(doctype)
    for pair in pairs:
        doc.set(pair["field"], pair["value"])
    for table in children:
        for row in table["rows"]:
            doc.append(table["field"], {pair["field"]: pair["value"] for pair in row})
    # Advisory only: insert() enforces mandatory fields natively at commit time,
    # but the approver should see gaps before approving, not after a failed run.
    supplied = {pair["field"] for pair in pairs}
    missing = [
        df.fieldname
        for df in meta.fields
        if df.get("reqd") and df.fieldname in writable and df.fieldname not in supplied
    ]
    return doc, children, missing


def preview_create_document(context, args):
    _, children, missing = _create_generic_plan(context, args)
    return {
        "summary": f"Create a new {args['doctype']}.",
        "operation": "create_document",
        "target": {"doctype": args["doctype"], "name": None},
        "details": {
            "fields": [dict(pair) for pair in args["fields"]],
            # Row counts only: the approver expands the run for full values.
            "children": [
                {"field": table["field"], "child_doctype": table["child_doctype"], "rows": len(table["rows"])}
                for table in children
            ],
            "missing_required": missing,
            "rejected_fields": [],
        },
    }


def create_document(context, args):
    doc, _, _ = _create_generic_plan(context, args)
    # No ignore_permissions/ignore_mandatory/ignore_links: native validation,
    # permissions and hooks run exactly as for a Desk create. docstatus stays 0,
    # so a submittable DocType yields a draft a human reviews and submits.
    doc.insert()
    return {"doctype": args["doctype"], "name": doc.name, "created": True}


def _update_generic_plan(context, args, lock=False):
    import frappe

    doctype = args["doctype"]
    _write_scope(doctype)
    doc, meta = checked_doc(doctype, args["name"], lock=lock, permission="write")
    if str(doc.modified) != args["expected_modified"]:
        frappe.throw(
            "Record changed since it was read; read it again and request a new approval.",
            frappe.TimestampMismatchError,
        )
    # Submitted (or cancelled) documents are frozen; only drafts stay editable.
    if doc.get("docstatus", 0) != 0:
        denied()
    writable = safe_fields(meta, context.user, "write") & safe_fields(meta, context.user)
    pairs = _checked_pairs(meta, writable, args["changes"])
    changes = [
        {
            "field": pair["field"],
            "label": meta.get_field(pair["field"]).label or pair["field"],
            "before": doc.get(pair["field"]),
            "after": pair["value"],
        }
        for pair in pairs
    ]
    # Preserve the complete before/after diff, never an invisible truncated edit.
    json_value(changes)
    return doc, changes


def preview_update_document(context, args):
    _, changes = _update_generic_plan(context, args)
    return {
        "summary": f"Update {args['doctype']} {args['name']}.",
        "operation": "update_document",
        "target": {"doctype": args["doctype"], "name": args["name"]},
        "details": {"expected_modified": args["expected_modified"]},
        "changes": changes,
    }


def update_document(context, args):
    doc, _ = _update_generic_plan(context, args, lock=True)
    for pair in args["changes"]:
        doc.set(pair["field"], pair["value"])
    doc.save()
    return {
        "doctype": args["doctype"],
        "name": doc.name,
        "modified": str(doc.modified),
        "updated_fields": sorted(pair["field"] for pair in args["changes"]),
    }


def specs(context):
    return [
        ToolSpec(
            "list_doctypes",
            "List DocTypes the current user may read under the configured allow-list. Names and modules only; no record data.",
            _LIST_DOCTYPES,
            list_doctypes,
            preview_list_doctypes,
        ),
        ToolSpec(
            "describe_doctype",
            "Describe one allowed DocType: permitted scalar fields, labels, required flags, Link/Select options and read-only child-table shapes. Never credentials or hidden fields.",
            _DESCRIBE,
            describe_doctype,
            preview_describe_doctype,
        ),
        ToolSpec(
            "create_document",
            "Create one draft document in a write-scoped DocType from scalar fields plus optional child-table rows. Submittable DocTypes yield drafts only; docstatus is never settable and ledger/payment/stock/workflow doctypes are hard-blocked. Native validation and permissions apply.",
            _CREATE_DOCUMENT,
            create_document,
            preview_create_document,
            mutates=True,
        ),
        ToolSpec(
            "update_document",
            "Update scalar fields of one existing write-scoped draft document; supply its exact modified timestamp. No child rows, no submitted documents, no ledger/payment/stock/workflow doctypes.",
            _UPDATE_DOCUMENT,
            update_document,
            preview_update_document,
            mutates=True,
        ),
    ]
