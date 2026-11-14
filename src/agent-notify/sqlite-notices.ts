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
CREATE INDEX IF NOT EXISTS notices_state ON notices(state,expires_at);`;

/** Rows are kept this long after the reply deadline, then removed. */
export const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  sender_id: string;
  message_id: string;
  state: NoticeState;
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
      this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
      this.#db.exec(SCHEMA);
      this.#db
        .prepare("INSERT OR IGNORE INTO notices_meta(id,target) VALUES(1,?)")
        .run(target);
      const bound = this.#db
        .prepare("SELECT target FROM notices_meta WHERE id=1")
        .get() as { target: string };
      if (bound.target !== target)
        throw new MessagingError("notices_target_mismatch");
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
  /** Marks undecided rows past their deadline expired and drops old rows. */
  maintain(now: number): NoticeRecord[] {
    const expired = (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state IN ('shown','later') AND expires_at<=?",
        )
        .all(now) as unknown as Row[]
    ).map((row) => this.#record(row));
    // A notice never shown (`showing`) expires too, without a report.
    this.#db
      .prepare(
        "UPDATE notices SET state='expired',decided_at=? WHERE state IN ('showing','shown','later') AND expires_at<=?",
      )
      .run(now, now);
    this.#db
      .prepare("DELETE FROM notices WHERE expires_at<=?")
      .run(now - NOTICE_RETENTION_MS);
    return expired;
  }
}
