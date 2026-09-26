"""Memory indexing: best-effort save indexing (vectorless when no embeddings
endpoint exists), lifecycle cleanup, semantic and keyword recall, dedupe."""

import hashlib
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_services import Row
from test_services import services as services

from frappe_intelligence.tools import memory as memory_tool
from frappe_intelligence.tools import validation


def _provider(store, name, owner, kind="OpenAI"):
    store[name] = Row(
        doctype="Intelligence Provider",
        name=name,
        owner=owner,
        enabled=1,
        is_shared=0,
        kind=kind,
        model="chat-model",
        api_key="secret",
        timeout=30,
    )


def _embedding_rows(store):
    return [
        row
        for row in store.values()
        if isinstance(row, dict) and row.get("doctype") == "Intelligence Embedding"
    ]


def _topic_embed(access, inputs):
    return [[text.lower().count("apple") + 0.25, text.lower().count("zebra") + 0.25] for text in inputs]


def _capable(rag, monkeypatch, model="embed-1"):
    monkeypatch.setattr(rag, "capability", lambda name: {"available": True, "model": model, "dims": 2})
    monkeypatch.setattr(rag, "_embed", _topic_embed)


def test_memory_save_embeds_through_first_capable_provider(services, monkeypatch):
    fake, store = services
    _provider(store, "foreign", "other@example.test")
    _provider(store, "p-plain", fake.session.user, kind="Anthropic")
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    seen = {}

    def fake_embed(access, inputs):
        seen["provider"] = access["provider"].name
        return [[0.5, 0.25] for _ in inputs]

    monkeypatch.setattr(
        rag, "capability", lambda name: {"available": True, "model": "embed-openai", "dims": 2}
    )
    monkeypatch.setattr(rag, "_embed", fake_embed)
    saved = memory.save_memory("Apples make the best pie filling.")
    # Another user's provider and kinds without embeddings are never chosen.
    assert seen["provider"] == "p-embed"
    rows = _embedding_rows(store)
    assert len(rows) == 1
    row = rows[0]
    assert row.get("source_type") == "Memory"
    assert row.get("source_name") == saved["name"]
    assert row.get("source_label") == "Personal memory"
    assert not row.get("conversation")
    assert row.get("chunk_index") == 0
    assert row.get("model") == "embed-openai"
    assert row.get("content_hash") == hashlib.sha256(b"Apples make the best pie filling.").hexdigest()
    assert json.loads(row.get("vector")) == [0.5, 0.25]


def test_memory_save_without_embeddings_provider_stores_lexical_rows(services, monkeypatch):
    fake, store = services
    _provider(store, "p-plain", fake.session.user, kind="Anthropic")
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    monkeypatch.setattr(rag, "_embed", lambda *args: pytest.fail("embeddings must not be attempted"))
    monkeypatch.setattr(
        rag, "capability", lambda name: pytest.fail("capability must not be probed for unsupported kinds")
    )
    saved = memory.save_memory("Keep this without vectors.")
    assert saved["name"]
    # The content is indexed even with no embeddings endpoint: keyword recall
    # can score it now and a later capable provider can upgrade it in place.
    rows = _embedding_rows(store)
    assert len(rows) == 1
    row = rows[0]
    assert row.get("source_type") == "Memory"
    assert row.get("source_name") == saved["name"]
    assert row.get("source_label") == "Personal memory"
    assert row.get("content") == "Keep this without vectors."
    assert row.get("content_hash") == hashlib.sha256(b"Keep this without vectors.").hexdigest()
    assert json.loads(row.get("vector")) == []
    assert not row.get("model")
    # An identical re-save refreshes the note instead of stacking up copies.
    again = memory.save_memory("Keep this without vectors.")
    assert again["name"] == saved["name"]
    assert len(_embedding_rows(store)) == 1


def test_memory_rows_upgrade_to_vectors_when_a_provider_appears(services, monkeypatch):
    fake, store = services
    _provider(store, "p-plain", fake.session.user, kind="Anthropic")
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    saved = memory.save_memory("Apples are the best fruit for pies.")
    assert json.loads(_embedding_rows(store)[0].get("vector")) == []
    _provider(store, "p-embed", fake.session.user)
    _capable(rag, monkeypatch)
    # Unchanged content still re-indexes: the rows were vectorless and an
    # embeddings endpoint can now fill them in.
    memory.save_memory("Apples are the best fruit for pies.", name=saved["name"])
    rows = _embedding_rows(store)
    assert len(rows) == 1
    assert json.loads(rows[0].get("vector")) != []
    assert rows[0].get("model") == "embed-1"


def test_memory_embed_failure_never_breaks_save(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    monkeypatch.setattr(rag, "capability", lambda name: {"available": True, "model": "embed-1", "dims": 2})

    def down(access, inputs):
        raise Exception("provider down")

    monkeypatch.setattr(rag, "_embed", down)
    saved = memory.save_memory("Survives an embedding outage.")
    assert saved["name"]
    assert _embedding_rows(store) == []


def test_memory_delete_removes_its_embedding_rows(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    saved = memory.save_memory("Apples for the pie.")
    assert _embedding_rows(store)
    assert memory.delete_memory(saved["name"]) == {"deleted": True}
    assert _embedding_rows(store) == []
    assert saved["name"] not in store


def test_memory_edit_replaces_rows_and_unchanged_save_keeps_them(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    saved = memory.save_memory("Apples are the best fruit for pies.")
    first_hash = _embedding_rows(store)[0].get("content_hash")
    memory.save_memory("Apples are the best fruit for pies.", name=saved["name"])
    rows = _embedding_rows(store)
    assert len(rows) == 1
    assert rows[0].get("content_hash") == first_hash
    memory.save_memory("Oranges now win the fruit contest.", name=saved["name"])
    rows = _embedding_rows(store)
    assert len(rows) == 1
    assert rows[0].get("source_name") == saved["name"]
    assert "Oranges" in rows[0].get("content")
    assert rows[0].get("content_hash") == hashlib.sha256(b"Oranges now win the fruit contest.").hexdigest()


def test_save_memory_dedupes_identical_content_in_place(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    saved = memory.save_memory("Apples are the best fruit for pies.")
    # Surrounding whitespace still counts as the same note.
    again = memory.save_memory("  Apples are the best fruit for pies.  ")
    assert again["name"] == saved["name"]
    assert again["content"] == "Apples are the best fruit for pies."
    assert set(again) == {"name", "scope", "conversation", "content", "modified"}
    memories = [
        row for row in store.values() if isinstance(row, dict) and row.get("doctype") == "Intelligence Memory"
    ]
    assert len(memories) == 1
    # Indexing stays idempotent across the refresh: still one row.
    assert len(_embedding_rows(store)) == 1
    # Differing content is a new note, never an overwrite.
    changed = memory.save_memory("Oranges now win the fruit contest.")
    assert changed["name"] != saved["name"]


def test_save_memory_dedupe_is_scoped_to_the_conversation(services):
    fake, store = services
    memory = importlib.import_module("frappe_intelligence.memory")
    store["chat-a"] = Row(doctype="Intelligence Conversation", name="chat-a", owner=fake.session.user)
    store["chat-b"] = Row(doctype="Intelligence Conversation", name="chat-b", owner=fake.session.user)
    first = memory.save_memory("Prefer concise answers.", scope="conversation", conversation="chat-a")
    again = memory.save_memory("Prefer concise answers.", scope="conversation", conversation="chat-a")
    assert again["name"] == first["name"]
    other = memory.save_memory("Prefer concise answers.", scope="conversation", conversation="chat-b")
    assert other["name"] != first["name"]
    personal = memory.save_memory("Prefer concise answers.")
    assert personal["name"] not in (first["name"], other["name"])


def test_save_memory_dedupe_never_matches_another_users_memory(services):
    fake, store = services
    memory = importlib.import_module("frappe_intelligence.memory")
    store["foreign"] = Row(
        doctype="Intelligence Memory",
        name="foreign",
        scope="personal",
        owner="other@example.test",
        content="Shared phrasing.",
        enabled=1,
    )
    saved = memory.save_memory("Shared phrasing.")
    assert saved["name"] != "foreign"
    assert store["foreign"].get("content") == "Shared phrasing."
    memories = [
        row for row in store.values() if isinstance(row, dict) and row.get("doctype") == "Intelligence Memory"
    ]
    assert len(memories) == 2


def test_save_memory_dedupe_skips_disabled_notes(services):
    fake, store = services
    memory = importlib.import_module("frappe_intelligence.memory")
    store["off"] = Row(
        doctype="Intelligence Memory",
        name="off",
        scope="personal",
        owner=fake.session.user,
        content="Old note.",
        enabled=0,
    )
    saved = memory.save_memory("Old note.")
    assert saved["name"] != "off"


def test_semantic_recall_ranks_the_relevant_memory_first(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    zebra = memory.save_memory("Zebras roam the savanna in herds.")
    apple = memory.save_memory("Apples are the best fruit for pies.")
    ranked = memory.search_memories(scope="personal", query="tell me about apples")
    assert [row["name"] for row in ranked] == [apple["name"], zebra["name"]]
    assert ranked[0]["score"] > ranked[1]["score"] > 0
    context = SimpleNamespace(conversation="chat")
    result = memory_tool.recall_memory(context, {"scope": "personal", "query": "apples"})
    assert result["untrusted_content"] is True
    assert result["truncated"] is False
    assert [row["name"] for row in result["memories"]] == [apple["name"], zebra["name"]]
    assert result["memories"][0]["score"] == ranked[0]["score"]


def test_semantic_recall_never_returns_another_users_memory(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    own = memory.save_memory("Zebras roam the savanna in herds.")
    store["fm"] = Row(
        doctype="Intelligence Memory",
        name="fm",
        scope="personal",
        owner="other@example.test",
        content="Secret apple orchard plans.",
        enabled=1,
    )
    store["fe"] = Row(
        doctype="Intelligence Embedding",
        name="fe",
        source_type="Memory",
        source_name="fm",
        content="Secret apple orchard plans.",
        vector=json.dumps([100.0, 0.0]),
        model="embed-1",
        content_hash="foreign",
        chunk_index=0,
    )
    context = SimpleNamespace(conversation="chat")
    result = memory_tool.recall_memory(context, {"scope": "personal", "query": "apple orchard plans"})
    assert [row["name"] for row in result["memories"]] == [own["name"]]
    assert all("Secret" not in row["content"] for row in result["memories"])


def test_recall_without_query_is_byte_identical_recency(services):
    _, store = services
    memory = importlib.import_module("frappe_intelligence.memory")
    memory.save_memory("First note.")
    memory.save_memory("Second note.")
    context = SimpleNamespace(conversation="chat")
    rows = memory.list_memories(scope="personal")
    expected = [
        {key: row.get(key) for key in ("name", "scope", "conversation", "content", "modified")}
        for row in rows[:20]
    ]
    plain = memory_tool.recall_memory(context, {"scope": "personal"})
    assert plain == {"memories": expected, "truncated": False, "untrusted_content": True}
    assert all("score" not in row for row in plain["memories"])
    limited = memory_tool.recall_memory(context, {"scope": "personal", "limit": 1})
    assert limited["truncated"] is True
    assert len(limited["memories"]) == 1


def test_recall_with_a_query_ranks_by_keyword_without_any_provider(services):
    _, store = services
    memory = importlib.import_module("frappe_intelligence.memory")
    memory.save_memory("First note about apples.")
    memory.save_memory("Second note about zebras.")
    context = SimpleNamespace(conversation="chat")
    # No provider exists at all: the query still ranks, on keyword overlap.
    queried = memory_tool.recall_memory(context, {"scope": "personal", "query": "apples"})
    assert [row["content"] for row in queried["memories"]] == ["First note about apples."]
    assert queried["memories"][0]["score"] > 0
    assert queried["untrusted_content"] is True
    rows = _embedding_rows(store)
    assert len(rows) == 2
    assert all(json.loads(row.get("vector")) == [] for row in rows)


def test_semantic_recall_scores_only_a_bounded_candidate_set(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    zebra = memory.save_memory("Zebras roam the savanna in herds.")
    memory.save_memory("Apples are the best fruit for pies.")
    # The cap slices the candidate list: the better-matching apple memory is
    # beyond it and cannot be ranked, whatever its vector says.
    monkeypatch.setattr(rag, "MAX_MEMORY_CANDIDATES", 1)
    context = SimpleNamespace(conversation="chat")
    result = memory_tool.recall_memory(context, {"scope": "personal", "query": "apples"})
    assert [row["name"] for row in result["memories"]] == [zebra["name"]]
    assert result["memories"][0]["score"] > 0
    ranked = memory_tool.recall_memory(context, {"scope": "personal", "query": "zebras"})
    assert [row["name"] for row in ranked["memories"]] == [zebra["name"]]
    assert ranked["memories"][0]["score"] > 0


def test_recall_falls_back_to_keyword_when_vectors_cannot_score(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    memory.save_memory("Zebras roam the savanna in herds.")
    apple = memory.save_memory("Apples are the best fruit for pies.")
    # A recaller whose embeddings live in another dimension scores nothing semantically.
    monkeypatch.setattr(rag, "_embed", lambda access, inputs: [[1.0, 0.0, 0.0] for _ in inputs])
    context = SimpleNamespace(conversation="chat")
    result = memory_tool.recall_memory(context, {"scope": "personal", "query": "apples"})
    # Keyword scoring takes over instead of silently dropping to recency order.
    assert [row["name"] for row in result["memories"]] == [apple["name"]]
    assert result["memories"][0]["score"] > 0


def test_site_memory_embeds_with_the_saving_managers_provider(services, monkeypatch):
    fake, store = services
    fake.get_roles = lambda user=None: ["System Manager"]
    _provider(store, "p-embed", fake.session.user)
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    seen = {}

    def fake_embed(access, inputs):
        seen["provider"] = access["provider"].name
        seen["user"] = access["user"]
        return [[0.5, 0.25] for _ in inputs]

    monkeypatch.setattr(rag, "capability", lambda name: {"available": True, "model": "embed-mgr", "dims": 2})
    monkeypatch.setattr(rag, "_embed", fake_embed)
    saved = memory.save_memory("Deploy windows are Friday mornings.", scope="site")
    rows = _embedding_rows(store)
    assert len(rows) == 1
    assert rows[0].get("source_name") == saved["name"]
    assert rows[0].get("source_label") == "Site memory"
    assert rows[0].get("model") == "embed-mgr"
    assert not rows[0].get("conversation")
    assert seen == {"provider": "p-embed", "user": fake.session.user}


def test_conversation_memory_vectors_stay_out_of_conversation_retrieval(services, monkeypatch):
    fake, store = services
    _provider(store, "p-embed", fake.session.user)
    store["chat"] = Row(
        doctype="Intelligence Conversation", name="chat", owner=fake.session.user, provider="p-embed"
    )
    store["m0"] = Row(
        doctype="Intelligence Message",
        name="m0",
        conversation="chat",
        role="user",
        content="Zebras roam the savanna in herds.",
        sequence=0,
    )
    rag = importlib.import_module("frappe_intelligence.rag")
    memory = importlib.import_module("frappe_intelligence.memory")
    _capable(rag, monkeypatch)
    saved = memory.save_memory(
        "Apples are the best fruit for pies.", scope="conversation", conversation="chat"
    )
    memory_rows = [row for row in _embedding_rows(store) if row.get("source_name") == saved["name"]]
    assert len(memory_rows) == 1
    assert memory_rows[0].get("conversation") == "chat"
    assert memory_rows[0].get("source_label") == "Conversation memory"
    # Conversation retrieval never surfaces memory chunks and never sweeps them.
    hits = rag.search("chat", "tell me about apples")
    assert hits
    assert all(hit["source_type"] == "Message" for hit in hits)
    assert all("Apples" not in hit["content"] for hit in hits)
    assert [row for row in _embedding_rows(store) if row.get("source_name") == saved["name"]] == memory_rows
    # The approved recall flow still ranks the conversation memory semantically.
    ranked = memory.search_memories(scope="conversation", conversation="chat", query="apples")
    assert [row["name"] for row in ranked] == [saved["name"]]
    assert ranked[0]["score"] > 0


def test_recall_tool_schema_accepts_an_optional_query():
    specs = {spec.name: spec for spec in memory_tool.specs(SimpleNamespace(conversation="chat"))}
    validation.check_schema(specs["recall_memory"].parameters)
    validation.validate({"scope": "personal"}, specs["recall_memory"].parameters)
    validation.validate(
        {"scope": "personal", "query": "apples", "limit": 5}, specs["recall_memory"].parameters
    )
    with pytest.raises(ValueError):
        validation.validate({"scope": "personal", "query": 3}, specs["recall_memory"].parameters)


def test_recall_preview_echoes_the_query_for_approval(services):
    context = SimpleNamespace(conversation="chat")
    preview = memory_tool.preview_recall(context, {"scope": "personal", "query": "  apples  ", "limit": 5})
    assert preview["details"] == {"limit": 5, "query": "apples"}
    preview = memory_tool.preview_recall(context, {"scope": "personal"})
    assert preview["details"] == {"limit": 20}


def test_embedding_doctype_allows_memory_chunks_without_a_conversation():
    path = (
        Path(__file__).resolve().parents[1]
        / "frappe_intelligence/frappe_intelligence/doctype/intelligence_embedding/intelligence_embedding.json"
    )
    doc = json.loads(path.read_text())
    fields = {field["fieldname"]: field for field in doc["fields"]}
    assert "Memory" in fields["source_type"]["options"].split("\n")
    assert not fields["conversation"].get("reqd")
