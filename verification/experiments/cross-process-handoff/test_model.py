"""Synthetic failure/interleaving checks of the proposed transaction authority."""
import tempfile
import unittest
import subprocess
import sys
import sqlite3
from pathlib import Path
from model import Authority, Refused


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "synthetic.sqlite"
        self.a = Authority(self.path)
        self.b = Authority(self.path)

    def tearDown(self):
        self.b.close()
        self.a.close()
        self.directory.cleanup()

    def grant(self, budget=1):
        self.a.configure(budget)
        self.a.permit("source", True)

    def ready(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        self.a.start("source", 0)
        self.a.fix_reply("source", 0, {"id": "fixed", "text": "synthetic", "expires": 100})

    def test_default_deny(self):
        with self.assertRaises(Refused):
            self.a.admit("source", "hash", 0)
        self.assertIsNone(self.a.inspect("source"))

    def test_admission_abort_rolls_back_budget(self):
        self.grant()
        with self.assertRaises(Refused):
            self.a.admit("source", "hash", 0, fail_before_commit=True)
        self.assertIsNone(self.b.inspect("source"))
        self.assertEqual(self.b.admit("source", "hash", 0), "admitted")

    def test_duplicate_admission_does_not_spend_or_restart(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        self.a.start("source", 0)
        self.assertEqual(self.b.admit("source", "hash", 0), "running")
        with self.assertRaises(Refused):
            self.b.start("source", 0)
        self.assertEqual(self.a.db.execute("SELECT remaining FROM control").fetchone(), (0,))

    def test_changed_identity_conflicts(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        with self.assertRaises(Refused):
            self.b.admit("source", "different", 0)

    def test_revocation_before_enqueue_wins(self):
        self.ready()
        self.b.permit("source", False)
        with self.assertRaises(Refused):
            self.a.enqueue("source", 0)
        self.assertEqual(self.a.db.execute("SELECT count(*) FROM outbox").fetchone(), (0,))

    def test_commit_before_revocation_retains_exact_record_but_blocks_send(self):
        self.ready()
        self.a.enqueue("source", 0)
        self.b.permit("source", False)
        with self.assertRaises(Refused):
            self.a.send_eligible("source", 0)
        self.assertEqual(self.b.inspect("source")[2], "enqueued")

    def test_outbox_and_receipt_abort_together(self):
        self.ready()
        with self.assertRaises(Refused):
            self.a.enqueue("source", 0, fail_before_commit=True)
        self.assertEqual(self.b.inspect("source")[2], "reply_ready")
        self.assertEqual(self.b.db.execute("SELECT count(*) FROM outbox").fetchone(), (0,))

    def test_response_loss_reconciles_same_reply_after_reopen(self):
        self.ready()
        with self.assertRaises(Refused):
            self.a.enqueue("source", 0, lose_response=True)
        self.a.close()
        self.a = Authority(self.path)
        self.assertEqual(self.a.inspect("source")[2], "enqueued")
        self.a.enqueue("source", 0)
        self.assertEqual(self.b.db.execute("SELECT count(*) FROM outbox").fetchone(), (1,))

    def test_owner_change_parks_unknown_and_does_not_regrant(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        self.a.start("source", 0)
        self.b.stop()
        self.assertEqual(self.a.inspect("source")[2], "unknown")
        self.a.configure(1)
        with self.assertRaises(Refused):
            self.a.start("source", 1)
        self.a.permit("source", True)
        self.assertEqual(self.a.admit("source", "hash", 1), "unknown")
        with self.assertRaises(Refused):
            self.a.start("source", 1)

    def test_reply_is_immutable(self):
        self.ready()
        with self.assertRaises(Refused):
            self.a.fix_reply("source", 0, {"id": "replacement"})

    def test_source_grant_is_not_an_allow_all(self):
        self.grant(2)
        with self.assertRaises(Refused):
            self.a.admit("other-source", "hash", 0)

    def test_other_writer_cannot_revoke_inside_authority_transaction(self):
        self.grant()
        self.b.db.execute("PRAGMA busy_timeout=0")
        with self.a.transaction():
            self.a._check("source", 0)
            with self.assertRaises(sqlite3.OperationalError):
                self.b.permit("source", False)
        self.b.permit("source", False)
        with self.assertRaises(Refused):
            self.a.admit("source", "hash", 0)

    def test_old_worker_cannot_finalize_after_owner_change(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        self.a.start("source", 0)
        self.b.stop()
        with self.assertRaises(Refused):
            self.a.fix_reply("source", 0, {"id": "late"})
        self.assertIsNone(self.a.inspect("source")[3])

    def test_budget_exhaustion_refuses_a_new_permitted_source(self):
        self.grant()
        self.a.admit("source", "hash", 0)
        self.a.permit("second", True)
        with self.assertRaises(Refused):
            self.b.admit("second", "hash2", 0)

    def test_process_exit_before_outbox_commit_rolls_back_both_rows(self):
        self.ready()
        program = """
import os, sys
from model import Authority
a = Authority(sys.argv[1])
with a.transaction():
    a._check('source', 0)
    row = a.inspect('source')
    a.db.execute('INSERT INTO outbox VALUES(?,?,?)', ('source', row[3], 0))
    a.db.execute("UPDATE requests SET state='enqueued' WHERE source='source'")
    os._exit(17)
"""
        result = subprocess.run([sys.executable, "-B", "-c", program, str(self.path)],
                                cwd=Path(__file__).parent, check=False)
        self.assertEqual(result.returncode, 17)
        self.assertEqual(self.b.inspect("source")[2], "reply_ready")
        self.assertEqual(self.b.db.execute("SELECT count(*) FROM outbox").fetchone(), (0,))

    def test_process_exit_after_commit_retains_both_rows(self):
        self.ready()
        program = """
import os, sys
from model import Authority
a = Authority(sys.argv[1])
a.enqueue('source', 0)
os._exit(18)
"""
        result = subprocess.run([sys.executable, "-B", "-c", program, str(self.path)],
                                cwd=Path(__file__).parent, check=False)
        self.assertEqual(result.returncode, 18)
        self.assertEqual(self.b.inspect("source")[2], "enqueued")
        self.a.enqueue("source", 0)
        self.assertEqual(self.b.db.execute("SELECT count(*) FROM outbox").fetchone(), (1,))


if __name__ == "__main__":
    unittest.main()
