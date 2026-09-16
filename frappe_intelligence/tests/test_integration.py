"""Real Frappe/MariaDB contracts; run only on a disposable allow_tests site.

    bench --site test.localhost run-tests --app frappe_intelligence \
        --module frappe_intelligence.tests.test_integration

These tests intentionally COMMIT synthetic fixtures so a second real database
connection can observe them. Exact fixture cleanup also commits. No provider
network calls or queue jobs are allowed: those boundaries are patched to fail or
record calls. This is not collected by the root offline pytest configuration.
"""

import uuid
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.client import get_password

try:
    from frappe.tests import IntegrationTestCase
except ImportError:  # Frappe v15
    from frappe.tests.utils import FrappeTestCase as IntegrationTestCase

from frappe_intelligence import api, engine
from frappe_intelligence.access import internal_write
from frappe_intelligence.providers import Reply, ToolCall


class TestIntelligenceIntegration(IntegrationTestCase):
    SETTINGS_FIELDS = (
        "enabled",
        "allowed_read_doctypes",
        "enabled_tools",
        "max_steps",
        "max_tokens",
        "max_run_seconds",
        "approval_expiry_minutes",
        "daily_run_limit",
    )

    def setUp(self):
        super().setUp()
        if not frappe.flags.in_test or not frappe.conf.get("allow_tests"):
            raise RuntimeError("Intelligence integration tests require a disposable allow_tests site.")
        self.original_user = frappe.session.user
        self.original_internal = frappe.flags.get("intelligence_internal")
        self.original_secret_grant = frappe.flags.get("intelligence_provider_secret")
        self.users = []
        self.todos = []
        self.original_settings = None
        self.prefix = "fi-live-" + uuid.uuid4().hex[:16]
        self.secret = "synthetic-no-provider-access-" + self.prefix

        for target in ("frappe.enqueue", "frappe.publish_realtime", "frappe.sendmail"):
            patcher = patch(target)
            setattr(self, target.rsplit(".", 1)[-1] + "_mock", patcher.start())
            self.addCleanup(patcher.stop)
        provider_patcher = patch(
            "frappe_intelligence.providers.complete",
            side_effect=AssertionError("Live provider calls are forbidden in this test suite."),
        )
        self.complete_mock = provider_patcher.start()
        self.addCleanup(provider_patcher.stop)
        # Added last so exact DB cleanup runs while all outbound boundaries are
        # still patched, including when fixture creation or a test fails.
        self.addCleanup(self._cleanup_fixtures)

        frappe.set_user("Administrator")
        settings = frappe.get_single("Intelligence Settings")
        self.original_settings = {field: settings.get(field) for field in self.SETTINGS_FIELDS}
        settings.update(
            {
                "enabled": 1,
                "allowed_read_doctypes": "ToDo",
                "enabled_tools": "read_document",
                "max_steps": 4,
                "max_tokens": 256,
                "max_run_seconds": 600,
                "approval_expiry_minutes": 60,
                "daily_run_limit": 100,
            }
        )
        settings.save()
        self.owner = self._create_user("owner", ["Intelligence User"])
        self.other = self._create_user("other", ["Intelligence User"])
        self.manager = self._create_user("manager", ["Intelligence Manager", "System Manager"])
        frappe.set_user(self.owner)
        provider = api.save_provider(
            title=self.prefix,
            kind="OpenAI",
            model="synthetic-no-network-model",
            api_key=self.secret,
        )
        self.provider = provider["name"]
        self.conversation = api.create_conversation(self.provider, self.prefix)["name"]
        frappe.db.commit()

    def _create_user(self, label, roles):
        email = f"{self.prefix}-{label}@example.invalid"
        user = frappe.get_doc(
            {
                "doctype": "User",
                "email": email,
                "first_name": "Synthetic Intelligence Test",
                "enabled": 1,
                "user_type": "System User",
                "send_welcome_email": 0,
                "roles": [{"role": role} for role in roles],
            }
        ).insert()
        self.users.append(user.name)
        return user.name

    def _cleanup_fixtures(self):
        """Remove only this test's unique synthetic identities and their records."""
        errors = []

        def cleanup(label, operation):
            try:
                operation()
            except Exception as error:
                # Continue exact cleanup, but never silently pass a failed cleanup.
                errors.append(f"{label}: {type(error).__name__}")

        frappe.db.rollback()
        frappe.set_user("Administrator")
        try:
            for name in self.todos:
                if frappe.db.exists("ToDo", name):
                    cleanup(
                        "synthetic ToDo",
                        lambda n=name: frappe.delete_doc(
                            "ToDo", n, force=True, ignore_permissions=True, delete_permanently=True
                        ),
                    )
            conversations = (
                frappe.get_all(
                    "Intelligence Conversation",
                    filters={"owner": ["in", self.users]},
                    pluck="name",
                )
                if self.users
                else []
            )
            with internal_write():
                for name in conversations:
                    # Break the Conversation.active_run link before deleting runs.
                    def clear_active(n=name):
                        doc = frappe.get_doc("Intelligence Conversation", n)
                        doc.active_run = None
                        doc.save()

                    cleanup("synthetic active pointer", clear_active)
                if conversations:
                    for doctype in (
                        "Intelligence Tool Execution",
                        "Intelligence Approval",
                        "Intelligence Message",
                        "Intelligence Run",
                        "Intelligence Memory",
                    ):
                        for name in frappe.get_all(
                            doctype, filters={"conversation": ["in", conversations]}, pluck="name"
                        ):
                            cleanup(
                                doctype,
                                lambda dt=doctype, n=name: frappe.delete_doc(
                                    dt, n, force=True, ignore_permissions=True, delete_permanently=True
                                ),
                            )
                for name in conversations:
                    cleanup(
                        "synthetic conversation",
                        lambda n=name: frappe.delete_doc(
                            "Intelligence Conversation",
                            n,
                            force=True,
                            ignore_permissions=True,
                            delete_permanently=True,
                        ),
                    )
                if self.users:
                    for name in frappe.get_all(
                        "Intelligence Provider", filters={"owner": ["in", self.users]}, pluck="name"
                    ):
                        cleanup(
                            "synthetic provider",
                            lambda n=name: frappe.delete_doc(
                                "Intelligence Provider",
                                n,
                                force=True,
                                ignore_permissions=True,
                                delete_permanently=True,
                            ),
                        )
            for user in self.users:
                if frappe.db.exists("User", user):
                    cleanup(
                        "synthetic user",
                        lambda name=user: frappe.delete_doc(
                            "User", name, force=True, ignore_permissions=True, delete_permanently=True
                        ),
                    )
            if self.original_settings is not None:

                def restore_settings():
                    doc = frappe.get_single("Intelligence Settings")
                    doc.update(self.original_settings)
                    doc.save()

                cleanup("settings restoration", restore_settings)
            frappe.db.commit()
        finally:
            frappe.flags.intelligence_internal = self.original_internal
            frappe.flags.intelligence_provider_secret = self.original_secret_grant
            frappe.set_user(self.original_user)
        if errors:
            raise AssertionError("Synthetic fixture cleanup failed: " + "; ".join(errors))

    def test_api_engine_completion_and_terminal_history(self):
        self.complete_mock.side_effect = None
        self.complete_mock.return_value = Reply(
            "Synthetic answer", [], {"input_tokens": 5, "output_tokens": 2}
        )
        run = api.send_message(self.conversation, "Synthetic prompt", context={})
        self.assertEqual(run["state"], "queued")
        self.assertTrue(self.enqueue_mock.call_args.kwargs["enqueue_after_commit"])
        frappe.db.commit()
        engine.process_run(run["name"])
        view = api.get_conversation(self.conversation)
        self.assertEqual(view["run"]["state"], "completed")
        self.assertEqual([row.role for row in view["messages"]], ["user", "assistant"])
        self.assertEqual(view["messages"][-1].content, "Synthetic answer")
        self.assertEqual(frappe.db.get_value("Intelligence Run", run["name"], "user"), self.owner)
        self.assertEqual(frappe.db.get_value("Intelligence Run", run["name"], "site"), frappe.local.site)
        self.assertEqual(self.complete_mock.call_count, 1)
        newer = api.send_message(self.conversation, "A subsequent prompt")
        self.assertNotEqual(newer["name"], run["name"])
        self.assertEqual(engine.get_run(run["name"])["state"], "completed")
        for event in self.publish_realtime_mock.call_args_list:
            if event.args and event.args[0] == "intelligence_update":
                self.assertEqual(event.kwargs["user"], self.owner)
                self.assertEqual(set(event.args[1]), {"conversation", "run", "state"})

    def test_real_read_waits_for_approval_and_receipts_once(self):
        todo = frappe.get_doc(
            {
                "doctype": "ToDo",
                "description": self.prefix + " private text",
                "status": "Open",
                "allocated_to": self.owner,
                "assigned_by": self.owner,
            }
        ).insert()
        self.todos.append(todo.name)
        self.complete_mock.side_effect = [
            Reply(
                "I propose a read.",
                [
                    ToolCall(
                        "synthetic-read",
                        "read_document",
                        {
                            "doctype": "ToDo",
                            "name": todo.name,
                            "fields": ["description"],
                        },
                    )
                ],
                {},
            ),
            Reply("Read complete.", [], {}),
        ]
        run = api.send_message(self.conversation, "Read my synthetic ToDo")
        frappe.db.commit()
        engine.process_run(run["name"])
        self.assertEqual(engine.get_run(run["name"])["state"], "awaiting_approval")
        self.assertFalse(frappe.db.get_value("Intelligence Run", run["name"], "lease_token"))
        self.assertFalse(frappe.db.exists("Intelligence Tool Execution", {"run": run["name"]}))
        self.assertFalse(frappe.db.exists("Intelligence Message", {"run": run["name"], "role": "tool"}))
        approval = frappe.db.get_value("Intelligence Approval", {"run": run["name"]}, "name")
        api.approve(approval, "approve")
        frappe.db.commit()
        engine.process_run(run["name"])
        self.assertEqual(
            frappe.db.count("Intelligence Tool Execution", {"run": run["name"], "state": "succeeded"}), 1
        )
        result = frappe.db.get_value("Intelligence Message", {"run": run["name"], "role": "tool"}, "content")
        self.assertIn(self.prefix + " private text", result)
        api.approve(approval, "approve")  # Replayed decisions cannot execute again.
        frappe.db.commit()
        engine.process_run(run["name"])
        engine.process_run(run["name"])
        self.assertEqual(engine.get_run(run["name"])["state"], "completed")
        self.assertEqual(frappe.db.count("Intelligence Tool Execution", {"run": run["name"]}), 1)

    def test_private_api_ownership_and_native_document_guard(self):
        run = api.send_message(self.conversation, "Private synthetic prompt")
        frappe.db.commit()
        for user in (self.other, self.manager):
            frappe.set_user(user)
            with self.assertRaises(frappe.PermissionError):
                api.get_conversation(self.conversation)
            with self.assertRaises(frappe.PermissionError):
                engine.get_run(run["name"])
            with self.assertRaises(frappe.PermissionError):
                api.cancel(run["name"])
            self.assertNotIn(self.conversation, {row.name for row in api.list_conversations()})
        frappe.set_user(self.owner)
        doc = frappe.get_doc("Intelligence Conversation", self.conversation)
        doc.title = "An unguarded direct change"
        with self.assertRaises(frappe.PermissionError):
            doc.save()

    def test_native_password_endpoint_cannot_read_another_owners_key(self):
        # Native frappe.client.get_password itself requires System Manager. Give
        # only this synthetic owner that role to exercise the real endpoint.
        frappe.set_user("Administrator")
        frappe.get_doc("User", self.owner).add_roles("System Manager")
        frappe.set_user(self.owner)
        self.assertEqual(get_password("Intelligence Provider", self.provider, "api_key"), self.secret)
        self.assertNotIn("api_key", api.provider_details(self.provider))
        frappe.set_user(self.manager)
        with self.assertRaises(frappe.PermissionError):
            get_password("Intelligence Provider", self.provider, "api_key")
        with internal_write():
            with self.assertRaises(frappe.PermissionError):
                get_password("Intelligence Provider", self.provider, "api_key")
        shared = api.save_provider(
            title=self.prefix + " shared",
            kind="OpenAI",
            model="synthetic-no-network-model",
            api_key=self.secret + "-shared",
            is_shared=1,
        )["name"]
        frappe.set_user(self.owner)
        with self.assertRaises(frappe.PermissionError):
            get_password("Intelligence Provider", shared, "api_key")
        self.assertEqual(engine.get_provider_config(shared).api_key, self.secret + "-shared")
        self.assertFalse(frappe.flags.get("intelligence_provider_secret"))

    @contextmanager
    def _two_databases(self):
        """Keep two real independent connections without threads or timing races."""
        primary = frappe.local.db  # Concrete DB object, not the frappe.db proxy.
        previous_user = frappe.session.user
        secondary = None
        primary.commit()
        try:
            frappe.connect()
            secondary = frappe.local.db
            self.assertIsNot(primary, secondary)
            frappe.local.db = primary
            frappe.set_user(previous_user)
            yield primary, secondary
        finally:
            try:
                if secondary is not None:
                    secondary.rollback()
                    secondary.close()
                primary.rollback()
            finally:
                frappe.local.db = primary
                frappe.set_user(previous_user)

    def _check_stale_snapshot_submission(self, same_conversation):
        self.assertEqual(frappe.conf.get("db_type") or "mariadb", "mariadb")
        target = self.conversation
        if not same_conversation:
            target = api.create_conversation(self.provider, self.prefix + " second")["name"]
            frappe.set_user("Administrator")
            settings = frappe.get_single("Intelligence Settings")
            settings.daily_run_limit = 1
            settings.save()
            frappe.set_user(self.owner)
        frappe.db.commit()
        with self._two_databases() as (reader, writer):
            original_isolation = reader.sql("SELECT @@tx_isolation")[0][0].upper().replace("-", " ")
            self.assertIn(
                original_isolation, {"READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"}
            )
            reader.rollback()
            reader.sql("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            try:
                reader.begin()
                self.assertEqual(reader.count("Intelligence Run", {"user": self.owner}), 0)
                # Another connection commits AFTER the reader's consistent
                # snapshot exists, exactly the admission race being protected.
                frappe.local.db = writer
                first = api.send_message(self.conversation, "The competing committed request")
                writer.commit()
                frappe.local.db = reader
                self.assertEqual(
                    reader.count("Intelligence Run", {"user": self.owner}),
                    0,
                    "The test must actually retain a stale REPEATABLE READ snapshot.",
                )
                message = "active run" if same_conversation else "daily Intelligence run limit"
                # Either admission fails closed with the expected validation message,
                # or MariaDB itself refuses the stale locking read (error 1020, surfaced
                # as QueryDeadlockError): on REPEATABLE READ, a FOR UPDATE read that finds
                # the row changed under its snapshot is aborted by the engine, which is an
                # equally sound rejection of the losing request. Both leave exactly one run.
                try:
                    api.send_message(target, "The losing stale-snapshot request")
                except frappe.QueryDeadlockError:
                    pass
                except frappe.ValidationError as error:
                    self.assertIn(message, str(error))
                else:
                    self.fail("The stale-snapshot request must not be admitted.")
                reader.rollback()
                self.assertEqual(reader.count("Intelligence Run", {"user": self.owner}), 1)
                self.assertEqual(
                    reader.get_value("Intelligence Conversation", self.conversation, "active_run"),
                    first["name"],
                )
                self.complete_mock.assert_not_called()
            finally:
                frappe.local.db = reader
                reader.rollback()
                reader.sql("SET SESSION TRANSACTION ISOLATION LEVEL " + original_isolation)

    def test_two_connections_reject_second_active_run_from_stale_snapshot(self):
        self._check_stale_snapshot_submission(same_conversation=True)

    def test_two_connections_enforce_cross_conversation_daily_quota(self):
        self._check_stale_snapshot_submission(same_conversation=False)
