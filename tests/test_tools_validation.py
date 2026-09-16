"""The schema interpreter deliberately rejects every unsupported keyword."""

import importlib

import pytest


def validator():
    return importlib.import_module("frappe_intelligence.tools.validation")


def test_schema_validator_module_exists():
    from pathlib import Path

    assert Path(__file__).parents[1].joinpath("frappe_intelligence/tools/validation.py").exists()


@pytest.mark.parametrize(
    "schema,value",
    [
        ({"type": "integer"}, True),
        ({"type": "integer", "minimum": 1, "maximum": 5}, 0),
        ({"type": "number"}, float("nan")),
        ({"type": "string", "maxLength": 3}, "long"),
        ({"type": "string", "format": "date"}, "2026-02-31"),
        ({"type": "string", "pattern": "^[a-z]+$"}, "bad.field"),
        ({"type": "string", "enum": ["Open", "Closed"]}, "Cancelled"),
        ({"type": "array", "items": {"type": "string"}, "maxItems": 1}, ["a", "b"]),
        ({"type": "array", "items": {"type": "string"}, "uniqueItems": True}, ["a", "a"]),
        (
            {
                "type": "object",
                "properties": {"a": {"type": "string"}},
                "required": ["a"],
                "additionalProperties": False,
            },
            {},
        ),
        ({"type": "object", "properties": {}, "required": [], "additionalProperties": False}, {"unknown": 1}),
    ],
)
def test_rejects_invalid_json_inputs(schema, value):
    with pytest.raises(ValueError):
        validator().validate(value, schema)


@pytest.mark.parametrize(
    "schema",
    [
        {"$ref": "https://evil.invalid/schema"},
        {"type": "object", "additionalProperties": True},
        {"type": "string", "format": "unknown"},
        {"type": "string", "unknownKeyword": True},
    ],
)
def test_unrecognized_or_open_schema_is_rejected(schema):
    with pytest.raises(ValueError):
        validator().check_schema(schema)


def test_scalar_union_and_nested_schema():
    schema = {
        "type": "object",
        "properties": {
            "values": {
                "type": "array",
                "maxItems": 3,
                "items": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
            }
        },
        "required": ["values"],
        "additionalProperties": False,
    }
    validator().check_schema(schema)
    validator().validate({"values": ["one", 2]}, schema)
    with pytest.raises(ValueError):
        validator().validate({"values": [False]}, schema)
