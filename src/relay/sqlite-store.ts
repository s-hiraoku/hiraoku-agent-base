/** SQLite infrastructure adapter. Explicit open and migrate; never imports HAB/Task code. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { RelayError } from "./service.ts";
import type {
  Acceptance,
  AcceptanceStore,
  Receipt,
  ReceiptQuery,
} from "./service.ts";

export interface StoreOptions {
  fingerprint_key: Uint8Array;
  max_pending: number;
  max_records: number;
  max_pending_per_recipient: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
}
const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE relay_schema(version INTEGER NOT NULL, fingerprint_key_check TEXT NOT NULL);
CREATE TABLE relay_threads(id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL);
CREATE TABLE relay_messages(
 sender_id TEXT NOT NULL, message_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES relay_threads(id),
 fingerprint TEXT NOT NULL, accepted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','expired')), body TEXT,
 body_bytes INTEGER NOT NULL CHECK(body_bytes>=0),
 PRIMARY KEY(sender_id,message_id));
CREATE TABLE relay_deliveries(
 sender_id TEXT NOT NULL, message_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','expired')),
 PRIMARY KEY(sender_id,message_id),
 FOREIGN KEY(sender_id,message_id) REFERENCES relay_messages(sender_id,message_id));
CREATE TABLE relay_delivery_audit(
 id INTEGER PRIMARY KEY, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
 at INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('accepted','expired')));
CREATE INDEX relay_messages_pending ON relay_messages(state,recipient_id,expires_at);
`;
type Row = {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  receipt_id: string;
  accepted_at: number;
  expires_at: number;
  state: "pending" | "expired";
  fingerprint: string;
  thread_id: string;
};
function receipt(row: Row): Receipt {
  return {
    sender_id: row.sender_id,
    message_id: row.message_id,
    recipient_id: row.recipient_id,
    receipt_id: row.receipt_id,
    accepted_at: new Date(row.accepted_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    state: row.state,
  };
}
export class SQLiteRelayStore implements AcceptanceStore {
  readonly #db: DatabaseSync;
  readonly #options: StoreOptions;
  #ready = false;
  constructor(path: string, options: StoreOptions) {
    for (const k of [
      "max_pending",
      "max_records",
      "max_pending_per_recipient",
      "max_body_bytes",
    ] as const)
      if (!Number.isSafeInteger(options[k]) || options[k] < 1)
        throw new RelayError("invalid_store_options");
    if (
      !Number.isSafeInteger(options.max_clock_skew_ms) ||
      options.max_clock_skew_ms < 0 ||
      options.max_clock_skew_ms > 60000 ||
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.byteLength < 32
    )
      throw new RelayError("invalid_store_options");
    this.#options = {
      ...options,
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    } catch (e) {
      this.#db.close();
      throw e;
    }
  }
  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  #keyCheck() {
    return createHash("sha256")
      .update(this.#options.fingerprint_key)
      .digest("hex");
  }
  /** Caller must explicitly authorize schema application to a dedicated Relay database. */
  migrate(): void {
    this.#ready = false;
    this.#tx(() => {
      const table = this.#db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='relay_schema'")
        .get();
      if (!table) {
        const others = this.#db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (others.length) throw new RelayError("unknown_schema");
        this.#db.exec(SCHEMA);
        this.#db
          .prepare("INSERT INTO relay_schema VALUES(?,?)")
          .run(SCHEMA_VERSION, this.#keyCheck());
      }
      const rows = this.#db
        .prepare("SELECT version,fingerprint_key_check FROM relay_schema")
        .all();
      if (rows.length !== 1 || rows[0].version !== SCHEMA_VERSION)
        throw new RelayError("unsupported_schema");
      if (rows[0].fingerprint_key_check !== this.#keyCheck())
        throw new RelayError("fingerprint_key_mismatch");
    });
    this.#ready = true;
  }
  #now(): number {
    if (!this.#ready) throw new RelayError("schema_not_ready");
    const row = this.#db
      .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS at")
      .get();
    if (!row || typeof row.at !== "number" || !Number.isSafeInteger(row.at))
      throw new RelayError("invalid_clock");
    return row.at;
  }
  #expire(now: number) {
    // Capture the transition and erase body in the same transaction as state change.
    this.#db
      .prepare(
        "INSERT INTO relay_delivery_audit(sender_id,message_id,at,event) SELECT sender_id,message_id,?,'expired' FROM relay_messages WHERE state='pending' AND expires_at<=?",
      )
      .run(now, now);
    this.#db
      .prepare(
        "UPDATE relay_deliveries SET state='expired' WHERE state='pending' AND EXISTS(SELECT 1 FROM relay_messages m WHERE m.sender_id=relay_deliveries.sender_id AND m.message_id=relay_deliveries.message_id AND m.expires_at<=?)",
      )
      .run(now);
    this.#db
      .prepare(
        "UPDATE relay_messages SET state='expired',body=NULL,body_bytes=0 WHERE state='pending' AND expires_at<=?",
      )
      .run(now);
  }
  accept(resolve: () => Acceptance): Receipt {
    return this.#tx(() => {
      const now = this.#now();
      const {
        message: m,
        sender_id: sender,
        comparison_material: material,
      } = resolve();
      // Managed attachments are fail-closed until the finalize/ownership port is implemented.
      if (m.body.parts.some((p) => p.type === "attachment"))
        throw new RelayError("attachment_store_unavailable");
      const fingerprint = createHmac("sha256", this.#options.fingerprint_key)
        .update(material)
        .digest("hex");
      const existing = this.#db
        .prepare(
          "SELECT * FROM relay_messages WHERE sender_id=? AND message_id=?",
        )
        .get(sender, m.message_id) as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new RelayError("idempotency_conflict");
        this.#expire(now);
        return receipt(
          this.#db
            .prepare(
              "SELECT * FROM relay_messages WHERE sender_id=? AND message_id=?",
            )
            .get(sender, m.message_id) as Row,
        );
      }
      const sent = Date.parse(m.first_sent_at),
        expires = Date.parse(m.expires_at);
      if (sent > now + this.#options.max_clock_skew_ms)
        throw new RelayError("clock_skew");
      if (expires <= now) throw new RelayError("expired_before_acceptance");
      this.#expire(now);
      const total = this.#db
        .prepare("SELECT count(*) n FROM relay_messages")
        .get()!;
      if (Number(total.n) >= this.#options.max_records)
        throw new RelayError("capacity_exceeded");
      const body = JSON.stringify(m),
        size = Buffer.byteLength(body);
      const usage = this.#db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(body_bytes),0) AS bytes,coalesce(sum(CASE WHEN recipient_id=? THEN 1 ELSE 0 END),0) AS recipient_n FROM relay_messages WHERE state='pending'",
        )
        .get(m.recipient_id)!;
      if (
        Number(usage.n) >= this.#options.max_pending ||
        Number(usage.recipient_n) >= this.#options.max_pending_per_recipient ||
        Number(usage.bytes) + size > this.#options.max_body_bytes
      )
        throw new RelayError("capacity_exceeded");
      const [a, b] = [sender, m.recipient_id].sort();
      const thread = this.#db
        .prepare("SELECT a,b FROM relay_threads WHERE id=?")
        .get(m.thread_id);
      if (thread && (thread.a !== a || thread.b !== b))
        throw new RelayError("invalid_reference");
      if (m.in_reply_to) {
        const parent = this.#db
          .prepare(
            "SELECT sender_id,recipient_id,thread_id FROM relay_messages WHERE sender_id=? AND message_id=?",
          )
          .get(m.in_reply_to.sender_id, m.in_reply_to.message_id);
        if (
          !parent ||
          parent.sender_id !== m.recipient_id ||
          parent.recipient_id !== sender ||
          parent.thread_id !== m.thread_id
        )
          throw new RelayError("invalid_reference");
      }
      if (!thread)
        this.#db
          .prepare("INSERT INTO relay_threads VALUES(?,?,?)")
          .run(m.thread_id, a, b);
      const row: Row = {
        sender_id: sender,
        message_id: m.message_id,
        recipient_id: m.recipient_id,
        receipt_id: randomUUID(),
        thread_id: m.thread_id,
        fingerprint,
        accepted_at: now,
        expires_at: expires,
        state: "pending",
      };
      this.#db
        .prepare(
          "INSERT INTO relay_messages VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
        )
        .run(
          sender,
          m.message_id,
          m.recipient_id,
          row.receipt_id,
          m.thread_id,
          fingerprint,
          now,
          expires,
          body,
          size,
        );
      this.#db
        .prepare("INSERT INTO relay_deliveries VALUES(?,?,?,'pending')")
        .run(sender, m.message_id, m.recipient_id);
      this.#db
        .prepare(
          "INSERT INTO relay_delivery_audit(sender_id,message_id,at,event) VALUES(?,?,?,'accepted')",
        )
        .run(sender, m.message_id, now);
      return receipt(row);
    });
  }
  status(resolve: () => ReceiptQuery): Receipt {
    return this.#tx(() => {
      const now = this.#now();
      const q = resolve();
      this.#expire(now);
      const row = this.#db
        .prepare(
          "SELECT * FROM relay_messages WHERE sender_id=? AND message_id=?",
        )
        .get(q.sender_id, q.message_id) as Row | undefined;
      if (!row) throw new RelayError("not_found");
      return receipt(row);
    });
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
