"""Bounded, pinned HTTPS JSON transport with no redirects, proxies, or SDK retries.

DNS runs in a bounded number of daemon workers because libc getaddrinfo has no
portable timeout. The caller's deadline includes DNS, TCP, TLS, headers and body.
Every DNS answer must be public; connections use a numeric address directly,
while TLS certificate verification/SNI and the HTTP Host remain the original host.
"""

import http.client
import ipaddress
import json
import math
import queue
import re
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from .types import ProviderError

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_TIMEOUT = 120
_DNS_SLOTS = threading.BoundedSemaphore(8)
_PATH = re.compile(r"/[A-Za-z0-9/_~.:-]*\Z")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_V6_UNICAST = ipaddress.ip_network("2000::/3")
_V6_SPECIAL = ipaddress.ip_network("2001::/23")
_V4_SPECIAL = ipaddress.ip_network("192.0.0.0/24")
# Azure's WireServer address is platform-local despite its public IPv4 spelling.
_AZURE_PLATFORM = ipaddress.ip_address("168.63.129.16")


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int
    target: str


@dataclass(frozen=True)
class Address:
    family: int
    ip: str


def _unsafe():
    return ProviderError(
        "unsafe_endpoint", "The provider endpoint is not permitted by the network security policy."
    )


def _invalid_response():
    return ProviderError("invalid_response", "The provider returned an invalid response.")


def _hostname(value):
    if not isinstance(value, str) or not value or len(value) > 253:
        raise _unsafe()
    try:
        host = value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise _unsafe() from None
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL.fullmatch(label) for label in labels):
        raise _unsafe()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    raise _unsafe()


def validate_endpoint(url, allowed_hosts):
    """Validate an exact hostname allowlist before performing any DNS or I/O."""
    if (
        not isinstance(url, str)
        or len(url) > 2048
        or any(ord(char) <= 32 or ord(char) == 127 for char in url)
        or any(char in url for char in "\\?#%")
        or not isinstance(allowed_hosts, (tuple, list))
    ):
        raise _unsafe()
    try:
        parsed = urlsplit(url)
        port = parsed.port
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise _unsafe()
        host = _hostname(parsed.hostname)
    except (ValueError, UnicodeError):
        raise _unsafe() from None
    permitted = {_hostname(item) for item in allowed_hosts}
    target = parsed.path or "/"
    if (
        host not in permitted
        or (port is not None and not 1 <= port <= 65535)
        or not _PATH.fullmatch(target)
        or "//" in target
        or any(segment in (".", "..") for segment in target.split("/"))
    ):
        raise _unsafe()
    return Endpoint(host, port or 443, target)


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProviderError("timeout", "The provider request timed out.")
    return remaining


def _public_ip(value):
    try:
        if not isinstance(value, str) or "%" in value:
            raise ValueError
        ip = ipaddress.ip_address(value)
    except ValueError:
        raise _unsafe() from None
    if (
        not ip.is_global
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_unspecified
    ):
        raise _unsafe()
    if ip.version == 4:
        if ip in _V4_SPECIAL or ip == _AZURE_PLATFORM:
            raise _unsafe()
    elif ip not in _V6_UNICAST or ip in _V6_SPECIAL or ip.ipv4_mapped or ip.sixtofour or ip.teredo:
        # Fail closed on mapped IPv4, NAT64, 6to4, Teredo and other special ranges.
        raise _unsafe()
    return ip


def _resolve_public_addresses(host, port, deadline):
    _remaining(deadline)
    if not _DNS_SLOTS.acquire(blocking=False):
        raise ProviderError("resolution_failed", "Provider name resolution is temporarily unavailable.")
    result = queue.Queue(maxsize=1)

    def lookup():
        try:
            answers = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            result.put((True, answers))
        except (OSError, UnicodeError):
            result.put((False, None))
        finally:
            _DNS_SLOTS.release()

    try:
        threading.Thread(target=lookup, name="intelligence-provider-dns", daemon=True).start()
    except RuntimeError:
        _DNS_SLOTS.release()
        raise ProviderError(
            "resolution_failed", "Provider name resolution is temporarily unavailable."
        ) from None
    try:
        success, answers = result.get(timeout=_remaining(deadline))
    except queue.Empty:
        raise ProviderError("timeout", "The provider request timed out.") from None
    _remaining(deadline)
    if not success or not isinstance(answers, (list, tuple)) or not answers or len(answers) > 64:
        raise ProviderError("resolution_failed", "The provider hostname could not be resolved safely.")
    addresses = []
    for family, socktype, protocol, _canonical, sockaddr in answers:
        if (
            family not in (socket.AF_INET, socket.AF_INET6)
            or socktype != socket.SOCK_STREAM
            or protocol != socket.IPPROTO_TCP
        ):
            raise _unsafe()
        ip = _public_ip(sockaddr[0])
        if (ip.version == 4) != (family == socket.AF_INET) or sockaddr[1] != port:
            raise _unsafe()
        if family == socket.AF_INET6 and (len(sockaddr) != 4 or sockaddr[2] or sockaddr[3]):
            raise _unsafe()
        address = Address(family, str(ip))
        if address not in addresses:
            addresses.append(address)
    return addresses


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, address, deadline):
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        super().__init__(host, port=port, timeout=_remaining(deadline), context=context)
        # Other applications may enable http.client's class-wide wire logger.
        # Never inherit it: it prints authorization headers and message bodies.
        self.set_debuglevel(0)
        self._address = address
        self._deadline = deadline

    def connect(self):
        # Never call create_connection/super().connect: those resolve the hostname again.
        raw = socket.socket(self._address.family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        try:
            raw.settimeout(_remaining(self._deadline))
            address = (self._address.ip, self.port)
            if self._address.family == socket.AF_INET6:
                address += (0, 0)
            raw.connect(address)
            raw.settimeout(_remaining(self._deadline))
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            self.sock.settimeout(_remaining(self._deadline))
        except BaseException:
            raw.close()
            raise


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON property")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("non-finite JSON number")


def _bounded_integer(value):
    if len(value) > 128:
        raise ValueError("oversized JSON integer")
    return int(value)


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON number")
    return number


def parse_json_object(value):
    """Strict JSON for both envelopes and string-encoded tool arguments."""
    try:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        parsed = json.loads(
            value,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_int=_bounded_integer,
            parse_float=_finite_float,
        )
        if not isinstance(parsed, dict):
            raise ValueError
        return parsed
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise _invalid_response() from None


def encode_json(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(
            "utf-8"
        )
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ProviderError("invalid_request", "The provider request contains invalid JSON data.") from None
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ProviderError("request_too_large", "The provider request exceeds the size limit.")
    return encoded


def _headers(headers):
    result = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
        "Connection": "close",
    }
    if not isinstance(headers, dict):
        raise ProviderError("invalid_config", "The provider credentials or configuration are invalid.")
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or name.lower() not in {"authorization", "x-api-key", "x-goog-api-key", "anthropic-version"}
            or not isinstance(value, str)
            or not value
            or len(value) > 8192
            or any(ord(char) < 32 or ord(char) > 126 for char in value)
        ):
            raise ProviderError("invalid_config", "The provider credentials or configuration are invalid.")
        result[name] = value
    return result


def _http_error(status):
    if 300 <= status < 400:
        return ProviderError("redirect_rejected", "Provider redirects are not permitted.")
    if status in (401, 403):
        return ProviderError(
            "authentication_failed", "The provider rejected the credentials or account permissions."
        )
    if status == 429:
        return ProviderError(
            "rate_limited", "The provider rate limit or account quota was reached. Try again later."
        )
    if status >= 500:
        return ProviderError("provider_unavailable", "The provider is temporarily unavailable.")
    return ProviderError(
        "request_rejected", "The provider rejected the request. Check the model and provider configuration."
    )


def post_json(*, url, headers, payload, timeout, allowed_hosts):
    """POST once, without environment proxies, redirects, or automatic retries."""
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or not 0 < timeout <= MAX_TIMEOUT
    ):
        raise ProviderError("invalid_config", "The provider timeout must be between 1 and 120 seconds.")
    deadline = time.monotonic() + timeout
    endpoint = validate_endpoint(url, allowed_hosts)
    body = encode_json(payload)
    headers = _headers(headers)
    addresses = _resolve_public_addresses(endpoint.host, endpoint.port, deadline)
    connection = None
    timer = None
    response = None
    expired = threading.Event()
    try:
        # A single attempt avoids replaying a request whose server-side result is unknown.
        connection = _PinnedHTTPSConnection(endpoint.host, endpoint.port, addresses[0], deadline)
        connection.connect()
        active_socket = connection.sock

        def interrupt():
            expired.set()
            try:
                # shutdown interrupts slow-drip headers/body even if HTTPResponse owns
                # the socket's remaining file reference after Connection: close.
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(_remaining(deadline), interrupt)
        timer.daemon = True
        timer.start()
        connection.request("POST", endpoint.target, body=body, headers=headers)
        response = connection.getresponse()
        _remaining(deadline)
        if not 200 <= response.status < 300:
            # Do not consume, log, or attach upstream error bodies to exceptions.
            raise _http_error(response.status)
        if response.getheader("content-encoding", "identity").lower() not in ("identity", ""):
            raise _invalid_response()
        length = response.getheader("content-length")
        if length is not None:
            if not length.isascii() or not length.isdigit() or len(length) > 12:
                raise _invalid_response()
            if int(length) > MAX_RESPONSE_BYTES:
                raise ProviderError("response_too_large", "The provider response exceeds the size limit.")
        chunks = []
        size = 0
        while True:
            # HTTPResponse may close its last socket reference as soon as the
            # final nonempty chunk is read. The watchdog enforces the total
            # deadline; do not touch that possibly closed socket on the EOF read.
            _remaining(deadline)
            chunk = response.read1(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - size))
            _remaining(deadline)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise ProviderError("response_too_large", "The provider response exceeds the size limit.")
            chunks.append(chunk)
        if length is not None and size != int(length):
            raise _invalid_response()
        result = parse_json_object(b"".join(chunks))
        _remaining(deadline)
        return result
    except (TimeoutError, socket.timeout):
        raise ProviderError("timeout", "The provider request timed out.") from None
    except (OSError, http.client.HTTPException):
        if expired.is_set() or time.monotonic() >= deadline:
            raise ProviderError("timeout", "The provider request timed out.") from None
        raise ProviderError(
            "connection_failed", "A secure connection to the provider could not be completed."
        ) from None
    finally:
        if timer is not None:
            timer.cancel()
        for resource in (response, connection):
            if resource is not None:
                try:
                    resource.close()
                except OSError:
                    # Cleanup must not replace a sanitized error with socket details.
                    pass
