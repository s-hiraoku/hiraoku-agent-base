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
import { agentCapacityPolicy, assertAgentCapacity } from "./agent-capacity.ts";
import type {
  AgentCapacityPolicy,
  SenderCapacityUsage,
} from "./agent-capacity.ts";
import { RelayError } from "./service.ts";
import type {
  Acceptance,
  DeliveryStore,
  Delivery,
  AckReceipt,
  ReceiveAuthorization,
  MaintenanceResult,
  Receipt,
  ReceiptQuery,
} from "./service.ts";
import type { AckRequest } from "./contract.ts";
import {
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  isReplayBoundMessageId,
} from "./contract.ts";

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
  agent_capacity?: AgentCapacityPolicy;
  fair_poll?: boolean;
}
const SCHEMA_VERSION = 6;
const MIGRATION_5 = `
CREATE TABLE relay_poll_cursors(recipient_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,updated_at INTEGER NOT NULL,fingerprint TEXT NOT NULL);
CREATE TABLE relay_poll_senders(recipient_id TEXT NOT NULL,sender_id TEXT NOT NULL,accepted_at INTEGER NOT NULL,message_id TEXT NOT NULL,updated_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(recipient_id,sender_id));
CREATE INDEX IF NOT EXISTS relay_messages_recipient_sender ON relay_messages(recipient_id,sender_id,state,accepted_at,message_id);
CREATE TRIGGER relay_poll_positions_terminal AFTER UPDATE OF state ON relay_messages WHEN NEW.state IN ('acked','expired') BEGIN
DELETE FROM relay_poll_senders WHERE recipient_id=NEW.recipient_id AND sender_id=NEW.sender_id AND NOT EXISTS(SELECT 1 FROM relay_messages WHERE recipient_id=NEW.recipient_id AND sender_id=NEW.sender_id AND state IN ('pending','leased','quarantined'));
DELETE FROM relay_poll_cursors WHERE recipient_id=NEW.recipient_id AND NOT EXISTS(SELECT 1 FROM relay_messages WHERE recipient_id=NEW.recipient_id AND state IN ('pending','leased','quarantined'));
END;
`;
const MIGRATION_6 = `DROP TABLE IF EXISTS relay_attachment_deletions;
DROP TABLE IF EXISTS relay_message_attachments;`;
type PollPosition = {
  recipient_id: string;
  sender_id: string;
  updated_at: number;
  fingerprint: string;
};
type SenderPosition = PollPosition & {
  accepted_at: number;
  message_id: string;
};

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
const MIGRATION_3 = `ALTER TABLE relay_messages ADD COLUMN terminal_at INTEGER;
ALTER TABLE relay_messages ADD COLUMN retain_until INTEGER;
CREATE INDEX relay_messages_retention ON relay_messages(state,retain_until);
CREATE TABLE relay_maintenance_totals(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL,expired INTEGER NOT NULL,purged INTEGER NOT NULL,threads INTEGER NOT NULL);
INSERT INTO relay_maintenance_totals VALUES(1,0,0,0,0);`;
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
    if (
      options.fair_poll !== undefined &&
      typeof options.fair_poll !== "boolean"
    )
      throw new RelayError("invalid_store_options");
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
      agent_capacity:
        options.agent_capacity === undefined
          ? undefined
          : agentCapacityPolicy(options.agent_capacity, options),
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    // Apply the finite busy wait before initialization PRAGMAs can read a locked schema.
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#db.function(
        "relay_gc_safe",
        { deterministic: true },
        (id, expires) => (isReplayBoundMessageId(id, expires) ? 1 : 0),
      );
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
          .run(2, this.#keyCheck());
      }
      const rows = this.#db
        .prepare("SELECT version,fingerprint_key_check FROM relay_schema")
        .all();
      if (
        rows.length !== 1 ||
        (rows[0].version !== 1 &&
          rows[0].version !== 2 &&
          rows[0].version !== 3 &&
          rows[0].version !== 4 &&
          rows[0].version !== 5 &&
          rows[0].version !== SCHEMA_VERSION)
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
      if (Number(rows[0].version) < 3) {
        this.#db.exec(MIGRATION_3);
        this.#db
          .prepare(
            "UPDATE relay_messages SET terminal_at=expires_at,retain_until=expires_at+? WHERE state='expired'",
          )
          .run(RECORD_RETENTION_MS);
        this.#db
          .prepare(
            "UPDATE relay_messages SET terminal_at=(SELECT acked_at FROM relay_ack_receipts a WHERE a.sender_id=relay_messages.sender_id AND a.message_id=relay_messages.message_id),retain_until=max(expires_at,(SELECT acked_at+? FROM relay_ack_receipts a WHERE a.sender_id=relay_messages.sender_id AND a.message_id=relay_messages.message_id))+? WHERE state='acked'",
          )
          .run(MAX_ACK_RETRY_MS, RECORD_RETENTION_MS);
        this.#db.exec("UPDATE relay_schema SET version=3");
      }
      if (Number(rows[0].version) < 5) {
        this.#db.exec(MIGRATION_5);
        this.#db.exec("UPDATE relay_schema SET version=5");
      }
      if (Number(rows[0].version) < 6) {
        // Schema 4 attachment tables are dropped, not migrated; schema 4/5 databases keep opening.
        this.#db.exec(MIGRATION_6);
        this.#db.exec("UPDATE relay_schema SET version=6");
      }
      this.#db
        .prepare(
          "SELECT recipient_id,sender_id,updated_at,fingerprint FROM relay_poll_cursors LIMIT 0",
        )
        .all();
      this.#db
        .prepare(
          "SELECT recipient_id,sender_id,accepted_at,message_id,updated_at,fingerprint FROM relay_poll_senders LIMIT 0",
        )
        .all();
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='relay_poll_positions_terminal'",
          )
          .get()
      )
        throw new RelayError("poll_cursor_schema_unavailable");
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
  #expire(now: number, limit = this.#options.max_records): number {
    const rows = this.#db
      .prepare(
        "SELECT * FROM relay_messages WHERE state IN ('pending','leased','quarantined') AND expires_at<=? ORDER BY expires_at,sender_id,message_id LIMIT ?",
      )
      .all(now, limit);
    for (const row of rows) {
      this.#audit(
        String(row.sender_id),
        String(row.message_id),
        now,
        "expired",
      );
      this.#db
        .prepare(
          "UPDATE relay_deliveries SET state='expired',token_hash=NULL,lease_until=NULL WHERE sender_id=? AND message_id=?",
        )
        .run(row.sender_id!, row.message_id!);
      this.#db
        .prepare(
          "UPDATE relay_messages SET state='expired',body=NULL,body_bytes=0,terminal_at=expires_at,retain_until=expires_at+? WHERE sender_id=? AND message_id=?",
        )
        .run(RECORD_RETENTION_MS, row.sender_id!, row.message_id!);
    }
    return rows.length;
  }
  accept(resolve: () => Acceptance): Receipt {
    return this.#tx(() => {
      const now = this.#now();
      const acceptance = resolve();
      const {
        message: m,
        sender_id: sender,
        comparison_material: material,
      } = acceptance;
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
      if (this.#options.agent_capacity) {
        const senders = this.#db
          .prepare(
            "SELECT sender_id,count(*) records,sum(CASE WHEN state IN ('pending','leased','quarantined') THEN 1 ELSE 0 END) pending,coalesce(sum(CASE WHEN state IN ('pending','leased','quarantined') THEN body_bytes ELSE 0 END),0) body_bytes FROM relay_messages GROUP BY sender_id",
          )
          .all() as unknown as SenderCapacityUsage[];
        const recipient = this.#db
          .prepare(
            "SELECT count(*) records,coalesce(sum(CASE WHEN state IN ('pending','leased','quarantined') THEN body_bytes ELSE 0 END),0) body_bytes FROM relay_messages WHERE recipient_id=?",
          )
          .get(m.recipient_id) as { records: number; body_bytes: number };
        assertAgentCapacity(
          this.#options.agent_capacity,
          this.#options,
          sender,
          size,
          senders,
          recipient,
        );
      }
      const [a, b] = [sender, m.recipient_id].sort();
      // Thread names are scoped to the sorted agent pair; another pair's use of the same name is never consulted.
      // Rows written before pair scoping keep their bare id; they are reused only by their own pair.
      const legacy = this.#db
        .prepare("SELECT 1 FROM relay_threads WHERE id=? AND a=? AND b=?")
        .get(m.thread_id, a, b);
      const threadKey = legacy
        ? m.thread_id
        : JSON.stringify([a, b, m.thread_id]);
      const thread =
        legacy ??
        this.#db
          .prepare("SELECT 1 FROM relay_threads WHERE id=? AND a=? AND b=?")
          .get(threadKey, a, b);
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
          parent.thread_id !== threadKey
        )
          throw new RelayError("invalid_reference");
      }
      if (!thread)
        this.#db
          .prepare("INSERT INTO relay_threads VALUES(?,?,?)")
          .run(threadKey, a, b);
      const row: Row = {
        sender_id: sender,
        message_id: m.message_id,
        recipient_id: m.recipient_id,
        receipt_id: randomUUID(),
        thread_id: threadKey,
        fingerprint,
        accepted_at: now,
        expires_at: expires,
        state: "pending",
        kind: m.kind,
      };
      this.#db
        .prepare(
          "INSERT INTO relay_messages(sender_id,message_id,recipient_id,receipt_id,thread_id,fingerprint,accepted_at,expires_at,state,body,body_bytes,kind) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?)",
        )
        .run(
          sender,
          m.message_id,
          m.recipient_id,
          row.receipt_id,
          threadKey,
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
  #pollHash(row: PollPosition) {
    return this.#hash(
      "poll-position-v1",
      JSON.stringify([row.recipient_id, row.sender_id, row.updated_at]),
    );
  }
  #senderHash(row: SenderPosition) {
    return this.#hash(
      "poll-sender-v1",
      JSON.stringify([
        row.recipient_id,
        row.sender_id,
        row.accepted_at,
        row.message_id,
        row.updated_at,
      ]),
    );
  }
  #positionValid(row: PollPosition): boolean {
    return (
      typeof row.recipient_id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.recipient_id) &&
      typeof row.sender_id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.sender_id) &&
      Number.isSafeInteger(row.updated_at) &&
      row.updated_at >= 0
    );
  }
  #fairPollRows(receiver: string, now: number) {
    const cursor = this.#db
      .prepare("SELECT * FROM relay_poll_cursors WHERE recipient_id=?")
      .get(receiver) as PollPosition | undefined;
    if (
      cursor &&
      (!this.#positionValid(cursor) ||
        cursor.fingerprint !== this.#pollHash(cursor))
    )
      throw new RelayError("poll_cursor_integrity");
    const senders = this.#db
      .prepare(
        "SELECT DISTINCT m.sender_id FROM relay_messages m JOIN relay_deliveries d USING(sender_id,message_id) WHERE m.recipient_id=? AND d.state='pending' AND d.next_visible_at<=? AND m.expires_at>? ORDER BY CASE WHEN ? IS NULL OR m.sender_id>? THEN 0 ELSE 1 END,m.sender_id LIMIT ?",
      )
      .all(
        receiver,
        now,
        now,
        cursor?.sender_id ?? null,
        cursor?.sender_id ?? null,
        this.#options.poll_scan_limit,
      );
    const rows = [];
    for (const { sender_id } of senders) {
      const position = this.#db
        .prepare(
          "SELECT * FROM relay_poll_senders WHERE recipient_id=? AND sender_id=?",
        )
        .get(receiver, sender_id!) as SenderPosition | undefined;
      if (
        position &&
        (!this.#positionValid(position) ||
          !Number.isSafeInteger(position.accepted_at) ||
          position.accepted_at < 0 ||
          typeof position.message_id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(position.message_id) ||
          position.fingerprint !== this.#senderHash(position))
      )
        throw new RelayError("poll_cursor_integrity");
      const row = this.#db
        .prepare(
          "SELECT m.*,d.generation,d.attempts FROM relay_messages m JOIN relay_deliveries d USING(sender_id,message_id) WHERE m.recipient_id=? AND m.sender_id=? AND d.state='pending' AND d.next_visible_at<=? AND m.expires_at>? ORDER BY CASE WHEN ? IS NULL OR m.accepted_at>? OR (m.accepted_at=? AND m.message_id>?) THEN 0 ELSE 1 END,m.accepted_at,m.message_id LIMIT 1",
        )
        .get(
          receiver,
          sender_id!,
          now,
          now,
          position?.accepted_at ?? null,
          position?.accepted_at ?? null,
          position?.accepted_at ?? null,
          position?.message_id ?? null,
        );
      if (row) rows.push(row);
    }
    return rows;
  }
  #advancePoll(receiver: string, row: Row) {
    const now = this.#now();
    const cursor: PollPosition = {
      recipient_id: receiver,
      sender_id: row.sender_id,
      updated_at: now,
      fingerprint: "",
    };
    const position: SenderPosition = {
      ...cursor,
      accepted_at: row.accepted_at,
      message_id: row.message_id,
    };
    this.#db
      .prepare(
        "INSERT INTO relay_poll_cursors VALUES(?,?,?,?) ON CONFLICT(recipient_id) DO UPDATE SET sender_id=excluded.sender_id,updated_at=excluded.updated_at,fingerprint=excluded.fingerprint",
      )
      .run(receiver, row.sender_id, now, this.#pollHash(cursor));
    this.#db
      .prepare(
        "INSERT INTO relay_poll_senders VALUES(?,?,?,?,?,?) ON CONFLICT(recipient_id,sender_id) DO UPDATE SET accepted_at=excluded.accepted_at,message_id=excluded.message_id,updated_at=excluded.updated_at,fingerprint=excluded.fingerprint",
      )
      .run(
        receiver,
        row.sender_id,
        row.accepted_at,
        row.message_id,
        now,
        this.#senderHash(position),
      );
  }
  hasActiveLease(recipientId: string): boolean {
    return this.#tx(() => {
      const now = this.#now();
      this.#expire(now);
      this.#requeue(now);
      return !!this.#db
        .prepare(
          "SELECT 1 FROM relay_deliveries WHERE recipient_id=? AND state='leased'",
        )
        .get(recipientId);
    });
  }
  lookupAckRequest(
    recipient: string,
    requestId: string,
  ): { sender_id: string; message_id: string } | null {
    return (
      (this.#db
        .prepare(
          "SELECT sender_id,message_id FROM relay_ack_receipts WHERE recipient_id=? AND request_id=?",
        )
        .get(recipient, requestId) as
        { sender_id: string; message_id: string } | undefined) ?? null
    );
  }
  capacityUsage(recipientId: string) {
    return this.#tx(() => {
      this.#expire(this.#now());
      const senders = this.#db
        .prepare(
          "SELECT sender_id,count(*) records,sum(CASE WHEN state IN ('pending','leased','quarantined') THEN 1 ELSE 0 END) pending,coalesce(sum(body_bytes),0) body_bytes FROM relay_messages GROUP BY sender_id",
        )
        .all() as unknown as SenderCapacityUsage[];
      const recipient = this.#db
        .prepare(
          "SELECT count(*) records,coalesce(sum(CASE WHEN state IN ('pending','leased','quarantined') THEN 1 ELSE 0 END),0) pending,coalesce(sum(body_bytes),0) body_bytes FROM relay_messages WHERE recipient_id=?",
        )
        .get(recipientId) as {
        records: number;
        pending: number;
        body_bytes: number;
      };
      return { senders, recipient };
    });
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
      const rows = this.#options.fair_poll
        ? this.#fairPollRows(receiver, now)
        : this.#db
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
        if (this.#options.fair_poll) this.#advancePoll(receiver, row);
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
        if (this.#options.fair_poll) {
          if (
            authorize() !== receiver ||
            authorize({ sender_id: row.sender_id, kind: row.kind }) !== receiver
          )
            throw new RelayError("forbidden");
          if (until <= this.#now())
            throw new RelayError("expired_before_acceptance");
        }
        return {
          message: { ...JSON.parse(row.body), sender_id: row.sender_id },
          generation,
          lease_token: token,
          lease_until: new Date(until).toISOString(),
        };
      }
      if (this.#options.fair_poll && authorize() !== receiver)
        throw new RelayError("forbidden");
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
            body: string | null;
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
          "UPDATE relay_messages SET state='acked',body=NULL,body_bytes=0,terminal_at=?,retain_until=max(expires_at,?)+? WHERE sender_id=? AND message_id=?",
        )
        .run(
          now,
          now + MAX_ACK_RETRY_MS,
          RECORD_RETENTION_MS,
          row.sender_id,
          row.message_id,
        );
      this.#audit(row.sender_id, row.message_id, now, "acked");
      return result(receiptId, now);
    });
  }
  /** Bounded explicit maintenance. No daemon, external IO or application execution. */
  maintain(authorize: () => void, limit: number): MaintenanceResult {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RelayError("invalid_maintenance_limit");
    return this.#tx(() => {
      const now = this.#now();
      const check = () => {
        try {
          const result: unknown = authorize();
          if (result && typeof result === "object" && "then" in result)
            void Promise.resolve(result).catch(() => {});
          if (result !== undefined) throw Error();
        } catch {
          throw new RelayError("forbidden");
        }
      };
      check();
      if (
        !this.#db
          .prepare("SELECT 1 FROM relay_maintenance_totals WHERE id=1")
          .get()
      )
        throw new RelayError("maintenance_state_unavailable");
      const expired = this.#expire(now, limit);
      const rows = this.#db
        .prepare(
          "SELECT sender_id,message_id FROM relay_messages WHERE state IN ('acked','expired') AND retain_until<=? AND expires_at+?<=? AND terminal_at+?<=? AND NOT EXISTS(SELECT 1 FROM relay_ack_receipts a WHERE a.sender_id=relay_messages.sender_id AND a.message_id=relay_messages.message_id AND a.acked_at+?+?>?) AND (state!='acked' OR EXISTS(SELECT 1 FROM relay_ack_receipts a WHERE a.sender_id=relay_messages.sender_id AND a.message_id=relay_messages.message_id)) AND relay_gc_safe(message_id,expires_at)=1 ORDER BY retain_until,sender_id,message_id LIMIT ?",
        )
        .all(
          now,
          RECORD_RETENTION_MS,
          now,
          RECORD_RETENTION_MS,
          now,
          MAX_ACK_RETRY_MS,
          RECORD_RETENTION_MS,
          now,
          limit - expired,
        );
      for (const row of rows) {
        for (const table of [
          "relay_ack_receipts",
          "relay_deliveries",
          "relay_delivery_audit",
          "relay_messages",
        ]) {
          this.#db
            .prepare(`DELETE FROM ${table} WHERE sender_id=? AND message_id=?`)
            .run(row.sender_id!, row.message_id!);
        }
      }
      const threads = this.#db
        .prepare(
          "SELECT id FROM relay_threads WHERE NOT EXISTS(SELECT 1 FROM relay_messages m WHERE m.thread_id=relay_threads.id) ORDER BY id LIMIT ?",
        )
        .all(limit - expired - rows.length);
      for (const row of threads)
        this.#db.prepare("DELETE FROM relay_threads WHERE id=?").run(row.id!);
      const held = Number(
        this.#db
          .prepare(
            "SELECT count(*) n FROM relay_messages WHERE state IN ('acked','expired') AND retain_until<=? AND relay_gc_safe(message_id,expires_at)=0",
          )
          .get(now)!.n,
      );
      this.#db
        .prepare(
          "UPDATE relay_maintenance_totals SET last_at=?,expired=expired+?,purged=purged+?,threads=threads+? WHERE id=1",
        )
        .run(now, expired, rows.length, threads.length);
      check();
      return {
        expired,
        purged: rows.length,
        threads: threads.length,
        safety_held: held,
      };
    });
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
