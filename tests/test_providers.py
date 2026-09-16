"""Offline protocol tests: real serializers with the HTTP boundary replaced."""

import json
from dataclasses import asdict
from unittest.mock import patch

import pytest

from frappe_intelligence.providers import ProviderConfig, ProviderError, Reply, ToolCall, complete

KEY = "secret-key-never-in-errors"
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_record",
            "description": "Find an approved record",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    }
]
MESSAGES = [{"role": "system", "content": "Be useful"}, {"role": "user", "content": "Find it"}]


def config(kind="openai", **kwargs):
    return ProviderConfig(kind=kind, model="configured-model", api_key=KEY, **kwargs)


def openai_response(**message):
    return {
        "choices": [
            {"message": {"role": "assistant", "content": "Done", **message}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
    }


def invoke(cfg, response, messages=None, tools=None):
    with patch("frappe_intelligence.providers.adapters.post_json", return_value=response) as transport:
        result = complete(cfg, messages or MESSAGES, TOOLS if tools is None else tools)
    return result, transport.call_args.kwargs


@pytest.mark.parametrize(
    ("kind", "url"),
    [
        ("openai", "https://api.openai.com/v1/chat/completions"),
        ("openrouter", "https://openrouter.ai/api/v1/chat/completions"),
        ("xai", "https://api.x.ai/v1/chat/completions"),
        ("custom", "https://models.example.com/api/v1/chat/completions"),
    ],
)
def test_openai_compatible_real_request_and_usage(kind, url):
    kwargs = (
        {"base_url": "https://models.example.com/api/v1/", "allowed_hosts": ("models.example.com",)}
        if kind == "custom"
        else {}
    )
    result, request = invoke(config(kind, **kwargs), openai_response())
    assert isinstance(result, Reply)
    assert result.text == "Done"
    assert result.usage == {"input_tokens": 12, "output_tokens": 7, "total_tokens": 19}
    assert request["url"] == url
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert KEY not in request["url"]
    assert request["payload"]["model"] == "configured-model"
    assert request["payload"]["messages"] == MESSAGES
    assert request["payload"]["tools"] == TOOLS
    assert request["payload"]["stream"] is False
    assert request["timeout"] == 60
    assert json.loads(json.dumps(request["payload"])) == request["payload"]


def test_openai_tool_calls_and_results_roundtrip():
    result, _ = invoke(
        config(),
        openai_response(
            content=None,
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "lookup_record", "arguments": '{"name":"INV-1"}'},
                }
            ],
        ),
    )
    assert result.tool_calls == [ToolCall("call_1", "lookup_record", {"name": "INV-1"})]
    history = MESSAGES + [
        {
            "role": "assistant",
            "content": result.text,
            "tool_calls": [asdict(call) for call in result.tool_calls],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"found":true}'},
    ]
    _, request = invoke(config(), openai_response(), history)
    sent = request["payload"]["messages"]
    assert json.loads(sent[-2]["tool_calls"][0]["function"]["arguments"]) == {"name": "INV-1"}
    assert "metadata" not in sent[-2]["tool_calls"][0]
    assert sent[-1] == history[-1]


def test_anthropic_system_parallel_tools_and_hidden_thought_filter():
    response = {
        "content": [
            {"type": "thinking", "thinking": "PRIVATE THOUGHT", "signature": "not-public"},
            {"type": "text", "text": "Looking"},
            {"type": "tool_use", "id": "toolu_1", "name": "lookup_record", "input": {"name": "INV-1"}},
            {"type": "tool_use", "id": "toolu_2", "name": "lookup_record", "input": {"name": "INV-2"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 9, "output_tokens": 3},
    }
    result, request = invoke(config("anthropic"), response)
    assert result.text == "Looking"
    assert "PRIVATE" not in repr(result)
    assert request["url"] == "https://api.anthropic.com/v1/messages"
    assert request["headers"]["x-api-key"] == KEY
    assert request["headers"]["anthropic-version"] == "2023-06-01"
    assert request["payload"]["system"] == "Be useful"
    assert request["payload"]["tools"][0]["input_schema"] == TOOLS[0]["function"]["parameters"]
    assert result.usage == {"input_tokens": 9, "output_tokens": 3, "total_tokens": 12}
    history = MESSAGES + [
        {
            "role": "assistant",
            "content": result.text,
            "tool_calls": [asdict(call) for call in result.tool_calls],
        },
        {"role": "tool", "content": '{"ok":true}', "tool_call_id": "toolu_1"},
        {"role": "tool", "content": "Denied by user", "tool_call_id": "toolu_2", "is_error": True},
    ]
    _, followup = invoke(config("anthropic"), {"content": [{"type": "text", "text": "Done"}]}, history)
    sent = followup["payload"]["messages"]
    assert sent[-2]["role"] == "assistant"
    assert sent[-2]["content"][1] == {
        "type": "tool_use",
        "id": "toolu_1",
        "name": "lookup_record",
        "input": {"name": "INV-1"},
    }
    assert sent[-1] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": '{"ok":true}'},
            {"type": "tool_result", "tool_use_id": "toolu_2", "content": "Denied by user", "is_error": True},
        ],
    }


def test_gemini_signatures_survive_serialized_parallel_tool_roundtrip_without_thought_text():
    response = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {"thought": True, "text": "PRIVATE THOUGHT"},
                        {"text": "Looking"},
                        {
                            "functionCall": {"name": "lookup_record", "args": {"name": "INV-1"}},
                            "thoughtSignature": "opaque+/signature==",
                        },
                        {
                            "functionCall": {
                                "id": "gemini_second",
                                "name": "lookup_record",
                                "args": {"name": "INV-2"},
                            },
                            "thoughtSignature": "opaque-second",
                        },
                    ],
                },
                "finishReason": "STOP",
            }
        ],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 4,
            "thoughtsTokenCount": 2,
            "totalTokenCount": 16,
        },
    }
    result, request = invoke(config("gemini"), response)
    assert result.text == "Looking"
    assert "PRIVATE THOUGHT" not in json.dumps(asdict(result))
    assert len(result.tool_calls) == 2
    assert result.tool_calls[0].id
    assert result.tool_calls[1].id == "gemini_second"
    assert (
        request["url"]
        == "https://generativelanguage.googleapis.com/v1beta/models/configured-model:generateContent"
    )
    assert request["headers"]["x-goog-api-key"] == KEY
    assert KEY not in request["url"]
    assert request["payload"]["systemInstruction"] == {"parts": [{"text": "Be useful"}]}
    declaration = request["payload"]["tools"][0]["functionDeclarations"][0]
    assert declaration["parametersJsonSchema"] == TOOLS[0]["function"]["parameters"]
    assert result.usage == {"input_tokens": 10, "output_tokens": 6, "total_tokens": 16}
    history = MESSAGES + [
        {
            "role": "assistant",
            "content": result.text,
            "tool_calls": json.loads(json.dumps([asdict(call) for call in result.tool_calls])),
        },
        *[{"role": "tool", "content": '{"ok":true}', "tool_call_id": call.id} for call in result.tool_calls],
    ]
    _, followup = invoke(
        config("gemini"), {"candidates": [{"content": {"parts": [{"text": "Done"}]}}]}, history
    )
    sent = followup["payload"]["contents"]
    parts = sent[-2]["parts"]
    assert parts[1]["thoughtSignature"] == "opaque+/signature=="
    assert parts[2]["thoughtSignature"] == "opaque-second"
    # Provider-generated IDs are replayed; locally synthesized IDs are never invented on the wire.
    assert "id" not in parts[1]["functionCall"]
    assert parts[2]["functionCall"]["id"] == "gemini_second"
    assert sent[-1]["role"] == "user"
    assert sent[-1]["parts"][0]["functionResponse"] == {
        "name": "lookup_record",
        "response": {"result": '{"ok":true}'},
    }
    assert sent[-1]["parts"][1]["functionResponse"]["id"] == "gemini_second"
    assert "PRIVATE THOUGHT" not in json.dumps(followup["payload"])


@pytest.mark.parametrize("kind", ["openai", "anthropic", "gemini", "openrouter", "xai"])
def test_models_are_user_configured_and_no_tools_omits_tool_parameters(kind):
    response = (
        openai_response()
        if kind not in ("anthropic", "gemini")
        else (
            {"content": [{"type": "text", "text": "Done"}]}
            if kind == "anthropic"
            else {"candidates": [{"content": {"parts": [{"text": "Done"}]}}]}
        )
    )
    _, request = invoke(ProviderConfig(kind, "deployment-custom-2029", KEY), response, tools=[])
    assert "tools" not in request["payload"]
    if kind != "gemini":
        assert request["payload"]["model"] == "deployment-custom-2029"
    else:
        assert "deployment-custom-2029" in request["url"]


@pytest.mark.parametrize(
    "arguments", ["not json " + KEY, "[]", '"string"', "null", '{"bad": NaN}', '{"a":1,"a":2}']
)
def test_malformed_tool_arguments_fail_closed_with_safe_error(arguments):
    with pytest.raises(ProviderError) as exc:
        invoke(
            config(),
            openai_response(
                tool_calls=[
                    {
                        "id": "a",
                        "type": "function",
                        "function": {"name": "lookup_record", "arguments": arguments},
                    }
                ]
            ),
        )
    assert exc.value.code == "invalid_response"
    assert KEY not in str(exc.value)
    assert arguments not in str(exc.value)


@pytest.mark.parametrize(
    "kind,response",
    [
        ("openai", {}),
        ("openai", {"choices": []}),
        ("openai", {"choices": [{"message": {"content": 42}}]}),
        ("anthropic", {"content": [{"type": "tool_use", "id": "t", "name": "lookup_record", "input": []}]}),
        ("gemini", {"candidates": []}),
        (
            "gemini",
            {
                "candidates": [
                    {"content": {"parts": [{"functionCall": {"name": "lookup_record", "args": []}}]}}
                ]
            },
        ),
    ],
)
def test_malformed_provider_responses_never_return_partial_tool_calls(kind, response):
    with pytest.raises(ProviderError, match="valid"):
        invoke(config(kind), response)


@pytest.mark.parametrize(
    "kind,response",
    [
        ("openai", {"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]}),
        ("anthropic", {"content": [{"type": "text", "text": "partial"}], "stop_reason": "max_tokens"}),
        (
            "gemini",
            {"candidates": [{"content": {"parts": [{"text": "partial"}]}, "finishReason": "MAX_TOKENS"}]},
        ),
    ],
)
def test_truncated_replies_are_not_treated_as_complete(kind, response):
    with pytest.raises(ProviderError) as exc:
        invoke(config(kind), response)
    assert exc.value.code == "incomplete_response"


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "unknown"},
        {"model": ""},
        {"api_key": ""},
        {"api_key": "key\r\nInjected: yes"},
        {"timeout": 0},
        {"timeout": 121},
        {"timeout": True},
        {"max_tokens": -1},
        {"base_url": "https://attacker.example"},
    ],
)
def test_invalid_configuration_fails_before_transport(overrides):
    cfg = ProviderConfig(**{"kind": "openai", "model": "configured-model", "api_key": KEY, **overrides})
    with patch("frappe_intelligence.providers.adapters.post_json") as transport:
        with pytest.raises(ProviderError) as exc:
            complete(cfg, MESSAGES, TOOLS)
    assert exc.value.code == "invalid_config"
    transport.assert_not_called()


@pytest.mark.parametrize(
    "messages",
    [
        [{"role": "tool", "content": "leaked", "tool_call_id": "missing"}],
        [{"role": "user", "content": {"unexpected": "object"}}],
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "a", "name": "lookup_record", "arguments": {}}],
            },
            {"role": "user", "content": "skip result"},
        ],
    ],
)
def test_malformed_histories_fail_before_transport(messages):
    with patch("frappe_intelligence.providers.adapters.post_json") as transport:
        with pytest.raises(ProviderError) as exc:
            complete(config(), messages, TOOLS)
    assert exc.value.code == "invalid_request"
    transport.assert_not_called()


def test_opaque_metadata_is_not_part_of_repr_and_defaults_are_independent():
    assert KEY not in repr(config())
    first = ToolCall("a", "lookup_record", {}, {"gemini": {"thoughtSignature": "OPAQUE_PRIVATE"}})
    assert "OPAQUE_PRIVATE" not in repr(first)
    second, third = ToolCall("b", "lookup_record", {}), ToolCall("c", "lookup_record", {})
    second.metadata["x"] = 1
    assert third.metadata == {}


def test_history_limit_matches_engine_two_thousand_message_limit():
    messages = [{"role": "user", "content": "Hello"} for _ in range(2000)]
    _, request = invoke(config(), openai_response(), messages)
    assert len(request["payload"]["messages"]) == 2000
    with pytest.raises(ProviderError) as exc:
        invoke(config(), openai_response(), messages + [{"role": "user", "content": "Extra"}])
    assert exc.value.code == "invalid_request"
