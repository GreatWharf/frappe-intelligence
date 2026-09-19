"""Approval policy matrix, scoped grants, bulk decisions and realtime run events."""

import importlib
import sys
from datetime import datetime, timedelta
from types import ModuleType

import pytest
from test_engine_state import Record, approvals, reply, submit
from test_engine_state import env as env
from test_install import migrator as migrator
from test_services import Row
from test_services import services as services


def set_tools(env, *specs):
    """Give the stubbed tools module exactly these (name, mutates, operation) tools."""
    toolmod = sys.modules["frappe_intelligence.tools"]
    toolmod.get_tools = lambda context: {
        name: Record(name=name, version="1", mutates=mutates, external=False, operation=operation)
        for name, mutates, operation in specs
    }
    return toolmod


def seed_policy(env, name, **values):
    row = dict(
        enabled=1,
        priority=100,
        tool="",
        target_doctype=None,
        operation="Any",
        role=None,
        amount_condition="Any amount",
        amount_limit=None,
        decision="Require approval",
        reason="",
    )
    row.update(values)
    return env.frappe.seed("Intelligence Policy", name, **row)


def grants(env):
    return env.frappe.get_all("Intelligence Tool Grant")


def current(env, name):
    return [row for row in approvals(env) if row.run == name]


def finish(env, name):
    """Approve what is pending, then drive the run to a completed terminal state."""
    for row in approvals(env):
        if row.run == name and row.status == "pending":
            env.engine.decide_approval(row.name, "approve")
    env.frappe.db.commit()
    env.replies.append(reply(text="Done."))
    for _ in range(6):
        env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"


def test_resolution_order_conversation_grant_then_always_then_policy_then_mode(env):
    set_tools(env, ("write", True, "Update"))
    seed_policy(env, "p-auto", tool="write", decision="Auto-approve")
    env.frappe.seed(
        "Intelligence Tool Grant",
        "g-always",
        user="alice",
        tool="write",
        scope_doctype="",
        scope="Always",
    )
    env.frappe.seed(
        "Intelligence Tool Grant",
        "g-conv",
        user="alice",
        tool="write",
        scope_doctype="",
        scope="This Conversation",
        conversation="conversation",
    )

    name = submit(env)
    env.replies.append(reply(("write", {"value": 1})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved"
    assert approval.source == "grant:g-conv", "the conversation-scoped grant decides first"
    finish(env, name)

    env.frappe.rows.pop(("Intelligence Tool Grant", "g-conv"))
    env.frappe.db.commit()
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved"
    assert approval.source == "grant:g-always", "an Always grant still beats the policy matrix"
    finish(env, name)

    env.frappe.rows.pop(("Intelligence Tool Grant", "g-always"))
    env.frappe.db.commit()
    name = submit(env)
    env.replies.append(reply(("write", {"value": 3})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved"
    assert approval.source == "policy:p-auto", "the policy matrix beats the mode fallback"
    finish(env, name)

    env.frappe.rows.pop(("Intelligence Policy", "p-auto"))
    env.frappe.db.commit()
    name = submit(env)
    env.replies.append(reply(("write", {"value": 4})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending", "with nothing else matching, the mode fallback decides"
    assert not approval.get("source")
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    finish(env, name)


def test_first_match_orders_by_priority_then_specificity(env):
    set_tools(env, ("read", False, "Read"), ("write", True, "Update"))
    seed_policy(env, "p-catchall", priority=100, decision="Deny", reason="catch all")
    seed_policy(env, "p-higher", priority=200, decision="Auto-approve")
    seed_policy(env, "p-specific", priority=200, tool="read", decision="Require approval")
    name = submit(env)
    env.replies.append(reply(("read", {}), ("write", {"value": 1})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env)}
    assert by_call["call-0"].status == "pending", (
        "p-specific ties p-higher on priority and wins on specificity"
    )
    assert by_call["call-1"].status == "approved"
    assert by_call["call-1"].source == "policy:p-higher", "priority beats the catch-all Deny"
    finish(env, name)
    assert len(env.executions) == 2


def test_equal_priority_and_specificity_fall_to_name_order(env):
    set_tools(env, ("write", True, "Update"))
    seed_policy(env, "b-second", priority=50, tool="write", decision="Auto-approve")
    seed_policy(env, "a-first", priority=50, tool="write", decision="Deny", reason="name order")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1}), text="Trying."))
    env.engine.process_run(name)
    assert not approvals(env), "a-first denies before b-second can approve"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "name order" in row.content for row in messages)
    finish(env, name)
    assert not env.executions


def test_amount_at_or_below_matches_and_excess_falls_through(env):
    set_tools(env, ("write", True, "Create"))
    seed_policy(
        env, "p-small", amount_condition="At or below limit", amount_limit=1000, decision="Auto-approve"
    )
    seed_policy(env, "p-big", amount_condition="Above limit", amount_limit=1000, decision="Require approval")

    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "grand_total": 500})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "policy:p-small"
    finish(env, name)

    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "grand_total": 5000})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending", "above the small limit, the large-invoice row decides"
    assert not approval.get("source")
    finish(env, name)

    # Field/value pair arguments flatten into the same comparison payload.
    name = submit(env)
    env.replies.append(
        reply(("write", {"doctype": "Purchase Invoice", "fields": [{"field": "grand_total", "value": 500}]}))
    )
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "policy:p-small"
    finish(env, name)


def test_an_unextractable_amount_never_matches_a_threshold_policy(env):
    set_tools(env, ("write", True, "Create"))
    seed_policy(
        env, "p-small", amount_condition="At or below limit", amount_limit=1000, decision="Auto-approve"
    )
    seed_policy(
        env, "p-big", amount_condition="Above limit", amount_limit=1000, decision="Deny", reason="big"
    )
    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "note": "no amount anywhere"})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending" and not approval.get("source"), (
        "threshold rows fail closed when no amount can be extracted"
    )
    finish(env, name)


def test_extract_amount_prefers_canonical_fields_and_ignores_bools(env):
    engine = env.engine
    assert engine.extract_amount("X", {"grand_total": 120.0, "total": 100}) == 120.0
    assert engine.extract_amount("X", {"rounded_total": 5}) == 5.0
    assert engine.extract_amount("X", {"paid_amount": 7, "amount": 9}) == 7.0
    assert engine.extract_amount("X", {"base_grand_total": 3}) == 3.0
    assert engine.extract_amount("X", {"tax_amount": 10, "net_total": 99}) == 99
    assert engine.extract_amount("X", {"qty": 5, "rate": 10}) is None
    assert engine.extract_amount("X", {"paid_amount": True}) is None
    assert engine.extract_amount("X", "not a mapping") is None


def test_a_denied_call_returns_a_tool_error_and_the_run_requeues(env):
    set_tools(env, ("write", True, "Delete"))
    seed_policy(env, "p-deny", operation="Delete", decision="Deny", reason="Deletes are forbidden here.")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1}), text="Deleting."))
    env.engine.process_run(name)
    assert not approvals(env), "a policy denial never offers an approval"
    assert not env.executions
    assert env.engine.get_run(name)["state"] == "queued", "the batch requeues under the step budget"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(
        row.role == "tool" and row.tool_call_id == "call-0" and "forbidden" in row.content.lower()
        for row in messages
    )
    env.replies.append(reply(text="Understood, leaving records untouched."))
    for _ in range(4):
        env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert not env.executions


def test_a_denied_call_does_not_block_a_sibling_proposal(env):
    set_tools(env, ("read", False, "Read"), ("write", True, "Delete"))
    seed_policy(env, "p-deny", tool="write", decision="Deny", reason="writes are off")
    name = submit(env)
    env.replies.append(reply(("read", {}), ("write", {"value": 1}), text="Two steps."))
    env.engine.process_run(name)
    rows = approvals(env)
    assert len(rows) == 1 and rows[0].tool_name == "read" and rows[0].status == "pending"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(
        row.role == "tool" and row.tool_call_id == "call-1" and "writes are off" in row.content
        for row in messages
    )
    finish(env, name)
    assert len(env.executions) == 1, "only the approved read executed"


def test_auto_approve_writes_a_decided_approval_with_the_policy_marker(env):
    set_tools(env, ("read", False, "Read"))
    seed_policy(env, "p-auto", operation="Read", decision="Auto-approve", reason="reads are safe")
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved"
    assert not approval.decided_by, "policy auto-approvals stay unattributed to a human"
    assert approval.decided_at
    assert approval.source == "policy:p-auto"
    assert approval.digest, "auto-approvals keep the same durable digest audit"
    assert env.engine.get_run(name)["state"] == "queued"
    finish(env, name)
    assert len(env.executions) == 1


def test_a_grant_auto_approval_carries_the_grant_marker(env):
    set_tools(env, ("write", True, "Update"))
    env.frappe.seed("Intelligence Tool Grant", "g1", user="alice", tool="write", scope_doctype="")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved"
    assert not approval.decided_by and approval.decided_at
    assert approval.source == "grant:g1"
    finish(env, name)


def test_a_grant_outranks_a_denying_policy(env):
    set_tools(env, ("write", True, "Delete"))
    seed_policy(env, "p-deny", operation="Delete", decision="Deny", reason="nope")
    env.frappe.seed("Intelligence Tool Grant", "g1", user="alice", tool="write", scope_doctype="")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "grant:g1"
    finish(env, name)


def test_a_require_approval_policy_overrides_automatic_mode(env):
    env.frappe.settings.approval_mode = "Automatic"
    set_tools(env, ("write", True, "Delete"))
    seed_policy(env, "p-guard", operation="Delete", decision="Require approval", reason="deletes ask")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending", "the policy matrix beats the Automatic mode"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    finish(env, name)


def test_disabled_policies_never_match(env):
    set_tools(env, ("read", False, "Read"))
    seed_policy(env, "p-off", enabled=0, decision="Auto-approve")
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending" and not approval.get("source")
    finish(env, name)


def test_a_role_constrained_policy_matches_only_holders(env):
    set_tools(env, ("read", False, "Read"))
    seed_policy(env, "p-role", role="Intelligence Manager", decision="Auto-approve")
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    assert current(env, name)[0].status == "pending", "alice holds no manager role yet"
    finish(env, name)

    env.frappe.roles["alice"] = ["Intelligence User", "Intelligence Manager"]
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "policy:p-role"
    finish(env, name)


def test_a_conversation_scoped_decision_records_a_grant_for_that_conversation_only(env):
    set_tools(env, ("write", True, "Update"))
    name = submit(env)
    env.replies.append(reply(("write", {"value": 3})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    with pytest.raises(ValueError):
        env.engine.decide_approval(approval.name, "always", scope="Sometimes")
    assert current(env, name)[0].status == "pending", "a bad scope changes nothing"

    env.engine.decide_approval(approval.name, "always", scope="This Conversation")
    env.frappe.db.commit()
    rows = grants(env)
    assert len(rows) == 1
    assert rows[0].scope == "This Conversation" and rows[0].conversation == "conversation"
    finish(env, name)

    name = submit(env)
    env.replies.append(reply(("write", {"value": 4})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == f"grant:{rows[0].name}"
    finish(env, name)

    env.frappe.seed("Intelligence Conversation", "other", owner="alice", provider="provider", message_count=0)
    result = env.engine.submit_message("other", "Hi")
    env.frappe.db.commit()
    env.replies.append(reply(("write", {"value": 9})))
    env.engine.process_run(result["name"])
    approval = current(env, result["name"])[0]
    assert approval.status == "pending", "a conversation-scoped grant stops at its conversation"
    finish(env, result["name"])


def test_decide_approvals_bulk_approves_and_resumes_once(env):
    set_tools(env, ("read", False, "Read"))
    name = submit(env)
    env.replies.append(reply(("read", {"a": 1}), ("read", {"a": 2})))
    env.engine.process_run(name)
    names = [row.name for row in approvals(env)]
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    jobs_before = len(env.frappe.jobs)
    result = env.engine.decide_approvals(names, "approve")
    env.frappe.db.commit()
    assert [outcome["status"] for outcome in result["outcomes"]] == ["approved", "approved"]
    assert [outcome["name"] for outcome in result["outcomes"]] == names
    assert result["run"]["name"] == name and result["run"]["state"] == "queued"
    assert len(env.frappe.jobs) == jobs_before + 1, "the batch resumes the run exactly once"
    decisions = env.frappe.run_events("decision")
    assert [event[1]["approval"] for event in decisions] == names
    env.replies.append(reply(text="Done."))
    for _ in range(6):
        env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert len(env.executions) == 2


def test_decide_approvals_rejects_the_whole_batch_on_one_bad_name(env):
    set_tools(env, ("read", False, "Read"))
    name = submit(env)
    env.replies.append(reply(("read", {"a": 1}), ("read", {"a": 2})))
    env.engine.process_run(name)
    names = [row.name for row in approvals(env)]
    with pytest.raises(ValueError):
        env.engine.decide_approvals(names + ["missing"], "approve")
    with pytest.raises(ValueError):
        env.engine.decide_approvals([names[0], names[0]], "approve")
    with pytest.raises(ValueError):
        env.engine.decide_approvals(names, "perhaps")
    with pytest.raises(ValueError):
        env.engine.decide_approvals(names, "approve", scope="Sometimes")
    with pytest.raises(ValueError):
        env.engine.decide_approvals([], "approve")
    env.frappe.get_doc("Intelligence Approval", names[1]).expires_at = datetime.now() - timedelta(minutes=1)
    with pytest.raises(ValueError):
        env.engine.decide_approvals(names, "approve")
    rows = approvals(env)
    assert all(row.status == "pending" for row in rows), "no prefix of a bad batch is decided"
    assert all(not row.decided_by for row in rows)
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    assert grants(env) == []


def test_decide_approvals_rejects_names_spanning_two_runs_or_another_user(env):
    set_tools(env, ("read", False, "Read"))
    first = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(first)
    a = current(env, first)[0].name
    env.frappe.seed("Intelligence Conversation", "other", owner="alice", provider="provider", message_count=0)
    second = env.engine.submit_message("other", "Hi")["name"]
    env.frappe.db.commit()
    env.replies.append(reply(("read", {})))
    env.engine.process_run(second)
    b = current(env, second)[0].name
    with pytest.raises(ValueError):
        env.engine.decide_approvals([a, b], "approve")
    env.frappe.session.user = "bob"
    with pytest.raises(PermissionError):
        env.engine.decide_approvals([a], "approve")
    env.frappe.session.user = "alice"
    assert all(row.status == "pending" for row in approvals(env))


def test_decide_approvals_always_writes_a_grant_per_tool(env):
    set_tools(env, ("read", False, "Read"), ("write", True, "Update"))
    name = submit(env)
    env.replies.append(reply(("read", {"a": 1}), ("write", {"v": 2}), ("read", {"a": 3})))
    env.engine.process_run(name)
    names = [row.name for row in approvals(env)]
    assert len(names) == 3
    result = env.engine.decide_approvals(names, "always")
    env.frappe.db.commit()
    assert [outcome["status"] for outcome in result["outcomes"]] == ["approved"] * 3
    rows = grants(env)
    assert len(rows) == 2, "three approvals across two tools grant each tool once"
    assert {row.tool for row in rows} == {"read", "write"}
    assert all((row.scope or "Always") == "Always" and not row.conversation for row in rows)
    finish(env, name)
    assert len(env.executions) == 3


def test_decide_approvals_bulk_denies_without_executing(env):
    set_tools(env, ("read", False, "Read"))
    name = submit(env)
    env.replies.append(reply(("read", {"a": 1}), ("read", {"a": 2})))
    env.engine.process_run(name)
    names = [row.name for row in approvals(env)]
    result = env.engine.decide_approvals(names, "deny")
    env.frappe.db.commit()
    assert [outcome["status"] for outcome in result["outcomes"]] == ["denied", "denied"]
    env.replies.append(reply(text="Understood."))
    for _ in range(6):
        env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert not env.executions
    messages = env.frappe.get_all("Intelligence Message")
    denied = [row for row in messages if row.role == "tool" and "denied" in row.content.lower()]
    assert len(denied) == 2


def test_realtime_events_cover_the_run_lifecycle(env):
    set_tools(env, ("read", False, "Read"))
    name = submit(env)
    kinds = [event[1]["kind"] for event in env.frappe.run_events()]
    assert "queued" in kinds and "message" in kinds
    env.replies.append(reply(("read", {}), text="Looking."))
    env.engine.process_run(name)
    kinds = [event[1]["kind"] for event in env.frappe.run_events()]
    assert "started" in kinds and "approval" in kinds
    approval = approvals(env)[0]
    proposed = env.frappe.run_events("approval")
    assert proposed[-1][1]["approval"] == approval.name and proposed[-1][1]["tool"] == "read"
    env.engine.decide_approval(approval.name, "approve")
    env.frappe.db.commit()
    decisions = env.frappe.run_events("decision")
    assert decisions[-1][1]["decision"] == "approved" and decisions[-1][1]["approval"] == approval.name
    env.replies.append(reply(text="Done."))
    env.engine.process_run(name)  # executes the approved call
    env.engine.process_run(name)  # provider turn completes the run
    assert env.engine.get_run(name)["state"] == "completed"
    kinds = [event[1]["kind"] for event in env.frappe.run_events()]
    assert "step" in kinds and "done" in kinds
    for _, message, kwargs in env.frappe.run_events():
        assert message["conversation"] == "conversation" and message["run"] == name
        assert kwargs["user"] == "alice"


def test_realtime_error_kind_on_run_failure(env):
    name = submit(env)
    env.frappe.get_doc("Intelligence Run", name).active_seconds = 601
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    errors = env.frappe.run_events("error")
    assert errors and errors[-1][1]["state"] == "failed"
    assert errors[-1][1]["conversation"] == "conversation" and errors[-1][1]["run"] == name
    assert errors[-1][2]["user"] == "alice"


def test_a_broken_run_event_transport_never_breaks_a_run(env, monkeypatch):
    original = env.frappe.publish_realtime

    def flaky(*args, **kwargs):
        if (kwargs.get("event") or (args and args[0])) == "intelligence_run_event":
            raise RuntimeError("socketio down")
        return original(*args, **kwargs)

    monkeypatch.setattr(env.frappe, "publish_realtime", flaky)
    name = submit(env)
    env.replies.append(reply(text="Hi"))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed", (
        "realtime only accelerates the UI; polling stays the correctness floor"
    )


def test_a_zero_policy_site_behaves_exactly_as_the_mode_fallback(env):
    assert not env.frappe.get_all("Intelligence Policy")
    set_tools(env, ("read", False, "Read"), ("write", True, "Update"))
    env.frappe.settings.approval_mode = "Approve Writes Only"
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"}), ("write", {"value": 1})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env)}
    assert by_call["call-0"].status == "approved"
    assert not by_call["call-0"].decided_by and not by_call["call-0"].get("source")
    assert by_call["call-1"].status == "pending"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    finish(env, name)


def test_priority_zero_is_a_real_rank_not_the_default(env):
    """A stored priority of 0 must lose to any higher row; `or 100` re-ranked it."""
    set_tools(env, ("write", True, "Update"))
    seed_policy(env, "a-zero", priority=0, tool="write", decision="Deny", reason="backstop")
    seed_policy(env, "z-hundred", priority=100, tool="write", decision="Auto-approve")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "policy:z-hundred", (
        "priority 100 beats a deliberate priority-0 backstop"
    )
    finish(env, name)


def test_priority_zero_never_outranks_a_stronger_deny(env):
    """The fail-open direction of the same bug: a 0-priority Auto-approve vs a 50-Deny."""
    set_tools(env, ("write", True, "Update"))
    seed_policy(env, "p-auto-weak", priority=0, tool="write", decision="Auto-approve")
    seed_policy(env, "p-deny-50", priority=50, tool="write", decision="Deny", reason="deny at 50")
    name = submit(env)
    env.replies.append(reply(("write", {"value": 1}), text="Trying."))
    env.engine.process_run(name)
    assert not approvals(env), "the priority-50 Deny decides; the weak auto-approve never fires"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "deny at 50" in row.content for row in messages)
    finish(env, name)
    assert not env.executions


def test_threshold_policies_compare_amounts_by_magnitude(env):
    """A negative total is the size of its absolute value, in both directions."""
    set_tools(env, ("write", True, "Create"))
    seed_policy(
        env, "p-small", amount_condition="At or below limit", amount_limit=1000, decision="Auto-approve"
    )
    seed_policy(
        env, "p-big", amount_condition="Above limit", amount_limit=1000, decision="Deny", reason="too large"
    )

    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "grand_total": -10_000_000})))
    env.engine.process_run(name)
    assert not current(env, name), "a ten-million credit note is not an at-or-below-1000 write"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "too large" in row.content for row in messages), (
        "the Above-limit Deny row fires for a large negative amount"
    )
    finish(env, name)
    assert not env.executions

    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "grand_total": -50})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "approved" and approval.source == "policy:p-small", (
        "a small credit note stays within the small-write limit"
    )
    finish(env, name)


def test_extract_amount_never_lets_a_zero_stub_shadow_a_real_total(env):
    engine = env.engine
    assert engine.extract_amount("X", {"grand_total": 0, "total": 99999}) == 99999.0
    assert engine.extract_amount("X", {"grand_total": 0, "tax_amount": 250}) == 250.0
    assert engine.extract_amount("X", {"grand_total": 0, "total": -400}) == -400.0
    assert engine.extract_amount("X", {"grand_total": 0}) == 0.0, "a genuine zero still reads as zero"
    assert engine.extract_amount("X", {"grand_total": 0, "note": "nothing numeric"}) == 0.0
    assert engine.extract_amount("X", {"note": "nothing numeric"}) is None


def test_a_zero_stub_amount_still_fails_closed_on_threshold_rows(env):
    set_tools(env, ("write", True, "Create"))
    seed_policy(
        env, "p-small", amount_condition="At or below limit", amount_limit=1000, decision="Auto-approve"
    )
    name = submit(env)
    env.replies.append(reply(("write", {"doctype": "Purchase Invoice", "grand_total": 0, "total": 99999})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending" and not approval.get("source"), (
        "the five-figure total behind the zero stub decides, not the stub"
    )
    finish(env, name)


def test_a_deny_policy_overrides_the_memory_exemption(env):
    """save_memory is exempt BY DEFAULT; an explicit Deny row still fires."""
    set_tools(env, ("save_memory", True, "Create"))
    seed_policy(env, "p-deny-memory", tool="save_memory", decision="Deny", reason="memory writes denied")
    name = submit(env)
    env.replies.append(reply(("save_memory", {"content": "Prefers INR."}), text="Noting."))
    env.engine.process_run(name)
    assert not approvals(env), "a policy denial never offers an approval, even for exempt tools"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(
        row.role == "tool" and row.tool_call_id == "call-0" and "memory writes denied" in row.content
        for row in messages
    )
    assert env.engine.get_run(name)["state"] == "queued"
    finish(env, name)
    assert not env.executions


def test_a_require_approval_policy_overrides_the_memory_exemption(env):
    set_tools(env, ("save_memory", True, "Create"))
    seed_policy(env, "p-ask-memory", tool="save_memory", decision="Require approval", reason="ask first")
    name = submit(env)
    env.replies.append(reply(("save_memory", {"content": "Prefers INR."})))
    env.engine.process_run(name)
    approval = current(env, name)[0]
    assert approval.status == "pending", "a manager's policy can force a checkpoint on memory writes"
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    finish(env, name)
    assert len(env.executions) == 1


def test_a_deny_policy_overrides_the_own_file_read_exemption(env):
    toolmod = set_tools(env, ("read_attachment", False, "Read"))
    toolmod.prepare = lambda context, tool, args: {
        "tool": tool,
        "arguments": args,
        "target": {"doctype": "File", "name": args["file"], "conversation": "conversation"},
    }
    seed_policy(env, "p-deny-files", tool="read_attachment", decision="Deny", reason="no file reads")
    name = submit(env)
    env.replies.append(reply(("read_attachment", {"file": "F-1"})))
    env.engine.process_run(name)
    assert not approvals(env)
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "no file reads" in row.content for row in messages)
    finish(env, name)
    assert not env.executions


POLICY_CONTROLLER = "frappe_intelligence.frappe_intelligence.doctype.intelligence_policy.intelligence_policy"
GRANT_CONTROLLER = (
    "frappe_intelligence.frappe_intelligence.doctype.intelligence_tool_grant.intelligence_tool_grant"
)


@pytest.fixture
def policies(services, monkeypatch):
    fake, store = services
    fake.get_roles = lambda user=None: ["Intelligence Manager"]
    document_module = ModuleType("frappe.model.document")
    document_module.Document = Row
    monkeypatch.setitem(sys.modules, "frappe.model.document", document_module)
    tools = ModuleType("frappe_intelligence.tools")
    tools.registered_tool_names = lambda user: {"search_records", "create_document", "retire_skill"}
    monkeypatch.setitem(sys.modules, "frappe_intelligence.tools", tools)
    monkeypatch.delitem(sys.modules, POLICY_CONTROLLER, raising=False)
    module = importlib.import_module(POLICY_CONTROLLER)
    yield module, fake, store
    sys.modules.pop(POLICY_CONTROLLER, None)


def make_policy(module, **overrides):
    data = {
        "doctype": "Intelligence Policy",
        "enabled": 1,
        "priority": 100,
        "tool": "search_records",
        "operation": "Any",
        "amount_condition": "Any amount",
        "decision": "Require approval",
        "reason": "",
    }
    data.update(overrides)
    return module.IntelligencePolicy(data)


def test_only_managers_can_save_a_policy(policies):
    module, fake, _ = policies
    make_policy(module).validate()
    fake.get_roles = lambda user=None: ["Intelligence User"]
    with pytest.raises(PermissionError):
        make_policy(module).validate()


def test_policy_tools_must_be_reviewed_registry_names(policies):
    module, _, _ = policies
    make_policy(module, tool="create_document").validate()
    make_policy(module, tool="").validate(), "a blank tool covers every tool"
    with pytest.raises(ValueError, match="reviewed"):
        make_policy(module, tool="unknown_tool").validate()
    with pytest.raises(ValueError, match="tool name"):
        make_policy(module, tool="Bad Tool!").validate()


def test_amount_limits_are_required_by_condition_and_cleared_otherwise(policies):
    module, _, _ = policies
    policy = make_policy(module, amount_condition="At or below limit", amount_limit="2500.5")
    policy.validate()
    assert policy.amount_limit == 2500.5
    with pytest.raises(ValueError, match="amount limit"):
        make_policy(module, amount_condition="Above limit").validate()
    policy = make_policy(module, amount_condition="Any amount", amount_limit=100)
    policy.validate()
    assert policy.amount_limit is None, "an unconditional row never carries a stale limit"


def test_policy_enums_priority_and_enabled_are_validated(policies):
    module, _, _ = policies
    with pytest.raises(ValueError, match="operation"):
        make_policy(module, operation="Execute").validate()
    with pytest.raises(ValueError, match="decision"):
        make_policy(module, decision="").validate()
    with pytest.raises(ValueError, match="amount condition"):
        make_policy(module, amount_condition="Sometimes").validate()
    with pytest.raises(ValueError, match="integer"):
        make_policy(module, priority="high").validate()
    policy = make_policy(module, enabled="1", priority="50", reason="  ok  ")
    policy.validate()
    assert policy.enabled == 1 and policy.priority == 50 and policy.reason == "ok"
    policy = make_policy(module, enabled="0")
    policy.validate()
    assert policy.enabled == 0


def test_policy_reasons_are_capped(policies):
    module, _, _ = policies
    with pytest.raises(ValueError, match="500"):
        make_policy(module, reason="x" * 501).validate()


@pytest.fixture
def grant_rules(services, monkeypatch):
    fake, store = services
    document_module = ModuleType("frappe.model.document")
    document_module.Document = Row
    monkeypatch.setitem(sys.modules, "frappe.model.document", document_module)
    monkeypatch.delitem(sys.modules, GRANT_CONTROLLER, raising=False)
    module = importlib.import_module(GRANT_CONTROLLER)
    yield module, fake, store
    sys.modules.pop(GRANT_CONTROLLER, None)


def make_grant(module, **overrides):
    data = {
        "doctype": "Intelligence Tool Grant",
        "user": "owner@example.test",
        "tool": "search_records",
        "scope_doctype": "",
    }
    data.update(overrides)
    return module.IntelligenceToolGrant(data)


def test_a_scoped_grant_requires_a_real_conversation(grant_rules):
    module, fake, _ = grant_rules
    with pytest.raises(ValueError, match="scope"):
        make_grant(module, scope="Sometimes").validate()
    with pytest.raises(ValueError, match="conversation"):
        make_grant(module, scope="This Conversation").validate()
    grant = make_grant(module, scope="This Conversation", conversation=" C-1 ")
    with pytest.raises(ValueError, match="does not exist"):
        grant.validate()
    fake.db.exists = lambda doctype, name: doctype == "Intelligence Conversation" and name == "C-1"
    grant.validate()
    assert grant.scope == "This Conversation" and grant.conversation == "C-1"


def test_an_always_grant_never_keeps_a_conversation(grant_rules):
    module, _, _ = grant_rules
    grant = make_grant(module, conversation="C-1")
    grant.validate()
    assert grant.scope == "Always", "a missing scope defaults to Always"
    assert grant.conversation is None, "an Always grant is never bound to one conversation"


def test_legacy_rows_without_a_scope_read_as_always(grant_rules):
    module, fake, store = grant_rules
    store["g1"] = Row(
        doctype="Intelligence Tool Grant",
        name="g1",
        user="owner@example.test",
        tool="search_records",
        scope_doctype="",
    )
    with pytest.raises(ValueError, match="already always allowed"):
        make_grant(module).validate()
    fake.db.exists = lambda doctype, name: doctype == "Intelligence Conversation" and name == "C-1"
    make_grant(module, scope="This Conversation", conversation="C-1").validate()


EXPECTED_POLICIES = {
    "example-read-auto-approve": ("Read", "Auto-approve"),
    "example-delete-require-approval": ("Delete", "Require approval"),
}


def policies_in(store):
    return {name: doc for (doctype, name), doc in store.items() if doctype == "Intelligence Policy"}


def test_after_migrate_seeds_two_disabled_example_policies_idempotently(migrator):
    module, _, store = migrator
    module.after_migrate()
    module.after_migrate()
    seeded = policies_in(store)
    assert set(seeded) == set(EXPECTED_POLICIES)
    for name, (operation, decision) in EXPECTED_POLICIES.items():
        doc = seeded[name]
        assert doc.enabled == 0, "seeded examples stay disabled until a manager opts in"
        assert doc.operation == operation and doc.decision == decision
        assert doc.amount_condition == "Any amount"


def test_seeded_policies_are_never_reverted_or_enabled_by_migrate(migrator):
    module, _, store = migrator
    module.after_migrate()
    doc = store[("Intelligence Policy", "example-read-auto-approve")]
    doc.enabled = 1
    doc.reason = "customized by the site"
    module.after_migrate()
    kept = store[("Intelligence Policy", "example-read-auto-approve")]
    assert kept.enabled == 1 and kept.reason == "customized by the site"
    assert len(policies_in(store)) == 2, "no duplicates and no resets across migrates"
