import io
import json
import tempfile
import unittest
from pathlib import Path

from hermes_bridge import desktop_session as probe


class FakeDB:
    def __init__(self, rows=None, fail=False, tips=None):
        self.rows, self.fail, self.closed = rows or {}, fail, False
        self.tips = tips or {}

    def get_session(self, session_id):
        if self.fail:
            raise RuntimeError("database is locked")
        return self.rows.get(session_id)

    def get_compression_tip(self, session_id):
        return self.tips.get(session_id)

    def close(self):
        self.closed = True


SESSION = "20261114_101500_ab12cd"


class DesktopSessionTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        (self.home / "state.db").write_bytes(b"")

    def check(self, db, home=None, session_id=SESSION):
        opened = []

        def open_db(path):
            opened.append(path)
            if isinstance(db, Exception):
                raise db
            return db

        result = probe.presence(session_id, home or self.home, open_db=open_db)
        return result, opened

    def test_an_existing_conversation_is_present(self):
        db = FakeDB({SESSION: {"id": SESSION, "archived": 0}})
        result, opened = self.check(db)
        self.assertEqual(result, {"result": "present"})
        self.assertEqual(opened, [self.home / "state.db"])
        self.assertTrue(db.closed)

    def test_a_missing_or_archived_conversation_is_gone(self):
        self.assertEqual(self.check(FakeDB())[0], {"result": "gone", "reason": "not_found"})
        archived = FakeDB({SESSION: {"id": SESSION, "archived": 1}})
        self.assertEqual(self.check(archived)[0], {"result": "gone", "reason": "archived"})

    def test_only_the_current_compression_tip_can_show_cards(self):
        tip = "20261114_102000_ef34ab"
        db = FakeDB(
            {SESSION: {"id": SESSION}, tip: {"id": tip}},
            tips={SESSION: tip},
        )
        self.assertEqual(self.check(db)[0], {"result": "gone", "reason": "compressed"})
        self.assertEqual(self.check(db, session_id=tip)[0], {"result": "present"})

    def test_a_failure_is_unknown_never_gone(self):
        self.assertEqual(self.check(FakeDB(fail=True))[0]["result"], "unknown")
        self.assertEqual(self.check(ImportError("hermes_state"))[0]["result"], "unknown")
        empty = Path(tempfile.mkdtemp())
        result, opened = self.check(FakeDB(), home=empty)
        self.assertEqual(result, {"result": "unknown", "reason": "no_state_db"})
        self.assertEqual(opened, [])

    def test_invalid_input_exits_2_without_reading(self):
        out = io.StringIO()
        for raw in ['{"session_id": "../x"}', '{"session_id": "a", "text": "x"}', "nope"]:
            self.assertEqual(probe.main(io.StringIO(raw), out), 2)
        self.assertEqual({json.loads(line)["result"] for line in out.getvalue().splitlines()},
                         {"unknown"})

    def test_parse_request_takes_only_the_session_id(self):
        self.assertEqual(probe.parse_request(json.dumps({"session_id": SESSION})), SESSION)


if __name__ == "__main__":
    unittest.main()
