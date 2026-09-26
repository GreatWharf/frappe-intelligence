"""Approval exemptions, standing always-allow grants and generated titles."""

import dataclasses
import sys
from datetime import datetime, timedelta

import pytest
from test_engine_state import Record, approvals, reply, submit
from test_engine_state import env as env


def set_tools(env, *specs):
    """Give the stubbed tools module exactly these (name, mutates) tools."""
    toolmod = sys.modules["frappe_intelligence.tools"]
    toolmod.get_tools = lambda context: {
        name: Record(name=name, version="1", mutates=mutates, external=False) for name, mutates in specs
    }
    return toolmod


def grants(env):
    return env.frappe.get_all("Intelligence Tool Grant")


def drive_to_completion(env, name):
    for _ in range(6):
        env.engine.process_run(name)
    return env.engine.get_run(name)["state"]


def submit_titled(env, message="Show my unpaid invoices"):
    env.frappe.seed(
        "Intelligence Conversation",
        "titled",
        owner="alice",
        provider="provider",
        message_count=0,
        title="New chat",
    )
    result = env.engine.submit_message("titled", message)
    env.frappe.db.commit()
    return result["name"]


def test_memory_tools_are_exempt_from_approval_in_the_strictest_mode(env):
    assert env.frappe.settings.get("approval_mode") in (None, "Approve Every Step")
    set_tools(env, ("recall_memory", False), ("save_memory", True))
    name = submit(env)
    env.replies.append(
        reply(("recall_memory", {"scope": "personal"}), ("save_memory", {"content": "Prefers INR."}))
    )
    env.engine.process_run(name)
    rows = approvals(env)
    assert len(rows) == 2
    assert all(row.status == "approved" for row in rows), "memory tools never wait on a click"
    assert all(not row.decided_by and row.decided_at and row.digest for row in rows)
    assert env.engine.get_run(name)["state"] == "queued"
    env.replies.append(reply(text="Noted."))
    assert drive_to_completion(env, name) == "completed"
    assert len(env.executions) == 2, "both exempt tools executed without a human decision"


def test_read_attachment_is_exempt_only_for_this_conversations_files(env):
    toolmod = set_tools(env, ("read_attachment", False))
    name = submit(env)
    toolmod.prepare = lambda context, tool, args: {
        "tool": tool,
        "arguments": args,
        "target": {"doctype": "File", "name": args["file"], "conversation": "conversation"},
    }
    env.replies.append(reply(("read_attachment", {"file": "F-1"})))
    env.engine.process_run(name)
    assert approvals(env)[0].status == "approved", "reading your own upload needs no approval"
    env.replies.append(reply(text="Read."))
    assert drive_to_completion(env, name) == "completed"

    name = submit(env)
    toolmod.prepare = lambda context, tool, args: {
        "tool": tool,
        "arguments": args,
        "target": {"doctype": "File", "name": args["file"], "conversation": "elsewhere"},
    }
    env.replies.append(reply(("read_attachment", {"file": "F-9"})))
    env.engine.process_run(name)
    pending = [row for row in approvals(env) if row.run == name]
    assert pending[0].status == "pending", "any other file still waits for a decision"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"


def test_an_unscoped_grant_auto_approves_every_call_of_the_tool(env):
    set_tools(env, ("write", True))
    env.frappe.seed("Intelligence Tool Grant", "g1", user="alice", tool="write", scope_doctype="")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2})))
    env.engine.process_run(name)
    assert approvals(env)[0].status == "approved"
    assert env.engine.get_run(name)["state"] == "queued"
    env.replies.append(reply(text="Done."))
    assert drive_to_completion(env, name) == "completed"
    assert len(env.executions) == 1


def test_a_scoped_grant_matches_only_calls_naming_that_doctype(env):
    set_tools(env, ("read", False))
    env.frappe.seed("Intelligence Tool Grant", "g1", user="alice", tool="read", scope_doctype="Customer")
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"}), ("read", {"doctype": "Supplier"})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env)}
    assert by_call["call-0"].status == "approved", "the granted DocType is covered"
    assert by_call["call-1"].status == "pending", "another DocType still asks"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"


def test_grants_never_cross_user_boundaries(env):
    set_tools(env, ("write", True))
    env.frappe.seed("Intelligence Tool Grant", "g1", user="bob", tool="write", scope_doctype="")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2})))
    env.engine.process_run(name)
    assert approvals(env)[0].status == "pending", "bob's grant must not cover alice's run"


def test_always_decision_approves_and_records_a_grant_once(env):
    set_tools(env, ("write", True))
    name = submit(env)
    env.replies.append(reply(("write", {"value": 3})))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    assert approval.status == "pending"

    env.engine.decide_approval(approval.name, "always")
    approval = approvals(env)[0]
    assert approval.status == "approved" and approval.decided_by == "alice"
    rows = grants(env)
    assert len(rows) == 1
    assert (rows[0].user, rows[0].tool, rows[0].scope_doctype) == ("alice", "write", "")

    env.engine.decide_approval(approval.name, "always")
    assert len(grants(env)) == 1, "repeating the decision never duplicates the grant"

    env.replies.append(reply(text="Done."))
    assert drive_to_completion(env, name) == "completed"

    name = submit(env)
    env.replies.append(reply(("write", {"value": 4})))
    env.engine.process_run(name)
    current = [row for row in approvals(env) if row.run == name]
    assert current[0].status == "approved", "the standing grant auto-approves the next run"


def test_always_decision_scopes_the_grant_to_the_validated_doctype(env):
    set_tools(env, ("read", False))
    env.frappe.seed("DocType", "Customer")
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "always")
    rows = grants(env)
    assert len(rows) == 1 and rows[0].scope_doctype == "Customer"
    env.replies.append(reply(text="Here you go."))
    assert drive_to_completion(env, name) == "completed"

    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"}), ("read", {"doctype": "Supplier"})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env) if row.run == name}
    assert by_call["call-0"].status == "approved"
    assert by_call["call-1"].status == "pending", "the scoped grant does not leak to other DocTypes"


def test_always_decision_refuses_to_widen_a_scope_that_no_longer_resolves(env):
    set_tools(env, ("read", False))
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Deleted DocType"})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "always")
    assert approvals(env)[0].status == "approved", "the approval itself still stands"
    assert grants(env) == [], "an unverifiable scope must not become an unscoped grant"


def test_deny_and_unknown_decisions_are_unchanged(env):
    set_tools(env, ("write", True))
    name = submit(env)
    env.replies.append(reply(("write", {"value": 3})))
    env.engine.process_run(name)
    with pytest.raises(ValueError):
        env.engine.decide_approval(approvals(env)[0].name, "perhaps")
    env.engine.decide_approval(approvals(env)[0].name, "deny")
    assert approvals(env)[0].status == "denied"
    assert grants(env) == []


def test_approval_modes_still_gate_reads_and_writes(env):
    # The exemptions above never weaken the mode policy for business tools.
    set_tools(env, ("read", False), ("write", True))
    env.frappe.settings.approval_mode = "Approve Writes Only"
    name = submit(env)
    env.replies.append(reply(("read", {}), ("write", {})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env)}
    assert by_call["call-0"].status == "approved"
    assert by_call["call-1"].status == "pending"


def test_expired_approval_cannot_be_always_approved(env):
    set_tools(env, ("write", True))
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1})))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    env.frappe.get_doc("Intelligence Approval", approval.name).expires_at = datetime.now() - timedelta(
        minutes=1
    )
    env.engine.decide_approval(approval.name, "always")
    assert approvals(env)[0].status == "expired"
    assert grants(env) == [], "an expired proposal grants nothing"


@dataclasses.dataclass
class TitleConfig:
    kind: str = "openai"
    model: str = "test"
    api_key: str = "secret"
    base_url: str = ""
    max_tokens: int = 4096
    timeout: int = 60
    allowed_hosts: tuple = ()
    effort: str = ""


def use_real_config(env, monkeypatch, kind="openai"):
    """Title generation needs a real dataclass config; the run turn tolerates it too."""
    monkeypatch.setattr(env.engine, "get_provider_config", lambda provider, user=None: TitleConfig(kind=kind))
    seen = []
    complete = sys.modules["frappe_intelligence.providers"].complete

    def spy(config, messages, tools):
        seen.append(config)
        return complete(config, messages, tools)

    sys.modules["frappe_intelligence.providers"].complete = spy
    return seen


def title_reply(text):
    return Record(text=text, tool_calls=[], usage={})


def test_the_first_completed_run_replaces_the_placeholder_title(env, monkeypatch):
    seen = use_real_config(env, monkeypatch)
    name = submit_titled(env)
    assert env.frappe.get_doc("Intelligence Conversation", "titled").title == "Show my unpaid invoices"
    env.replies.append(reply(text="Here are your unpaid invoices."))
    env.replies.append(title_reply('  "Unpaid invoice review."\n'))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Unpaid invoice review", "quotes, punctuation and whitespace are stripped"
    assert len(seen) == 2, "the run turn, then the tiny title call"
    assert seen[-1].max_tokens == 1200 and seen[-1].effort == "low", (
        "reasoning models need room for thinking plus the few visible words"
    )
    assert env.calls[-1][0]["role"] == "system" and "at most 100 characters" in env.calls[-1][0]["content"]
    payload = env.calls[-1][-1]["content"]
    assert "User message:\nShow my unpaid invoices" in payload
    assert "Assistant reply (context only):\nHere are your unpaid invoices." in payload
    assert env.frappe.events[-1][1]["state"] == "completed", "the rename pushes the usual snapshot"


def test_the_title_call_keeps_thinking_off_for_anthropic_and_gemini(env, monkeypatch):
    seen = use_real_config(env, monkeypatch, kind="anthropic")
    name = submit_titled(env)
    env.replies.append(reply(text="Answer."))
    env.replies.append(title_reply("Quiet review"))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert seen[-1].max_tokens == 1200 and seen[-1].effort == "", (
        "Anthropic thinking budgets must exceed max_tokens, so thinking stays off"
    )


def test_later_runs_never_regenerate_the_title(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    env.replies.append(reply(text="First answer."))
    env.replies.append(title_reply("Invoice follow ups"))
    env.engine.process_run(name)
    assert env.frappe.get_doc("Intelligence Conversation", "titled").title == "Invoice follow ups"

    result = env.engine.submit_message("titled", "Anything else?")
    env.frappe.db.commit()
    env.replies.append(reply(text="Second answer."))
    env.engine.process_run(result["name"])
    assert env.engine.get_run(result["name"])["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Invoice follow ups", "the first reply belongs to the first run only"


def test_a_manual_rename_is_never_overwritten(env, monkeypatch):
    use_real_config(env, monkeypatch)
    env.frappe.get_doc("Intelligence Conversation", "conversation").update(
        title="Quarterly review", title_manually_set=1
    )
    name = submit(env)
    env.replies.append(reply(text="Answer."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert env.frappe.get_doc("Intelligence Conversation", "conversation").title == "Quarterly review"
    assert len(env.calls) == 1, "no title call happens for a user-named conversation"


def test_a_failing_title_call_never_breaks_the_run(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    env.replies.append(reply(text="Answer."))
    env.replies.append(lambda: (_ for _ in ()).throw(RuntimeError("provider down")))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Show my unpaid invoices", "the truncated placeholder stays"


def test_an_empty_title_reply_keeps_the_placeholder(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    env.replies.append(reply(text="Answer."))
    env.replies.append(title_reply('"\n.  '))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Show my unpaid invoices"
