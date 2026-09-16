"""Offline SSRF/transport tests; DNS and sockets are mocked, never contacted."""

import http.client
import io
import json
import socket
import ssl
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from frappe_intelligence.providers import ProviderError, network

URL = "https://models.example.com/v1/chat/completions"
HOSTS = ("models.example.com",)
PUBLIC_IP = "93.184.216.34"


@pytest.mark.parametrize(
    "url,hosts",
    [
        ("http://models.example.com/v1", HOSTS),
        ("https://models.example.com@evil.example/v1", HOSTS),
        ("https://user:password@models.example.com/v1", HOSTS),
        ("https://models.example.com/v1?key=secret", HOSTS),
        ("https://models.example.com/v1#fragment", HOSTS),
        ("https://models.example.com/v1\r\nInjected", HOSTS),
        ("https://models.example.com\\@evil.example/v1", HOSTS),
        ("https://models.example.com/%2e%2e/admin", HOSTS),
        ("https://models.example.com/v1/../admin", HOSTS),
        ("https://models.example.com//admin", HOSTS),
        ("https://127.0.0.1/v1", ("127.0.0.1",)),
        ("https://[::1]/v1", ("::1",)),
        ("https://models.example.com.evil.example/v1", HOSTS),
        ("https://models.example.com/v1", ("*.example.com",)),
        ("https://models.example.com/v1", ()),
        ("https://localhost/v1", ("localhost",)),
        ("https://models.example.com:0/v1", HOSTS),
        ("https://models.example.com:65536/v1", HOSTS),
    ],
)
def test_unsafe_urls_fail_before_dns(url, hosts):
    with patch.object(socket, "getaddrinfo") as dns:
        with pytest.raises(ProviderError) as exc:
            network.validate_endpoint(url, hosts)
    assert exc.value.code == "unsafe_endpoint"
    dns.assert_not_called()


def test_exact_allowlist_allows_canonical_hostname_and_https_port():
    endpoint = network.validate_endpoint("https://MODELS.example.com:8443/v1/chat/completions", HOSTS)
    assert endpoint.host == "models.example.com"
    assert endpoint.port == 8443
    assert endpoint.target == "/v1/chat/completions"


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "0.0.0.0",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.170.2",
        "100.100.100.200",
        "168.63.129.16",  # Azure platform/WireServer endpoint looks globally routable.
        "100.64.0.1",
        "192.0.0.8",
        "198.18.0.1",
        "192.0.2.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",
        "64:ff9b::a9fe:a9fe",
        "64:ff9b:1::1",
        "2002:7f00:0001::",
        "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    ],
)
def test_private_metadata_and_transition_addresses_are_blocked(ip):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr = (ip, 443, 0, 0) if family == socket.AF_INET6 else (ip, 443)
    answers = [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]
    with patch.object(socket, "getaddrinfo", return_value=answers):
        with pytest.raises(ProviderError) as exc:
            network._resolve_public_addresses("models.example.com", 443, time.monotonic() + 1)
    assert exc.value.code == "unsafe_endpoint"
    assert ip not in str(exc.value)


def test_mixed_public_private_dns_is_rejected_entirely():
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (PUBLIC_IP, 443)),
        (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("::1", 443, 0, 0)),
    ]
    with patch.object(socket, "getaddrinfo", return_value=answers):
        with pytest.raises(ProviderError) as exc:
            network._resolve_public_addresses("models.example.com", 443, time.monotonic() + 1)
    assert exc.value.code == "unsafe_endpoint"


def test_public_ipv4_and_native_ipv6_are_supported():
    answers = [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (PUBLIC_IP, 443)),
        (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("2606:4700:4700::1111", 443, 0, 0)),
    ]
    with patch.object(socket, "getaddrinfo", return_value=answers):
        addresses = network._resolve_public_addresses("models.example.com", 443, time.monotonic() + 1)
    assert [a.ip for a in addresses] == [PUBLIC_IP, "2606:4700:4700::1111"]


def test_dns_has_wall_clock_budget_even_when_system_resolver_hangs():
    release = threading.Event()
    with patch.object(socket, "getaddrinfo", side_effect=lambda *a, **kw: release.wait(2)):
        try:
            start = time.monotonic()
            with pytest.raises(ProviderError) as exc:
                network._resolve_public_addresses("models.example.com", 443, start + 0.03)
            assert exc.value.code == "timeout"
            assert time.monotonic() - start < 0.5
        finally:
            release.set()


@pytest.mark.parametrize(
    "family,ip,address",
    [
        (socket.AF_INET, PUBLIC_IP, (PUBLIC_IP, 443)),
        (socket.AF_INET6, "2606:4700:4700::1111", ("2606:4700:4700::1111", 443, 0, 0)),
    ],
)
def test_connection_pins_numeric_ip_but_verifies_original_tls_hostname(family, ip, address):
    context = MagicMock()
    raw = MagicMock()
    with (
        patch.object(ssl, "create_default_context", return_value=context),
        patch.object(socket, "socket", return_value=raw) as socket_factory,
        patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS must not be repeated")),
    ):
        conn = network._PinnedHTTPSConnection(
            "models.example.com", 443, network.Address(family, ip), time.monotonic() + 1
        )
        conn.connect()
    socket_factory.assert_called_once_with(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    raw.connect.assert_called_once_with(address)
    context.wrap_socket.assert_called_once_with(raw, server_hostname="models.example.com")
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    assert conn.host == "models.example.com"


class Response:
    def __init__(self, body=b'{"ok":true}', status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.body = body
        self.read_count = 0

    def getheader(self, name, default=None):
        return self.headers.get(name.lower(), default)

    def read1(self, limit):
        self.read_count += 1
        result, self.body = self.body[:limit], self.body[limit:]
        return result

    def close(self):
        pass


def post(response, **kwargs):
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ) as dns,
        patch.object(network, "_PinnedHTTPSConnection") as factory,
    ):
        conn = factory.return_value
        conn.getresponse.return_value = response
        result = network.post_json(
            url=URL,
            headers={"Authorization": "Bearer super-secret"},
            payload={"prompt": "private"},
            timeout=1,
            allowed_hosts=HOSTS,
            **kwargs,
        )
    return result, conn, dns, factory


def test_http_json_transport_disables_compression_and_does_not_use_proxy_environment(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "https://proxy-attacker.invalid")
    monkeypatch.setenv("ALL_PROXY", "https://proxy-attacker.invalid")
    result, conn, dns, factory = post(Response())
    assert result == {"ok": True}
    args, kwargs = conn.request.call_args
    assert args[:2] == ("POST", "/v1/chat/completions")
    assert kwargs["headers"]["Accept-Encoding"] == "identity"
    assert kwargs["headers"]["Content-Type"] == "application/json"
    assert json.loads(kwargs["body"]) == {"prompt": "private"}
    assert "super-secret" not in args[1]
    assert factory.call_args.args[0] == "models.example.com"
    assert dns.call_count == 1
    conn.close.assert_called_once()


@pytest.mark.parametrize(
    "status,code",
    [
        (301, "redirect_rejected"),
        (307, "redirect_rejected"),
        (401, "authentication_failed"),
        (403, "authentication_failed"),
        (429, "rate_limited"),
        (400, "request_rejected"),
        (500, "provider_unavailable"),
    ],
)
def test_http_errors_never_read_or_expose_error_body_or_redirect(status, code):
    response = Response(b"super-secret secret customer data", status, {"location": "http://169.254.169.254/"})
    with pytest.raises(ProviderError) as exc:
        post(response)
    assert exc.value.code == code
    assert "super-secret" not in str(exc.value)
    assert response.read_count == 0


@pytest.mark.parametrize(
    "response",
    [
        Response(b"not json super-secret"),
        Response(b"[]"),
        Response(b'{"bad":NaN}'),
        Response(b'{"a":1,"a":2}'),
        Response(b"\xff"),
    ],
)
def test_bad_json_is_safe(response):
    with pytest.raises(ProviderError) as exc:
        post(response)
    assert exc.value.code == "invalid_response"
    assert "super-secret" not in str(exc.value)


def test_response_body_and_content_length_are_bounded():
    with patch.object(network, "MAX_RESPONSE_BYTES", 16):
        for response in (Response(b"x" * 100), Response(headers={"content-length": "10000000"})):
            with pytest.raises(ProviderError) as exc:
                post(response)
            assert exc.value.code == "response_too_large"
            assert response.read_count <= 2


def test_compressed_response_is_rejected_without_decompression():
    with pytest.raises(ProviderError) as exc:
        post(Response(headers={"content-encoding": "gzip"}))
    assert exc.value.code == "invalid_response"


def test_request_body_is_bounded_before_network_io():
    with (
        patch.object(network, "MAX_REQUEST_BYTES", 8),
        patch.object(network, "_resolve_public_addresses") as dns,
    ):
        with pytest.raises(ProviderError) as exc:
            network.post_json(url=URL, headers={}, payload={"long": "x" * 50}, timeout=1, allowed_hosts=HOSTS)
    assert exc.value.code == "request_too_large"
    dns.assert_not_called()


def test_slow_header_reader_is_interrupted_by_total_deadline():
    interrupted = threading.Event()
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ),
        patch.object(network, "_PinnedHTTPSConnection") as factory,
    ):
        conn = factory.return_value
        conn.sock.shutdown.side_effect = lambda *_: interrupted.set()

        def blocked_headers():
            assert interrupted.wait(0.5), "deadline watchdog did not interrupt the socket"
            raise OSError("private socket details super-secret")

        conn.getresponse.side_effect = blocked_headers
        with pytest.raises(ProviderError) as exc:
            network.post_json(url=URL, headers={}, payload={}, timeout=0.03, allowed_hosts=HOSTS)
    assert exc.value.code == "timeout"
    assert "super-secret" not in str(exc.value)


def test_socket_failures_are_safe_and_not_retried():
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ),
        patch.object(network, "_PinnedHTTPSConnection") as factory,
    ):
        factory.return_value.connect.side_effect = OSError("super-secret private DNS/socket details")
        with pytest.raises(ProviderError) as exc:
            network.post_json(url=URL, headers={}, payload={}, timeout=1, allowed_hosts=HOSTS)
    assert exc.value.code == "connection_failed"
    assert "super-secret" not in str(exc.value)
    factory.assert_called_once()


def test_real_stdlib_response_at_content_length_eof_does_not_touch_closed_socket():
    stream = io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}')
    fake_socket = MagicMock()
    fake_socket.makefile.return_value = stream

    def settimeout(_timeout):
        if stream.closed:
            raise OSError("socket was closed by HTTPResponse at EOF")

    fake_socket.settimeout.side_effect = settimeout
    response = http.client.HTTPResponse(fake_socket)
    response.begin()
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ),
        patch.object(network, "_PinnedHTTPSConnection") as factory,
    ):
        factory.return_value.sock = fake_socket
        factory.return_value.getresponse.return_value = response
        result = network.post_json(url=URL, headers={}, payload={}, timeout=1, allowed_hosts=HOSTS)
    assert result == {"ok": True}
    assert stream.closed


@pytest.mark.parametrize(
    "body", [b'{"number":1e999}', b'{"number":-1e999}', b'{"number":' + b"9" * 200 + b"}"]
)
def test_nonfinite_exponents_and_unbounded_integers_are_rejected(body):
    with pytest.raises(ProviderError) as exc:
        post(Response(body))
    assert exc.value.code == "invalid_response"


def test_truncated_content_length_cannot_pass_as_a_complete_json_response():
    with pytest.raises(ProviderError) as exc:
        post(Response(b'{"ok":true}', headers={"content-length": "40"}))
    assert exc.value.code == "invalid_response"


def test_tls_context_initialization_failure_is_safe():
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ),
        patch.object(
            network, "_PinnedHTTPSConnection", side_effect=OSError("private trust-store path super-secret")
        ),
    ):
        with pytest.raises(ProviderError) as exc:
            network.post_json(url=URL, headers={}, payload={}, timeout=1, allowed_hosts=HOSTS)
    assert exc.value.code == "connection_failed"
    assert "super-secret" not in str(exc.value)


def test_connection_cleanup_failure_cannot_replace_safe_provider_error():
    with (
        patch.object(
            network, "_resolve_public_addresses", return_value=[network.Address(socket.AF_INET, PUBLIC_IP)]
        ),
        patch.object(network, "_PinnedHTTPSConnection") as factory,
    ):
        factory.return_value.getresponse.return_value = Response(status=401)
        factory.return_value.close.side_effect = OSError("super-secret socket details")
        with pytest.raises(ProviderError) as exc:
            network.post_json(url=URL, headers={}, payload={}, timeout=1, allowed_hosts=HOSTS)
    assert exc.value.code == "authentication_failed"
    assert "super-secret" not in str(exc.value)
