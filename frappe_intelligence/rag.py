"""Retrieval over private conversation sources through the configured provider.

Embeddings are requested lazily, only when a conversation asks for retrieval,
and only through the provider already configured for that conversation. Every
entry point checks conversation access first; index rows are internal server
records and are never exposed as documents. When the configured provider has
no embeddings endpoint the pipeline degrades to an honest, cached unavailable
status and chat continues without retrieval.

Saved memories are indexed best-effort through the same provider path. Their
chunks never join conversation retrieval; they are read only by the explicitly
approved memory recall flow, which falls back to the recency list whenever
embeddings are unavailable.
"""

import hashlib
import io
import json
import math

import frappe

from .access import can_use_provider, get_conversation, get_settings, internal_write, require_user
from .providers import ProviderConfig, ProviderError, adapters

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
# A conversation index is a working set, not an archive: bounded so retrieval
# stays exact and cheap in pure python.
MAX_CHUNKS = 400
MAX_SOURCE_CHARS = 400000
MAX_QUERY_CHARS = 8000
EMBEDDING_BATCH = 16
CACHE_TTL_SECONDS = 6 * 60 * 60
# Saved memories embed through the same pipeline: one memory is a couple of
# chunks, and semantic recall scores only a bounded, already-visible set.
MEMORY_SOURCE = "Memory"
MEMORY_CHUNK_SIZE = 4000
MEMORY_CHUNK_OVERLAP = 800
MAX_MEMORY_CHUNKS = 4
MAX_MEMORY_CANDIDATES = 200
# OpenAI-compatible embedding models per wire; "custom" follows the OpenAI
# convention because custom endpoints are OpenAI-compatible by definition.
_EMBEDDING_MODEL = {
    "openai": "text-embedding-3-small",
    "openrouter": "openai/text-embedding-3-small",
    "custom": "text-embedding-3-small",
}


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping windows, breaking on whitespace when possible."""
    if not isinstance(text, str):
        return []
    text = text.strip()
    if not text:
        return []
    if not isinstance(size, int) or size < 200 or not isinstance(overlap, int) or not 0 <= overlap < size:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            split = text.rfind(" ", start, end)
            if split > start:
                end = split
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = end - overlap if end - overlap > start else end
    return chunks


def cosine(left, right):
    """Pure-python cosine similarity; malformed or mismatched vectors score 0."""
    if (
        not isinstance(left, (list, tuple))
        or not isinstance(right, (list, tuple))
        or not left
        or len(left) != len(right)
    ):
        return 0.0
    dot = norm_left = norm_right = 0.0
    for a, b in zip(left, right):
        if (
            isinstance(a, bool)
            or isinstance(b, bool)
            or not isinstance(a, (int, float))
            or not isinstance(b, (int, float))
        ):
            return 0.0
        dot += a * b
        norm_left += a * a
        norm_right += b * b
    if not norm_left or not norm_right:
        return 0.0
    return dot / (math.sqrt(norm_left) * math.sqrt(norm_right))


def _cache():
    try:
        return frappe.cache()
    except Exception:
        return None


def _cache_key(provider_name):
    return f"intelligence-rag-probe-{provider_name}"


def _forget(provider_name):
    cache = _cache()
    if cache is not None:
        try:
            cache.delete_value(_cache_key(provider_name))
        except Exception:
            pass


def _embedding_model(kind):
    return _EMBEDDING_MODEL.get(kind)


def _provider_config(doc, api_key, settings):
    kind = (doc.get("kind") or "").lower()
    try:
        timeout = int(doc.get("timeout") or 30)
    except (TypeError, ValueError):
        timeout = 30
    return ProviderConfig(
        kind=kind,
        model=_embedding_model(kind) or "",
        api_key=api_key,
        base_url=doc.get("base_url") or "",
        max_tokens=1,
        timeout=min(max(timeout, 5), 120),
        allowed_hosts=tuple(
            host.strip() for host in (settings.get("allowed_custom_hosts") or "").splitlines() if host.strip()
        ),
        effort="",
    )


def capability(provider_name):
    """Embeddings capability for one provider, for the current user.

    Permission answers are computed per call; only network-derived endpoint
    truths are cached, site-wide, for CACHE_TTL_SECONDS. Never raises.
    """
    unavailable = lambda reason: {"available": False, "reason": reason}  # noqa: E731
    try:
        user = require_user()
        doc = frappe.get_doc("Intelligence Provider", provider_name)
    except Exception:
        return unavailable("The configured provider no longer exists.")
    if not can_use_provider(doc, user):
        return unavailable("You cannot use the configured provider.")
    kind = (doc.get("kind") or "").lower()
    if kind not in adapters.EMBEDDING_KINDS:
        return unavailable("This provider's API does not support embeddings.")
    probe = _probe(provider_name, doc, user)
    if not probe.get("available"):
        return probe
    return {"available": True, "model": probe.get("model"), "dims": probe.get("dims")}


def _probe(provider_name, doc, user):
    """One authenticated embeddings probe, cached per provider; never raises."""
    cache = _cache()
    if cache is not None:
        try:
            cached = cache.get_value(_cache_key(provider_name))
        except Exception:
            cached = None
        if isinstance(cached, dict) and cached.get("v") == 1:
            return cached
    result = _live_probe(doc, user)
    result["v"] = 1
    if cache is not None:
        try:
            cache.set_value(_cache_key(provider_name), result, expires_in_sec=CACHE_TTL_SECONDS)
        except Exception:
            pass
    return result


def _live_probe(doc, user):
    unavailable = lambda reason: {"available": False, "reason": reason}  # noqa: E731
    from .access import provider_secret_access

    try:
        with provider_secret_access(doc.name, user):
            api_key = doc.get_password("api_key")
    except Exception:
        return unavailable("The provider credentials could not be read for retrieval.")
    if not api_key:
        return unavailable("The configured provider has no API key for retrieval.")
    config = _provider_config(doc, api_key, get_settings())
    try:
        vectors = adapters.embed_documents(config, ["retrieval capability check"])
    except ProviderError as exc:
        if exc.code == "authentication_failed":
            return unavailable("The provider rejected the credentials used for retrieval.")
        return unavailable("The configured provider does not expose an embeddings endpoint.")
    except Exception:
        return unavailable("Retrieval is temporarily unavailable.")
    return {"available": True, "model": config.model, "dims": len(vectors[0])}


def status():
    """Honest retrieval availability for the current user; safe for the boot payload.

    The first call per provider per cache window performs one tiny authenticated
    embeddings request; later calls read the cached outcome. Never raises.
    """
    unavailable = lambda reason: {"available": False, "reason": reason}  # noqa: E731
    try:
        require_user()
    except Exception:
        return unavailable("Retrieval needs a signed-in Intelligence user.")
    try:
        from .provider_service import list_providers

        providers = list_providers()
    except Exception:
        return unavailable("Retrieval status could not be determined.")
    if not providers:
        return unavailable("Configure a provider to use retrieval.")
    reasons = []
    for provider in providers:
        result = capability(provider["name"])
        if result.get("available"):
            return {
                "available": True,
                "provider": provider.get("title") or provider["name"],
                "model": result.get("model"),
            }
        if result.get("reason"):
            reasons.append(result["reason"])
    return unavailable(reasons[0] if reasons else "No configured provider offers embeddings.")


def _retrieval_access(chat):
    """Resolve the conversation's provider for retrieval, or None when unusable."""
    user = require_user()
    provider_name = chat.get("provider")
    if not provider_name:
        return None
    try:
        doc = frappe.get_doc("Intelligence Provider", provider_name)
    except Exception:
        return None
    if not can_use_provider(doc, user):
        return None
    if (doc.get("kind") or "").lower() not in adapters.EMBEDDING_KINDS:
        return None
    state = capability(provider_name)
    if not state.get("available"):
        return None
    return {"user": user, "provider": doc, "state": state}


def _memory_access():
    """Resolve the current user's first embeddings-capable provider, or None.

    Memories are cross-conversation, so unlike _retrieval_access there is no
    conversation provider to prefer: the saver's (or recaller's) first usable
    provider that supports embeddings wins. Never raises.
    """
    try:
        user = require_user()
        from .provider_service import list_providers

        providers = list_providers()
    except Exception:
        return None
    for row in providers:
        name = row.get("name")
        if not name:
            continue
        try:
            doc = frappe.get_doc("Intelligence Provider", name)
            if not can_use_provider(doc, user):
                continue
            if (doc.get("kind") or "").lower() not in adapters.EMBEDDING_KINDS:
                continue
            state = capability(name)
        except Exception:
            continue
        if state.get("available"):
            return {"user": user, "provider": doc, "state": state}
    return None


def _embed(access, inputs):
    from .access import provider_secret_access

    doc = access["provider"]
    with provider_secret_access(doc.name, access["user"]):
        api_key = doc.get_password("api_key")
    config = _provider_config(doc, api_key, get_settings())
    return adapters.embed_documents(config, inputs)


def _pdf_text(raw):
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    try:
        reader = PdfReader(io.BytesIO(raw))
        return "\n".join((page.extract_text() or "") for page in reader.pages[:50])
    except Exception:
        return ""


def _attachment_text(name):
    try:
        content = frappe.get_doc("File", name).get_content()
    except Exception:
        return ""
    raw = content if isinstance(content, bytes) else str(content or "").encode("utf-8")
    if raw[:5] == b"%PDF-":
        return _pdf_text(raw)
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return ""


def _sources(chat):
    """Indexable texts in deterministic order: private attachments, then messages."""
    sources = []
    for row in frappe.get_all(
        "File",
        filters={
            "attached_to_doctype": "Intelligence Conversation",
            "attached_to_name": chat.name,
            "is_private": 1,
        },
        fields=["name", "file_name", "attached_to_name"],
        order_by="creation asc",
        limit_page_length=20,
    ):
        if row.get("attached_to_name") != chat.name:
            continue
        sources.append({"type": "Attachment", "name": row.name, "label": row.get("file_name") or row.name})
    for row in frappe.get_all(
        "Intelligence Message",
        filters={"conversation": chat.name},
        fields=["name", "conversation", "role", "content"],
        order_by="sequence asc",
        limit_page_length=1000,
    ):
        if row.get("conversation") != chat.name:
            continue
        if row.get("role") in ("user", "assistant") and (row.get("content") or "").strip():
            label = "Your message" if row.get("role") == "user" else "Assistant message"
            sources.append({"type": "Message", "name": row.name, "label": label, "text": row["content"]})
    return sources


def _rows(conversation):
    # Memory chunks share the conversation column but belong to the approved
    # memory recall flow only: never to conversation retrieval, and never to
    # the stale-source sweep of _ensure_indexed.
    return [
        row
        for row in frappe.get_all(
            "Intelligence Embedding",
            filters={"conversation": conversation},
            fields=[
                "name",
                "conversation",
                "source_name",
                "source_type",
                "source_label",
                "content",
                "content_hash",
                "vector",
            ],
            limit_page_length=MAX_CHUNKS + 50,
        )
        if row.get("conversation") == conversation and row.get("source_type") != MEMORY_SOURCE
    ]


def _delete_rows(conversation, source_name=None):
    filters = {"conversation": conversation}
    if source_name is not None:
        filters["source_name"] = source_name
    deleted = 0
    for row in frappe.get_all(
        "Intelligence Embedding",
        filters=filters,
        fields=["name", "conversation", "source_name"],
        limit_page_length=MAX_CHUNKS + 50,
    ):
        if row.get("conversation") != conversation:
            continue
        if source_name is not None and row.get("source_name") != source_name:
            continue
        with internal_write():
            frappe.delete_doc("Intelligence Embedding", row.get("name"), ignore_permissions=True)
        deleted += 1
    return deleted


def _source_rows(source_type, source_name, fields):
    return [
        row
        for row in frappe.get_all(
            "Intelligence Embedding",
            filters={"source_type": source_type, "source_name": source_name},
            fields=fields,
            limit_page_length=MAX_MEMORY_CHUNKS + 50,
        )
        if row.get("source_type") == source_type and row.get("source_name") == source_name
    ]


def _delete_source_rows(source_type, source_name):
    deleted = 0
    for row in _source_rows(source_type, source_name, ["name", "source_type", "source_name"]):
        with internal_write():
            frappe.delete_doc("Intelligence Embedding", row.get("name"), ignore_permissions=True)
        deleted += 1
    return deleted


def _index_chunks(conversation, access, source, digest, chunks):
    for start in range(0, len(chunks), EMBEDDING_BATCH):
        batch = chunks[start : start + EMBEDDING_BATCH]
        try:
            vectors = _embed(access, batch)
        except ProviderError:
            # A mid-index outage keeps earlier batches and fails no ask; the
            # cached capability is dropped so the next status re-probes.
            _forget(access["provider"].name)
            return
        except Exception:
            return
        with internal_write():
            for offset, (chunk, vector) in enumerate(zip(batch, vectors)):
                frappe.get_doc(
                    {
                        "doctype": "Intelligence Embedding",
                        "conversation": conversation,
                        "source_type": source["type"],
                        "source_name": source["name"],
                        "source_label": str(source["label"])[:140],
                        "chunk_index": start + offset,
                        "content": chunk,
                        "vector": json.dumps(vector, separators=(",", ":")),
                        "content_hash": digest,
                        "model": access["state"].get("model") or "",
                    }
                ).insert(ignore_permissions=True)


def _ensure_indexed(chat, access):
    """Idempotently embed new and changed sources, bounded to MAX_CHUNKS rows."""
    grouped = {}
    for row in _rows(chat.name):
        grouped.setdefault(row.get("source_name"), []).append(row)
    total = sum(len(rows) for rows in grouped.values())
    keep = set()
    pending = []
    for source in _sources(chat):
        if total >= MAX_CHUNKS:
            break
        text = source.get("text")
        if text is None:
            text = _attachment_text(source["name"])
        text = (text or "")[:MAX_SOURCE_CHARS].strip()
        if not text:
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        keep.add(source["name"])
        existing = grouped.get(source["name"]) or []
        if existing and {row.get("content_hash") for row in existing} == {digest}:
            continue
        if existing:
            _delete_rows(chat.name, source["name"])
            total -= len(existing)
        room = max(MAX_CHUNKS - total, 0)
        chunks = chunk_text(text)[:room]
        if not chunks:
            continue
        pending.append((source, digest, chunks))
        total += len(chunks)
    for stale in set(grouped) - keep:
        _delete_rows(chat.name, stale)
    for source, digest, chunks in pending:
        _index_chunks(chat.name, access, source, digest, chunks)
    return total


def search(conversation, query, top_k=5):
    """Top matching private chunks for a conversation, or [] when unavailable."""
    chat = get_conversation(conversation)
    if not isinstance(query, str) or not query.strip():
        frappe.throw("Enter a retrieval query.")
    query = query.strip()[:MAX_QUERY_CHARS]
    try:
        top_k = int(top_k)
    except (TypeError, ValueError):
        top_k = 5
    top_k = min(max(top_k, 1), 20)
    access = _retrieval_access(chat)
    if access is None:
        return []
    _ensure_indexed(chat, access)
    try:
        query_vector = _embed(access, [query])[0]
    except ProviderError:
        _forget(access["provider"].name)
        return []
    except Exception:
        return []
    scored = []
    for row in _rows(chat.name):
        try:
            vector = json.loads(row.get("vector") or "[]")
        except ValueError:
            continue
        score = cosine(query_vector, vector)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "content": row.get("content"),
            "source_type": row.get("source_type"),
            "source_label": row.get("source_label"),
            "score": round(score, 4),
        }
        for score, row in scored[:top_k]
    ]


def context_block(conversation, query, top_k=5, max_chars=4000):
    """Assembled retrieval context for the engine; empty string when unavailable."""
    try:
        hits = search(conversation, query, top_k=top_k)
    except Exception:
        return ""
    if not hits:
        return ""
    blocks = []
    size = 0
    for hit in hits:
        block = f"[{hit.get('source_label') or hit.get('source_type') or 'source'}]\n{hit['content']}"
        if size + len(block) > max_chars:
            break
        blocks.append(block)
        size += len(block)
    return "\n\n".join(blocks)


def drop_conversation(conversation):
    """Delete a conversation's index rows; for the conversation deletion path."""
    return _delete_rows(conversation)


def index_memory(memory):
    """Best-effort vector index for one saved memory; never raises, never blocks the save.

    Unchanged content keeps its rows (content_hash match); changed content has
    its rows replaced. When no provider offers embeddings the memory is stored
    without vectors and the recency fallback in the recall flow keeps working.
    """
    try:
        name = memory.get("name")
        content = (memory.get("content") or "").strip()
        if not name or not content:
            return
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        existing = _source_rows(MEMORY_SOURCE, name, ["name", "source_type", "source_name", "content_hash"])
        if existing and {row.get("content_hash") for row in existing} == {digest}:
            return
        if existing:
            _delete_source_rows(MEMORY_SOURCE, name)
        access = _memory_access()
        if access is None:
            return
        chunks = chunk_text(content, size=MEMORY_CHUNK_SIZE, overlap=MEMORY_CHUNK_OVERLAP)[:MAX_MEMORY_CHUNKS]
        if not chunks:
            return
        scope = str(memory.get("scope") or "personal").title()
        source = {"type": MEMORY_SOURCE, "name": name, "label": f"{scope} memory"}
        _index_chunks(memory.get("conversation"), access, source, digest, chunks)
    except Exception:
        return


def drop_memory(name):
    """Delete one memory's index rows; part of the memory deletion write."""
    if not name:
        return 0
    return _delete_source_rows(MEMORY_SOURCE, name)


def score_memories(candidates, query):
    """Cosine scores {memory name: score} over visible candidates, or None when unavailable.

    Candidates must already be visibility-filtered by the caller; scoring only
    reorders that set. Only chunks embedded with the recaller's current
    embedding model can score; anything else leaves the memory unranked so the
    caller keeps its recency order. Read-only, bounded to MAX_MEMORY_CANDIDATES.
    """
    if not isinstance(query, str) or not query.strip():
        return None
    access = _memory_access()
    if access is None:
        return None
    names = []
    for row in candidates:
        if len(names) >= MAX_MEMORY_CANDIDATES:
            break
        name = row.get("name")
        if name and name not in names:
            names.append(name)
    if not names:
        return None
    try:
        query_vector = _embed(access, [query.strip()[:MAX_QUERY_CHARS]])[0]
    except ProviderError:
        _forget(access["provider"].name)
        return None
    except Exception:
        return None
    wanted = set(names)
    model = access["state"].get("model") or ""
    scores = {}
    for row in frappe.get_all(
        "Intelligence Embedding",
        filters={"source_type": MEMORY_SOURCE, "source_name": ("in", names)},
        fields=["name", "source_type", "source_name", "vector", "model"],
        limit_page_length=MAX_MEMORY_CANDIDATES * MAX_MEMORY_CHUNKS + 50,
    ):
        if row.get("source_type") != MEMORY_SOURCE:
            continue
        source_name = row.get("source_name")
        if source_name not in wanted:
            continue
        if model and (row.get("model") or "") != model:
            continue
        try:
            vector = json.loads(row.get("vector") or "[]")
        except ValueError:
            continue
        score = cosine(query_vector, vector)
        if score > scores.get(source_name, 0.0):
            scores[source_name] = score
    return {name: round(score, 4) for name, score in scores.items() if score > 0}
