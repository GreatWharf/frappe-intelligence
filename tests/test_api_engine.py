import importlib
import sys

import pytest
from test_engine_state import env as env


@pytest.mark.parametrize("context", [None, "", {}, "{}"])
def test_context_free_workspace_message_reaches_real_engine(env, monkeypatch, context):
    monkeypatch.setattr(env.frappe, "whitelist", lambda *a, **kw: lambda fn: fn, raising=False)
    monkeypatch.delitem(sys.modules, "frappe_intelligence.api", raising=False)
    api = importlib.import_module("frappe_intelligence.api")
    try:
        result = api.send_message("conversation", "Help me", context=context)
        assert result["state"] == "queued"
        run = env.frappe.get_doc("Intelligence Run", result["name"])
        assert run.user == "alice"
        assert env.frappe.get_doc("Intelligence Conversation", "conversation").message_count == 1
    finally:
        sys.modules.pop("frappe_intelligence.api", None)
