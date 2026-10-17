import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import {
  comparisonMaterial,
  parseAck,
  parseSubmission,
  validateLimits,
} from "./contract.ts";
import type { AckRequest, ContractLimits } from "./contract.ts";
import { RelayError } from "./service.ts";
import type { AckReceipt, Delivery } from "./service.ts";
import type { InboxEntry, ReceiverStore } from "./receiver.ts";
export interface InboxOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  max_body_bytes: number;
  max_ack_records: number;
  ack_retry_ms: number;
  retry_base_ms: number;
  retry_cap_ms: number;
  max_attempts: number;
}
const SCHEMA = `CREATE TABLE relay_inbox_meta(version INTEGER NOT NULL,agent_id TEXT NOT NULL,key_check TEXT NOT NULL);
CREATE TABLE relay_inbox(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,received_at INTEGER NOT NULL,receipt_confirmed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sender_id,message_id));
CREATE TABLE relay_receiver_acks(request_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,message_id TEXT NOT NULL,generation INTEGER NOT NULL,request TEXT,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','confirmed','obsolete','quarantined')),attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER NOT NULL DEFAULT 0,retry_until INTEGER NOT NULL,receipt TEXT,reason TEXT,UNIQUE(sender_id,message_id,generation),FOREIGN KEY(sender_id,message_id) REFERENCES relay_inbox(sender_id,message_id));`;
export class SQLiteInbox implements ReceiverStore {
  readonly #db: DatabaseSync;
  readonly #options: InboxOptions;
  #ready = false;
  constructor(path: string, options: InboxOptions) {
    validateLimits(options.limits);
    if (
      typeof options.agent_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.agent_id) ||
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.byteLength < 32
    )
      throw new RelayError("invalid_inbox_options");
    for (const k of [
      "max_records",
      "max_body_bytes",
      "max_ack_records",
      "ack_retry_ms",
      "retry_base_ms",
      "retry_cap_ms",
      "max_attempts",
    ] as const)
      if (!Number.isSafeInteger(options[k]) || options[k] < 1)
        throw new RelayError("invalid_inbox_options");
    if (
      options.retry_cap_ms < options.retry_base_ms ||
      options.retry_cap_ms > 3600000 ||
      options.ack_retry_ms > 30 * 86400000 ||
      options.max_attempts > 1000
    )
      throw new RelayError("invalid_inbox_options");
    this.#options = {
      ...options,
      limits: { ...options.limits },
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    // ACK retry stores a temporary lease token; host must also use a private directory/backups.
    if (path !== ":memory:") {
      const fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0)
          throw new RelayError("insecure_inbox_file");
      } finally {
        closeSync(fd);
      }
    }
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
  #hash(value: string) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(value)
      .digest("hex");
  }
  #leaseFingerprint(request: AckRequest) {
    return this.#hash(
      JSON.stringify([
        request.sender_id,
        request.message_id,
        request.generation,
        request.lease_token,
      ]),
    );
  }
  #keyCheck() {
    return createHash("sha256")
      .update(this.#options.fingerprint_key)
      .digest("hex");
  }
  migrate(): void {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='relay_inbox_meta'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new RelayError("unknown_schema");
        this.#db.exec(SCHEMA);
        this.#db
          .prepare("INSERT INTO relay_inbox_meta VALUES(1,?,?)")
          .run(this.#options.agent_id, this.#keyCheck());
      }
      const rows = this.#db.prepare("SELECT * FROM relay_inbox_meta").all();
      if (rows.length !== 1 || rows[0].version !== 1)
        throw new RelayError("unsupported_schema");
      if (
        rows[0].agent_id !== this.#options.agent_id ||
        rows[0].key_check !== this.#keyCheck()
      )
        throw new RelayError("inbox_identity_mismatch");
    });
    this.#ready = true;
  }
  #now(): number {
    if (!this.#ready) throw new RelayError("schema_not_ready");
    const at = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
        .get()!.at,
    );
    if (!Number.isSafeInteger(at)) throw new RelayError("invalid_clock");
    return at;
  }
  save(delivery: Delivery): void {
    const { sender_id, ...wire } = delivery.message;
    const message = parseSubmission(wire, this.#options.limits);
    if (message.recipient_id !== this.#options.agent_id)
      throw new RelayError("foreign_delivery");
    if (message.body.parts.some((p) => p.type === "attachment"))
      throw new RelayError("attachment_store_unavailable");
    const request = parseAck(
      {
        sender_id,
        message_id: message.message_id,
        generation: delivery.generation,
        lease_token: delivery.lease_token,
        request_id: randomUUID(),
      },
      this.#options.limits,
    );
    const lease = Date.parse(delivery.lease_until);
    if (
      !Number.isFinite(lease) ||
      new Date(lease).toISOString() !== delivery.lease_until ||
      lease > Date.parse(message.expires_at)
    )
      throw new RelayError("invalid_delivery");
    const fingerprint = this.#hash(
      comparisonMaterial(sender_id, message, this.#options.limits),
    );
    this.#tx(() => {
      const now = this.#now();
      const existing = this.#db
        .prepare(
          "SELECT fingerprint FROM relay_inbox WHERE sender_id=? AND message_id=?",
        )
        .get(sender_id, message.message_id);
      if (existing && existing.fingerprint !== fingerprint)
        throw new RelayError("inbox_content_conflict");
      const prior = this.#db
        .prepare(
          "SELECT fingerprint FROM relay_receiver_acks WHERE sender_id=? AND message_id=? AND generation=?",
        )
        .get(sender_id, message.message_id, request.generation);
      const leaseFingerprint = this.#leaseFingerprint(request);
      if (prior) {
        if (prior.fingerprint !== leaseFingerprint)
          throw new RelayError("inbox_lease_conflict");
        return;
      }
      if (
        Number(
          this.#db.prepare("SELECT count(*) n FROM relay_receiver_acks").get()!
            .n,
        ) >= this.#options.max_ack_records
      )
        throw new RelayError("inbox_capacity_exceeded");
      if (!existing) {
        const usage = this.#db
          .prepare(
            "SELECT count(*) n,coalesce(sum(length(cast(body AS BLOB))),0) bytes FROM relay_inbox",
          )
          .get()!;
        const body = JSON.stringify(message);
        if (
          Number(usage.n) >= this.#options.max_records ||
          Number(usage.bytes) + Buffer.byteLength(body) >
            this.#options.max_body_bytes
        )
          throw new RelayError("inbox_capacity_exceeded");
        this.#db
          .prepare(
            "INSERT INTO relay_inbox(sender_id,message_id,body,fingerprint,received_at) VALUES(?,?,?,?,?)",
          )
          .run(sender_id, message.message_id, body, fingerprint, now);
      }
      this.#db
        .prepare(
          "INSERT INTO relay_receiver_acks(request_id,sender_id,message_id,generation,request,fingerprint,state,retry_until) VALUES(?,?,?,?,?,?,'pending',?)",
        )
        .run(
          request.request_id,
          sender_id,
          message.message_id,
          request.generation,
          JSON.stringify(request),
          leaseFingerprint,
          now + this.#options.ack_retry_ms,
        );
    });
  }
  claimAck(): AckRequest | null {
    return this.#tx(() => {
      const now = this.#now();
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state='quarantined',request=NULL,reason='retry_exhausted' WHERE state='pending' AND (retry_until<=? OR attempts>=?)",
        )
        .run(now, this.#options.max_attempts);
      const row = this.#db
        .prepare(
          "SELECT * FROM relay_receiver_acks WHERE state='pending' AND next_retry_at<=? ORDER BY next_retry_at,request_id LIMIT 1",
        )
        .get(now);
      if (!row) return null;
      const backoff = Math.min(
        this.#options.retry_cap_ms,
        this.#options.retry_base_ms * 2 ** Number(row.attempts),
      );
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET attempts=attempts+1,next_retry_at=? WHERE request_id=?",
        )
        .run(now + backoff, row.request_id!);
      return parseAck(JSON.parse(String(row.request)), this.#options.limits);
    });
  }
  confirmAck(request: AckRequest, receipt: AckReceipt): void {
    const stamp = Date.parse(receipt.acked_at);
    if (
      receipt.state !== "acked" ||
      receipt.recipient_id !== this.#options.agent_id ||
      receipt.sender_id !== request.sender_id ||
      receipt.message_id !== request.message_id ||
      receipt.request_id !== request.request_id ||
      typeof receipt.receipt_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(receipt.receipt_id) ||
      !Number.isFinite(stamp) ||
      new Date(stamp).toISOString() !== receipt.acked_at
    )
      throw new RelayError("invalid_ack_receipt");
    this.#tx(() => {
      this.#now();
      const row = this.#db
        .prepare(
          "SELECT fingerprint,receipt FROM relay_receiver_acks WHERE request_id=? AND sender_id=? AND message_id=?",
        )
        .get(request.request_id, request.sender_id, request.message_id);
      if (!row || row.fingerprint !== this.#leaseFingerprint(request))
        throw new RelayError("unknown_local_ack");
      const safe = {
        recipient_id: receipt.recipient_id,
        sender_id: receipt.sender_id,
        message_id: receipt.message_id,
        request_id: receipt.request_id,
        receipt_id: receipt.receipt_id,
        acked_at: receipt.acked_at,
        state: "acked",
      };
      if (row.receipt && row.receipt !== JSON.stringify(safe))
        throw new RelayError("local_ack_receipt_conflict");
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state='confirmed',request=NULL,receipt=?,reason=NULL WHERE request_id=?",
        )
        .run(JSON.stringify(safe), request.request_id);
      this.#db
        .prepare(
          "UPDATE relay_inbox SET receipt_confirmed=1 WHERE sender_id=? AND message_id=?",
        )
        .run(request.sender_id, request.message_id);
    });
  }
  rejectAck(
    request: AckRequest,
    reason: "invalid_ack" | "forbidden" | "ack_idempotency_conflict",
  ): void {
    this.#tx(() => {
      this.#now();
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state=?,request=NULL,reason=? WHERE request_id=? AND state='pending'",
        )
        .run(
          reason === "invalid_ack" ? "obsolete" : "quarantined",
          reason,
          request.request_id,
        );
    });
  }
  inbox(): InboxEntry[] {
    this.#now();
    return this.#db
      .prepare(
        "SELECT sender_id,body,received_at,receipt_confirmed FROM relay_inbox ORDER BY received_at,sender_id,message_id",
      )
      .all()
      .map((row) => ({
        sender_id: String(row.sender_id),
        message: JSON.parse(String(row.body)),
        received_at: new Date(Number(row.received_at)).toISOString(),
        receipt_confirmed: row.receipt_confirmed === 1,
      }));
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
