"""Generate the initial declarative app schema; refuse to overwrite existing files."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "frappe_intelligence"


def field(name, kind="Data", **options):
    return {"fieldname": name, "label": name.replace("_", " ").title(), "fieldtype": kind, **options}


def link(name, target, **options):
    return field(name, "Link", options=target, **options)


def select(name, values, **options):
    return field(name, "Select", options="\n".join(values), **options)


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise RuntimeError(f"Refusing to overwrite {path}")
    path.write_text(content)


def main():
    roles = [
        {"role": name, "read": 1, "create": 1, "write": 1}
        for name in ("Intelligence User", "Intelligence Manager", "System Manager")
    ]
    definitions = {
        "Intelligence Provider": [
            field("title", reqd=1, in_list_view=1),
            select("kind", ["OpenAI", "Anthropic", "Gemini", "OpenRouter", "xAI", "Custom"], reqd=1),
            field("model", reqd=1),
            field("api_key", "Password", hidden=1),
            field("base_url"),
            field("is_shared", "Check", default="0"),
            field("enabled", "Check", default="1"),
            field("allowed_roles", "Small Text"),
            field("max_tokens", "Int", default="4096"),
            field("timeout", "Int", default="60"),
        ],
        "Intelligence Conversation": [
            field("title", default="New chat", reqd=1, in_list_view=1),
            link("provider", "Intelligence Provider", reqd=1),
            field("archived", "Check", default="0"),
            link("active_run", "Intelligence Run"),
            field("message_count", "Int", default="0"),
        ],
        "Intelligence Message": [
            link("conversation", "Intelligence Conversation", reqd=1, search_index=1),
            link("run", "Intelligence Run"),
            select("role", ["user", "assistant", "tool", "system"], reqd=1),
            field("content", "Long Text"),
            field("tool_calls", "Long Text"),
            field("tool_call_id"),
            select("status", ["complete", "streaming", "interrupted"], default="complete"),
            field("sequence", "Int", reqd=1),
        ],
        "Intelligence Run": [
            link("conversation", "Intelligence Conversation", reqd=1, search_index=1),
            link("provider", "Intelligence Provider", reqd=1),
            link("user", "User", reqd=1),
            field("site", reqd=1),
            select(
                "state",
                [
                    "queued",
                    "running",
                    "awaiting_approval",
                    "completed",
                    "failed",
                    "cancelled",
                    "needs_reconciliation",
                ],
                default="queued",
                in_list_view=1,
            ),
            field("error", "Long Text"),
            field("step_count", "Int", default="0"),
            field("active_seconds", "Float", default="0"),
            field("lease_token"),
            field("lease_expires", "Datetime"),
            field("cancel_requested", "Check", default="0"),
            field("started_at", "Datetime"),
            field("finished_at", "Datetime"),
            field("heartbeat_at", "Datetime"),
            field("context_json", "Long Text"),
            field("attachments_json", "Long Text"),
            field("input_tokens", "Int", default="0"),
            field("output_tokens", "Int", default="0"),
        ],
        "Intelligence Approval": [
            link("conversation", "Intelligence Conversation", reqd=1, search_index=1),
            link("run", "Intelligence Run", reqd=1, search_index=1),
            field("tool_name", reqd=1),
            field("tool_version", reqd=1),
            field("tool_call_id", reqd=1),
            field("arguments_json", "Long Text", reqd=1),
            field("preview_json", "Long Text"),
            field("digest", reqd=1),
            select(
                "status",
                ["pending", "approved", "denied", "executing", "succeeded", "failed", "expired", "uncertain"],
                default="pending",
            ),
            field("expires_at", "Datetime", reqd=1),
            link("decided_by", "User"),
            field("decided_at", "Datetime"),
        ],
        "Intelligence Tool Execution": [
            link("conversation", "Intelligence Conversation", reqd=1, search_index=1),
            link("run", "Intelligence Run", reqd=1),
            link("approval", "Intelligence Approval", reqd=1, unique=1),
            field("tool_name", reqd=1),
            select("state", ["started", "succeeded", "failed", "uncertain"], default="started"),
            field("result_json", "Long Text"),
            field("error", "Long Text"),
            field("started_at", "Datetime"),
            field("finished_at", "Datetime"),
        ],
        "Intelligence Memory": [
            select("scope", ["personal", "conversation", "site"], reqd=1, default="personal"),
            link("conversation", "Intelligence Conversation"),
            field("content", "Long Text", reqd=1),
            field("enabled", "Check", default="1"),
        ],
        "Intelligence Settings": [
            field("enabled", "Check", default="1"),
            field("allowed_read_doctypes", "Small Text"),
            field("allowed_reports", "Small Text"),
            field("enabled_tools", "Small Text"),
            field("allowed_custom_hosts", "Small Text"),
            field("max_steps", "Int", default="12"),
            field("max_tokens", "Int", default="4096"),
            field("max_run_seconds", "Int", default="600"),
            field("approval_expiry_minutes", "Int", default="1440"),
            field("max_upload_mb", "Int", default="10"),
            field("max_file_chars", "Int", default="30000"),
            field("daily_run_limit", "Int", default="100"),
        ],
    }
    module = ROOT / "frappe_intelligence"
    for directory in (module, module / "doctype", module / "page", module / "page/intelligence"):
        write(directory / "__init__.py", "")
    for name, fields in definitions.items():
        slug = name.lower().replace(" ", "_")
        single = name == "Intelligence Settings"
        definition = {
            "doctype": "DocType",
            "name": name,
            "module": "Frappe Intelligence",
            "autoname": "hash",
            "engine": "InnoDB",
            "issingle": int(single),
            "fields": fields,
            "field_order": [f["fieldname"] for f in fields],
            "permissions": (
                [
                    {"role": "System Manager", "read": 1, "write": 1},
                    {"role": "Intelligence User", "read": 1},
                    {"role": "Intelligence Manager", "read": 1},
                ]
                if single
                else roles
            ),
            "track_changes": 0,
            "sort_field": "creation",
            "sort_order": "DESC",
        }
        if any(f["fieldname"] == "title" for f in fields):
            definition["title_field"] = "title"
        folder = module / "doctype" / slug
        write(folder / "__init__.py", "")
        write(folder / f"{slug}.json", json.dumps(definition, indent=2) + "\n")
        base = "SettingsDocument" if single else "ManagedDocument"
        write(
            folder / f"{slug}.py",
            f"from frappe_intelligence.documents import {base}\n\n\nclass {name.replace(' ', '')}({base}):\n    pass\n",
        )
    write(ROOT / "modules.txt", "Frappe Intelligence\n")
    write(ROOT / "patches.txt", "[pre_model_sync]\n\n[post_model_sync]\n")
    write(
        module / "page/intelligence/intelligence.json",
        json.dumps(
            {
                "doctype": "Page",
                "name": "intelligence",
                "page_name": "intelligence",
                "title": "Intelligence",
                "module": "Frappe Intelligence",
                "standard": "Yes",
                "system_page": 0,
                "roles": [{"role": role["role"]} for role in roles],
            },
            indent=2,
        )
        + "\n",
    )


if __name__ == "__main__":
    main()
