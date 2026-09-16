"""Full offline wire tests: only DNS, TCP and TLS are mocked.

Python's real HTTPConnection/HTTPResponse and every provider serializer run.
No model endpoint, DNS resolver or Internet socket is contacted.
"""

import http.client
import io
import json
import socket
import ssl
from unittest.mock import MagicMock, patch

import pytest

from frappe_intelligence.providers import ProviderConfig, ProviderError, complete

KEY = "wire-test-secret"
PUBLIC_IP = "93.184.216.34"


class SocketFixture:
    def __init__(self, response):
        self.stream = io.BytesIO(response)
        self.sent = bytearray()
        self.connected = None

    def connect(self, address):
        self.connected = address

    def settimeout(self, timeout):
        if self.stream.closed:
            raise OSError("HTTPResponse already closed the socket")
        assert timeout > 0

    def sendall(self, data):
        self.sent.extend(data)

    def makefile(self, mode):
        assert mode == "rb"
        return self.stream

    def shutdown(self, how):
        pass

    def close(self):
        pass


def wire_complete(kind, body, *, chunked=False, debug=False):
    encoded = json.dumps(body, separators=(",", ":")).encode()
    if chunked:
        response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        response += hex(len(encoded))[2:].encode() + b"\r\n" + encoded + b"\r\n0\r\n\r\n"
    else:
        response = (
            b"HTTP/1.1 200 OK\r\nContent-Length: "
            + str(len(encoded)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + encoded
        )
    fixture = SocketFixture(response)
    context = MagicMock()
    context.wrap_socket.return_value = fixture
    dns_answer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (PUBLIC_IP, 443))]
    custom = (
        {"base_url": "https://custom.example/v1", "allowed_hosts": ("custom.example",)}
        if kind == "custom"
        else {}
    )
    with (
        patch.object(socket, "getaddrinfo", return_value=dns_answer) as dns,
        patch.object(socket, "socket", return_value=fixture),
        patch.object(ssl, "create_default_context", return_value=context),
        patch.object(http.client.HTTPConnection, "debuglevel", 1 if debug else 0),
    ):
        reply = complete(
            ProviderConfig(kind, "configured-model", KEY, **custom),
            [{"role": "user", "content": "Hello"}],
            [],
        )
    return reply, bytes(fixture.sent), context, dns, fixture


@pytest.mark.parametrize(
    "kind,host,body",
    [
        (
            "openai",
            "api.openai.com",
            {"choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}]},
        ),
        (
            "openrouter",
            "openrouter.ai",
            {"choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}]},
        ),
        ("xai", "api.x.ai", {"choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}]}),
        (
            "custom",
            "custom.example",
            {"choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}]},
        ),
        (
            "anthropic",
            "api.anthropic.com",
            {"content": [{"type": "text", "text": "Done"}], "stop_reason": "end_turn"},
        ),
        (
            "gemini",
            "generativelanguage.googleapis.com",
            {"candidates": [{"content": {"parts": [{"text": "Done"}]}, "finishReason": "STOP"}]},
        ),
    ],
)
@pytest.mark.parametrize("chunked", [False, True])
def test_real_http_serialization_for_all_providers(kind, host, body, chunked):
    reply, wire, context, dns, fixture = wire_complete(kind, body, chunked=chunked)
    assert reply.text == "Done"
    headers, encoded = wire.split(b"\r\n\r\n", 1)
    assert f"Host: {host}\r\n".encode() in headers
    assert KEY.encode() not in headers.split(b"\r\n", 1)[0]
    assert KEY.encode() not in encoded
    assert json.loads(encoded)
    assert fixture.connected == (PUBLIC_IP, 443)
    assert context.wrap_socket.call_args.kwargs["server_hostname"] == host
    assert dns.call_count == 1
    assert fixture.stream.closed


def test_inherited_http_debug_logging_cannot_print_credentials(capsys):
    body = {"choices": [{"message": {"content": "Done"}, "finish_reason": "stop"}]}
    wire_complete("openai", body, debug=True)
    captured = capsys.readouterr()
    assert KEY not in captured.out
    assert KEY not in captured.err


def test_provider_body_with_connection_closed_early_is_rejected():
    fixture = SocketFixture(
        b'HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n{"choices":[]}'
    )
    context = MagicMock()
    context.wrap_socket.return_value = fixture
    dns_answer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (PUBLIC_IP, 443))]
    with (
        patch.object(socket, "getaddrinfo", return_value=dns_answer),
        patch.object(socket, "socket", return_value=fixture),
        patch.object(ssl, "create_default_context", return_value=context),
    ):
        with pytest.raises(ProviderError) as exc:
            complete(
                ProviderConfig("openai", "configured-model", KEY), [{"role": "user", "content": "Hello"}], []
            )
    assert exc.value.code == "invalid_response"
