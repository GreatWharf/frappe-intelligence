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


def test_bm25_scores_rank_by_keyword_overlap(services):
    module = importlib.import_module("frappe_intelligence.rag")
    documents = {
        "apple": "Apples are the best fruit for pies.",
        "zebra": "Zebras roam the savanna in herds.",
        "revenue": "Quarterly revenue grew steadily.",
    }
    # Case and punctuation are normalized away; only overlapping docs score.
    scores = module.bm25_scores("tell me about APPLES!", documents)
    assert set(scores) == {"apple"}
    assert scores["apple"] > 0
    # Length normalization: one hit in a short document beats one in a long one.
    scores = module.bm25_scores("apples", {"short": "apples", "long": "apples " + "filler " * 200})
    assert scores["short"] > scores["long"] > 0
    # Guards: empty input and zero overlap score nothing, never divide by zero.
    assert module.bm25_scores("", documents) == {}
    assert module.bm25_scores(None, documents) == {}
    assert module.bm25_scores("apples", {}) == {}
    assert module.bm25_scores("kubernetes", documents) == {}
    assert module.bm25_scores("apples", {"empty": ""}) == {}
    single = module.bm25_scores("apples", {"only": "apples"})
    assert single["only"] > 0


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


def test_status_reports_lexical_mode_when_the_endpoint_is_missing(services, monkeypatch):
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
    # Retrieval still works on keyword scoring; the payload says so honestly.
    assert result["available"] is True
    assert result["mode"] == "lexical"
    assert "does not expose an embeddings endpoint" in result["reason"]


def test_status_reports_lexical_mode_for_chat_only_providers(services):
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
    assert module.status() == {
        "available": True,
        "mode": "lexical",
        "reason": "This provider's API does not support embeddings.",
    }


def test_status_reports_semantic_mode_when_embeddings_work(services, monkeypatch):
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
    module = importlib.import_module("frappe_intelligence.rag")
    monkeypatch.setattr(module, "capability", lambda name: {"available": True, "model": "embed-1", "dims": 2})
    assert module.status() == {
        "available": True,
        "mode": "semantic",
        "provider": "Fleet",
        "model": "embed-1",
    }


def test_search_checks_conversation_access_first(services):
    _, store = services
    store["chat"] = Row(doctype="Intelligence Conversation", name="chat", owner="other@example.test")
    module = importlib.import_module("frappe_intelligence.rag")
    with pytest.raises(PermissionError):
        module.search("chat", "anything")


def test_search_empty_when_there_is_nothing_to_index(services):
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


def _chat_with_messages(store, owner, provider="p"):
    if provider:
        store["chat"] = Row(doctype="Intelligence Conversation", name="chat", owner=owner, provider=provider)
    else:
        store["chat"] = Row(doctype="Intelligence Conversation", name="chat", owner=owner)
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


def test_search_without_embeddings_endpoint_ranks_lexically(services, monkeypatch):
    fake, store = services
    store["p"] = Row(
        doctype="Intelligence Provider",
        name="p",
        owner=fake.session.user,
        enabled=1,
        kind="Anthropic",
        api_key="secret",
    )
    _chat_with_messages(store, fake.session.user)
    module = importlib.import_module("frappe_intelligence.rag")
    monkeypatch.setattr(module, "_embed", lambda *args: pytest.fail("no embeddings endpoint to call"))
    hits = module.search("chat", "tell me about apples", top_k=2)
    assert len(hits) == 1
    assert "Apples" in hits[0]["content"]
    assert hits[0]["source_type"] == "Message"
    assert hits[0]["score"] > 0
    # The content was indexed anyway, with the empty-vector sentinel.
    rows = _embedding_rows(store)
    assert len(rows) == 3
    assert all(json.loads(row.get("vector")) == [] for row in rows)
    assert all(not row.get("model") for row in rows)
    # Lexical indexing is idempotent too: a second search adds no rows.
    again = module.search("chat", "zebras")
    assert again and "Zebras" in again[0]["content"]
    assert len(_embedding_rows(store)) == 3


def test_search_with_a_deleted_provider_still_ranks_lexically(services):
    fake, store = services
    _chat_with_messages(store, fake.session.user, provider="deleted-p")
    module = importlib.import_module("frappe_intelligence.rag")
    hits = module.search("chat", "apples")
    assert len(hits) == 1
    assert "Apples" in hits[0]["content"]


def test_search_upgrades_vectorless_rows_once_embeddings_work(services, monkeypatch):
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
    _chat_with_messages(store, fake.session.user)
    module = importlib.import_module("frappe_intelligence.rag")
    # First the endpoint is down: rows index lexically and keyword rank.
    monkeypatch.setattr(module, "capability", lambda name: {"available": False, "reason": "down"})
    hits = module.search("chat", "apples")
    assert len(hits) == 1
    assert "Apples" in hits[0]["content"]
    assert all(json.loads(row.get("vector")) == [] for row in _embedding_rows(store))
    # Then the endpoint appears: unchanged content is re-embedded in place and
    # semantic ranking takes over (this query shares no keywords with any row,
    # so only real vectors can produce hits).
    monkeypatch.setattr(module, "capability", lambda name: {"available": True, "model": "embed-1", "dims": 2})

    def fake_embed(access, inputs):
        return [[1.0, 0.0] if "zebra" in text.lower() else [0.0, 1.0] for text in inputs]

    monkeypatch.setattr(module, "_embed", fake_embed)
    hits = module.search("chat", "orchard")
    assert hits
    assert all("Zebras" not in hit["content"] for hit in hits)
    rows = _embedding_rows(store)
    assert len(rows) == 3
    assert all(json.loads(row.get("vector")) != [] for row in rows)
    assert all(row.get("model") == "embed-1" for row in rows)


def test_search_falls_back_to_keyword_when_the_embed_call_fails(services, monkeypatch):
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
    _chat_with_messages(store, fake.session.user)
    module = importlib.import_module("frappe_intelligence.rag")
    monkeypatch.setattr(module, "capability", lambda name: {"available": True, "model": "embed-1", "dims": 2})

    def flaky(access, inputs):
        if inputs == ["tell me about apples"]:
            raise ProviderError("request_rejected", "The provider rejected the request.")
        return [[0.5, 0.25] for _ in inputs]

    monkeypatch.setattr(module, "_embed", flaky)
    hits = module.search("chat", "tell me about apples")
    assert len(hits) == 1
    assert "Apples" in hits[0]["content"]
    # The rows were embedded fine; only the query vector failed.
    assert all(json.loads(row.get("vector")) != [] for row in _embedding_rows(store))


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
