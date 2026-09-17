"""Non-streaming REST protocol adapters; no SDK state, Frappe, or model catalog."""

import re
import uuid
from dataclasses import asdict

from .network import MAX_TIMEOUT, encode_json, parse_json_object, post_json, validate_endpoint
from .types import ProviderConfig, ProviderError, Reply, ToolCall

_ENDPOINTS = {
    "openai": ("https://api.openai.com/v1/chat/completions", "api.openai.com"),
    "anthropic": ("https://api.anthropic.com/v1/messages", "api.anthropic.com"),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta", "generativelanguage.googleapis.com"),
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions", "openrouter.ai"),
    "xai": ("https://api.x.ai/v1/chat/completions", "api.x.ai"),
}
# The wire contract is lowercase; the DocType Select labels normalize to these at the engine boundary.
KINDS = frozenset({*_ENDPOINTS, "custom"})
_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_CALL_ID = re.compile(r"[A-Za-z0-9_.:-]{1,256}\Z")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}\Z")


def _config_error():
    return ProviderError("invalid_config", "The provider credentials or configuration are invalid.")


def _request_error():
    return ProviderError(
        "invalid_request", "The conversation or tool definitions are invalid for the provider."
    )


def _response_error():
    return ProviderError("invalid_response", "The provider returned an invalid response.")


def _incomplete():
    return ProviderError(
        "incomplete_response",
        "The provider response was incomplete. Adjust the token limit or request and try again.",
    )


def _refused():
    return ProviderError(
        "request_refused", "The provider could not complete this request under its content policy."
    )


def _configuration(config):
    if not isinstance(config, ProviderConfig):
        raise _config_error()
    if (
        not isinstance(config.kind, str)
        or config.kind not in KINDS
        or not isinstance(config.model, str)
        or not _MODEL.fullmatch(config.model)
        or not isinstance(config.api_key, str)
        or not config.api_key.strip()
        or len(config.api_key) > 4096
        or any(ord(char) < 33 or ord(char) > 126 for char in config.api_key)
        or type(config.max_tokens) is not int
        or not 1 <= config.max_tokens <= 131072
        or type(config.timeout) is not int
        or not 1 <= config.timeout <= MAX_TIMEOUT
        or not isinstance(config.base_url, str)
    ):
        raise _config_error()
    if config.kind == "custom":
        # The configured URL is an API root, e.g. https://provider.example/v1.
        validate_endpoint(config.base_url, config.allowed_hosts)
        url = config.base_url.rstrip("/") + "/chat/completions"
        allowed_hosts = config.allowed_hosts
    else:
        if config.base_url:
            raise _config_error()
        url, host = _ENDPOINTS[config.kind]
        allowed_hosts = (host,)
        if config.kind == "gemini":
            model = config.model.removeprefix("models/")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", model):
                raise _config_error()
            url += f"/models/{model}:generateContent"
    validate_endpoint(url, allowed_hosts)
    return url, allowed_hosts


def _call(value, *, response=False):
    error = _response_error if response else _request_error
    if isinstance(value, ToolCall):
        value = asdict(value)
    if not isinstance(value, dict):
        raise error()
    call_id, name, arguments = value.get("id"), value.get("name"), value.get("arguments")
    metadata = value.get("metadata", {})
    if (
        not isinstance(call_id, str)
        or not _CALL_ID.fullmatch(call_id)
        or not isinstance(name, str)
        or not _NAME.fullmatch(name)
        or not isinstance(arguments, dict)
        or not isinstance(metadata, dict)
    ):
        raise error()
    try:
        encode_json(arguments)
        encode_json(metadata)
    except ProviderError:
        raise error() from None
    return ToolCall(call_id, name, arguments, metadata)


def _messages(messages):
    if not isinstance(messages, list) or not messages or len(messages) > 2000:
        raise _request_error()
    normalized = []
    pending = {}
    seen = set()
    for value in messages:
        if not isinstance(value, dict):
            raise _request_error()
        role = value.get("role")
        content = value.get("content", "")
        if content is None and role == "assistant":
            content = ""
        if role not in ("system", "user", "assistant", "tool") or not isinstance(content, str):
            raise _request_error()
        message = {"role": role, "content": content}
        if role == "tool":
            call_id = value.get("tool_call_id")
            if not isinstance(call_id, str) or call_id not in pending or value.get("tool_calls"):
                raise _request_error()
            message["call"] = pending.pop(call_id)
            if "is_error" in value:
                if not isinstance(value["is_error"], bool):
                    raise _request_error()
                message["is_error"] = value["is_error"]
        else:
            if pending:
                raise _request_error()
            calls = value.get("tool_calls", [])
            if not isinstance(calls, list) or len(calls) > 128 or (calls and role != "assistant"):
                raise _request_error()
            if calls:
                message["tool_calls"] = [_call(call) for call in calls]
                for call in message["tool_calls"]:
                    if call.id in seen:
                        raise _request_error()
                    pending[call.id] = call
                    seen.add(call.id)
        normalized.append(message)
    if pending:
        raise _request_error()
    return normalized


def _tools(tools):
    if not isinstance(tools, list) or len(tools) > 128:
        raise _request_error()
    result = []
    names = set()
    for tool in tools:
        if (
            not isinstance(tool, dict)
            or tool.get("type") != "function"
            or not isinstance(tool.get("function"), dict)
        ):
            raise _request_error()
        function = tool["function"]
        name = function.get("name")
        description = function.get("description", "")
        parameters = function.get("parameters")
        if (
            not isinstance(name, str)
            or not _NAME.fullmatch(name)
            or name in names
            or not isinstance(description, str)
            or not isinstance(parameters, dict)
        ):
            raise _request_error()
        encode_json(parameters)
        names.add(name)
        result.append({"name": name, "description": description, "parameters": parameters})
    return result


def _openai_request(config, messages, tools):
    sent = []
    for message in messages:
        item = {"role": message["role"], "content": message["content"]}
        if message["role"] == "tool":
            item["tool_call_id"] = message["call"].id
        elif message.get("tool_calls"):
            item["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": encode_json(call.arguments).decode("utf-8")},
                }
                for call in message["tool_calls"]
            ]
        sent.append(item)
    token_parameter = "max_completion_tokens" if config.kind == "openai" else "max_tokens"
    payload = {"model": config.model, "messages": sent, "stream": False, token_parameter: config.max_tokens}
    if tools:
        payload["tools"] = [{"type": "function", "function": function} for function in tools]
    return {"Authorization": f"Bearer {config.api_key}"}, payload


def _append_turn(turns, role, parts, key):
    if turns and turns[-1]["role"] == role:
        turns[-1][key].extend(parts)
    else:
        turns.append({"role": role, key: parts})


def _anthropic_request(config, messages, tools):
    system = []
    turns = []
    for message in messages:
        role, text = message["role"], message["content"]
        if role == "system":
            system.append(text)
            continue
        if role == "tool":
            result = {"type": "tool_result", "tool_use_id": message["call"].id, "content": text}
            if message.get("is_error"):
                result["is_error"] = True
            _append_turn(turns, "user", [result], "content")
        else:
            parts = [{"type": "text", "text": text}] if text else []
            parts.extend(
                {"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments}
                for call in message.get("tool_calls", [])
            )
            if not parts:
                raise _request_error()
            _append_turn(turns, role, parts, "content")
    if not turns:
        raise _request_error()
    payload = {"model": config.model, "max_tokens": config.max_tokens, "messages": turns, "stream": False}
    if system:
        payload["system"] = "\n\n".join(system)
    if tools:
        payload["tools"] = [
            {
                "name": function["name"],
                "description": function["description"],
                "input_schema": function["parameters"],
            }
            for function in tools
        ]
    headers = {"x-api-key": config.api_key, "anthropic-version": "2023-06-01"}
    return headers, payload


def _gemini_metadata(call):
    metadata = call.metadata.get("gemini", {})
    if not isinstance(metadata, dict):
        raise _request_error()
    signature = metadata.get("thoughtSignature")
    wire_id = metadata.get("id")
    if signature is not None and (not isinstance(signature, str) or len(signature) > 1024 * 1024):
        raise _request_error()
    if wire_id is not None and wire_id != call.id:
        raise _request_error()
    return signature, wire_id


def _gemini_request(config, messages, tools):
    system = []
    turns = []
    for message in messages:
        role, text = message["role"], message["content"]
        if role == "system":
            system.append({"text": text})
            continue
        if role == "tool":
            call = message["call"]
            _signature, wire_id = _gemini_metadata(call)
            result = {"name": call.name, "response": {"result": text}}
            if wire_id is not None:
                result["id"] = wire_id
            _append_turn(turns, "user", [{"functionResponse": result}], "parts")
        else:
            parts = [{"text": text}] if text else []
            for call in message.get("tool_calls", []):
                signature, wire_id = _gemini_metadata(call)
                function_call = {"name": call.name, "args": call.arguments}
                if wire_id is not None:
                    function_call["id"] = wire_id
                part = {"functionCall": function_call}
                if signature is not None:
                    part["thoughtSignature"] = signature
                parts.append(part)
            if not parts:
                raise _request_error()
            _append_turn(turns, "model" if role == "assistant" else "user", parts, "parts")
    if not turns:
        raise _request_error()
    payload = {"contents": turns, "generationConfig": {"maxOutputTokens": config.max_tokens}}
    if system:
        payload["systemInstruction"] = {"parts": system}
    if tools:
        # Use JSON Schema verbatim instead of lossy conversion into Gemini's
        # smaller OpenAPI Schema subset (which loses refs/additionalProperties).
        payload["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": function["name"],
                        "description": function["description"],
                        "parametersJsonSchema": function["parameters"],
                    }
                    for function in tools
                ]
            }
        ]
    return {"x-goog-api-key": config.api_key}, payload


def _count(value):
    return value if type(value) is int and 0 <= value <= 10**12 else 0


def _usage(raw, kind):
    raw = raw if isinstance(raw, dict) else {}
    if kind == "anthropic":
        inputs = sum(
            _count(raw.get(key))
            for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )
        outputs = _count(raw.get("output_tokens"))
        total = inputs + outputs
    elif kind == "gemini":
        inputs = _count(raw.get("promptTokenCount"))
        outputs = _count(raw.get("candidatesTokenCount")) + _count(raw.get("thoughtsTokenCount"))
        total = _count(raw.get("totalTokenCount"))
    else:
        inputs = _count(raw.get("prompt_tokens"))
        outputs = _count(raw.get("completion_tokens"))
        total = _count(raw.get("total_tokens"))
    return {"input_tokens": inputs, "output_tokens": outputs, "total_tokens": max(total, inputs + outputs)}


def _reply(text, calls, usage):
    if not text and not calls:
        raise _response_error()
    if len(calls) > 128 or len({call.id for call in calls}) != len(calls):
        raise _response_error()
    return Reply(text, calls, usage)


def _openai_reply(response):
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise _response_error()
    choice = choices[0]
    reason = choice.get("finish_reason")
    if reason == "length":
        raise _incomplete()
    if reason == "content_filter":
        raise _refused()
    if reason not in (None, "stop", "tool_calls"):
        raise _response_error()
    message = choice.get("message")
    if not isinstance(message, dict):
        raise _response_error()
    if message.get("refusal"):
        raise _refused()
    content = message.get("content")
    if content is None:
        text = ""
    elif isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                raise _response_error()
            if part.get("type") == "text":
                if not isinstance(part.get("text"), str):
                    raise _response_error()
                parts.append(part["text"])
        text = "".join(parts)
    else:
        raise _response_error()
    raw_calls = message.get("tool_calls", [])
    if not isinstance(raw_calls, list) or len(raw_calls) > 128:
        raise _response_error()
    calls = []
    for raw in raw_calls:
        if (
            not isinstance(raw, dict)
            or raw.get("type") != "function"
            or not isinstance(raw.get("function"), dict)
        ):
            raise _response_error()
        function = raw["function"]
        calls.append(
            _call(
                {
                    "id": raw.get("id"),
                    "name": function.get("name"),
                    "arguments": parse_json_object(function.get("arguments")),
                },
                response=True,
            )
        )
    return _reply(text, calls, _usage(response.get("usage"), "openai"))


def _anthropic_reply(response):
    reason = response.get("stop_reason")
    if reason in ("max_tokens", "pause_turn", "model_context_window_exceeded"):
        raise _incomplete()
    if reason == "refusal":
        raise _refused()
    if reason not in (None, "end_turn", "stop_sequence", "tool_use"):
        raise _response_error()
    content = response.get("content")
    if not isinstance(content, list):
        raise _response_error()
    text, calls = [], []
    for part in content:
        if not isinstance(part, dict):
            raise _response_error()
        if part.get("type") == "text":
            if not isinstance(part.get("text"), str):
                raise _response_error()
            text.append(part["text"])
        elif part.get("type") == "tool_use":
            calls.append(
                _call(
                    {"id": part.get("id"), "name": part.get("name"), "arguments": part.get("input")},
                    response=True,
                )
            )
        # Never surface thinking/redacted_thinking blocks or their signatures.
    return _reply("".join(text), calls, _usage(response.get("usage"), "anthropic"))


def _gemini_reply(response):
    feedback = response.get("promptFeedback", {})
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        raise _refused()
    candidates = response.get("candidates")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        raise _response_error()
    candidate = candidates[0]
    reason = candidate.get("finishReason")
    if reason == "MAX_TOKENS":
        raise _incomplete()
    if reason in (
        "SAFETY",
        "RECITATION",
        "LANGUAGE",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "SPII",
        "IMAGE_SAFETY",
    ):
        raise _refused()
    if reason not in (None, "STOP"):
        raise _response_error()
    content = candidate.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("parts"), list):
        raise _response_error()
    text, calls = [], []
    for part in content["parts"]:
        if not isinstance(part, dict):
            raise _response_error()
        if part.get("thought") is True:
            continue
        if "text" in part:
            if not isinstance(part["text"], str):
                raise _response_error()
            text.append(part["text"])
        if "functionCall" in part:
            function = part["functionCall"]
            if not isinstance(function, dict):
                raise _response_error()
            metadata = {}
            if "thoughtSignature" in part:
                signature = part["thoughtSignature"]
                if not isinstance(signature, str) or len(signature) > 1024 * 1024:
                    raise _response_error()
                metadata["thoughtSignature"] = signature
            if "id" in function:
                metadata["id"] = function["id"]
            calls.append(
                _call(
                    {
                        "id": function.get("id", "gemini_" + uuid.uuid4().hex),
                        "name": function.get("name"),
                        "arguments": function.get("args", {}),
                        "metadata": {"gemini": metadata},
                    },
                    response=True,
                )
            )
    return _reply("".join(text), calls, _usage(response.get("usageMetadata"), "gemini"))


def complete(config, messages, tools):
    """Normalize a complete tool-capable response, or raise a safe ProviderError."""
    url, allowed_hosts = _configuration(config)
    messages = _messages(messages)
    tools = _tools(tools)
    if config.kind == "anthropic":
        serialize, normalize = _anthropic_request, _anthropic_reply
    elif config.kind == "gemini":
        serialize, normalize = _gemini_request, _gemini_reply
    else:
        serialize, normalize = _openai_request, _openai_reply
    headers, payload = serialize(config, messages, tools)
    response = post_json(
        url=url, headers=headers, payload=payload, timeout=config.timeout, allowed_hosts=allowed_hosts
    )
    if not isinstance(response, dict):
        raise _response_error()
    return normalize(response)
