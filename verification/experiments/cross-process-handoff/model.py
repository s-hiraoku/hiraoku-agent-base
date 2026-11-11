"""Design experiment, NOT a product port, authorization provider or receiver.

An explicit single SQLite authority serializes *all* effective permission writes
with admission and outbox commit. No native API, model, secrets or network.
"""
import json
import sqlite3
from contextlib import contextmanager


class Refused(Exception):
    pass


class Authority:
    def __init__(self, path):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS control(
                id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL,
                enabled INTEGER NOT NULL, remaining INTEGER NOT NULL);
            INSERT OR IGNORE INTO control VALUES(1, 0, 0, 0);
            CREATE TABLE IF NOT EXISTS grants(source TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS requests(
                source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                epoch INTEGER NOT NULL, state TEXT NOT NULL, reply TEXT);
            CREATE TABLE IF NOT EXISTS outbox(
                source TEXT PRIMARY KEY, exact_reply TEXT NOT NULL, epoch INTEGER NOT NULL);
        """)

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def configure(self, remaining):
        """Synthetic trusted owner only; deliberately no RPC exposes this method."""
        if type(remaining) is not int or remaining < 0:
            raise Refused("invalid_budget")
        with self.transaction():
            self.db.execute("UPDATE control SET enabled=1, remaining=? WHERE id=1", (remaining,))

    def permit(self, source, allowed):
        """Effective policy change: the SAME transaction authority as enqueue."""
        with self.transaction():
            self.db.execute("INSERT INTO grants VALUES(?,?) ON CONFLICT(source) DO UPDATE SET allowed=excluded.allowed", (source, int(allowed)))

    def stop(self):
        with self.transaction():
            self.db.execute("UPDATE control SET enabled=0, epoch=epoch+1 WHERE id=1")
            self.db.execute("UPDATE grants SET allowed=0")
            # Admitted/running work cannot be claimed as absent on owner change.
            self.db.execute("UPDATE requests SET state='unknown' WHERE state='running'")

    def _check(self, source, epoch):
        current, enabled, remaining = self.db.execute("SELECT epoch,enabled,remaining FROM control").fetchone()
        grant = self.db.execute("SELECT allowed FROM grants WHERE source=?", (source,)).fetchone()
        if current != epoch or not enabled or grant != (1,):
            raise Refused("current_authority_required")
        return remaining

    def inspect(self, source):
        # Internal reference observation; not a public unauthenticated read API.
        return self.db.execute("SELECT fingerprint,epoch,state,reply FROM requests WHERE source=?", (source,)).fetchone()

    def admit(self, source, fingerprint, epoch, *, fail_before_commit=False):
        with self.transaction():
            remaining = self._check(source, epoch)
            prior = self.inspect(source)
            if prior:
                if prior[0] != fingerprint:
                    raise Refused("identity_conflict")
                return prior[2]
            if remaining == 0:
                raise Refused("budget_exhausted")
            self.db.execute("INSERT INTO requests VALUES(?,?,?,'admitted',NULL)", (source, fingerprint, epoch))
            self.db.execute("UPDATE control SET remaining=remaining-1")
            if fail_before_commit:
                raise Refused("injected_abort")
        return "admitted"

    def start(self, source, epoch):
        with self.transaction():
            self._check(source, epoch)
            if self.db.execute("UPDATE requests SET state='running' WHERE source=? AND epoch=? AND state='admitted'", (source, epoch)).rowcount != 1:
                raise Refused("not_startable")
        # Only now may a hypothetical native worker call a provider. This model never does.

    def fix_reply(self, source, epoch, envelope):
        exact = json.dumps(envelope, sort_keys=True, separators=(",", ":"))
        with self.transaction():
            self._check(source, epoch)
            prior = self.inspect(source)
            if not prior or prior[1] != epoch:
                raise Refused("missing_admission")
            if prior[3] is not None:
                if prior[3] != exact:
                    raise Refused("reply_conflict")
                return
            if prior[2] != "running":
                raise Refused("not_running")
            self.db.execute("UPDATE requests SET state='reply_ready',reply=? WHERE source=?", (exact, source))

    def enqueue(self, source, epoch, *, fail_before_commit=False, lose_response=False):
        with self.transaction():
            self._check(source, epoch)
            prior = self.inspect(source)
            if not prior or prior[1] != epoch or prior[2] not in ("reply_ready", "enqueued"):
                raise Refused("reply_unavailable")
            saved = self.db.execute("SELECT exact_reply,epoch FROM outbox WHERE source=?", (source,)).fetchone()
            if saved and saved != (prior[3], epoch):
                raise Refused("outbox_conflict")
            self.db.execute("INSERT OR IGNORE INTO outbox VALUES(?,?,?)", (source, prior[3], epoch))
            self.db.execute("UPDATE requests SET state='enqueued' WHERE source=?", (source,))
            if fail_before_commit:
                raise Refused("injected_abort")
        if lose_response:
            raise Refused("injected_response_loss")

    def send_eligible(self, source, epoch):
        """Observation only; never a network send or a durable permission token."""
        with self.transaction():
            self._check(source, epoch)
            return self.db.execute("SELECT exact_reply FROM outbox WHERE source=? AND epoch=?", (source, epoch)).fetchone() is not None
