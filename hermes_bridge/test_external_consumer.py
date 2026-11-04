"""Synthetic text generation and local native receipts; no credentials or live model."""

from contextlib import closing
from dataclasses import replace
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

from hermes_bridge.external_contract import (
    ExternalRequestError,
    ExternalText,
    RecipientBinding,
)
from hermes_bridge.external_consumer import ExternalTextConsumer
from hermes_bridge.external_journal import NativeJournal


class Model:
    def __init__(self):
        self.calls = []
        self.fail = False

    def draft(self, request, key):
        self.calls.append((request, key))
        if self.fail:
            raise OSError("private provider diagnostic")
        return "A draft for " + request.text


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.path = self.root / "native.sqlite"
        self.binding = RecipientBinding(
            "native-local", "recipient-profile", "agent-B", "owner-B", "epoch-1"
        )
        self.model = Model()
        self.now = 100
        self.current = True
        self.journal = None
        self.open()
        self.request = ExternalText(
            "origin-owner-scope",
            "agent-A",
            "agent-B",
            "message-1",
            "task-1",
            "context-1",
            "hello",
            10000,
        )

    def tearDown(self):
        if self.journal:
            self.journal.close()
        self.tmp.cleanup()

    def check(self):
        if not self.current:
            raise ExternalRequestError("native_authority_revoked")

    def open(self):
        self.journal = NativeJournal(self.path, self.binding)
        self.consumer = ExternalTextConsumer(
            self.journal, self.model, self.check, lambda: self.now
        )

    def reopen(self):
        self.journal.close()
        self.journal = None
        self.open()

    def ready(self):
        key = self.consumer.prepare(self.request)["key"]
        self.assertEqual(self.consumer.run_once(key)["state"], "result_ready")
        self.consumer.request_reply_approval(key, 1000)
        return key

    def approve(self, key):
        row, _ = self.consumer.pending_reply(key)
        return self.consumer.owner_decision(
            key, row["approval_id"], row["approval_hash"], "once"
        )

    def test_duplicate_is_one_model_run_and_conflicting_body_or_recipient_is_refused(
        self,
    ):
        key = self.ready()
        self.consumer.prepare(self.request)
        self.consumer.run_once(key)
        self.assertEqual(len(self.model.calls), 1)
        for changed in (
            replace(self.request, text="different"),
            replace(self.request, recipient_id="agent-C"),
        ):
            with self.assertRaises(ExternalRequestError):
                self.consumer.prepare(changed)
        self.assertNotIn("owner-B", str(self.consumer.snapshot(key)))
        self.assertNotIn("approval_id", self.consumer.snapshot(key))
        self.assertIsNone(self.consumer.snapshot(key)["result"])

    def test_waiting_approval_restores_same_id_without_a_model_call_or_send(self):
        key = self.ready()
        old = self.journal.get(key)
        self.reopen()
        restored, _ = self.consumer.pending_reply(key)
        self.assertEqual(restored["approval_id"], old["approval_id"])
        self.consumer.run_once(key)
        self.assertEqual(len(self.model.calls), 1)
        with self.assertRaises(ExternalRequestError):
            self.consumer.handoff_reply(key, self.fail_enqueue)

    def test_exact_owner_approved_reply_handoff_is_consumed_once(self):
        key = self.ready()
        self.approve(key)
        sent = []

        def enqueue(identity, action):
            sent.append((identity, action))
            return {"durable": True, "id": identity}

        self.assertEqual(
            self.consumer.handoff_reply(key, enqueue)["state"], "completed"
        )
        with self.assertRaises(ExternalRequestError):
            self.consumer.handoff_reply(key, enqueue)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1]["recipient_id"], "agent-A")
        self.assertEqual(sent[0][1]["in_reply_to"], "message-1")
        self.assertEqual(self.consumer.snapshot(key)["result"], "A draft for hello")

    def test_changed_content_old_or_expired_approval_and_revocation_block_handoff(self):
        key = self.ready()
        row = self.journal.get(key)
        with self.assertRaises(ExternalRequestError):
            self.consumer.owner_decision(
                key, row["approval_id"], "changed-hash", "once"
            )
        self.approve(key)
        with self.assertRaises(ExternalRequestError):
            self.approve(key)
        self.current = False
        with self.assertRaises(ExternalRequestError):
            self.consumer.handoff_reply(key, self.fail_enqueue)
        self.current = True
        self.now = 1001
        with self.assertRaises(ExternalRequestError):
            self.consumer.handoff_reply(key, self.fail_enqueue)

    def test_reply_response_loss_is_unknown_and_only_receipt_reconciliation_completes(
        self,
    ):
        key = self.ready()
        self.approve(key)
        saved = {}

        def lost(identity, action):
            saved[identity] = action
            raise OSError("response lost after commit")

        self.assertEqual(self.consumer.handoff_reply(key, lost)["state"], "unknown")
        self.reopen()
        self.assertEqual(self.consumer.run_once(key)["state"], "unknown")
        row = self.journal.get(key)
        self.assertEqual(
            self.consumer.reconcile(key, lambda i: None)["state"], "unknown"
        )
        self.assertEqual(
            self.consumer.reconcile(
                key, lambda i: {"durable": True, "id": i} if i in saved else None
            )["state"],
            "completed",
        )
        self.assertEqual(len(saved), 1)
        self.assertEqual(row["consumed"], 1)

    def test_crashed_or_uncertain_model_is_never_reinvoked(self):
        key = self.consumer.prepare(self.request)["key"]
        self.journal.transition(key, "prepared", "running")
        self.reopen()
        self.assertEqual(self.consumer.run_once(key)["state"], "unknown")
        self.assertFalse(self.model.calls)
        key2 = self.consumer.prepare(replace(self.request, message_id="message-2"))[
            "key"
        ]
        self.model.fail = True
        self.assertEqual(self.consumer.run_once(key2)["state"], "unknown")
        self.consumer.run_once(key2)
        self.assertEqual(len(self.model.calls), 1)
        self.assertNotIn("private provider", str(self.consumer.snapshot(key2)))

    def test_backup_restore_with_rotated_external_epoch_cannot_revive_consumed_approval(
        self,
    ):
        key = self.ready()
        backup = self.root / "backup.sqlite"
        with closing(sqlite3.connect(backup)) as target:
            self.journal.db.backup(target)
        self.approve(key)
        self.consumer.handoff_reply(key, lambda i, a: {"durable": True, "id": i})
        self.journal.close()
        self.journal = None
        shutil.copyfile(backup, self.path)
        self.binding = replace(self.binding, authority_epoch="epoch-after-restore")
        self.open()
        self.assertEqual(self.journal.get(key)["state"], "unknown")
        with self.assertRaises(ExternalRequestError):
            self.approve(key)
        with self.assertRaises(ExternalRequestError):
            self.consumer.handoff_reply(key, self.fail_enqueue)

    def test_single_owner_scope_and_capacity(self):
        with self.assertRaises(sqlite3.OperationalError):
            NativeJournal(self.path, self.binding)
        self.journal.max_records = 1
        self.consumer.prepare(self.request)
        with self.assertRaises(ExternalRequestError):
            self.consumer.prepare(replace(self.request, message_id="message-2"))
        self.assertFalse(self.model.calls)

    def test_work_deadline_is_independent_and_expires_before_start(self):
        key = self.consumer.prepare(self.request)["key"]
        self.now = self.request.work_deadline
        self.assertEqual(self.consumer.run_once(key)["state"], "rejected")
        self.assertFalse(self.model.calls)

    @staticmethod
    def fail_enqueue(*args):
        raise AssertionError("enqueue must not be reached")

    def test_owner_scopes_never_alias_the_same_sender_message(self):
        a = self.consumer.prepare(self.request)
        b = self.consumer.prepare(
            replace(self.request, owner_scope="other-origin-owner")
        )
        self.assertNotEqual(a["key"], b["key"])
        self.assertFalse(self.model.calls)

    def test_denial_or_expiry_never_releases_draft(self):
        for index, expired in enumerate((False, True)):
            request = replace(self.request, message_id=f"denial-{index}")
            key = self.consumer.prepare(request)["key"]
            self.consumer.run_once(key)
            row = self.consumer.request_reply_approval(key, 200)
            self.now = 201 if expired else 100
            result = self.consumer.owner_decision(
                key,
                row["approval_id"],
                row["approval_hash"],
                "once" if expired else "deny",
            )
            self.assertEqual(result["state"], "rejected")
            self.assertIsNone(self.consumer.snapshot(key)["result"])
            with self.assertRaises(ExternalRequestError):
                self.consumer.handoff_reply(key, self.fail_enqueue)
            self.now = 100
