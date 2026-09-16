"""Bounded, fail-closed JSON Schema subset used by the tool boundary.

This is NOT a general JSON Schema implementation. Extensions may use only the
explicit keywords below; refs, open objects and unknown keywords are rejected at
registration. Keeping the small offline interpreter avoids silently skipping
validation when an optional dependency is absent. No coercion or defaults occur.
"""

import json
import math
import re
from datetime import date, datetime

_COMMON = {"type", "description", "enum"}
_KEYWORDS = {
    "object": {"properties", "required", "additionalProperties", "minProperties", "maxProperties"},
    "array": {"items", "minItems", "maxItems", "uniqueItems"},
    "string": {"minLength", "maxLength", "pattern", "format"},
    "integer": {"minimum", "maximum"},
    "number": {"minimum", "maximum"},
    "boolean": set(),
    "null": set(),
}


def _invalid():
    raise ValueError("Tool arguments or schema are invalid.")


def check_schema(schema, depth=0):
    if not isinstance(schema, dict) or depth > 12:
        _invalid()
    if "anyOf" in schema:
        if (
            set(schema) - {"anyOf", "description"}
            or not isinstance(schema["anyOf"], list)
            or not 1 <= len(schema["anyOf"]) <= 8
        ):
            _invalid()
        for child in schema["anyOf"]:
            check_schema(child, depth + 1)
        return
    kind = schema.get("type")
    if kind not in _KEYWORDS or set(schema) - (_COMMON | _KEYWORDS[kind]):
        _invalid()
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        _invalid()
    if kind == "object":
        if schema.get("additionalProperties") is not False or not isinstance(schema.get("properties"), dict):
            _invalid()
        required = schema.get("required")
        if not isinstance(required, list) or any(
            not isinstance(k, str) or k not in schema["properties"] for k in required
        ):
            _invalid()
        for name, child in schema["properties"].items():
            if not isinstance(name, str):
                _invalid()
            check_schema(child, depth + 1)
    elif kind == "array":
        check_schema(schema.get("items"), depth + 1)
    elif kind == "string":
        if "format" in schema and schema["format"] not in {"date", "date-time", "frappe-datetime"}:
            _invalid()
        if "pattern" in schema:
            # Patterns are trusted registration-time code, never model supplied.
            try:
                re.compile(schema["pattern"])
            except (TypeError, re.error):
                _invalid()
    for name in ("minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"):
        if name in schema and (type(schema[name]) is not int or schema[name] < 0):
            _invalid()
    for name in ("minimum", "maximum"):
        if name in schema and (type(schema[name]) not in (int, float) or not math.isfinite(schema[name])):
            _invalid()


def validate(value, schema):
    check_schema(schema)
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
    except (TypeError, ValueError, RecursionError):
        _invalid()
    if len(encoded.encode("utf-8")) > 128_000:
        _invalid()
    _validate(value, schema, 0)


def _validate(value, schema, depth):
    if depth > 16:
        _invalid()
    if "anyOf" in schema:
        for child in schema["anyOf"]:
            try:
                _validate(value, child, depth + 1)
                return
            except ValueError:
                continue
        _invalid()
    kind = schema["type"]
    types = {
        "object": (dict,),
        "array": (list,),
        "string": (str,),
        "integer": (int,),
        "number": (int, float),
        "boolean": (bool,),
        "null": (type(None),),
    }
    if type(value) not in types[kind]:
        _invalid()
    if "enum" in schema and not any(type(value) is type(item) and value == item for item in schema["enum"]):
        _invalid()
    if kind == "object":
        if set(value) - set(schema["properties"]) or set(schema["required"]) - set(value):
            _invalid()
        _bounds(len(value), schema, "minProperties", "maxProperties")
        for name, item in value.items():
            _validate(item, schema["properties"][name], depth + 1)
    elif kind == "array":
        _bounds(len(value), schema, "minItems", "maxItems")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            _invalid()
        for item in value:
            _validate(item, schema["items"], depth + 1)
    elif kind == "string":
        _bounds(len(value), schema, "minLength", "maxLength")
        if "\x00" in value or ("pattern" in schema and not re.search(schema["pattern"], value)):
            _invalid()
        fmt = schema.get("format")
        try:
            if fmt == "date":
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    _invalid()
                date.fromisoformat(value)
            elif fmt in {"date-time", "frappe-datetime"}:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                if len(value) < 19:
                    _invalid()
        except ValueError:
            _invalid()
    elif kind in {"number", "integer"}:
        if not math.isfinite(value):
            _invalid()
        _bounds(value, schema, "minimum", "maximum")


def _bounds(value, schema, low, high):
    if (low in schema and value < schema[low]) or (high in schema and value > schema[high]):
        _invalid()


def object_schema(properties, required=(), **kwargs):
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
        **kwargs,
    }


def string_schema(max_length=140, **kwargs):
    return {"type": "string", "minLength": 1, "maxLength": max_length, **kwargs}


FIELD = string_schema(140, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
NAME = string_schema()
DATE = string_schema(10, format="date")
MODIFIED = string_schema(40, format="frappe-datetime")
SCALAR = {
    "anyOf": [
        {"type": "string", "maxLength": 1000},
        {"type": "number"},
        {"type": "boolean"},
        {"type": "null"},
    ]
}
