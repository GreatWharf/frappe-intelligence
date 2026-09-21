"""Offline retrieval tests: chunking, similarity, capability gating, indexing."""

import http.client
import importlib
import json
import socket
import ssl
import sys
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from test_providers_wire import PUBLIC_IP, SocketFixture
from test_services import Row
from test_services import services as services

from frappe_intelligence.providers import ProviderConfig, ProviderError, embed_documents

KEY = "wire-test-secret"


def test_chunk_windows_overlap_and_cover(services):
    module = importlib.import_module("frappe_intelligence.rag")
    text = " ".join(f"word{i}" for i in range(600))
    chunks = module.chunk_text(text)
    assert len(chunks) >= 4
    assert all(0 < len(chunk) <= module.CHUNK_SIZE for chunk in chunks)
    assert chunks[0].startswith("word0")
    assert chunks[-1].endswith("word599")
    # The overlap means each window's tail words reappear in the next window.
    assert chunks[0].split()[-1] in chunks[1].split()
    assert module.chunk_text("") == []
    assert module.chunk_text("   ") == []
    assert module.chunk_text("short") == ["short"]
    assert module.chunk_text(None) == []


def test_cosine_scores_and_guards(services):
    module = importlib.import_module("frappe_intelligence.rag")
    assert module.cosine([1, 0], [1, 0]) == pytest.approx(1.0)
    assert module.cosine([1, 0], [0, 1]) == pytest.approx(0.0)
    assert module.cosine([1, 1], [-1, -1]) == pytest.approx(-1.0)
    assert module.cosine([1, 1], [1]) == 0.0
    assert module.cosine([0, 0], [1, 1]) == 0.0
    assert module.cosine([True, 1], [1, 1]) == 0.0
    assert module.cosine("nope", [1]) == 0.0


def test_capability_without_provider(services):
    module = importlib.import_module("frappe_intelligence.rag")
    result = module.capability("missing")
    assert result["available"] is False
    assert "no longer exists" in result["reason"]


def test_capability_unsupported_kind_never_touches_the_network(services, monkeypatch):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner=fake.session.user,
        enabled=1,
        is_shared=0,
        kind="Anthropic",
        api_key="secret",
    )
    module = importlib.import_module("frappe_intelligence.rag")

    def boom(config, inputs):
        raise AssertionError("network must not be attempted")

    monkeypatch.setattr("frappe_intelligence.providers.adapters.embed_documents", boom)
    result = module.capability("p")
    assert result["available"] is False
    assert "does not support embeddings" in result["reason"]


def test_status_without_providers_is_actionable(services):
    module = importlib.import_module("frappe_intelligence.rag")
    assert module.status() == {"available": False, "reason": "Configure a provider to use retrieval."}


def _secret_access(monkeypatch):
    @contextmanager
    def secret(name, user):
        yield

    monkeypatch.setattr(
        sys.modules["frappe_intelligence.access"], "provider_secret_access", secret, raising=False
    )


def test_status_reports_missing_embeddings_endpoint(services, monkeypatch):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        title="Fleet",
        owner=fake.session.user,
        enabled=1,
        is_shared=0,
        kind="OpenAI",
        model="chat-model",
        api_key="secret",
    )
    _secret_access(monkeypatch)

    def rejected(config, inputs):
        raise ProviderError("request_rejected", "The provider rejected the request.")

    monkeypatch.setattr("frappe_intelligence.providers.adapters.embed_documents", rejected)
    module = importlib.import_module("frappe_intelligence.rag")
    result = module.status()
    assert result["available"] is False
    assert "does not expose an embeddings endpoint" in result["reason"]


def test_search_checks_conversation_access_first(services):
    _, store = services
    store["chat"] = Row(doctype="Intelligence Conversation", name="chat", owner="other@example.test")
    module = importlib.import_module("frappe_intelligence.rag")
    with pytest.raises(PermissionError):
        module.search("chat", "anything")


def test_search_empty_when_provider_has_no_embeddings(services):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner=fake.session.user,
        enabled=1,
        kind="Anthropic",
        api_key="secret",
    )
    store["chat"] = Row(
        doctype="Intelligence Conversation", name="chat", owner=fake.session.user, provider="p"
    )
    module = importlib.import_module("frappe_intelligence.rag")
    assert module.search("chat", "apples") == []


def _embedding_rows(store):
    return [
        row
        for row in store.values()
        if isinstance(row, dict) and row.get("doctype") == "Intelligence Embedding"
    ]


def test_index_and_search_ranks_and_is_idempotent(services, monkeypatch):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner=fake.session.user,
        enabled=1,
        kind="OpenAI",
        model="chat-model",
        api_key="secret",
        timeout=30,
    )
    store["chat"] = Row(
        doctype="Intelligence Conversation", name="chat", owner=fake.session.user, provider="p"
    )
    for index, content in enumerate(
        [
            "Apples are the best fruit for pies",
            "Zebras roam the savanna in herds",
            "Quarterly revenue grew steadily",
        ]
    ):
        store[f"m{index}"] = Row(
            doctype="Intelligence Message",
            name=f"m{index}",
            conversation="chat",
            role="user",
            content=content,
            sequence=index,
        )
    module = importlib.import_module("frappe_intelligence.rag")
    monkeypatch.setattr(module, "capability", lambda name: {"available": True, "model": "embed-1", "dims": 2})

    def fake_embed(access, inputs):
        return [[text.lower().count("apple") + 0.25, text.lower().count("zebra") + 0.25] for text in inputs]

    monkeypatch.setattr(module, "_embed", fake_embed)
    hits = module.search("chat", "tell me about apples", top_k=2)
    assert len(hits) == 2
    assert "Apples" in hits[0]["content"]
    assert hits[0]["source_type"] == "Message"
    assert hits[0]["score"] >= hits[1]["score"]
    assert len(_embedding_rows(store)) == 3
    again = module.search("chat", "apples again")
    assert len(_embedding_rows(store)) == 3
    assert again and "Apples" in again[0]["content"]
    # Changed content re-indexes its source instead of duplicating it.
    store["m0"].content = "Oranges now win the fruit contest"
    monkeypatch.setattr(
        module,
        "_embed",
        lambda access, inputs: [
            [text.lower().count("orange") + 0.25, text.lower().count("zebra") + 0.25] for text in inputs
        ],
    )
    hits = module.search("chat", "oranges")
    assert "Oranges" in hits[0]["content"]
    rows = _embedding_rows(store)
    assert any("Oranges" in (row.get("content") or "") for row in rows)
    assert not any("Apples" in (row.get("content") or "") for row in rows)
    assert any("Zebras" in (row.get("content") or "") for row in rows)


def _wire_embed(kind, body, status=200):
    encoded = json.dumps(body, separators=(",", ":")).encode()
    reason = {200: "OK", 404: "Not Found"}[status]
    response = (
        f"HTTP/1.1 {status} {reason}\r\nContent-Length: ".encode()
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
    config = ProviderConfig(kind, "text-embedding-3-small", KEY, **custom)
    with (
        patch.object(socket, "getaddrinfo", return_value=dns_answer),
        patch.object(socket, "socket", return_value=fixture),
        patch.object(ssl, "create_default_context", return_value=context),
        patch.object(http.client.HTTPConnection, "debuglevel", 0),
    ):
        result = embed_documents(config, ["hello world", "second text"])
    return result, bytes(fixture.sent)


def test_embed_documents_hits_the_embeddings_endpoint_and_returns_vectors():
    body = {"data": [{"index": 0, "embedding": [0.1, 0.2]}, {"index": 1, "embedding": [0.3, 0.4]}]}
    vectors, wire = _wire_embed("openai", body)
    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    headers, encoded = wire.split(b"\r\n\r\n", 1)
    assert b"POST /v1/embeddings HTTP/1.1" in headers
    assert b"Host: api.openai.com" in headers
    assert json.loads(encoded) == {
        "model": "text-embedding-3-small",
        "input": ["hello world", "second text"],
    }


def test_embed_documents_sorts_out_of_order_indices():
    body = {"data": [{"index": 1, "embedding": [0.3, 0.4]}, {"index": 0, "embedding": [0.1, 0.2]}]}
    vectors, _ = _wire_embed("custom", body)
    assert vectors == [[0.1, 0.2], [0.3, 0.4]]


def test_embed_documents_endpoint_missing_is_a_safe_rejection():
    with pytest.raises(ProviderError) as error:
        _wire_embed("openai", {"error": "no route"}, status=404)
    assert error.value.code == "request_rejected"


def test_embed_documents_rejects_unsupported_kind_without_network():
    with pytest.raises(ProviderError) as error:
        embed_documents(ProviderConfig("anthropic", "some-model", KEY), ["text"])
    assert error.value.code == "unsupported"


def test_embed_documents_validates_batch_and_vectors():
    with pytest.raises(ProviderError) as error:
        embed_documents(ProviderConfig("openai", "text-embedding-3-small", KEY), [])
    assert error.value.code == "invalid_request"
    with pytest.raises(ProviderError) as error:
        _wire_embed("openai", {"data": [{"embedding": ["not-a-number"]}]})
    assert error.value.code == "invalid_response"
