"""Stable, Frappe-independent interface to configured model providers.

Models are administrator/user configuration, not a bundled catalog. Responses
are non-streaming; tool proposals are returned to the approval engine and never
executed here. Persist ToolCall.metadata privately for Gemini continuations.
"""

from .adapters import EMBEDDING_KINDS, KINDS, complete, embed_documents
from .types import ProviderConfig, ProviderError, Reply, ToolCall

__all__ = [
    "EMBEDDING_KINDS",
    "KINDS",
    "ProviderConfig",
    "ProviderError",
    "Reply",
    "ToolCall",
    "complete",
    "embed_documents",
]
