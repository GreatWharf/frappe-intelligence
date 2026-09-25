"""Exercise the real engine against a transactional, injectable Frappe boundary."""

import copy
import importlib
import json
import re
import sys
import types
from datetime import datetime, timedelta

import pytest


class Record(dict):
    def __getattr__(self, name):
        return self.get(name)

    __setattr__ = dict.__setitem__

    def check_permission(self, permission):
        if self.get("no_permission"):
            raise PermissionError(permission)

    def get_password(self, field):
        return self.get(field)


class Document(Record):
    def insert(self, **kwargs):
        from pathlib import Path

        schema = (
            Path(__file__).resolve().parents[1]
            / "frappe_intelligence"
            / "frappe_intelligence"
            / "doctype"
            / self.doctype.lower().replace(" ", "_")
        )
        path = schema / (schema.name + ".json")
        if path.exists():
            for field in json.loads(path.read_text())["fields"]:
                if field.get("reqd"):
                    assert self.get(field["fieldname"]) not in (None, ""), (
                        f"Missing mandatory {self.doctype}.{field['fieldname']}"
                    )
        self.setdefault("name", f"doc-{len(self._fake.rows) + 1}")
        self.setdefault("owner", self._fake.session.user)
        self.setdefault("creation", datetime.now())
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def save(self, **kwargs):
        self._fake.rows[(self.doctype, self.name)] = self
        return self

    def db_set(self, field, value=None, **kwargs):
        self.update(field if isinstance(field, dict) else {field: value})


class Database:
    def __init__(self, fake):
        self.fake = fake
        self.snapshot = {}
        self.in_transaction = False
        self.locks = []

    def commit(self):
        self.snapshot = self.clone()
        self.in_transaction = False
        self.locks.clear()

    def clone(self):
        return {
            key: {k: copy.deepcopy(v) for k, v in row.items() if k != "_fake"}
            for key, row in self.fake.rows.items()
        }

    def rollback(self, **kwargs):
        self.fake.rows = {key: Document(dict(value, _fake=self.fake)) for key, value in self.snapshot.items()}
        self.in_transaction = False
        self.locks.clear()

    def sql(self, query, values=(), **kwargs):
        self.in_transaction = True
        match = re.search(r'FROM [`"]tab([^`"]+)[`"]', query, re.I)
        assert match, query
        doctype = match.group(1)
        name = values[0] if isinstance(values, (tuple, list)) else values
        row = self.fake.rows.get((doctype, name))
        self.locks.append((doctype, name))
        if re.search(r"WHERE `?user`?\s*=", query, re.I):
            assert doctype == "Intelligence Run" and "FOR UPDATE" in query
            assert ("User", values[0]) in self.locks
            rows = self.fake.get_all(
                doctype,
                filters={"user": values[0], "creation": [">=", values[1]]},
                order_by="creation asc",
                limit_page_length=values[2],
            )
            return rows if kwargs.get("as_dict") else [(item.name,) for item in rows]
        if re.search(r"WHERE run\s*=", query, re.I):
            rows = self.fake.get_all(doctype, filters={"run": name}, order_by="creation asc")
            return rows if kwargs.get("as_dict") else [(item.name,) for item in rows]
        if kwargs.get("as_dict"):
            return [row] if row else []
        return [(name,)] if row else []

    def get_value(self, doctype, name, field="name", **kwargs):
        self.in_transaction = True
        rows = (
            self.fake.get_all(doctype, filters=name)
            if isinstance(name, dict)
            else [self.fake.rows.get((doctype, name))]
        )
        row = next((r for r in rows if r), None)
        if row is None:
            return None
        if isinstance(field, (tuple, list)):
            values = Record({key: row.get(key) for key in field})
            return values if kwargs.get("as_dict") else tuple(values.values())
        return row.get(field)

    def set_value(self, doctype, name, field, value=None, **kwargs):
        self.in_transaction = True
        row = self.fake.rows[(doctype, name)]
        row.update(field if isinstance(field, dict) else {field: value})

    def count(self, doctype, filters=None):
        return len(self.fake.get_all(doctype, filters=filters))

    def exists(self, doctype, name):
        return self.get_value(doctype, name)

    def escape(self, value):
        return "'" + str(value).replace("'", "''") + "'"


class ShareStore:
    """In-memory frappe.share over the same row store: native DocShare semantics."""

    def __init__(self, fake):
        self.fake = fake
        self.count = 0

    def _rows(self):
        return [row for (doctype, _), row in self.fake.rows.items() if doctype == "DocShare"]

    def add(self, doctype, name, user=None, read=1, write=0, everyone=0, **kwargs):
        for row in self._rows():
            if row.share_doctype == doctype and row.share_name == name and row.get("user") == user:
                row.update(read=1 if read else 0, write=1 if write else 0, everyone=1 if everyone else 0)
                return row
        self.count += 1
        return self.fake.seed(
            "DocShare",
            "share-%d" % self.count,
            user=user,
            share_doctype=doctype,
            share_name=name,
            read=1 if read else 0,
            write=1 if write else 0,
            everyone=1 if everyone else 0,
        )

    def remove(self, doctype, name, user, flags=None):
        for key, row in list(self.fake.rows.items()):
            if (
                key[0] == "DocShare"
                and row.share_doctype == doctype
                and row.share_name == name
                and row.get("user") == user
            ):
                del self.fake.rows[key]

    def get_users(self, doctype, name):
        return [row for row in self._rows() if row.share_doctype == doctype and row.share_name == name]

    def get_shared(self, doctype, user=None, rights=None, **kwargs):
        user = user or self.fake.session.user
        rights = rights or ["read"]
        return [
            {"share_name": row.share_name}
            for row in self._rows()
            if row.share_doctype == doctype
            and (row.get("user") == user or row.get("everyone"))
            and all(row.get(right) for right in rights)
        ]


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self.rows = {}
        self.session = Record(user="alice")
        self.local = Record(site="site.test")
        self.flags = Record()
        self.db = Database(self)
        self.share = ShareStore(self)
        self.jobs = []
        self.events = []
        self.PermissionError = PermissionError
        self.ValidationError = ValueError
        self.DoesNotExistError = LookupError
        self.roles = {
            "alice": ["Intelligence User"],
            "bob": ["Intelligence User"],
            "manager": ["Intelligence Manager"],
            "Administrator": ["System Manager"],
        }
        self._dict = Record
        self.settings = Record(
            enabled=1,
            max_steps=4,
            max_tokens=256,
            max_run_seconds=600,
            approval_expiry_minutes=60,
            daily_run_limit=10,
            allowed_custom_hosts="",
            enabled_tools="read\nwrite\nexternal",
        )
        self.seed("User", "alice", enabled=1, user_type="System User")
        self.seed("User", "bob", enabled=1, user_type="System User")
        self.seed("User", "manager", enabled=1, user_type="System User")
        self.seed("User", "Administrator", enabled=1, user_type="System User")
        self.seed(
            "Intelligence Provider",
            "provider",
            owner="alice",
            enabled=1,
            kind="OpenAI",
            model="test",
            api_key="secret",
            is_shared=0,
            timeout=30,
            max_tokens=256,
        )
        self.seed(
            "Intelligence Conversation", "conversation", owner="alice", provider="provider", message_count=0
        )
        self.db.commit()

    def seed(self, doctype, name, **values):
        record = Document(dict(values, doctype=doctype, name=name, _fake=self))
        self.rows[(doctype, name)] = record
        return record

    def get_doc(self, doctype, name=None, **kwargs):
        self.db.in_transaction = True
        if isinstance(doctype, dict):
            return Document(dict(doctype, _fake=self))
        record = self.rows.get((doctype, name))
        if record is None:
            raise LookupError(name)
        return record

    def get_single(self, doctype):
        return self.settings

    def get_roles(self, user=None):
        return self.roles.get(user or self.session.user, [])

    def set_user(self, user):
        self.session.user = user

    def throw(self, message, exc=ValueError, **kwargs):
        raise exc(message)

    def get_all(
        self, doctype, filters=None, fields=None, order_by=None, limit_page_length=None, limit=None, **kwargs
    ):
        def matches(row):
            for field, expected in (filters or {}).items():
                actual = row.get(field)
                if isinstance(expected, (list, tuple)):
                    op, value = expected
                    if op == "in" and actual not in value:
                        return False
                    if op == "not in" and actual in value:
                        return False
                    if op == "!=" and actual == value:
                        return False
                    if op == "like" and value.strip("%") not in (actual or ""):
                        return False
                    if op in (">=", ">") and (actual is None or actual < value):
                        return False
                    if op in ("<=", "<") and (actual is None or actual > value):
                        return False
                elif actual != expected:
                    return False
            return True

        rows = [r for (dt, _), r in self.rows.items() if dt == doctype and matches(r)]
        if order_by:
            key = order_by.split()[0]
            rows.sort(key=lambda row: row.get(key) or 0, reverse="desc" in order_by.lower())
        return rows[: limit_page_length or limit or len(rows)]

    def enqueue(self, method, **kwargs):
        self.jobs.append((method, kwargs))

    def publish_realtime(self, event, message, **kwargs):
        self.events.append((event, message, kwargs))

    def run_events(self, kind=None):
        """Captured intelligence_run_event publishes, optionally filtered by kind."""
        events = [event for event in self.events if event[0] == "intelligence_run_event"]
        if kind:
            events = [event for event in events if event[1].get("kind") == kind]
        return events

    def log_error(self, *args, **kwargs):
        pass


@pytest.fixture
def env(monkeypatch):
    fake = FakeFrappe()
    monkeypatch.setitem(sys.modules, "frappe", fake)
    root = str(__import__("pathlib").Path(__file__).resolve().parents[1])
    monkeypatch.syspath_prepend(root)
    engine = importlib.import_module("frappe_intelligence.engine")
    access = importlib.import_module("frappe_intelligence.access")
    monkeypatch.setattr(engine, "frappe", fake)
    monkeypatch.setattr(access, "frappe", fake)
    calls = []
    replies = []
    executions = []
    toolmod = types.ModuleType("frappe_intelligence.tools")
    toolmod.ToolContext = lambda **kw: Record(kw)
    toolmod.get_tools = lambda context: {
        name: Record(name=name, version="1", mutates=name == "write", external=name == "external")
        for name in ("read", "write", "external")
    }
    toolmod.schemas = lambda context: []
    toolmod.prepare = lambda context, name, args: {"tool": name, "arguments": args}

    def execute(context, name, args):
        assert fake.session.user == "alice"
        assert not fake.flags.get("intelligence_internal"), "Privilege must not leak into tools"
        executions.append((name, args))
        fake.seed("Business Record", "effect", value=args)
        if args.get("fail"):
            raise RuntimeError("secret tool exception")
        return {"ok": True}

    toolmod.execute = execute
    monkeypatch.setitem(sys.modules, "frappe_intelligence.tools", toolmod)
    provider = types.ModuleType("frappe_intelligence.providers")
    provider.ProviderConfig = lambda **kwargs: Record(kwargs)
    provider.KINDS = frozenset({"openai", "anthropic", "gemini", "openrouter", "xai", "custom"})

    class ProviderError(Exception):
        pass

    provider.ProviderError = ProviderError

    def complete(config, messages, tools):
        assert not fake.db.in_transaction, "Provider call held a database transaction"
        assert fake.session.user == "alice"
        calls.append(copy.deepcopy(messages))
        reply = replies.pop(0)
        return reply() if callable(reply) else reply

    provider.complete = complete
    monkeypatch.setitem(sys.modules, "frappe_intelligence.providers", provider)
    return Record(
        frappe=fake, engine=engine, access=access, replies=replies, calls=calls, executions=executions
    )


def reply(*calls, text="", usage=None):
    return Record(
        text=text,
        tool_calls=[
            Record(id=f"call-{i}", name=name, arguments=args, metadata={})
            for i, (name, args) in enumerate(calls)
        ],
        usage=usage or {},
    )


def submit(env):
    result = env.engine.submit_message("conversation", "Help me")
    env.frappe.db.commit()  # Frappe POST request transaction boundary
    return result["name"]


def approvals(env):
    return env.frappe.get_all("Intelligence Approval")


def test_submission_is_durable_owned_and_enqueued_after_commit(env):
    name = submit(env)
    row = env.frappe.get_doc("Intelligence Run", name)
    assert row.user == "alice" and row.site == "site.test" and row.state == "queued"
    assert env.frappe.jobs[-1][1]["enqueue_after_commit"] is True
    assert env.frappe.get_doc("Intelligence Conversation", "conversation").active_run == name
    with pytest.raises(ValueError):
        submit(env)


def test_every_read_requires_approval_and_pending_releases_worker(env):
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"})))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    assert len(approvals(env)) == 1 and approvals(env)[0].status == "pending"
    assert not env.executions
    assert not env.frappe.get_doc("Intelligence Run", name).lease_token
    assert env.frappe.events[-1][2]["user"] == "alice"
    assert set(env.frappe.events[-1][1]) == {"conversation", "run", "state"}


def test_approval_executes_once_and_canonical_history_survives_resume(env):
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2}), text="Proposed."))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    env.engine.decide_approval(approval.name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert len(env.executions) == 1
    receipt = env.frappe.get_all("Intelligence Tool Execution")[0]
    assert receipt.state == "succeeded"
    env.engine.decide_approval(approval.name, "approve")
    env.frappe.db.commit()
    env.replies.append(reply(text="Done."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert len(env.executions) == 1
    assert any(message.get("tool_calls") for message in env.calls[-1])
    assert any(message.get("tool_call_id") == "call-0" for message in env.calls[-1])


def test_denial_returns_a_tool_result_without_execution(env):
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "deny")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert not env.executions
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "denied" in row.content.lower() for row in messages)


def test_prepare_rejection_returns_a_tool_error_and_the_run_recovers(env, monkeypatch):
    toolmod = sys.modules["frappe_intelligence.tools"]
    name = submit(env)
    env.replies.append(reply(("read", {"fields": ["password"]}), text="Checking."))

    def rejecting_prepare(context, tool_name, args):
        if args.get("fields"):
            raise PermissionError("Not permitted to use this Intelligence tool or resource.")
        return {"tool": tool_name, "arguments": args}

    monkeypatch.setattr(toolmod, "prepare", rejecting_prepare)
    env.engine.process_run(name)
    run = env.engine.get_run(name)
    assert run["state"] != "failed"
    assert not approvals(env), "a rejected prepare must never create an approval row"
    assert not env.executions
    messages = env.frappe.get_all("Intelligence Message")
    assert any(
        row.role == "tool" and row.tool_call_id == "call-0" and "not permitted" in row.content.lower()
        for row in messages
    )
    env.replies.append(reply(text="That field is off limits; here is what I can show instead."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"


def test_prepare_rejection_alongside_a_valid_call_still_offers_the_approval(env, monkeypatch):
    toolmod = sys.modules["frappe_intelligence.tools"]
    name = submit(env)
    env.replies.append(
        reply(("read", {"fields": ["password"]}), ("read", {"doctype": "Customer"}), text="Two lookups.")
    )

    def selective_prepare(context, tool_name, args):
        if args.get("fields"):
            raise ValueError("Unsupported field selection.")
        return {"tool": tool_name, "arguments": args}

    monkeypatch.setattr(toolmod, "prepare", selective_prepare)
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    pending = approvals(env)
    assert len(pending) == 1 and pending[0].tool_call_id == "call-1"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(
        row.role == "tool" and row.tool_call_id == "call-0" and "unsupported field" in row.content.lower()
        for row in messages
    )


def test_digest_tampering_and_expiry_cannot_authorize(env):
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    original = approval.arguments_json
    approval.arguments_json = '{"injected":true}'
    with pytest.raises(ValueError):
        env.engine.decide_approval(approval.name, "approve")
    approval.arguments_json = original
    approval.expires_at = datetime.now() - timedelta(seconds=1)
    env.engine.decide_approval(approval.name, "approve")
    assert approval.status == "expired"
    assert not env.executions


def test_cross_user_and_cross_site_access_rejected(env):
    name = submit(env)
    env.frappe.session.user = "bob"
    for operation in (
        lambda: env.engine.get_run(name),
        lambda: env.engine.cancel_run(name),
        lambda: submit(env),
    ):
        with pytest.raises(PermissionError):
            operation()
    env.frappe.session.user = "alice"
    env.frappe.local.site = "other.test"
    with pytest.raises(PermissionError):
        env.engine.process_run(name)
    assert not env.calls


def test_cancellation_discards_inflight_provider_output(env):
    name = submit(env)

    def inflight():
        env.engine.cancel_run(name)
        env.frappe.db.commit()
        return reply(("write", {}), text="late response")

    env.replies.append(inflight)
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "cancelled"
    assert not approvals(env)
    assert not env.executions


def test_local_effect_and_receipt_roll_back_together_on_error(env):
    name = submit(env)
    env.replies.append(reply(("write", {"fail": True})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert ("Business Record", "effect") not in env.frappe.rows
    assert env.engine.get_run(name)["state"] == "failed"
    assert "secret" not in env.engine.get_run(name)["error"]


def test_local_validation_error_returns_a_tool_error_and_the_run_recovers(env, monkeypatch):
    toolmod = sys.modules["frappe_intelligence.tools"]
    name = submit(env)
    env.replies.append(reply(("write", {"value": 3})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()

    def validating_execute(context, tool_name, args):
        raise ValueError("Expense account is mandatory for item Shipping & Handling")

    monkeypatch.setattr(toolmod, "execute", validating_execute)
    env.engine.process_run(name)
    assert ("Business Record", "effect") not in env.frappe.rows, "the failed write must roll back"
    assert env.engine.get_run(name)["state"] != "failed"
    assert approvals(env)[0].status == "failed"
    receipts = env.frappe.get_all("Intelligence Tool Execution")
    assert len(receipts) == 1 and receipts[0].state == "failed"
    messages = env.frappe.get_all("Intelligence Message")
    assert any(row.role == "tool" and "Expense account" in row.content for row in messages)
    env.replies.append(reply(text="Retrying with the item's default expense account."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"


def test_expired_external_execution_becomes_uncertain_without_retry(env):
    name = submit(env)
    run = env.frappe.get_doc("Intelligence Run", name)
    run.update(state="running", lease_token="dead", lease_expires=datetime.now() - timedelta(seconds=1))
    approval = env.frappe.seed(
        "Intelligence Approval",
        "approval",
        conversation="conversation",
        run=name,
        status="executing",
        tool_name="external",
    )
    env.frappe.seed(
        "Intelligence Tool Execution",
        "receipt",
        conversation="conversation",
        run=name,
        approval=approval.name,
        tool_name="external",
        state="started",
    )
    env.frappe.db.commit()
    recover(env)
    assert env.engine.get_run(name)["state"] == "needs_reconciliation"
    assert not env.executions
    assert env.frappe.get_doc("Intelligence Tool Execution", "receipt").state == "uncertain"


def test_stale_provider_worker_cannot_persist_after_recovery(env):
    name = submit(env)

    def inflight():
        run = env.frappe.get_doc("Intelligence Run", name)
        run.lease_expires = datetime.now() - timedelta(seconds=1)
        env.frappe.db.commit()
        recover(env)
        return reply(text="stale")

    env.replies.append(inflight)
    env.engine.process_run(name)
    assert not any(row.content == "stale" for row in env.frappe.get_all("Intelligence Message"))
    assert env.engine.get_run(name)["state"] == "queued"


def test_submission_preserves_sequence_with_fresh_document_instances(env, monkeypatch):
    get_doc = env.frappe.get_doc

    def fresh(doctype, name=None, **kwargs):
        doc = get_doc(doctype, name, **kwargs)
        return Document(dict(doc)) if doctype == "Intelligence Conversation" else doc

    monkeypatch.setattr(env.frappe, "get_doc", fresh)
    submit(env)
    assert env.frappe.get_doc("Intelligence Conversation", "conversation").message_count == 1


def test_external_success_is_receipted_and_failure_never_retried(env):
    name = submit(env)
    env.replies.append(reply(("external", {"fail": True})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "needs_reconciliation"
    env.engine.process_run(name)
    recover(env)
    assert len(env.executions) == 1
    assert env.frappe.get_all("Intelligence Tool Execution")[0].state == "uncertain"
    with pytest.raises(ValueError):
        submit(env)


def test_multiple_calls_wait_for_every_decision_and_execute_one_per_worker(env):
    name = submit(env)
    env.replies.append(reply(("read", {"a": 1}), ("read", {"a": 2})))
    env.engine.process_run(name)
    first, second = approvals(env)
    env.engine.decide_approval(first.name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert not env.executions
    env.engine.decide_approval(second.name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert len(env.executions) == 1
    env.engine.process_run(name)
    assert len(env.executions) == 2


def test_revoked_provider_fails_queued_run_instead_of_endless_recovery(env):
    name = submit(env)
    env.frappe.get_doc("Intelligence Provider", "provider").enabled = 0
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert not env.calls


def test_human_approval_wait_does_not_consume_active_time_budget(env):
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    run = env.frappe.get_doc("Intelligence Run", name)
    run.started_at = datetime.now() - timedelta(hours=10)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert len(env.executions) == 1
    assert env.engine.get_run(name)["state"] == "queued"


def test_active_time_budget_fails_before_more_provider_calls(env):
    name = submit(env)
    env.frappe.get_doc("Intelligence Run", name).active_seconds = 601
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert not env.calls


def test_large_queue_cannot_starve_expired_running_recovery(env):
    for i in range(205):
        env.frappe.seed(
            "Intelligence Run",
            f"queued-{i}",
            conversation="conversation",
            provider="provider",
            user="alice",
            site="site.test",
            state="queued",
        )
    run = env.frappe.seed(
        "Intelligence Run",
        "expired",
        conversation="conversation",
        provider="provider",
        user="alice",
        site="site.test",
        state="running",
        lease_token="dead",
        lease_expires=datetime.now() - timedelta(seconds=1),
    )
    env.frappe.db.commit()
    recover(env)
    assert run.state == "queued"
    assert not run.lease_token


def test_run_user_match_does_not_bypass_conversation_ownership(env):
    name = submit(env)
    env.frappe.get_doc("Intelligence Conversation", "conversation").owner = "bob"
    with pytest.raises(PermissionError):
        env.engine.get_run(name)


def test_approved_arguments_are_reverified_before_execution(env):
    name = submit(env)
    env.replies.append(reply(("write", {"value": "approved"})))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    env.engine.decide_approval(approval.name, "approve")
    approval.arguments_json = '{"value":"tampered"}'
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert not env.executions


def test_changed_tool_preview_invalidates_approval(env, monkeypatch):
    name = submit(env)
    env.replies.append(reply(("write", {})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()
    monkeypatch.setattr(
        sys.modules["frappe_intelligence.tools"], "prepare", lambda *args: {"revision": "changed"}
    )
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert not env.executions


def test_external_success_is_not_repeated_on_queue_redelivery(env):
    name = submit(env)
    env.replies.append(reply(("external", {})))
    env.engine.process_run(name)
    env.engine.decide_approval(approvals(env)[0].name, "approve")
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.frappe.get_all("Intelligence Tool Execution")[0].state == "succeeded"
    env.replies.append(reply(text="Done"))
    env.engine.process_run(name)
    env.engine.process_run(name)
    assert len(env.executions) == 1
    assert env.engine.get_run(name)["state"] == "completed"


def test_invalid_context_and_foreign_files_rejected_before_submission(env):
    with pytest.raises(ValueError):
        env.engine.submit_message(
            "conversation", "Hi", context={"doctype": "User", "execution_user": "Administrator"}
        )
    env.frappe.seed("Customer", "private", no_permission=True)
    with pytest.raises(PermissionError):
        env.engine.submit_message("conversation", "Hi", context={"doctype": "Customer", "name": "private"})
    env.frappe.seed(
        "File",
        "foreign",
        owner="bob",
        is_private=1,
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
    )
    with pytest.raises(PermissionError):
        env.engine.submit_message("conversation", "Hi", attachments=["foreign"])
    assert not env.frappe.get_all("Intelligence Run")


def test_scheduler_terminates_role_revoked_runs_even_while_awaiting_approval(env):
    name = submit(env)
    env.replies.append(reply(("read", {})))
    env.engine.process_run(name)
    env.frappe.roles["alice"] = []
    env.frappe.session.user = "manager"
    env.frappe.db.commit()
    recover(env)
    assert env.frappe.get_doc("Intelligence Run", name).state == "failed"
    assert approvals(env)[0].status == "failed"
    assert not env.executions


def install_stale_run_snapshot(env, monkeypatch):
    """Ordinary reads retain a pre-lock snapshot; locking reads see the new commit."""
    snapshot = env.frappe.db.clone()
    original_value = env.frappe.db.get_value
    original_count = env.frappe.db.count

    def get_value(doctype, name, field="name", **kwargs):
        if doctype == "Intelligence Run" and isinstance(name, str) and not kwargs.get("for_update"):
            return snapshot.get((doctype, name), {}).get(field)
        return original_value(doctype, name, field, **kwargs)

    def count(doctype, filters=None):
        if doctype == "Intelligence Run":
            return sum(
                1
                for (dt, _), row in snapshot.items()
                if dt == doctype
                and row.get("user") == filters["user"]
                and row.get("creation") >= filters["creation"][1]
            )
        return original_count(doctype, filters)

    monkeypatch.setattr(env.frappe.db, "get_value", get_value)
    monkeypatch.setattr(env.frappe.db, "count", count)


def test_current_active_run_read_rejects_competing_commit_outside_snapshot(env, monkeypatch):
    install_stale_run_snapshot(env, monkeypatch)
    env.frappe.seed(
        "Intelligence Run",
        "competing",
        user="alice",
        conversation="conversation",
        provider="provider",
        site="site.test",
        state="queued",
        creation=datetime.now(),
    )
    env.frappe.get_doc("Intelligence Conversation", "conversation").active_run = "competing"
    env.frappe.db.commit()  # A different connection committed while this request waited.
    with pytest.raises(ValueError, match="active run"):
        submit(env)
    assert len(env.frappe.get_all("Intelligence Run")) == 1


def test_current_quota_read_rejects_competing_commit_outside_snapshot(env, monkeypatch):
    env.frappe.settings.daily_run_limit = 1
    install_stale_run_snapshot(env, monkeypatch)
    env.frappe.seed("Intelligence Conversation", "other", owner="alice", provider="provider")
    env.frappe.seed(
        "Intelligence Run",
        "competing",
        user="alice",
        conversation="other",
        provider="provider",
        site="site.test",
        state="completed",
        creation=datetime.now(),
    )
    env.frappe.db.commit()
    with pytest.raises(ValueError, match="daily"):
        submit(env)
    assert len(env.frappe.get_all("Intelligence Run")) == 1


def test_superseded_queued_run_never_claims_or_clears_new_active_run(env):
    name = submit(env)
    env.frappe.get_doc("Intelligence Conversation", "conversation").active_run = "newer"
    env.frappe.seed(
        "Intelligence Run",
        "newer",
        user="alice",
        conversation="conversation",
        provider="provider",
        site="site.test",
        state="queued",
        creation=datetime.now(),
    )
    env.frappe.db.commit()
    env.replies.append(reply(text="must not run"))
    env.engine.process_run(name)
    assert not env.calls and not env.executions
    assert env.engine.get_run(name)["state"] == "failed"
    assert env.frappe.get_doc("Intelligence Conversation", "conversation").active_run == "newer"


def test_terminal_run_remains_readable_after_a_new_run_is_active(env):
    name = submit(env)
    env.replies.append(reply(text="Finished"))
    env.engine.process_run(name)
    newer = submit(env)
    assert newer != name
    assert env.engine.get_run(name)["state"] == "completed"


def test_superseded_inflight_response_cannot_clear_new_pointer_from_stale_snapshot(env, monkeypatch):
    name = submit(env)
    old_conversation = dict(env.frappe.get_doc("Intelligence Conversation", "conversation"))
    get_doc = env.frappe.get_doc

    def snapshot_read(doctype, docname=None, **kwargs):
        if doctype == "Intelligence Conversation" and not kwargs.get("for_update"):
            return Document(dict(old_conversation))
        return get_doc(doctype, docname, **kwargs)

    monkeypatch.setattr(env.frappe, "get_doc", snapshot_read)

    def inflight():
        get_doc("Intelligence Conversation", "conversation").active_run = "newer"
        env.frappe.seed(
            "Intelligence Run",
            "newer",
            user="alice",
            conversation="conversation",
            provider="provider",
            site="site.test",
            state="queued",
            creation=datetime.now(),
        )
        env.frappe.db.commit()
        return reply(("write", {}), text="must not persist")

    env.replies.append(inflight)
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert get_doc("Intelligence Conversation", "conversation").active_run == "newer"
    assert not approvals(env) and not env.executions
    assert not any(row.content == "must not persist" for row in env.frappe.get_all("Intelligence Message"))


def recover(env):
    original = env.frappe.session.user
    env.frappe.session.user = "Administrator"
    try:
        return env.engine.recover_runs()
    finally:
        env.frappe.session.user = original


def test_recovery_is_scheduler_only(env):
    with pytest.raises(PermissionError):
        env.engine.recover_runs()


def test_daily_quota_and_step_budget_are_enforced(env):
    env.frappe.settings.daily_run_limit = 1
    name = submit(env)
    env.frappe.get_doc("Intelligence Run", name).step_count = 4
    env.frappe.db.commit()
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    assert not env.calls
    with pytest.raises(ValueError):
        submit(env)


def test_first_message_titles_a_new_chat_conversation(env):
    env.frappe.seed(
        "Intelligence Conversation",
        "titled",
        owner="alice",
        provider="provider",
        message_count=0,
        title="New chat",
    )
    result = env.engine.submit_message("titled", "  Help me\n  plan   the\n\nquarter  ")
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Help me plan the quarter"
    assert doc.active_run == result["name"]


def test_first_message_title_is_capped_at_one_hundred_characters(env):
    env.frappe.seed(
        "Intelligence Conversation",
        "titled",
        owner="alice",
        provider="provider",
        message_count=0,
        title="New chat",
    )
    env.engine.submit_message("titled", "word " * 30)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == ("word " * 30).strip()[:100]
    assert len(doc.title) == 100


def test_a_custom_titled_conversation_is_never_renamed(env):
    env.frappe.seed(
        "Intelligence Conversation",
        "titled",
        owner="alice",
        provider="provider",
        message_count=0,
        title="Quarterly review",
    )
    env.engine.submit_message("titled", "Help me")
    assert env.frappe.get_doc("Intelligence Conversation", "titled").title == "Quarterly review"


def test_a_model_override_is_stored_on_the_run_and_reaches_the_provider(env):
    env.frappe.get_doc("Intelligence Provider", "provider").models = "test\nother\nthird"
    seen = []
    complete = sys.modules["frappe_intelligence.providers"].complete

    def spy(config, messages, tools):
        seen.append(config)
        return complete(config, messages, tools)

    sys.modules["frappe_intelligence.providers"].complete = spy
    try:
        result = env.engine.submit_message("conversation", "Help me", model=" other ")
        env.frappe.db.commit()
        name = result["name"]
        assert env.frappe.get_doc("Intelligence Run", name).model == "other", "whitespace is stripped"
        env.replies.append(reply(text="Done."))
        env.engine.process_run(name)
        assert seen and seen[0].model == "other", "the one-off pick replaces the provider default"
    finally:
        sys.modules["frappe_intelligence.providers"].complete = complete


def test_a_model_override_must_come_from_the_provider_catalog(env):
    env.frappe.get_doc("Intelligence Provider", "provider").models = "test\nother"
    with pytest.raises(ValueError):
        env.engine.submit_message("conversation", "Help me", model="not-listed")
    with pytest.raises(ValueError):
        env.engine.submit_message("conversation", "Help me", model=42)
    with pytest.raises(ValueError):
        env.engine.submit_message("conversation", "Help me", model="x" * 141)
    # The provider default needs no stored override.
    result = env.engine.submit_message("conversation", "Help me", model="test")
    assert env.frappe.get_doc("Intelligence Run", result["name"]).model == ""


def test_an_empty_catalog_accepts_any_well_formed_model(env):
    result = env.engine.submit_message("conversation", "Help me", model="frontier-lab-9")
    assert env.frappe.get_doc("Intelligence Run", result["name"]).model == "frontier-lab-9"
    env.frappe.db.commit()
    env.frappe.get_doc("Intelligence Run", result["name"]).state = "completed"
    env.frappe.get_doc("Intelligence Conversation", "conversation").active_run = None
    result = env.engine.submit_message("conversation", "Again", model="")
    assert env.frappe.get_doc("Intelligence Run", result["name"]).model == "", "blank means no pick"


def test_automatic_mode_auto_approves_and_requeues_the_run(env):
    env.frappe.settings.approval_mode = "Automatic"
    name = submit(env)
    env.replies.append(reply(("write", {"value": 2})))
    env.engine.process_run(name)
    approval = approvals(env)[0]
    assert approval.status == "approved"
    assert not approval.decided_by, "policy auto-approvals stay unattributed to a human"
    assert approval.decided_at
    assert approval.digest, "auto-approvals keep the same durable digest audit"
    assert env.engine.get_run(name)["state"] == "queued"
    env.replies.append(reply(text="Done."))
    env.engine.process_run(name)
    env.engine.process_run(name)
    assert len(env.executions) == 1
    assert env.engine.get_run(name)["state"] == "completed"


def test_writes_only_mode_auto_approves_reads_and_holds_writes(env):
    env.frappe.settings.approval_mode = "Approve Writes Only"
    name = submit(env)
    env.replies.append(reply(("read", {"doctype": "Customer"}), ("write", {"value": 1})))
    env.engine.process_run(name)
    by_call = {row.tool_call_id: row for row in approvals(env)}
    assert by_call["call-0"].tool_name == "read"
    assert by_call["call-0"].status == "approved"
    assert not by_call["call-0"].decided_by and by_call["call-0"].decided_at
    assert by_call["call-1"].tool_name == "write"
    assert by_call["call-1"].status == "pending"
    assert not by_call["call-1"].decided_by
    assert env.engine.get_run(name)["state"] == "awaiting_approval"
    assert not env.executions


def test_default_mode_keeps_every_proposal_pending(env):
    assert env.frappe.settings.get("approval_mode") in (None, "Approve Every Step")
    name = submit(env)
    env.replies.append(reply(("read", {}), ("write", {})))
    env.engine.process_run(name)
    rows = approvals(env)
    assert len(rows) == 2
    assert all(row.status == "pending" and not row.decided_by for row in rows)
    assert env.engine.get_run(name)["state"] == "awaiting_approval"


def test_notification_failure_never_breaks_run_completion(env, monkeypatch):
    get_doc = env.frappe.get_doc

    def exploding(doctype, name=None, **kwargs):
        if isinstance(doctype, dict) and doctype.get("doctype") == "Notification Log":
            raise RuntimeError("notification table missing")
        return get_doc(doctype, name, **kwargs)

    errors = []
    monkeypatch.setattr(env.frappe, "get_doc", exploding)
    monkeypatch.setattr(env.frappe, "log_error", lambda *args, **kwargs: errors.append(kwargs))
    name = submit(env)
    env.replies.append(reply(text="Done."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert errors and errors[0].get("title") == "Intelligence notification failed"
