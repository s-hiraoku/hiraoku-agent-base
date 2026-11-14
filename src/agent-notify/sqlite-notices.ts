/** The notifier's decision record: one row per message, with guarded state changes. */
import { DatabaseSync } from "node:sqlite";
import type { NoticeRecord, NoticeState, PeekedMessage } from "./contract.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS notices(
  message_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  sender TEXT,
  expires_at INTEGER NOT NULL,
  shown_at INTEGER NOT NULL,
  decided_at INTEGER,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_state ON notices(state,expires_at);`;

/** Rows are kept this long after the reply deadline, then removed. */
export const NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  message_id: string;
  target: string;
  state: NoticeState;
  sender: string | null;
  expires_at: number;
  shown_at: number;
  decided_at: number | null;
  message: string;
}
const record = (row: Row): NoticeRecord => ({
  message_id: row.message_id,
  target: row.target,
  state: row.state,
  from: row.sender,
  expires_at: new Date(row.expires_at).toISOString(),
  shown_at: new Date(row.shown_at).toISOString(),
  decided_at:
    row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
  message: JSON.parse(row.message) as PeekedMessage,
});

export class SQLiteNotices {
  readonly #db: DatabaseSync;
  readonly #target: string;
  constructor(path: string, target: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
    this.#db.exec(SCHEMA);
    this.#target = target;
  }
  close() {
    this.#db.close();
  }
  get(messageId: string): NoticeRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM notices WHERE message_id=?")
      .get(messageId) as Row | undefined;
    return row && record(row);
  }
  /** Records a message as shown. False when it was already recorded. */
  insertShown(message: PeekedMessage, now: number): boolean {
    const result = this.#db
      .prepare(
        "INSERT OR IGNORE INTO notices(message_id,target,state,sender,expires_at,shown_at,decided_at,message) VALUES(?,?,'shown',?,?,?,NULL,?)",
      )
      .run(
        message.message_id,
        this.#target,
        message.from,
        Date.parse(message.expires_at),
        now,
        JSON.stringify(message),
      );
    return result.changes === 1;
  }
  /** Removes a row whose notice could not be shown, so the next check shows it again. */
  forget(messageId: string) {
    this.#db
      .prepare("DELETE FROM notices WHERE message_id=? AND state='shown'")
      .run(messageId);
  }
  /** Moves one row only from one of `from`; false when another caller got there first. */
  transition(
    messageId: string,
    from: readonly NoticeState[],
    to: NoticeState,
    now: number,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE notices SET state=?,decided_at=? WHERE message_id=? AND state IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, now, messageId, ...from);
    return result.changes === 1;
  }
  /** Messages waiting for a choice: shown or later, oldest first. */
  open(): NoticeRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state IN ('shown','later') ORDER BY shown_at,message_id",
        )
        .all() as unknown as Row[]
    ).map(record);
  }
  /** Marks undecided rows past their deadline expired and drops old rows. */
  maintain(now: number): NoticeRecord[] {
    const expired = (
      this.#db
        .prepare(
          "SELECT * FROM notices WHERE state IN ('shown','later') AND expires_at<=?",
        )
        .all(now) as unknown as Row[]
    ).map(record);
    this.#db
      .prepare(
        "UPDATE notices SET state='expired',decided_at=? WHERE state IN ('shown','later') AND expires_at<=?",
      )
      .run(now, now);
    this.#db
      .prepare("DELETE FROM notices WHERE expires_at<=?")
      .run(now - NOTICE_RETENTION_MS);
    return expired;
  }
}
