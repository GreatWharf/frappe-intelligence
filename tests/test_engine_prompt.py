"""Engine system prompt: transient identity, ground rules and enabled-skill guidance.

The system message is rebuilt on every provider turn and prepended ahead of the
stored history; it is never persisted as an Intelligence Message row, so skill
edits apply to later runs immediately. The skills block lists only enabled
Intelligence Skill records visible to the run user (own or shared), newest
changes first, with a hard character cap that drops least-recently-modified
skills and says so.
"""

import copy
import importlib
import re
import sys
import types
from datetime import datetime

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


class FakeFrappe(types.ModuleType):
    def __init__(self):
        super().__init__("frappe")
        self.rows = {}
        self.error_logs = []
        self.session = Record(user="alice")
        self.local = Record(site="site.test")
        self.flags = Record()
        self.db = Database(self)
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

    def skill(self, name, **values):
        defaults = dict(
            owner="alice",
            shared=0,
            enabled=1,
            title=name,
            description="",
            instructions="",
            origin="Learned",
            version=1,
            modified="2026-09-01 00:00:00",
        )
        defaults.update(values)
        return self.seed("Intelligence Skill", name, **defaults)

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

    def log_error(self, *args, **kwargs):
        self.error_logs.append(kwargs)

    def get_traceback(self, *args, **kwargs):
        import traceback

        return traceback.format_exc()


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
        executions.append((name, args))
        return {"ok": True}

    toolmod.execute = execute
    monkeypatch.setitem(sys.modules, "frappe_intelligence.tools", toolmod)
    provider = types.ModuleType("frappe_intelligence.providers")
    provider.ProviderConfig = lambda **kwargs: Record(kwargs)
    provider.KINDS = frozenset({"openai", "anthropic", "gemini", "openrouter", "xai", "custom"})

    class ProviderError(Exception):
        def __init__(self, code, message=""):
            self.code = code
            super().__init__(message)

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
        frappe=fake,
        engine=engine,
        access=access,
        replies=replies,
        calls=calls,
        executions=executions,
        provider=provider,
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
    env.frappe.db.commit()
    return result["name"]


def system_prompt(env):
    name = submit(env)
    env.replies.append(reply(text="Done."))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert len(env.calls) == 1
    return env.calls[0]


def test_system_message_is_prepended_ahead_of_history(env):
    messages = system_prompt(env)
    assert messages[0]["role"] == "system"
    assert isinstance(messages[0]["content"], str) and messages[0]["content"]
    assert messages[1]["role"] == "user"
    assert "Help me" in messages[1]["content"]
    assert set(messages[0]) == {"role", "content"}


def test_system_message_is_never_persisted_as_a_message_row(env):
    system_prompt(env)
    roles = {row.role for row in env.frappe.get_all("Intelligence Message")}
    assert "system" not in roles
    assert roles <= {"user", "assistant", "tool"}


def test_ground_rules_memory_and_adaptive_guidance_are_present(env):
    prompt = system_prompt(env)[0]["content"]
    assert "You are Intelligence" in prompt
    assert "embedded in ERPNext Desk" in prompt
    assert "Never invent record names, totals or dates" in prompt
    assert "Read before you write" in prompt
    assert "explicit approval" in prompt
    assert "Never retry a denied action" in prompt
    assert "off-limits" in prompt
    assert "propose drafts instead" in prompt
    assert "recall_memory" in prompt
    assert "save_memory" in prompt
    assert "propose_skill" in prompt
    assert len(env.engine._GROUND_RULES) < 1200


def test_skills_block_lists_only_enabled_own_and_shared_skills(env):
    env.frappe.skill(
        "SKILL-OWN",
        title="VAT returns",
        description="Prepare the monthly VAT return.",
        instructions="Open the report.\nCheck totals.",
        modified="2026-09-02 00:00:00",
    )
    env.frappe.skill(
        "SKILL-SHARED",
        owner="bob",
        shared=1,
        title="Shared checklist",
        description="Team-wide checklist.",
        modified="2026-09-03 00:00:00",
    )
    env.frappe.skill("SKILL-OFF", enabled=0, title="Disabled skill", modified="2026-09-04 00:00:00")
    env.frappe.skill(
        "SKILL-FOREIGN", owner="bob", title="Bob's private skill", modified="2026-09-05 00:00:00"
    )
    prompt = system_prompt(env)[0]["content"]
    assert "## Skills" in prompt
    assert (
        "- SKILL-OWN: VAT returns. Prepare the monthly VAT return.\n  Open the report.\n  Check totals."
        in prompt
    )
    assert "- SKILL-SHARED: Shared checklist. Team-wide checklist." in prompt
    # Newest first.
    assert prompt.index("SKILL-SHARED") < prompt.index("SKILL-OWN")
    assert "SKILL-OFF" not in prompt
    assert "SKILL-FOREIGN" not in prompt
    assert "Bob's private skill" not in prompt


def test_prompt_without_visible_skills_has_no_skills_block(env):
    env.frappe.skill("SKILL-OFF", enabled=0, title="Disabled")
    env.frappe.skill("SKILL-FOREIGN", owner="bob", title="Private")
    prompt = system_prompt(env)[0]["content"]
    assert "## Skills" not in prompt


def test_skills_block_cap_drops_least_recently_modified_with_note(env):
    for index in range(5):
        env.frappe.skill(
            f"SKILL-{index}",
            title=f"Skill {index}",
            description="Does things.",
            instructions="x" * 2500,
            modified=f"2026-09-0{index + 1} 00:00:00",
        )
    prompt = system_prompt(env)[0]["content"]
    block = prompt[prompt.index("## Skills") :]
    assert len(block) <= 4000
    # Only the most recently modified skill fits; the rest are dropped, not truncated.
    assert "- SKILL-4: Skill 4. Does things." in block
    for dropped in range(4):
        assert f"SKILL-{dropped}" not in block
    assert "[4 more enabled skills not shown]" in block


def test_skills_block_keeps_every_skill_when_all_fit(env):
    env.frappe.skill("SKILL-A", title="Alpha", instructions="First step.", modified="2026-09-01 00:00:00")
    env.frappe.skill("SKILL-B", title="Beta", instructions="Second step.", modified="2026-09-02 00:00:00")
    prompt = system_prompt(env)[0]["content"]
    assert "- SKILL-B: Beta.\n  Second step." in prompt
    assert "- SKILL-A: Alpha.\n  First step." in prompt
    assert prompt.index("SKILL-B") < prompt.index("SKILL-A")
    assert "more enabled skills not shown" not in prompt


def test_transient_provider_errors_are_retried_until_success(env, monkeypatch):
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda seconds: sleeps.append(seconds))
    name = submit(env)
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise env.provider.ProviderError("rate_limited", "Slow down.")
        return reply(text="Done after retry.")

    # The provider stub consumes one queued reply per HTTP attempt.
    env.replies.extend([flaky, flaky, flaky])
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    assert len(attempts) == 3
    assert sleeps == [3, 6]
    # One assistant turn reached the transcript; duplicates were never appended.
    assert len(env.calls) == 3


def test_non_transient_provider_error_fails_without_retry(env, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda seconds: pytest.fail("Must not back off"))
    name = submit(env)
    attempts = []

    def auth_failed():
        attempts.append(1)
        raise env.provider.ProviderError("authentication_failed", "Bad key.")

    env.replies.append(auth_failed)
    env.engine.process_run(name)
    run = env.engine.get_run(name)
    assert run["state"] == "failed"
    assert len(attempts) == 1


def test_transient_provider_error_exhausts_bounded_attempts(env, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    name = submit(env)
    attempts = []

    def unavailable():
        attempts.append(1)
        raise env.provider.ProviderError("provider_unavailable", "503")

    # The provider stub consumes one queued reply per HTTP attempt.
    env.replies.extend([unavailable, unavailable, unavailable, unavailable])
    env.engine.process_run(name)
    run = env.engine.get_run(name)
    assert run["state"] == "failed"
    assert len(attempts) == 4
    # An exhausted provider failure says so; the generic safe message is for
    # unexpected errors only.
    assert "provider" in run["error"].lower()
    assert "try again" in run["error"].lower()


def test_failed_runs_log_a_traceback_for_diagnostics(env, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    name = submit(env)

    def unavailable():
        raise env.provider.ProviderError("provider_unavailable", "503")

    # The provider stub consumes one queued reply per HTTP attempt.
    env.replies.extend([unavailable, unavailable, unavailable, unavailable])
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "failed"
    # The user-facing message stays sanitized, but the real traceback must reach
    # the Error Log or production failures are undiagnosable.
    assert len(env.frappe.error_logs) == 1
    entry = env.frappe.error_logs[0]
    assert entry.get("title") == "Intelligence run failed"
    assert "ProviderError" in entry.get("message", "")


def test_unexpected_run_errors_log_a_traceback_and_stay_generic(env):
    name = submit(env)

    def broken():
        raise KeyError("adapter-shape")

    env.replies.append(broken)
    env.engine.process_run(name)
    run = env.engine.get_run(name)
    assert run["state"] == "failed"
    assert run["error"].startswith("The run could not continue safely")
    assert "adapter-shape" not in run["error"]
    assert len(env.frappe.error_logs) == 1
    assert "adapter-shape" in env.frappe.error_logs[0].get("message", "")


def test_attachments_block_lists_conversation_files(env):
    env.frappe.seed(
        "File",
        "file-a1",
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_name="harbor-hos-77.pdf",
        is_folder=0,
        creation="2026-09-01 00:00:00",
    )
    env.frappe.seed(
        "File",
        "file-b2",
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="other-conversation",
        file_name="foreign.pdf",
        is_folder=0,
        creation="2026-09-02 00:00:00",
    )
    env.frappe.seed(
        "File",
        "file-c3",
        attached_to_doctype="Intelligence Conversation",
        attached_to_name="conversation",
        file_name="a folder",
        is_folder=1,
        creation="2026-09-03 00:00:00",
    )
    prompt = system_prompt(env)[0]["content"]
    assert "## Attachments" in prompt
    assert "- file-a1: harbor-hos-77.pdf" in prompt
    assert "read_attachment" in prompt
    # Other conversations' files and folders are never listed.
    assert "file-b2" not in prompt
    assert "foreign.pdf" not in prompt
    assert "file-c3" not in prompt


def test_prompt_without_attachments_has_no_attachments_block(env):
    prompt = system_prompt(env)[0]["content"]
    assert "## Attachments" not in prompt
