/** SQLite infrastructure adapter. Explicit open and migrate; never imports HAB/Task code. */
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  createHmac,
  randomUUID,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { RelayError } from "./service.ts";
import type {
  Acceptance,
  DeliveryStore,
  Delivery,
  AckReceipt,
  ReceiveAuthorization,
  Receipt,
  ReceiptQuery,
} from "./service.ts";
import type { AckRequest } from "./contract.ts";

export interface StoreOptions {
  fingerprint_key: Uint8Array;
  max_pending: number;
  max_records: number;
  max_pending_per_recipient: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
  poll_scan_limit: number;
}
const SCHEMA_VERSION = 2;
const TABLES = `
CREATE TABLE relay_messages(
 sender_id TEXT NOT NULL, message_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES relay_threads(id),
 fingerprint TEXT NOT NULL, accepted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','leased','acked','expired','quarantined')), body TEXT,
 body_bytes INTEGER NOT NULL CHECK(body_bytes>=0), kind TEXT NOT NULL,
 PRIMARY KEY(sender_id,message_id));
CREATE TABLE relay_deliveries(
 sender_id TEXT NOT NULL, message_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','leased','acked','expired','quarantined')),
 generation INTEGER NOT NULL DEFAULT 0, token_hash TEXT,
 lease_until INTEGER, next_visible_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(sender_id,message_id),
 FOREIGN KEY(sender_id,message_id) REFERENCES relay_messages(sender_id,message_id));
CREATE TABLE relay_delivery_audit(
 id INTEGER PRIMARY KEY, sender_id TEXT NOT NULL, message_id TEXT NOT NULL,
 at INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('accepted','expired','leased','requeued','quarantined','acked')));
CREATE TABLE relay_ack_receipts(
 recipient_id TEXT NOT NULL, request_id TEXT NOT NULL, sender_id TEXT NOT NULL,
 message_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE,
 acked_at INTEGER NOT NULL, PRIMARY KEY(recipient_id,request_id),
 UNIQUE(sender_id,message_id),
 FOREIGN KEY(sender_id,message_id) REFERENCES relay_messages(sender_id,message_id));
`;
const INDEXES = `CREATE INDEX IF NOT EXISTS relay_messages_pending ON relay_messages(state,recipient_id,expires_at);
CREATE INDEX IF NOT EXISTS relay_deliveries_recipient ON relay_deliveries(recipient_id,state,next_visible_at);
CREATE UNIQUE INDEX IF NOT EXISTS relay_one_live_lease ON relay_deliveries(recipient_id) WHERE state='leased';`;
const SCHEMA =
  `CREATE TABLE relay_schema(version INTEGER NOT NULL, fingerprint_key_check TEXT NOT NULL);
CREATE TABLE relay_threads(id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL);` +
  TABLES +
  INDEXES;
type Row = {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  receipt_id: string;
  accepted_at: number;
  expires_at: number;
  state: Receipt["state"];
  kind: string;
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
export class SQLiteRelayStore implements DeliveryStore {
  readonly #db: DatabaseSync;
  readonly #options: StoreOptions;
  #ready = false;
  constructor(path: string, options: StoreOptions) {
    for (const k of [
      "max_pending",
      "max_records",
      "max_pending_per_recipient",
      "max_body_bytes",
      "lease_ms",
      "max_attempts",
      "retry_base_ms",
      "retry_cap_ms",
      "poll_scan_limit",
    ] as const)
      if (!Number.isSafeInteger(options[k]) || options[k] < 1)
        throw new RelayError("invalid_store_options");
    if (
      options.lease_ms > 3600000 ||
      options.max_attempts > 1000 ||
      options.retry_cap_ms < options.retry_base_ms ||
      options.retry_cap_ms > 3600000
    )
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
      if (
        rows.length !== 1 ||
        (rows[0].version !== 1 && rows[0].version !== SCHEMA_VERSION)
      )
        throw new RelayError("unsupported_schema");
      if (rows[0].fingerprint_key_check !== this.#keyCheck())
        throw new RelayError("fingerprint_key_mismatch");
      if (rows[0].version === 1) {
        // Rebuild CHECK-constrained tables transactionally; preserve every v1 receipt.
        this.#db.exec(
          TABLES.replaceAll("relay_messages", "relay_messages_v2")
            .replaceAll("relay_deliveries", "relay_deliveries_v2")
            .replaceAll("relay_delivery_audit", "relay_delivery_audit_v2"),
        );
        this.#db
          .exec(`INSERT INTO relay_messages_v2 SELECT *,coalesce(json_extract(body,'$.kind'),'unknown') FROM relay_messages;
INSERT INTO relay_deliveries_v2(sender_id,message_id,recipient_id,state) SELECT sender_id,message_id,recipient_id,state FROM relay_deliveries;
INSERT INTO relay_delivery_audit_v2 SELECT * FROM relay_delivery_audit;
DROP TABLE relay_deliveries;
DROP TABLE relay_messages;
DROP TABLE relay_delivery_audit;
ALTER TABLE relay_messages_v2 RENAME TO relay_messages;
ALTER TABLE relay_deliveries_v2 RENAME TO relay_deliveries;
ALTER TABLE relay_delivery_audit_v2 RENAME TO relay_delivery_audit;
UPDATE relay_schema SET version=2;`);
        this.#db.exec(INDEXES);
      }
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
        "INSERT INTO relay_delivery_audit(sender_id,message_id,at,event) SELECT sender_id,message_id,?,'expired' FROM relay_messages WHERE state IN ('pending','leased','quarantined') AND expires_at<=?",
      )
      .run(now, now);
    this.#db
      .prepare(
        "UPDATE relay_deliveries SET state='expired',token_hash=NULL,lease_until=NULL WHERE state IN ('pending','leased','quarantined') AND EXISTS(SELECT 1 FROM relay_messages m WHERE m.sender_id=relay_deliveries.sender_id AND m.message_id=relay_deliveries.message_id AND m.expires_at<=?)",
      )
      .run(now);
    this.#db
      .prepare(
        "UPDATE relay_messages SET state='expired',body=NULL,body_bytes=0 WHERE state IN ('pending','leased','quarantined') AND expires_at<=?",
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
          "SELECT count(*) AS n,coalesce(sum(body_bytes),0) AS bytes,coalesce(sum(CASE WHEN recipient_id=? THEN 1 ELSE 0 END),0) AS recipient_n FROM relay_messages WHERE state IN ('pending','leased','quarantined')",
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
        kind: m.kind,
      };
      this.#db
        .prepare(
          "INSERT INTO relay_messages VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)",
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
          m.kind,
        );
      this.#db
        .prepare(
          "INSERT INTO relay_deliveries(sender_id,message_id,recipient_id,state) VALUES(?,?,?,'pending')",
        )
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
  #hash(domain: string, value: string): string {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + ":" + value)
      .digest("hex");
  }
  #audit(sender: string, message: string, now: number, event: string) {
    this.#db
      .prepare(
        "INSERT INTO relay_delivery_audit(sender_id,message_id,at,event) VALUES(?,?,?,?)",
      )
      .run(sender, message, now, event);
  }
  #requeue(now: number) {
    const expired = this.#db
      .prepare(
        "SELECT sender_id,message_id,attempts FROM relay_deliveries WHERE state='leased' AND lease_until<=?",
      )
      .all(now);
    for (const row of expired) {
      const state =
        Number(row.attempts) >= this.#options.max_attempts
          ? "quarantined"
          : "pending";
      this.#db
        .prepare(
          "UPDATE relay_deliveries SET state=?,token_hash=NULL,lease_until=NULL WHERE sender_id=? AND message_id=?",
        )
        .run(state, row.sender_id!, row.message_id!);
      this.#db
        .prepare(
          "UPDATE relay_messages SET state=? WHERE sender_id=? AND message_id=?",
        )
        .run(state, row.sender_id!, row.message_id!);
      this.#audit(
        String(row.sender_id),
        String(row.message_id),
        now,
        state === "pending" ? "requeued" : "quarantined",
      );
    }
  }
  poll(authorize: ReceiveAuthorization): Delivery | null {
    return this.#tx(() => {
      const now = this.#now(),
        receiver = authorize();
      this.#expire(now);
      this.#requeue(now);
      // One durable in-flight lease per receiver, shared by every process/connection.
      if (
        this.#db
          .prepare(
            "SELECT 1 FROM relay_deliveries WHERE recipient_id=? AND state='leased'",
          )
          .get(receiver)
      )
        return null;
      const rows = this.#db
        .prepare(
          "SELECT m.*,d.generation,d.attempts FROM relay_messages m JOIN relay_deliveries d USING(sender_id,message_id) WHERE m.recipient_id=? AND d.state='pending' AND d.next_visible_at<=? AND m.expires_at>? ORDER BY m.accepted_at,m.sender_id,m.message_id LIMIT ?",
        )
        .all(receiver, now, now, this.#options.poll_scan_limit);
      for (const raw of rows) {
        const row = raw as unknown as Row & {
          body: string;
          generation: number;
          attempts: number;
        };
        try {
          if (
            authorize({ sender_id: row.sender_id, kind: row.kind }) !== receiver
          )
            throw new RelayError("forbidden");
        } catch (e) {
          if (e instanceof RelayError && e.code === "forbidden") continue;
          throw e;
        }
        const token = Buffer.from(randomBytes(32)).toString("base64url"),
          generation = row.generation + 1;
        const until = Math.min(now + this.#options.lease_ms, row.expires_at);
        const base = Math.min(
          this.#options.retry_cap_ms,
          this.#options.retry_base_ms * 2 ** row.attempts,
        );
        const jitter = randomInt(Math.max(1, Math.floor(base / 5) + 1));
        const retry = Math.min(this.#options.retry_cap_ms, base + jitter);
        this.#db
          .prepare(
            "UPDATE relay_deliveries SET state='leased',generation=?,token_hash=?,lease_until=?,next_visible_at=?,attempts=attempts+1 WHERE sender_id=? AND message_id=?",
          )
          .run(
            generation,
            this.#hash("lease", token),
            until,
            until + retry,
            row.sender_id,
            row.message_id,
          );
        this.#db
          .prepare(
            "UPDATE relay_messages SET state='leased' WHERE sender_id=? AND message_id=?",
          )
          .run(row.sender_id, row.message_id);
        this.#audit(row.sender_id, row.message_id, now, "leased");
        return {
          message: { ...JSON.parse(row.body), sender_id: row.sender_id },
          generation,
          lease_token: token,
          lease_until: new Date(until).toISOString(),
        };
      }
      return null;
    });
  }
  ack(request: AckRequest, authorize: ReceiveAuthorization): AckReceipt {
    return this.#tx(() => {
      const now = this.#now(),
        receiver = authorize();
      const row = this.#db
        .prepare(
          "SELECT m.*,d.generation,d.token_hash,d.lease_until FROM relay_messages m JOIN relay_deliveries d USING(sender_id,message_id) WHERE m.sender_id=? AND m.message_id=? AND m.recipient_id=?",
        )
        .get(request.sender_id, request.message_id, receiver) as
        | (Row & {
            generation: number;
            token_hash: string | null;
            lease_until: number | null;
          })
        | undefined;
      if (!row) throw new RelayError("invalid_ack");
      if (authorize({ sender_id: row.sender_id, kind: row.kind }) !== receiver)
        throw new RelayError("forbidden");
      const fingerprint = this.#hash("ack", JSON.stringify(request));
      const existing = this.#db
        .prepare(
          "SELECT * FROM relay_ack_receipts WHERE recipient_id=? AND request_id=?",
        )
        .get(receiver, request.request_id);
      const result = (receiptId: string, at: number): AckReceipt => ({
        recipient_id: receiver,
        sender_id: request.sender_id,
        message_id: request.message_id,
        request_id: request.request_id,
        receipt_id: receiptId,
        acked_at: new Date(at).toISOString(),
        state: "acked",
      });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new RelayError("ack_idempotency_conflict");
        return result(String(existing.receipt_id), Number(existing.acked_at));
      }
      const tokenHash = this.#hash("lease", request.lease_token);
      if (
        row.state !== "leased" ||
        row.generation !== request.generation ||
        !row.token_hash ||
        !timingSafeEqual(
          Buffer.from(row.token_hash, "hex"),
          Buffer.from(tokenHash, "hex"),
        ) ||
        row.lease_until === null ||
        row.lease_until <= now ||
        row.expires_at <= now
      )
        throw new RelayError("invalid_ack");
      const receiptId = randomUUID();
      this.#db
        .prepare("INSERT INTO relay_ack_receipts VALUES(?,?,?,?,?,?,?)")
        .run(
          receiver,
          request.request_id,
          request.sender_id,
          request.message_id,
          fingerprint,
          receiptId,
          now,
        );
      this.#db
        .prepare(
          "UPDATE relay_deliveries SET state='acked',token_hash=NULL,lease_until=NULL WHERE sender_id=? AND message_id=?",
        )
        .run(row.sender_id, row.message_id);
      this.#db
        .prepare(
          "UPDATE relay_messages SET state='acked',body=NULL,body_bytes=0 WHERE sender_id=? AND message_id=?",
        )
        .run(row.sender_id, row.message_id);
      this.#audit(row.sender_id, row.message_id, now, "acked");
      return result(receiptId, now);
    });
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
