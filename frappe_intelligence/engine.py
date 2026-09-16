"""Durable, approval-gated execution. Queue delivery is at-least-once, effects are not.

Every state transition locks the conversation and then its run. Workers carry a
fencing token: a late HTTP result cannot overwrite cancellation/recovery. Local
business effects and their receipt commit together; external calls first commit
a started receipt and cannot be automatically retried after an uncertain result.

Only the API facade is whitelisted. In particular process_run, append_message,
and get_provider_config must NEVER be exposed as RPC endpoints.
"""

import hashlib
import hmac
import json
import uuid
from contextlib import contextmanager
from dataclasses import asdict, is_dataclass
from datetime import datetime, timedelta

import frappe

from frappe_intelligence.access import (
    can_use_provider,
    get_conversation,
    get_settings,
    internal_write,
    provider_secret_access,
    require_user,
)

RUN = "Intelligence Run"
CONVERSATION = "Intelligence Conversation"
MESSAGE = "Intelligence Message"
APPROVAL = "Intelligence Approval"
EXECUTION = "Intelligence Tool Execution"
TERMINAL = frozenset({"completed", "failed", "cancelled", "needs_reconciliation"})
ACTIVE = ("queued", "running", "awaiting_approval")
MAX_CALLS_PER_TURN = 8
MAX_MESSAGE_CHARS = 30000
MAX_HISTORY_CHARS = 250000
MAX_RESULT_CHARS = 60000


class LostLease(Exception):
    """Expected when another worker or cancellation has superseded this worker."""


def _now():
    # Frappe stores naive datetimes in the site's timezone.
    try:
        from frappe.utils import now_datetime
    except ImportError:  # isolated boundary tests
        return datetime.now()
    return now_datetime()


def _date(value):
    return datetime.fromisoformat(value) if isinstance(value, str) else value


def _json(value, limit=MAX_HISTORY_CHARS):
    value = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if len(value) > limit:
        frappe.throw("Intelligence data exceeds the permitted size.", frappe.ValidationError)
    return value


def _parse(value, default):
    return json.loads(value) if value else default


def _number(value, default, low, high):
    try:
        return max(low, min(high, int(value if value is not None else default)))
    except (ValueError, TypeError):
        frappe.throw("Invalid Intelligence limit configuration.", frappe.ValidationError)


def _lock(doctype, name):
    # Only constants from this module are accepted; values are always bound.
    if doctype not in {RUN, CONVERSATION, APPROVAL, EXECUTION, "User"}:
        raise ValueError("Unsupported lock target")
    if not frappe.db.sql(f"SELECT name FROM `tab{doctype}` WHERE name=%s FOR UPDATE", (name,)):
        frappe.throw("Intelligence resource not found.", frappe.DoesNotExistError)


def _locked_run(name):
    conversation = frappe.db.get_value(RUN, name, "conversation")
    if not conversation:
        frappe.throw("Intelligence run not found.", frappe.DoesNotExistError)
    _lock(CONVERSATION, conversation)
    _lock(RUN, name)
    return frappe.get_doc(RUN, name, for_update=True)


def _save(doc, **values):
    with internal_write():
        doc.update(values)
        doc.save()
    return doc


def _insert(doctype, **values):
    with internal_write():
        return frappe.get_doc(dict(doctype=doctype, **values)).insert()


def _event(run):
    frappe.publish_realtime(
        "intelligence_update",
        {
            "conversation": run.conversation,
            "run": run.name,
            "state": run.state,
        },
        user=run.user,
        after_commit=True,
    )


def _enqueue(run):
    # No job deduplication by run id: a resume may enqueue before the old job has
    # exited. Database leases, not Redis delivery/deduplication, are authoritative.
    frappe.enqueue(
        "frappe_intelligence.engine.process_run",
        run_name=run.name,
        queue="long",
        timeout=900,
        enqueue_after_commit=True,
    )


def _public(run):
    fields = (
        "name",
        "conversation",
        "state",
        "error",
        "step_count",
        "cancel_requested",
        "started_at",
        "finished_at",
        "input_tokens",
        "output_tokens",
    )
    return {field: run.get(field) for field in fields}


def _owned(run):
    user = require_user()
    if run.user != user or run.site != frappe.local.site:
        frappe.throw("Not permitted to access this run.", frappe.PermissionError)
    conversation = get_conversation(run.conversation)
    if conversation.provider != run.provider:
        frappe.throw("The run provider binding has changed.", frappe.ValidationError)
    return conversation


def _assert_active(run):
    # Execution-only invariant. Terminal runs remain owner-readable for history.
    active = frappe.db.get_value(CONVERSATION, run.conversation, "active_run", for_update=True)
    if active != run.name:
        frappe.throw("This run is no longer the conversation's active run.", frappe.ValidationError)


def get_run(run_name):
    run = frappe.get_doc(RUN, run_name)
    _owned(run)
    run.check_permission("read")
    return _public(run)


def get_provider_config(provider_name, user=None):
    """Server-only key load, reauthorized for the CURRENT user on every call."""
    from frappe_intelligence.providers import ProviderConfig

    current_user = require_user()
    if user is not None and user != current_user:
        frappe.throw("Provider credentials cannot be loaded for another user.", frappe.PermissionError)
    doc = frappe.get_doc("Intelligence Provider", provider_name, for_update=True)
    if not can_use_provider(doc, current_user):
        frappe.throw("This provider is unavailable to your account.", frappe.PermissionError)
    settings = get_settings()
    if not settings.enabled:
        frappe.throw("Frappe Intelligence is disabled.", frappe.ValidationError)
    with provider_secret_access(provider_name, current_user):
        key = doc.get_password("api_key")
    if not key:
        frappe.throw("This provider has no API key configured.", frappe.ValidationError)
    allowed = tuple(
        host.strip() for host in (settings.allowed_custom_hosts or "").splitlines() if host.strip()
    )
    return ProviderConfig(
        kind=doc.kind,
        model=doc.model,
        api_key=key,
        base_url=doc.base_url or "",
        max_tokens=min(_number(doc.max_tokens, 4096, 1, 32768), _number(settings.max_tokens, 4096, 1, 32768)),
        timeout=_number(doc.timeout, 60, 5, 120),
        allowed_hosts=allowed,
    )


def append_message(conversation, role, content, **values):
    """Server-only canonical append; sequence allocation is conversation-locked."""
    allowed = {"run", "tool_calls", "tool_call_id", "status"}
    if set(values) - allowed or role not in {"user", "assistant", "tool"}:
        frappe.throw("Invalid message fields.", frappe.ValidationError)
    if not isinstance(content, str) or len(content) > MAX_RESULT_CHARS:
        frappe.throw("Invalid message content.", frappe.ValidationError)
    _lock(CONVERSATION, conversation)
    doc = get_conversation(conversation, write=True)
    if values.get("run"):
        run = frappe.get_doc(RUN, values["run"])
        if run.conversation != conversation or run.user != frappe.session.user:
            frappe.throw("Invalid message run binding.", frappe.PermissionError)
    if isinstance(values.get("tool_calls"), list):
        values["tool_calls"] = _json(values["tool_calls"])
    sequence = int(doc.message_count or 0) + 1
    result = _insert(
        MESSAGE,
        conversation=conversation,
        role=role,
        content=content,
        sequence=sequence,
        **dict({"status": "complete"}, **values),
    )
    _save(doc, message_count=sequence)
    return result


def _validate_context(context):
    if context is None or context == {}:
        return {}
    if not isinstance(context, dict) or set(context) - {"doctype", "name"}:
        frappe.throw("Context accepts only doctype and name.", frappe.ValidationError)
    if not context.get("doctype") or any(
        not isinstance(value, str) or len(value) > 140 for value in context.values()
    ):
        frappe.throw("Invalid Desk context.", frappe.ValidationError)
    if context.get("name"):
        frappe.get_doc(context["doctype"], context["name"]).check_permission("read")
    elif not frappe.has_permission(context["doctype"], "read", user=frappe.session.user):
        frappe.throw("Not permitted to access this context.", frappe.PermissionError)
    return context


def _validate_attachments(conversation, attachments):
    if attachments is None:
        return []
    if not isinstance(attachments, list) or len(attachments) > 10:
        frappe.throw("At most ten private attachments are allowed.", frappe.ValidationError)
    for name in attachments:
        if not isinstance(name, str) or len(name) > 140:
            frappe.throw("Invalid attachment reference.", frappe.ValidationError)
        doc = frappe.get_doc("File", name)
        doc.check_permission("read")
        if (
            not doc.is_private
            or doc.attached_to_doctype != CONVERSATION
            or doc.attached_to_name != conversation
            or doc.owner != frappe.session.user
        ):
            frappe.throw("Attachment does not belong to this conversation.", frappe.PermissionError)
    return list(dict.fromkeys(attachments))


def submit_message(conversation, content, context=None, attachments=None):
    user = require_user()
    settings = get_settings()
    if not settings.enabled:
        frappe.throw("Frappe Intelligence is disabled.", frappe.ValidationError)
    if not isinstance(content, str) or not content.strip() or len(content) > MAX_MESSAGE_CHARS:
        frappe.throw("Enter a message of at most 30000 characters.", frappe.ValidationError)
    # Serializes daily quota consumption across ALL conversations of this user.
    _lock("User", user)
    _lock(CONVERSATION, conversation)
    doc = get_conversation(conversation, write=True)
    if doc.archived:
        frappe.throw("Unarchive this conversation before sending a message.", frappe.ValidationError)
    # require_user/get_settings may already have established a REPEATABLE READ
    # snapshot before we waited for the mutex. Every admission read must therefore
    # be a current (locking) read, not only the User/Conversation locks themselves.
    active_state = (
        frappe.db.get_value(RUN, doc.active_run, "state", for_update=True) if doc.active_run else None
    )
    if active_state in ACTIVE:
        frappe.throw("This conversation already has an active run.", frappe.ValidationError)
    if active_state == "needs_reconciliation":
        frappe.throw("Reconcile the previous uncertain action before continuing.", frappe.ValidationError)
    today = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    quota = _number(settings.daily_run_limit, 100, 1, 10000)
    consumed = frappe.db.sql(
        "SELECT name FROM `tabIntelligence Run` WHERE `user`=%s AND creation >= %s "
        "ORDER BY creation, name LIMIT %s FOR UPDATE",
        (user, today, quota),
    )
    if len(consumed) >= quota:
        frappe.throw("Your daily Intelligence run limit has been reached.", frappe.ValidationError)
    get_provider_config(doc.provider)
    context = _validate_context(context)
    attachments = _validate_attachments(conversation, attachments)
    run = _insert(
        RUN,
        conversation=conversation,
        provider=doc.provider,
        user=user,
        site=frappe.local.site,
        state="queued",
        step_count=0,
        cancel_requested=0,
        input_tokens=0,
        output_tokens=0,
        context_json=_json(context),
        attachments_json=_json(attachments),
    )
    # Only caller-selected context identifiers, never record contents, are disclosed.
    canonical = content.strip()
    if context:
        canonical += "\n\nUser-selected Desk context (identifiers only): " + _json(context)
    if attachments:
        canonical += "\n\nPrivate attachment references (content requires approved tools): " + _json(
            attachments
        )
    append_message(conversation, "user", canonical, run=run.name)
    _save(frappe.get_doc(CONVERSATION, conversation, for_update=True), active_run=run.name)
    _enqueue(run)
    _event(run)
    return _public(run)


def _active_seconds(run):
    elapsed = float(run.get("active_seconds") or 0)
    if run.state == "running" and run.heartbeat_at:
        end = min(_now(), _date(run.lease_expires)) if run.lease_expires else _now()
        elapsed += max(0.0, (end - _date(run.heartbeat_at)).total_seconds())
    return elapsed


def _finish(run, state, error=""):
    _save(
        run,
        active_seconds=_active_seconds(run),
        state=state,
        error=error,
        finished_at=_now(),
        lease_token=None,
        lease_expires=None,
        heartbeat_at=_now(),
    )
    conversation = frappe.get_doc(CONVERSATION, run.conversation, for_update=True)
    # An uncertain effect blocks further runs until a deliberate reconciliation.
    if conversation.active_run == run.name and state != "needs_reconciliation":
        _save(conversation, active_run=None)
    _event(run)


def _release(run, state="queued"):
    _save(
        run,
        active_seconds=_active_seconds(run),
        state=state,
        lease_token=None,
        lease_expires=None,
        heartbeat_at=_now(),
    )
    _event(run)
    if state == "queued":
        _enqueue(run)


def _fence(run, token):
    if (
        run.state != "running"
        or run.lease_token != token
        or not run.lease_expires
        or _date(run.lease_expires) <= _now()
    ):
        raise LostLease()
    if run.cancel_requested:
        raise LostLease()
    _owned(run)
    _assert_active(run)


def _budget(run, settings, provider_step=False):
    if not settings.enabled:
        return "Frappe Intelligence was disabled."
    if provider_step and int(run.step_count or 0) >= _number(settings.max_steps, 12, 1, 50):
        return "The maximum number of model steps was reached."
    if _active_seconds(run) >= _number(settings.max_run_seconds, 600, 30, 3600):
        return "The run time limit was reached. Start a new run if needed."
    return ""


def _tool_context(run):
    from frappe_intelligence.tools import ToolContext

    return ToolContext(site=run.site, user=run.user, conversation=run.conversation, run=run.name)


def _digest(run, approval):
    payload = {
        "site": run.site,
        "user": run.user,
        "conversation": run.conversation,
        "run": run.name,
        "tool": approval.tool_name,
        "version": approval.tool_version,
        "call": approval.tool_call_id,
        "arguments": _parse(approval.arguments_json, {}),
        "preview": _parse(approval.preview_json, {}),
    }
    return hashlib.sha256(_json(payload).encode()).hexdigest()


def _verify_approval(run, approval):
    if (
        approval.run != run.name
        or approval.conversation != run.conversation
        or not hmac.compare_digest(approval.digest or "", _digest(run, approval))
    ):
        frappe.throw("The tool proposal changed. It cannot be approved or executed.", frappe.ValidationError)


def _children(doctype, run):
    if doctype not in {APPROVAL, EXECUTION}:
        raise ValueError("Unsupported child records")
    # Locking reads see the latest committed state even on REPEATABLE READ sites.
    # The run lock serializes inserts, including empty child sets.
    rows = frappe.db.sql(
        f"SELECT name FROM `tab{doctype}` WHERE run=%s ORDER BY creation, name FOR UPDATE",
        (run.name,),
        as_dict=True,
    )
    return [frappe.get_doc(doctype, row.name, for_update=True) for row in rows]


def _approval_rows(run, statuses=None):
    return [doc for doc in _children(APPROVAL, run) if not statuses or doc.status in statuses]


def _receipt(run, approval):
    return next((doc for doc in _children(EXECUTION, run) if doc.approval == approval), None)


def _started_receipts(run):
    return [doc for doc in _children(EXECUTION, run) if doc.state == "started"]


def decide_approval(approval_name, decision):
    require_user()
    if decision not in {"approve", "deny"}:
        frappe.throw("Decision must be approve or deny.", frappe.ValidationError)
    run_name = frappe.db.get_value(APPROVAL, approval_name, "run")
    run = _locked_run(run_name)
    _owned(run)
    _lock(APPROVAL, approval_name)
    approval = frappe.get_doc(APPROVAL, approval_name, for_update=True)
    approval.check_permission("write")
    _verify_approval(run, approval)
    wanted = "approved" if decision == "approve" else "denied"
    if approval.status != "pending":
        accepted = (
            {"approved", "executing", "succeeded", "failed", "uncertain"}
            if decision == "approve"
            else {"denied"}
        )
        if approval.status not in accepted and approval.status != "expired":
            frappe.throw("This proposal already has a different decision.", frappe.ValidationError)
        return _public(run)
    if run.state in TERMINAL or run.cancel_requested:
        frappe.throw("This run is no longer accepting approvals.", frappe.ValidationError)
    if _date(approval.expires_at) <= _now():
        wanted = "expired"
    _save(approval, status=wanted, decided_by=frappe.session.user, decided_at=_now())
    if not _approval_rows(run, ("pending",)):
        _release(run)
    else:
        _event(run)
    return _public(run)


def _mark_uncertain(run, error):
    for receipt in _started_receipts(run):
        _save(receipt, state="uncertain", error=error, finished_at=_now())
        _save(frappe.get_doc(APPROVAL, receipt.approval), status="uncertain")
    _finish(run, "needs_reconciliation", error)


def cancel_run(run_name):
    run = _locked_run(run_name)
    _owned(run)
    if run.state in TERMINAL:
        return _public(run)
    _save(run, cancel_requested=1)
    for row in _approval_rows(run, ("pending", "approved")):
        _save(frappe.get_doc(APPROVAL, row.name), status="denied", decided_by=run.user, decided_at=_now())
    if _started_receipts(run):
        _mark_uncertain(run, "Cancellation overlapped an external action. Check its outcome before retrying.")
    else:
        _finish(run, "cancelled")
    return _public(run)


def _history(run):
    rows = frappe.get_all(
        MESSAGE,
        filters={"conversation": run.conversation},
        fields=["role", "content", "tool_calls", "tool_call_id", "run", "sequence"],
        order_by="sequence asc",
        limit_page_length=2001,
    )
    if len(rows) > 2000:
        frappe.throw("This conversation is too long. Start a new conversation.", frappe.ValidationError)
    completed = {
        row.name
        for row in frappe.get_all(
            RUN,
            filters={"conversation": run.conversation, "state": "completed"},
            fields=["name"],
            limit_page_length=2000,
        )
    }
    messages = []
    for row in rows:
        # Incomplete/failed historical runs may contain unmatched tool calls.
        # Keep their durable audit records, but do not send invalid partial turns.
        if row.run and row.run != run.name and row.run not in completed:
            continue
        message = {"role": row.role, "content": row.content or ""}
        if row.tool_calls:
            message["tool_calls"] = _parse(row.tool_calls, [])
        if row.tool_call_id:
            message["tool_call_id"] = row.tool_call_id
        messages.append(message)
    _json(messages, MAX_HISTORY_CHARS)  # fail explicitly, never silently truncate
    return messages


def _normal_calls(reply):
    calls = []
    seen = set()
    if len(reply.tool_calls) > MAX_CALLS_PER_TURN:
        frappe.throw("The model proposed too many tools in one step.", frappe.ValidationError)
    for call in reply.tool_calls:
        value = asdict(call) if is_dataclass(call) else dict(call)
        if (
            not isinstance(value.get("id"), str)
            or not value["id"]
            or len(value["id"]) > 140
            or value["id"] in seen
            or not isinstance(value.get("name"), str)
            or not isinstance(value.get("arguments"), dict)
        ):
            frappe.throw("The model returned an invalid tool proposal.", frappe.ValidationError)
        seen.add(value["id"])
        calls.append({key: value[key] for key in ("id", "name", "arguments", "metadata") if key in value})
    _json(calls, MAX_RESULT_CHARS)
    return calls


def _provider_turn(run_name, token):
    from frappe_intelligence.providers import complete
    from frappe_intelligence.tools import get_tools, prepare, schemas

    run = _locked_run(run_name)
    _fence(run, token)
    config = get_provider_config(run.provider)
    history = _history(run)
    context = _tool_context(run)
    tool_schemas = schemas(context)
    _save(run, step_count=int(run.step_count or 0) + 1)
    frappe.db.commit()  # no write OR read transaction is held across network I/O
    reply = complete(config, history, tool_schemas)
    run = _locked_run(run_name)
    _fence(run, token)
    # Reauthorize after HTTP; roles/provider ownership may have changed meanwhile.
    get_provider_config(run.provider)
    error = _budget(run, get_settings())
    if error:
        _finish(run, "failed", error)
        frappe.db.commit()
        return
    calls = _normal_calls(reply)
    available = get_tools(context)
    proposals = []
    for call in calls:
        if call["name"] not in available:
            frappe.throw("The model proposed an unavailable tool.", frappe.ValidationError)
        spec = available[call["name"]]
        preview = prepare(context, call["name"], call["arguments"])
        proposals.append((call, spec, preview))
    append_message(run.conversation, "assistant", reply.text or "", run=run.name, tool_calls=calls or None)
    usage = reply.usage or {}
    _save(
        run,
        input_tokens=int(run.input_tokens or 0) + _number(usage.get("input_tokens"), 0, 0, 10000000),
        output_tokens=int(run.output_tokens or 0) + _number(usage.get("output_tokens"), 0, 0, 10000000),
    )
    expires = _now() + timedelta(minutes=_number(get_settings().approval_expiry_minutes, 1440, 1, 10080))
    for call, spec, preview in proposals:
        proposal = frappe._dict(
            conversation=run.conversation,
            run=run.name,
            tool_name=call["name"],
            tool_version=spec.version,
            tool_call_id=call["id"],
            arguments_json=_json(call["arguments"]),
            preview_json=_json(preview),
            status="pending",
            expires_at=expires,
        )
        _insert(APPROVAL, **proposal, digest=_digest(run, proposal))
    if calls:
        _release(run, "awaiting_approval")
    else:
        _finish(run, "completed")
    frappe.db.commit()


def _tool_result(run, approval, result):
    append_message(
        run.conversation,
        "tool",
        _json(result, MAX_RESULT_CHARS),
        run=run.name,
        tool_call_id=approval.tool_call_id,
    )


@contextmanager
def _unprivileged_tool():
    previous = frappe.flags.get("intelligence_internal")
    frappe.flags.intelligence_internal = False
    try:
        yield
    finally:
        frappe.flags.intelligence_internal = previous


def _execute_approval(run_name, token, approval_name):
    from frappe_intelligence.tools import execute, get_tools, prepare

    run = _locked_run(run_name)
    _fence(run, token)
    approval = frappe.get_doc(APPROVAL, approval_name, for_update=True)
    _verify_approval(run, approval)
    receipt = _receipt(run, approval.name)
    if receipt:
        if receipt.state in {"started", "uncertain"}:
            _mark_uncertain(run, "An external action has an unknown outcome. Reconciliation is required.")
            return
        return  # atomic receipt + result message already persisted
    if approval.status in {"denied", "expired"}:
        receipt = _insert(
            EXECUTION,
            conversation=run.conversation,
            run=run.name,
            approval=approval.name,
            tool_name=approval.tool_name,
            state="failed",
            started_at=_now(),
            finished_at=_now(),
            error=f"Tool {approval.status} by the user or expiry policy.",
        )
        _tool_result(run, approval, {"error": receipt.error})
        return
    if approval.status != "approved":
        frappe.throw("Tool has not been explicitly approved.", frappe.ValidationError)
    if _date(approval.expires_at) <= _now():
        _save(approval, status="expired")
        return _execute_approval(run_name, token, approval_name)
    context = _tool_context(run)
    specs = get_tools(context)
    spec = specs.get(approval.tool_name)
    if spec is None or spec.version != approval.tool_version:
        frappe.throw("The approved tool is no longer available at that version.", frappe.ValidationError)
    arguments = _parse(approval.arguments_json, {})
    # A changed permission/record revision invalidates approval instead of silently
    # applying an updated operation. Never replace the user's approved arguments.
    preview = prepare(context, approval.tool_name, arguments)
    if _json(preview) != _json(_parse(approval.preview_json, {})):
        frappe.throw("The tool preview changed. Request a fresh approval.", frappe.ValidationError)
    _save(approval, status="executing")
    receipt = _insert(
        EXECUTION,
        conversation=run.conversation,
        run=run.name,
        approval=approval.name,
        tool_name=approval.tool_name,
        state="started",
        started_at=_now(),
    )
    if spec.external:
        frappe.db.commit()  # durable intent before any non-transactional effect
    try:
        with _unprivileged_tool():
            result = execute(context, approval.tool_name, arguments)
        encoded = _json(result, MAX_RESULT_CHARS)
    except Exception:
        if spec.external:
            frappe.db.rollback()
            run = _locked_run(run_name)
            if run.lease_token == token and run.state == "running":
                _mark_uncertain(
                    run, "The external action did not return a confirmed result. Reconciliation is required."
                )
            return
        raise  # process_run rolls back effect AND started receipt, then records failure
    if spec.external:
        # External extensions may read the DB, but may not stage local mutations.
        frappe.db.rollback()
        run = _locked_run(run_name)
        _fence(run, token)
        approval = frappe.get_doc(APPROVAL, approval_name, for_update=True)
        receipt = frappe.get_doc(EXECUTION, receipt.name)
    else:
        _fence(run, token)
    _save(receipt, state="succeeded", result_json=encoded, finished_at=_now())
    _save(approval, status="succeeded")
    _tool_result(run, approval, result)


def process_run(run_name):
    """RQ entry: consumes one bounded step, then exits (including on approval wait)."""
    original_user = frappe.session.user
    token = None
    verified_site = False
    try:
        run = frappe.get_doc(RUN, run_name)
        if not run.site or run.site != frappe.local.site:
            frappe.throw("Run is bound to another site.", frappe.PermissionError)
        verified_site = True
        frappe.set_user(run.user)
        require_user()
        run = _locked_run(run_name)
        _owned(run)
        if run.state in TERMINAL or run.state == "awaiting_approval":
            frappe.db.rollback()
            return
        if run.state == "running":
            # Only scheduler recovery may replace an expired lease; it checks for
            # external started receipts before allowing ANY retry.
            frappe.db.rollback()
            return
        _assert_active(run)
        if run.cancel_requested:
            _finish(run, "cancelled")
            frappe.db.commit()
            return
        settings = get_settings()
        outstanding = []
        for row in _approval_rows(run, ("approved", "denied", "expired")):
            if not _receipt(run, row.name):
                outstanding.append(row.name)
        error = _budget(run, settings, provider_step=not outstanding)
        if error:
            _finish(run, "failed", error)
            frappe.db.commit()
            return
        get_provider_config(run.provider)
        token = uuid.uuid4().hex
        # Network timeout <=120s, worker timeout=900s. Local tools must be bounded.
        lease_seconds = min(180, _number(settings.max_run_seconds, 600, 30, 3600) - _active_seconds(run))
        _save(
            run,
            state="running",
            lease_token=token,
            lease_expires=_now() + timedelta(seconds=lease_seconds),
            started_at=run.started_at or _now(),
            heartbeat_at=_now(),
        )
        _event(run)
        frappe.db.commit()
        if outstanding:
            # One tool per job keeps each receipt, cancellation point and lease small.
            _execute_approval(run_name, token, outstanding[0])
            run = _locked_run(run_name)
            if run.state == "running":
                _fence(run, token)
                _release(run)
            frappe.db.commit()
        else:
            _provider_turn(run_name, token)
    except LostLease:
        frappe.db.rollback()  # stale provider/local tool output is not authoritative
    except Exception:
        frappe.db.rollback()
        if token:
            run = _locked_run(run_name)
            if run.state == "running" and run.lease_token == token:
                if _started_receipts(run):
                    _mark_uncertain(run, "An external action may have completed. Reconciliation is required.")
                else:
                    for row in _approval_rows(run, ("approved", "executing")):
                        approval = frappe.get_doc(APPROVAL, row.name)
                        _save(approval, status="failed")
                        if not _receipt(run, row.name):
                            _insert(
                                EXECUTION,
                                conversation=run.conversation,
                                run=run.name,
                                approval=row.name,
                                tool_name=approval.tool_name,
                                state="failed",
                                started_at=_now(),
                                finished_at=_now(),
                                error="Tool execution failed and local changes were rolled back.",
                            )
                    _finish(
                        run,
                        "failed",
                        "The run could not continue safely. Review permissions, provider configuration and tool inputs.",
                    )
                frappe.db.commit()
        elif verified_site:
            # Revoked user/provider access is terminal, not an endlessly requeued
            # poison job. Only app bookkeeping runs under the original RQ identity.
            frappe.set_user(original_user)
            run = _locked_run(run_name)
            if run.site == frappe.local.site and run.state == "queued":
                _finish(
                    run,
                    "failed",
                    "The initiating user or provider is no longer authorized, or run configuration is invalid.",
                )
                frappe.db.commit()
            else:
                frappe.db.rollback()
                raise
        else:
            raise
    finally:
        frappe.set_user(original_user)


def _recoverable_identity(run):
    provider = frappe.get_doc("Intelligence Provider", run.provider, for_update=True)
    conversation = frappe.get_doc(CONVERSATION, run.conversation, for_update=True)
    return (
        conversation.owner == run.user
        and conversation.provider == run.provider
        and frappe.db.get_value("User", run.user, "user_type") == "System User"
        and can_use_provider(provider, run.user)
        and frappe.get_single("Intelligence Settings").enabled
    )


def recover_runs():
    """Scheduler-only, site-local recovery. No caller-supplied identities or effects."""
    if frappe.session.user != "Administrator":
        frappe.throw("Run recovery is restricted to the site scheduler.", frappe.PermissionError)
    # Separate bounded cohorts prevent a large queued/pending backlog from
    # starving lease recovery or a later run with an earlier approval expiry.
    names = frappe.get_all(
        RUN,
        filters={"state": "running"},
        fields=["name"],
        order_by="lease_expires asc",
        limit_page_length=200,
    )
    expired = frappe.get_all(
        APPROVAL,
        filters={"status": "pending", "expires_at": ["<=", _now()]},
        fields=["run"],
        order_by="expires_at asc",
        limit_page_length=200,
    )
    names += [frappe._dict(name=row.run) for row in expired]
    names += frappe.get_all(
        RUN,
        filters={"state": "awaiting_approval"},
        fields=["name"],
        order_by="modified asc",
        limit_page_length=200,
    )
    names += frappe.get_all(
        RUN, filters={"state": "queued"}, fields=["name"], order_by="modified asc", limit_page_length=200
    )
    names = list({row.name: row for row in names}.values())
    original_user = frappe.session.user
    recovered = 0
    try:
        for row in names:
            try:
                run = _locked_run(row.name)
                if run.site != frappe.local.site:
                    frappe.db.rollback()
                    continue
                # Infrastructure repair remains under the scheduler identity; tools
                # and provider calls are ONLY performed by a reauthorized worker.
                if run.state in ACTIVE and not _recoverable_identity(run):
                    if _started_receipts(run):
                        _mark_uncertain(
                            run,
                            "Authorization was revoked during an external action. Reconciliation is required.",
                        )
                    else:
                        for approval in _approval_rows(run, ("pending", "approved")):
                            _save(approval, status="failed")
                        _finish(run, "failed", "The initiating user or provider is no longer authorized.")
                    recovered += 1
                    frappe.db.commit()
                    continue
                if run.state == "running" and (not run.lease_expires or _date(run.lease_expires) <= _now()):
                    if _started_receipts(run):
                        _mark_uncertain(
                            run, "A worker stopped during an external action. Reconciliation is required."
                        )
                    elif run.cancel_requested:
                        _finish(run, "cancelled")
                    else:
                        _release(run)
                    recovered += 1
                elif run.state == "awaiting_approval":
                    for proposal in _approval_rows(run, ("pending",)):
                        approval = frappe.get_doc(APPROVAL, proposal.name)
                        if _date(approval.expires_at) <= _now():
                            _save(approval, status="expired")
                    if not _approval_rows(run, ("pending",)):
                        _release(run)
                        recovered += 1
                    else:
                        _save(run, heartbeat_at=_now())
                elif run.state == "queued":
                    _save(run, heartbeat_at=_now())  # rotate this cohort fairly via modified
                    _enqueue(run)  # repairs failed enqueue-after-commit / Redis loss
                frappe.db.commit()
            except Exception:
                frappe.db.rollback()
                # No exception payloads/credentials in logs. Surface recovery failure
                # to scheduler monitoring instead of silently dropping broken rows.
                raise
    finally:
        frappe.set_user(original_user)
    return {"recovered": recovered}
