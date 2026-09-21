"""Backfill the global search index for existing Intelligence Conversations.

The doctype marks its title in_global_search, but rows written before that flag
synced were never indexed. Rebuilding once makes every conversation findable by
title from Desk search without touching user data.
"""

from frappe.utils.global_search import rebuild_for_doctype


def execute():
    rebuild_for_doctype("Intelligence Conversation")
