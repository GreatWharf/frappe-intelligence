"""Native report execution for a fixed, company-scoped ERPNext report catalog.

Site settings can narrow this catalog, not authorize arbitrary scripts. Return
only native filtered tabular rows, never chart/summary/HTML/prepared report data.
Aggregated reports cannot safely express non-Company User Permissions, so those
users must use permission-aware document tools instead (fail closed).
"""

from datetime import date

from . import ToolSpec, denied, policy_lines
from .validation import DATE, NAME, object_schema

_FINANCIAL = {"Balance Sheet", "Profit and Loss Statement", "Cash Flow"}
_REPORTS = _FINANCIAL | {"Trial Balance", "General Ledger", "Accounts Receivable", "Accounts Payable"}
_FILTERS = object_schema(
    {
        "company": NAME,
        "fiscal_year": NAME,
        "from_date": DATE,
        "to_date": DATE,
        "report_date": DATE,
        "period_start_date": DATE,
        "period_end_date": DATE,
        "periodicity": {"type": "string", "enum": ["Monthly", "Quarterly", "Half-Yearly", "Yearly"]},
    },
    ("company",),
)
_SCHEMA = object_schema(
    {
        "report_name": {"type": "string", "enum": sorted(_REPORTS)},
        "filters": _FILTERS,
        "limit": {"type": "integer", "minimum": 1, "maximum": 200},
    },
    ("report_name", "filters"),
)


def _plan(context, args):
    import frappe

    from frappe_intelligence.access import get_settings

    name = args["report_name"]
    if (
        "erpnext" not in frappe.get_installed_apps()
        or name not in _REPORTS
        or name not in policy_lines(get_settings().get("allowed_reports"))
    ):
        denied()
    report = frappe.get_doc("Report", name)
    if (
        not report.is_permitted()
        or report.get("disabled")
        or report.get("is_standard") != "Yes"
        or report.get("report_type") != "Script Report"
        or report.get("module") != "Accounts"
        or not frappe.has_permission(report.ref_doctype, "report")
        or not frappe.has_permission(report.ref_doctype, "read")
    ):
        denied()
    company = frappe.get_doc("Company", args["filters"]["company"])
    company.check_permission("read")
    user_permissions = frappe.permissions.get_user_permissions(context.user)
    if any(doctype != "Company" and values for doctype, values in user_permissions.items()):
        denied()
    # Check Company permissions explicitly even when configured applicable_for
    # would cause a native Company Document permission check to ignore them.
    allowed_companies = {entry.get("doc") for entry in user_permissions.get("Company", [])}
    if allowed_companies and company.name not in allowed_companies:
        denied()
    filters = dict(args["filters"])
    if name in _FINANCIAL:
        required = {"company", "period_start_date", "period_end_date"}
        allowed = required | {"periodicity"}
        start, end = filters.get("period_start_date"), filters.get("period_end_date")
    elif name in {"Accounts Receivable", "Accounts Payable"}:
        required = allowed = {"company", "report_date"}
        start = end = None
    else:
        required = {"company", "from_date", "to_date"}
        if name == "Trial Balance":
            required.add("fiscal_year")
        allowed = required
        start, end = filters.get("from_date"), filters.get("to_date")
    if set(filters) - allowed or required - set(filters):
        raise ValueError("This report requires its specific company and date filters.")
    if start and end and (date.fromisoformat(end) - date.fromisoformat(start)).days not in range(0, 3661):
        raise ValueError("Report date range must be ordered and no longer than ten years.")
    if "fiscal_year" in filters:
        frappe.get_doc("Fiscal Year", filters["fiscal_year"]).check_permission("read")
    if name in _FINANCIAL:
        filters.update(
            filter_based_on="Date Range",
            periodicity=filters.get("periodicity", "Monthly"),
            accumulated_values=1,
        )
    return report, filters


def preview(context, args):
    report, filters = _plan(context, args)
    return {
        "summary": f"Run {args['report_name']} for the selected permitted company.",
        "operation": "report",
        "target": {"doctype": "Report", "name": args["report_name"]},
        "details": {
            "filters": filters,
            "report_modified": str(report.modified),
            "limit": args.get("limit", 100),
        },
    }


def run_report(context, args):
    _, filters = _plan(context, args)
    from frappe.desk.query_report import run

    # No caller-selected user, prepared report name, custom columns or default
    # filter substitution. Native run applies report roles and link/user filters.
    result = run(
        report_name=args["report_name"],
        filters=filters,
        ignore_prepared_report=True,
        are_default_filters=False,
    )
    if (
        not isinstance(result, dict)
        or not isinstance(result.get("columns"), list)
        or not isinstance(result.get("result"), list)
    ):
        raise ValueError("Report did not return a supported tabular result.")
    columns = []
    from .records import _SENSITIVE

    for column in result["columns"]:
        if not isinstance(column, dict) or not isinstance(column.get("fieldname"), str):
            raise ValueError("Report returned unsupported columns.")
        if _SENSITIVE.search(column["fieldname"]) or column.get("fieldtype") in {
            "Password",
            "HTML",
            "Attach",
            "Attach Image",
        }:
            continue
        columns.append({key: column.get(key) for key in ("fieldname", "label", "fieldtype", "options")})
    if len(columns) > 80:
        raise ValueError("Report has too many columns; narrow the reporting interval.")
    limit = args.get("limit", 100)
    rows = []
    for row in result["result"][:limit]:
        if not isinstance(row, dict):
            raise ValueError("Report returned unsupported rows.")
        projected = {col["fieldname"]: row.get(col["fieldname"]) for col in columns}
        if any(
            isinstance(value, (dict, list, tuple, bytes)) or (isinstance(value, str) and len(value) > 8000)
            for value in projected.values()
        ):
            raise ValueError("Report cells exceed the disclosure limit.")
        rows.append(projected)
    return {
        "report_name": args["report_name"],
        "filters": filters,
        "columns": columns,
        "rows": rows,
        "truncated": len(result["result"]) > limit,
    }


def specs(context):
    return [
        ToolSpec(
            "run_report",
            "Run one of the reviewed native ERPNext financial reports for exactly one permitted company. Supply its required date filters; no custom/prepared reports. Requires report permissions and approval.",
            _SCHEMA,
            run_report,
            preview,
            operation="Report",
        )
    ]
