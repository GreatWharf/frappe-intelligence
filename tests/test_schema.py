import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "frappe_intelligence"
MANAGED = [
    "intelligence_conversation",
    "intelligence_message",
    "intelligence_run",
    "intelligence_approval",
    "intelligence_tool_execution",
    "intelligence_provider",
    "intelligence_memory",
]


def schema(name):
    return json.loads((APP / "frappe_intelligence/doctype" / name / f"{name}.json").read_text())


def test_private_data_cannot_be_created_or_edited_through_generic_rest():
    for name in MANAGED:
        doc = schema(name)
        assert doc["module"] == "Frappe Intelligence"
        assert all(not row.get("delete") and not row.get("share") for row in doc["permissions"])
        controller = APP / "frappe_intelligence/doctype" / name / f"{name}.py"
        assert "(ManagedDocument)" in controller.read_text()
        assert len(doc["field_order"]) == len(set(doc["field_order"]))
        assert set(doc["field_order"]) == {field["fieldname"] for field in doc["fields"]}
        path = APP / "frappe_intelligence/doctype" / name / f"{name}.py"
        ast.parse(path.read_text())


def test_provider_secret_is_password_and_execution_receipt_is_unique():
    fields = {field["fieldname"]: field for field in schema("intelligence_provider")["fields"]}
    assert fields["api_key"]["fieldtype"] == "Password"
    assert fields["api_key"].get("hidden")
    execution = {field["fieldname"]: field for field in schema("intelligence_tool_execution")["fields"]}
    assert execution["approval"].get("unique")
    run = {field["fieldname"]: field for field in schema("intelligence_run")["fields"]}
    assert run["site"]["fieldtype"] == "Data"
    assert {"lease_token", "lease_expires", "cancel_requested", "user"} <= run.keys()


def test_app_assets_and_lifecycle_hooks_are_packaged():
    for name in ("modules.txt", "patches.txt", "hooks.py"):
        assert (APP / name).exists()
    assert (APP / "frappe_intelligence/page/intelligence_chat/intelligence_chat.json").exists()
    assert (APP / "public/images/intelligence.svg").exists()


def test_preview_server_serves_only_paths_that_exist():
    import re

    source = (ROOT / "dev/preview-server.cjs").read_text(encoding="utf-8")
    served = re.findall(r"'(frappe_intelligence/[^']+)'", source)
    assert served, "preview server fixture paths not found"
    for relative in served:
        assert (ROOT / relative).exists(), relative
