from frappe_intelligence.documents import ManagedDocument


class IntelligenceMemory(ManagedDocument):
    """Native Desk saves and deletes join the same embedding lifecycle as the
    service path (which also indexes explicitly; both are idempotent)."""

    def on_update(self):
        from frappe_intelligence import rag

        rag.index_memory(self)

    def on_trash(self):
        super().on_trash()
        from frappe_intelligence import rag

        try:
            rag.drop_memory(self.name)
        except Exception:
            # Deleting the memory must never fail on index cleanup.
            pass
