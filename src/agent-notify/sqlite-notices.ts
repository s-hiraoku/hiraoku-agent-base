/**
 * The notifier's decision record: one row per message, keyed by (sender_id, message_id),
 * with guarded state changes. A store belongs to the one session target it was created
 * for; opening it for another target is refused, so a choice made for one session can
 * never be handed to another.
 */
import { DatabaseSync } from "node:sqlite";
import { MessagingError } from "../messaging/delivery-service.ts";
import { ensurePrivateFile } from "./private-file.ts";
import type { NoticeRecord, NoticeState, PeekedMessage } from "./contract.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS notices_meta(
  id INTEGER PRIMARY KEY CHECK(id=1),
  target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices(
  sender_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL,
  sender TEXT,
  expires_at INTEGER NOT NULL,
  shown_at INTEGER NOT NULL,
  decided_at INTEGER,
  message TEXT NOT NULL,
  PRIMARY KEY(sender_id,message_id)
);
CREATE INDEX IF NOT EXISTS notices_state ON notices(state,expires_at);
CREATE TABLE IF NOT EXISTS auto_accepts(
  sender_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(sender_id,message_id)
);
CREATE INDEX IF NOT EXISTS auto_accepts_sender ON auto_accepts(sender_id,accepted_at);
CREATE INDEX IF NOT EXISTS auto_accepts_thread ON auto_accepts(sender_id,thread_id);`;

/**
 * An `accepting` claim older than this was left by a notifier that stopped mid-handoff (a
 * handoff command may run at most 5 minutes). It becomes `unknown`: the request may or may
 * not have reached the session, so it is never resent by itself.
 */
export const ACCEPTING_ABANDONED_MS = 15 * 60 * 1000;

/**
 * A `declining` claim older than this is retried: a decline in progress tells HAB within
 * the 30-second call limit, so an older one failed or was left by a stopped notifier.
 */
export const DECLINE_RETRY_MS = 60 * 1000;

/** Rows are kept this long after the reply deadline, then removed. */
export const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  sender_id: string;
  message_id: string;
  state: NoticeState;
  revision: number;
  sender: string | null;
  expires_at: number;
  shown_at: number;
  decided_at: number | null;
  message: string;
}
export interface NoticeKey {
  sender_id: string;
  message_id: string;
}

export class SQLiteNotices {
  readonly #db: DatabaseSync;
  readonly #target: string;
  constructor(path: string, target: string) {
    // The rows hold message text: owner-only, like the other SQLite stores. SQLite gives the
    // WAL and shared-memory files the database file's permissions.
    if (path !== ":memory:") {
      ensurePrivateFile(path, "insecure_notices_file");
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA busy_timeout=5000");
      // Refuse an existing foreign binding before even journal-mode/schema migration.
      // Repeat the check under the write lock below to cover competing initializers.
      const checkBinding = () => {
        const meta = this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notices_meta'",
          )
          .get();
        if (!meta) return;
        const bound = this.#db
          .prepare("SELECT target FROM notices_meta WHERE id=1")
          .get() as { target: string } | undefined;
        if (bound && bound.target !== target)
          throw new MessagingError("notices_target_mismatch");
      };
      checkBinding();
      this.#db.exec("PRAGMA journal_mode=WAL");
      // Upgrade existing stores without changing their binding or decisions. A durable
      // store-wide sequence survives clock changes, concurrent writers and restarts.
      const columns = (table: string) =>
        this.#db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[];
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        checkBinding();
        this.#db.exec(SCHEMA);
        this.#db
          .prepare("INSERT OR IGNORE INTO notices_meta(id,target) VALUES(1,?)")
          .run(target);
        checkBinding();
        if (
          !columns("notices_meta").some((column) => column.name === "revision")
        )
          this.#db.exec(
            "ALTER TABLE notices_meta ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
          );
        if (!columns("notices").some((column) => column.name === "revision"))
          this.#db.exec(
            "ALTER TABLE notices ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
          );
        this.#db.exec(`
          CREATE TRIGGER IF NOT EXISTS notices_insert_revision AFTER INSERT ON notices BEGIN
            UPDATE notices_meta SET revision=revision+1 WHERE id=1;
            UPDATE notices SET revision=(SELECT revision FROM notices_meta WHERE id=1)
              WHERE sender_id=NEW.sender_id AND message_id=NEW.message_id;
          END;
          CREATE TRIGGER IF NOT EXISTS notices_state_revision AFTER UPDATE OF state ON notices BEGIN
            UPDATE notices_meta SET revision=revision+1 WHERE id=1;
            UPDATE notices SET revision=(SELECT revision FROM notices_meta WHERE id=1)
              WHERE sender_id=NEW.sender_id AND message_id=NEW.message_id;
          END;
        `);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#target = target;
  }
  get target() {
    return this.#target;
  }
  close() {
    this.#db.close();
  }
  #record(row: Row): NoticeRecord {
    return {
      message_id: row.message_id,
      sender_id: row.sender_id,
      target: this.#target,
      state: row.state,
      revision: row.revision,
      from: row.sender,
      expires_at: new Date(row.expires_at).toISOString(),
      shown_at: new Date(row.shown_at).toISOString(),
      decided_at:
        row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
      message: JSON.parse(row.message) as PeekedMessage,
    };
  }
  /** Every notice with this message ID (more than one only if two senders chose it). */
  find(messageId: string): NoticeRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM notices WHERE message_id=? ORDER BY sender_id")
        .all(messageId) as unknown as Row[]
    ).map((row) => this.#record(row));
  }
  get(key: NoticeKey): NoticeRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM notices WHERE sender_id=? AND message_id=?")
      .get(key.sender_id, key.message_id) as Row | undefined;
    return row && this.#record(row);
  }
  /** Records a message about to be shown. False when it was already recorded. */
  insertShowing(message: PeekedMessage, now: number): boolean {
    const result = this.#db
      .prepare(
        "INSERT OR IGNORE INTO notices(sender_id,message_id,state,sender,expires_at,shown_at,decided_at,message) VALUES(?,?,'showing',?,?,?,NULL,?)",
      )
      .run(
        message.sender_id,
        message.message_id,
        message.from,
        Date.parse(message.expires_at),
        now,
        JSON.stringify(message),
      );
    return result.changes === 1;
  }
  /** Moves one row only from one of `from`; false when another caller got there first. */
  transition(
    key: NoticeKey,
    from: readonly NoticeState[],
    to: NoticeState,
    now: number,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE notices SET state=?,decided_at=? WHERE sender_id=? AND message_id=? AND state IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, now, key.sender_id, key.message_id, ...from);
    return result.changes === 1;
  }
  /** Authoritative mutable state, independent of the immutable notice/event cursor. */
  states() {
    return {
      binding_id: this.#target,
      states: this.all().map(({ sender_id, message_id, state, revision }) => ({
        sender_id,
        message_id,
        state,
        revision,
      })),
    };
  }
  /** Messages waiting for a choice: shown or later, oldest first. */
  open(): NoticeRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state IN ('shown','later') ORDER BY shown_at,sender_id,message_id",
        )
        .all() as unknown as Row[]
    ).map((row) => this.#record(row));
  }
  /** Turns `accepting` claims abandoned by a stopped notifier into `unknown`. */
  abandon(now: number): NoticeRecord[] {
    const cutoff = now - ACCEPTING_ABANDONED_MS;
    const rows = (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state='accepting' AND decided_at<=?",
        )
        .all(cutoff) as unknown as Row[]
    ).map((row) => this.#record(row));
    return rows.filter((row) =>
      this.transition(row, ["accepting"], "unknown", now),
    );
  }
  /** `declining` claims that failed or were left by a stopped notifier (older than a running decline can be). */
  stuckDeclines(now: number): NoticeRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state='declining' AND decided_at<=?",
        )
        .all(now - DECLINE_RETRY_MS) as unknown as Row[]
    ).map((row) => this.#record(row));
  }
  /** 対応する choices waiting for HAB, oldest first. */
  waitingAccepts(): NoticeRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state='accept_waiting' ORDER BY decided_at,sender_id,message_id",
        )
        .all() as unknown as Row[]
    ).map((row) => this.#record(row));
  }
  /**
   * Notes an automatic 対応する (ADR-023), so the per-sender and per-thread caps hold across
   * restarts. Kept as long as the notice row itself.
   */
  recordAutoAccept(
    key: NoticeKey,
    threadId: string,
    rule: string,
    now: number,
  ): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO auto_accepts(sender_id,message_id,thread_id,rule,accepted_at) VALUES(?,?,?,?,?)",
      )
      .run(key.sender_id, key.message_id, threadId, rule, now);
  }
  /** Whether this message was handed off automatically, and by which rule. */
  autoAcceptRule(key: NoticeKey): string | undefined {
    const row = this.#db
      .prepare(
        "SELECT rule FROM auto_accepts WHERE sender_id=? AND message_id=?",
      )
      .get(key.sender_id, key.message_id) as { rule: string } | undefined;
    return row?.rule;
  }
  /** Automatic handoffs for one sender since a time, and in one of its threads. */
  autoAcceptCounts() {
    return {
      bySenderSince: (senderId: string, since: number) =>
        (
          this.#db
            .prepare(
              "SELECT COUNT(*) AS n FROM auto_accepts WHERE sender_id=? AND accepted_at>=?",
            )
            .get(senderId, since) as { n: number }
        ).n,
      // HAB names a thread by the agent pair and thread_id, so two senders' thread-1 differ.
      byThread: (senderId: string, threadId: string) =>
        (
          this.#db
            .prepare(
              "SELECT COUNT(*) AS n FROM auto_accepts WHERE sender_id=? AND thread_id=?",
            )
            .get(senderId, threadId) as { n: number }
        ).n,
    };
  }
  /** Every record of this target, oldest first: what each shown notice became. */
  all(): NoticeRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM notices ORDER BY shown_at,sender_id,message_id")
        .all() as unknown as Row[]
    ).map((row) => this.#record(row));
  }
  /** Marks undecided or still-waiting rows past their deadline expired and drops old rows. */
  maintain(now: number): NoticeRecord[] {
    const expired = (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state IN ('shown','later','accept_waiting') AND expires_at<=?",
        )
        .all(now) as unknown as Row[]
    ).map((row) => this.#record(row));
    // A notice never shown (`showing`) expires too, without a report.
    this.#db
      .prepare(
        "UPDATE notices SET state='expired',decided_at=? WHERE state IN ('showing','shown','later','accept_waiting') AND expires_at<=?",
      )
      .run(now, now);
    this.#db
      .prepare("DELETE FROM notices WHERE expires_at<=?")
      .run(now - NOTICE_RETENTION_MS);
    this.#db
      .prepare(
        "DELETE FROM auto_accepts WHERE NOT EXISTS (SELECT 1 FROM notices n WHERE n.sender_id=auto_accepts.sender_id AND n.message_id=auto_accepts.message_id)",
      )
      .run();
    return expired;
  }
}
