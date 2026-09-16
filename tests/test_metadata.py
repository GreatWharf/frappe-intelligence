import ast
import json
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

ROOT = Path(__file__).resolve().parents[1]


def test_versions_and_cloud_range_match_the_declared_stack():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    version = project["project"]["version"]
    assert f'__version__ = "{version}"' in (ROOT / "frappe_intelligence/__init__.py").read_text()
    assert json.loads((ROOT / "package.json").read_text())["version"] == version
    assert project["tool"]["bench"]["frappe-dependencies"]["frappe"] == ">=15.0.0-dev,<17.0.0"
    assert project["project"]["requires-python"] == ">=3.10,<3.15"


def test_runtime_and_tests_parse_with_python_310_grammar():
    for directory in (ROOT / "frappe_intelligence", ROOT / "tests", ROOT / "scripts"):
        for source in directory.rglob("*.py"):
            ast.parse(source.read_text(), filename=str(source), feature_version=(3, 10))


def test_mutating_ui_methods_are_post_only():
    tree = ast.parse((ROOT / "frappe_intelligence/api.py").read_text())
    mutating = {
        "create_conversation",
        "send_message",
        "approve",
        "cancel",
        "rename_conversation",
        "archive_conversation",
        "upload_attachment",
        "save_memory",
        "delete_memory",
        "save_provider",
        "delete_provider",
    }
    checked = set()
    for function in tree.body:
        if not isinstance(function, ast.FunctionDef) or function.name not in mutating:
            continue
        for decorator in function.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and decorator.func.attr == "whitelist"
            ):
                values = {keyword.arg: ast.literal_eval(keyword.value) for keyword in decorator.keywords}
                assert values.get("methods") == ["POST"], function.name
                checked.add(function.name)
    assert checked == mutating
