from frappe_intelligence.documents import ManagedDocument


class IntelligenceEmbedding(ManagedDocument):
    # Internal retrieval index: written only by rag.py inside internal_write
    # after conversation access checks, and readable by no Desk role directly.
    pass
