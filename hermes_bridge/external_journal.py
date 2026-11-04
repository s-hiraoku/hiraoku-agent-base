"""Private native execution receipts, not a second HAB Task engine or inbox."""

from contextlib import contextmanager
from dataclasses import asdict
import json
import os
import stat
from pathlib import Path
import sqlite3

from hermes_bridge.external_contract import ExternalRequestError, canonical, digest


def _private_file(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ExternalRequestError("private_journal_required")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(fd)
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or (hasattr(os, "getuid") and info.st_uid != os.getuid())
    ):
        raise ExternalRequestError("private_journal_required")
    return path


class NativeJournal:
    def __init__(self, path, binding, *, max_records=1000):
        if type(max_records) is not int or not 1 <= max_records <= 10000:
            raise ExternalRequestError("invalid_capacity")
        self.binding, self.max_records = binding, max_records
        path = _private_file(path)
        self.owner = sqlite3.connect(
            _private_file(Path(str(path) + ".owner")), timeout=0
        )
        self.db = None
        try:
            self.owner.execute("PRAGMA journal_mode=DELETE")
            self.owner.execute("BEGIN EXCLUSIVE")
            self.db = sqlite3.connect(path, timeout=0, isolation_level=None)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript(
                "CREATE TABLE IF NOT EXISTS native_meta(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,epoch TEXT NOT NULL);"
                "CREATE TABLE IF NOT EXISTS native_runs(key TEXT PRIMARY KEY,request TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,result TEXT,approval_id TEXT,approval_hash TEXT,approval_deadline INTEGER,decision TEXT,decision_at INTEGER,decision_epoch TEXT,consumed INTEGER NOT NULL DEFAULT 0);"
            )
            with self.transaction():
                row = self.db.execute("SELECT * FROM native_meta WHERE id=1").fetchone()
                identity = canonical(binding.identity)
                if row is None:
                    self.db.execute(
                        "INSERT INTO native_meta VALUES(1,?,?)",
                        (identity, binding.authority_epoch),
                    )
                elif row["identity"] != identity:
                    raise ExternalRequestError("native_scope_mismatch")
                elif row["epoch"] != binding.authority_epoch:
                    # An external authority epoch must rotate on backup restore. Never
                    # resurrect a consumed grant or infer that a restored run did not execute.
                    self.db.execute(
                        "UPDATE native_runs SET state='unknown',decision=NULL,revision=revision+1 WHERE state NOT IN ('rejected','completed')"
                    )
                    self.db.execute(
                        "UPDATE native_meta SET epoch=? WHERE id=1",
                        (binding.authority_epoch,),
                    )
                self.db.execute(
                    "UPDATE native_runs SET state='unknown',revision=revision+1 WHERE state IN ('running','handoff_started')"
                )
        except BaseException:
            self.close()
            raise

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        self.owner.close()

    def get(self, key):
        row = self.db.execute(
            "SELECT * FROM native_runs WHERE key=?", (key,)
        ).fetchone()
        if row is None:
            raise ExternalRequestError("native_run_not_found")
        return dict(row)

    def prepare(self, request, now):
        if request.recipient_id != self.binding.recipient_id:
            raise ExternalRequestError("foreign_request")
        key, raw = request.key(self.binding), canonical(asdict(request))
        with self.transaction():
            row = self.db.execute(
                "SELECT * FROM native_runs WHERE key=?", (key,)
            ).fetchone()
            if row is not None:
                if row["request_hash"] != digest(json.loads(raw)):
                    raise ExternalRequestError("native_request_conflict")
                return dict(row)
            if request.work_deadline <= now:
                raise ExternalRequestError("work_expired")
            if (
                self.db.execute("SELECT count(*) FROM native_runs").fetchone()[0]
                >= self.max_records
            ):
                raise ExternalRequestError("native_capacity_exceeded")
            self.db.execute(
                "INSERT INTO native_runs(key,request,request_hash,state) VALUES(?,?,?,'prepared')",
                (key, raw, digest(json.loads(raw))),
            )
        return self.get(key)

    def transition(self, key, expected, state, *, result=None):
        with self.transaction():
            changed = self.db.execute(
                "UPDATE native_runs SET state=?,result=coalesce(?,result),revision=revision+1 WHERE key=? AND state=?",
                (state, result, key, expected),
            ).rowcount
            if changed != 1:
                raise ExternalRequestError("native_state_conflict")
        return self.get(key)

    def propose_reply(self, key, deadline):
        with self.transaction():
            row = self.get(key)
            if row["state"] == "awaiting_owner":
                return row
            if row["state"] != "result_ready":
                raise ExternalRequestError("native_state_conflict")
            request = json.loads(row["request"])
            action = {
                "operation": "reply",
                "recipient_id": request["sender_id"],
                "in_reply_to": request["message_id"],
                "task_id": request["task_id"],
                "text": row["result"],
            }
            action_hash = digest(action)
            approval_id = digest([key, "reply", action_hash])
            self.db.execute(
                "UPDATE native_runs SET state='awaiting_owner',approval_id=?,approval_hash=?,approval_deadline=?,decision=NULL,revision=revision+1 WHERE key=?",
                (approval_id, action_hash, deadline, key),
            )
        return self.get(key)

    def decide(self, key, approval_id, action_hash, choice, now):
        if choice not in ("once", "deny"):
            raise ExternalRequestError("native_decision_invalid")
        with self.transaction():
            row = self.get(key)
            if row["state"] != "awaiting_owner" or row["consumed"]:
                raise ExternalRequestError("native_state_conflict")
            if row["approval_id"] != approval_id or row["approval_hash"] != action_hash:
                raise ExternalRequestError("native_approval_conflict")
            state = (
                "rejected"
                if choice == "deny" or row["approval_deadline"] <= now
                else "reply_approved"
            )
            self.db.execute(
                "UPDATE native_runs SET state=?,decision=?,decision_at=?,decision_epoch=?,revision=revision+1 WHERE key=?",
                (state, choice, now, self.binding.authority_epoch, key),
            )
        return self.get(key)

    def handoff(self, key):
        with self.transaction():
            row = self.get(key)
            if row["state"] != "reply_approved" or row["consumed"]:
                raise ExternalRequestError("native_state_conflict")
            self.db.execute(
                "UPDATE native_runs SET state='handoff_started',consumed=1,revision=revision+1 WHERE key=?",
                (key,),
            )
        return self.get(key)
