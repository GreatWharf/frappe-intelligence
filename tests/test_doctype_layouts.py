"""Layout pins for the Desk-facing Intelligence doctypes.

The engine, validation and API layers key off exact field names and types, so
layout polish (sections, columns, HTML slots, descriptions) must never rename
a field, change its fieldtype or drop it from field_order. These tests cover
the four doctypes the Desk forms expose: Settings, Memory, Skill, Tool Grant.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "frappe_intelligence"
DOCTYPE_DIR = APP / "frappe_intelligence" / "doctype"
PUBLIC_JS = APP / "public" / "js"

SETTINGS_FIELDS = {
    "enabled": "Check",
    "approval_mode": "Select",
    "allowed_read_doctypes": "Small Text",
    "allowed_write_doctypes": "Small Text",
    "allowed_reports": "Small Text",
    "enabled_tools": "Small Text",
    "allowed_custom_hosts": "Small Text",
    "max_steps": "Int",
    "max_tokens": "Int",
    "max_run_seconds": "Int",
    "approval_expiry_minutes": "Int",
    "max_upload_mb": "Int",
    "max_file_chars": "Int",
    "daily_run_limit": "Int",
}

MEMORY_FIELDS = {
    "scope": "Select",
    "conversation": "Link",
    "content": "Long Text",
    "enabled": "Check",
}

SKILL_FIELDS = {
    "title": "Data",
    "description": "Small Text",
    "instructions": "Long Text",
    "scope_read": "Small Text",
    "scope_write": "Small Text",
    "enabled": "Check",
    "shared": "Check",
    "origin": "Select",
    "version": "Int",
}

GRANT_FIELDS = {
    "user": "Link",
    "tool": "Data",
    "scope_doctype": "Data",
    "scope": "Select",
    "conversation": "Link",
}

NEW_FORM_SCRIPTS = (
    "intelligence_chips.js",
    "intelligence_settings_form.js",
    "intelligence_memory_form.js",
    "intelligence_skill_form.js",
)


def schema(name):
    return json.loads((DOCTYPE_DIR / name / f"{name}.json").read_text())


def fields(name):
    return {field["fieldname"]: field for field in schema(name)["fields"]}


def test_field_order_matches_fields_exactly():
    for name in (
        "intelligence_settings",
        "intelligence_memory",
        "intelligence_skill",
        "intelligence_tool_grant",
    ):
        doc = schema(name)
        assert len(doc["field_order"]) == len(set(doc["field_order"])), name
        assert set(doc["field_order"]) == {field["fieldname"] for field in doc["fields"]}, name


def test_engine_field_names_and_types_are_unchanged():
    for doctype, pinned in (
        ("intelligence_settings", SETTINGS_FIELDS),
        ("intelligence_memory", MEMORY_FIELDS),
        ("intelligence_skill", SKILL_FIELDS),
        ("intelligence_tool_grant", GRANT_FIELDS),
    ):
        found = fields(doctype)
        for fieldname, fieldtype in pinned.items():
            assert fieldname in found, f"{doctype}.{fieldname} was renamed or removed"
            assert found[fieldname]["fieldtype"] == fieldtype, f"{doctype}.{fieldname} type changed"


def test_permissions_stay_read_only_friendly():
    for name in (
        "intelligence_settings",
        "intelligence_memory",
        "intelligence_skill",
        "intelligence_tool_grant",
    ):
        doc = schema(name)
        assert doc["module"] == "Frappe Intelligence"
        assert all(not row.get("share") for row in doc["permissions"]), name
        if name != "intelligence_skill" and name != "intelligence_tool_grant":
            assert all(not row.get("delete") for row in doc["permissions"]), name


def test_settings_layout_sections_and_editor_slots():
    found = fields("intelligence_settings")
    for fieldname in ("sb_assistant", "sb_limits", "sb_scope"):
        assert found[fieldname]["fieldtype"] == "Section Break", fieldname
    for fieldname in (
        "rag_status_html",
        "allowed_read_doctypes_chips",
        "allowed_write_doctypes_chips",
        "enabled_tools_chips",
        "allowed_reports_chips",
        "allowed_custom_hosts_chips",
    ):
        assert found[fieldname]["fieldtype"] == "HTML", fieldname
    assert found["approval_mode"]["options"] == "Approve Every Step\nApprove Writes Only\nAutomatic"
    assert "OUTPUT" in found["max_tokens"]["description"]


def test_memory_layout_flags_and_secret_note():
    doc = schema("intelligence_memory")
    found = fields("intelligence_memory")
    assert doc["title_field"] == "content"
    assert found["scope"]["in_list_view"] and found["enabled"]["in_list_view"]
    assert found["conversation"]["depends_on"] == "eval:doc.scope=='conversation'"
    assert "5000" in found["content"]["description"]
    note = found["secrets_note_html"]["options"]
    assert "Never store passwords, API keys, or other secrets in memory." in note


def test_skill_layout_and_read_only_provenance():
    found = fields("intelligence_skill")
    for fieldname in ("sb_about", "sb_instructions", "sb_scope", "sb_publishing"):
        assert found[fieldname]["fieldtype"] == "Section Break", fieldname
    for fieldname in ("scope_read_chips", "scope_write_chips"):
        assert found[fieldname]["fieldtype"] == "HTML", fieldname
    assert found["origin"]["read_only"] and found["version"]["read_only"]
    for fieldname in ("title", "origin", "enabled", "shared"):
        assert found[fieldname]["in_list_view"], fieldname


def test_grant_form_explains_provenance_and_off_switch():
    found = fields("intelligence_tool_grant")
    description = found["sb_grant"]["description"]
    assert "Always" in description and "Deleting a grant" in description
    assert found["conversation"]["depends_on"] == "eval:doc.scope=='This Conversation'"
    for fieldname in ("user", "tool", "scope_doctype", "scope"):
        assert found[fieldname]["in_list_view"], fieldname


def test_no_em_dash_in_layouts_or_form_scripts():
    paths = [
        DOCTYPE_DIR / name / f"{name}.json"
        for name in (
            "intelligence_settings",
            "intelligence_memory",
            "intelligence_skill",
            "intelligence_tool_grant",
        )
    ]
    paths += [PUBLIC_JS / script for script in NEW_FORM_SCRIPTS]
    for path in paths:
        assert chr(0x2014) not in path.read_text(), path.name


def test_form_scripts_ship_and_stay_self_registering():
    for script in NEW_FORM_SCRIPTS:
        source = (PUBLIC_JS / script).read_text()
        assert "global.fi" in source, script
        assert 'typeof module === "object"' in source, script
