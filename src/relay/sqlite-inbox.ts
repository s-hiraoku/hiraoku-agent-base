import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import {
  comparisonMaterial,
  parseAck,
  parseSubmission,
  validateLimits,
  RECORD_RETENTION_MS,
  isReplayBoundMessageId,
} from "./contract.ts";
import type { AckRequest, ContractLimits, Submission } from "./contract.ts";
import type { AttachmentInboxAdmission } from "./attachment-inbox.ts";
import { RelayError } from "./service.ts";
import type { AckReceipt, Delivery } from "./service.ts";
import type {
  InboxEntry,
  ReceiverStore,
  InboxLifecycleStore,
  InboxMaintenanceResult,
} from "./receiver.ts";
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
const MIGRATION_2 = `ALTER TABLE relay_inbox ADD COLUMN released_at INTEGER;
ALTER TABLE relay_inbox ADD COLUMN expires_at INTEGER;
ALTER TABLE relay_inbox ADD COLUMN ack_retry_until INTEGER;
ALTER TABLE relay_inbox ADD COLUMN ack_terminal_at INTEGER;
ALTER TABLE relay_inbox ADD COLUMN retain_until INTEGER;
ALTER TABLE relay_receiver_acks ADD COLUMN terminal_at INTEGER;
ALTER TABLE relay_receiver_acks ADD COLUMN retain_until INTEGER;
CREATE INDEX relay_inbox_retention ON relay_inbox(released_at,retain_until);
CREATE INDEX relay_receiver_acks_retention ON relay_receiver_acks(state,retain_until);
CREATE TABLE relay_inbox_maintenance_totals(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL,expired_acks INTEGER NOT NULL,purged_acks INTEGER NOT NULL,purged_messages INTEGER NOT NULL);
INSERT INTO relay_inbox_maintenance_totals VALUES(1,0,0,0,0);`;
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export class SQLiteInbox implements ReceiverStore, InboxLifecycleStore {
  readonly #db: DatabaseSync;
  readonly #options: InboxOptions;
  readonly #attachments: AttachmentInboxAdmission | undefined;
  #ready = false;
  constructor(
    path: string,
    options: InboxOptions,
    attachments?: AttachmentInboxAdmission,
  ) {
    if (
      attachments !== undefined &&
      (typeof attachments.withVerified !== "function" ||
        typeof attachments.withRetained !== "function")
    )
      throw new RelayError("invalid_inbox_options");
    this.#attachments =
      attachments === undefined
        ? undefined
        : Object.freeze({
            withVerified: attachments.withVerified.bind(attachments),
            withRetained: attachments.withRetained.bind(attachments),
          });
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
      this.#db.function(
        "relay_inbox_gc_safe",
        { deterministic: true },
        (id, expiry) => Number(isReplayBoundMessageId(id, expiry)),
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
  #withAttachments<T>(sender: string, message: Submission, action: () => T): T {
    if (!message.body.parts.some((p) => p.type === "attachment"))
      return action();
    if (!this.#attachments)
      throw new RelayError("attachment_store_unavailable");
    return this.#attachmentAction(
      (cb) => this.#attachments!.withVerified(sender, message, cb),
      action,
    );
  }
  #attachmentAction<T>(run: (action: () => T) => T, action: () => T): T {
    let open = true,
      called = false;
    try {
      const result = run(() => {
        if (!open || called)
          throw new RelayError("attachment_inbox_unverified");
        called = true;
        return action();
      });
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("attachment_inbox_unverified");
      }
      if (!called) throw new RelayError("attachment_inbox_unverified");
      return result;
    } finally {
      open = false;
    }
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
      if (rows.length !== 1 || ![1, 2, 3].includes(Number(rows[0].version)))
        throw new RelayError("unsupported_schema");
      if (
        rows[0].agent_id !== this.#options.agent_id ||
        rows[0].key_check !== this.#keyCheck()
      )
        throw new RelayError("inbox_identity_mismatch");
      if (rows[0].version === 1) {
        const now = this.#clock();
        this.#db.exec(MIGRATION_2);
        const messages = this.#db
          .prepare(
            "SELECT sender_id,message_id,body,fingerprint,received_at FROM relay_inbox",
          )
          .all();
        if (messages.length > this.#options.max_records)
          throw new RelayError("inbox_capacity_exceeded");
        this.#db
          .prepare(
            "UPDATE relay_receiver_acks SET terminal_at=CASE WHEN state='pending' THEN NULL ELSE ? END,retain_until=max(retry_until,?)+?",
          )
          .run(now, now, RECORD_RETENTION_MS);
        for (const row of messages) {
          const message = parseSubmission(
            JSON.parse(String(row.body)),
            this.#options.limits,
          );
          if (
            message.message_id !== row.message_id ||
            message.recipient_id !== this.#options.agent_id ||
            this.#hash(
              comparisonMaterial(
                String(row.sender_id),
                message,
                this.#options.limits,
              ),
            ) !== row.fingerprint
          )
            throw new RelayError("invalid_inbox_record");
          const ack = this.#db
            .prepare(
              "SELECT coalesce(max(retry_until),0) horizon,max(terminal_at) terminal FROM relay_receiver_acks WHERE sender_id=? AND message_id=?",
            )
            .get(row.sender_id!, row.message_id!)!;
          const expiry = Date.parse(message.expires_at);
          this.#db
            .prepare(
              "UPDATE relay_inbox SET expires_at=?,ack_retry_until=?,ack_terminal_at=?,retain_until=? WHERE sender_id=? AND message_id=?",
            )
            .run(
              expiry,
              ack.horizon!,
              ack.terminal ?? null,
              Math.max(
                expiry,
                Number(row.received_at),
                Number(ack.horizon),
                Number(ack.terminal),
              ) + RECORD_RETENTION_MS,
              row.sender_id!,
              row.message_id!,
            );
        }
        this.#db.exec("UPDATE relay_inbox_meta SET version=2");
      }
      if (
        Number(
          this.#db.prepare("SELECT version FROM relay_inbox_meta").get()!
            .version,
        ) === 2
      ) {
        this.#db.exec(
          "ALTER TABLE relay_inbox ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0 CHECK(has_attachments IN (0,1)); ALTER TABLE relay_inbox ADD COLUMN attachment_guard TEXT NOT NULL DEFAULT ''",
        );
        const records = this.#db
          .prepare(
            "SELECT sender_id,message_id,body,fingerprint FROM relay_inbox WHERE body<>''",
          )
          .all();
        if (records.length > this.#options.max_records)
          throw new RelayError("inbox_capacity_exceeded");
        for (const row of records) {
          const message = parseSubmission(
            JSON.parse(String(row.body)),
            this.#options.limits,
          );
          if (
            message.message_id !== row.message_id ||
            message.recipient_id !== this.#options.agent_id ||
            this.#hash(
              comparisonMaterial(
                String(row.sender_id),
                message,
                this.#options.limits,
              ),
            ) !== row.fingerprint
          )
            throw new RelayError("invalid_inbox_record");
          this.#db
            .prepare(
              "UPDATE relay_inbox SET has_attachments=? WHERE sender_id=? AND message_id=?",
            )
            .run(
              Number(message.body.parts.some((p) => p.type === "attachment")),
              row.sender_id!,
              row.message_id!,
            );
        }
        for (const row of this.#db
          .prepare(
            "SELECT sender_id,message_id,has_attachments FROM relay_inbox",
          )
          .all()) {
          this.#db
            .prepare(
              "UPDATE relay_inbox SET attachment_guard=? WHERE sender_id=? AND message_id=?",
            )
            .run(
              this.#hash(
                JSON.stringify([
                  "attachment-v1",
                  row.sender_id,
                  row.message_id,
                  row.has_attachments,
                ]),
              ),
              row.sender_id!,
              row.message_id!,
            );
        }
        this.#db.exec(
          "CREATE TRIGGER relay_attachment_identity BEFORE UPDATE OF has_attachments,attachment_guard ON relay_inbox BEGIN SELECT RAISE(ABORT,'immutable attachment identity');END; UPDATE relay_inbox_meta SET version=3",
        );
      }
      this.#db
        .prepare(
          "SELECT has_attachments,attachment_guard FROM relay_inbox LIMIT 0",
        )
        .all();
    });
    this.#ready = true;
  }
  #clock(): number {
    const at = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
        .get()!.at,
    );
    if (!Number.isSafeInteger(at)) throw new RelayError("invalid_clock");
    return at;
  }
  #now(): number {
    if (!this.#ready) throw new RelayError("schema_not_ready");
    return this.#clock();
  }
  save(delivery: Delivery): void {
    const { sender_id, ...wire } = delivery.message;
    const message = parseSubmission(wire, this.#options.limits);
    if (message.recipient_id !== this.#options.agent_id)
      throw new RelayError("foreign_delivery");
    this.#withAttachments(sender_id, message, () =>
      this.#saveVerified(delivery, sender_id, message),
    );
  }
  #saveVerified(
    delivery: Delivery,
    sender_id: string,
    message: Submission,
  ): void {
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
      // Existing exact journal retries above remain valid after TTL. A new ACK
      // generation or unseen expired delivery must never recreate collected state.
      if (lease <= now || Date.parse(message.expires_at) <= now)
        throw new RelayError("expired_delivery");
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
            "INSERT INTO relay_inbox(sender_id,message_id,body,fingerprint,received_at,expires_at,ack_retry_until,retain_until,has_attachments,attachment_guard) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            sender_id,
            message.message_id,
            body,
            fingerprint,
            now,
            Date.parse(message.expires_at),
            now + this.#options.ack_retry_ms,
            Math.max(
              Date.parse(message.expires_at),
              now + this.#options.ack_retry_ms,
            ) + RECORD_RETENTION_MS,
            Number(message.body.parts.some((p) => p.type === "attachment")),
            this.#hash(
              JSON.stringify([
                "attachment-v1",
                sender_id,
                message.message_id,
                Number(message.body.parts.some((p) => p.type === "attachment")),
              ]),
            ),
          );
      }
      this.#db
        .prepare(
          "UPDATE relay_inbox SET ack_retry_until=max(ack_retry_until,?),retain_until=max(retain_until,?) WHERE sender_id=? AND message_id=?",
        )
        .run(
          now + this.#options.ack_retry_ms,
          now + this.#options.ack_retry_ms + RECORD_RETENTION_MS,
          sender_id,
          message.message_id,
        );
      this.#db
        .prepare(
          "INSERT INTO relay_receiver_acks(request_id,sender_id,message_id,generation,request,fingerprint,state,retry_until,retain_until) VALUES(?,?,?,?,?,?,'pending',?,?)",
        )
        .run(
          request.request_id,
          sender_id,
          message.message_id,
          request.generation,
          JSON.stringify(request),
          leaseFingerprint,
          now + this.#options.ack_retry_ms,
          now + this.#options.ack_retry_ms + RECORD_RETENTION_MS,
        );
    });
  }
  #ackTerminal(senderId: string, messageId: string, now: number): void {
    this.#db
      .prepare(
        "UPDATE relay_inbox SET ack_terminal_at=max(coalesce(ack_terminal_at,0),?),retain_until=max(retain_until,?) WHERE sender_id=? AND message_id=?",
      )
      .run(now, now + RECORD_RETENTION_MS, senderId, messageId);
  }
  #expireAcks(now: number, limit: number): number {
    const rows = this.#db
      .prepare(
        "SELECT request_id,sender_id,message_id FROM relay_receiver_acks WHERE state='pending' AND (retry_until<=? OR attempts>=?) ORDER BY retry_until,request_id LIMIT ?",
      )
      .all(now, this.#options.max_attempts, limit);
    for (const row of rows) {
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state='quarantined',request=NULL,reason='retry_exhausted',terminal_at=?,retain_until=max(retry_until,?)+? WHERE request_id=?",
        )
        .run(now, now, RECORD_RETENTION_MS, row.request_id!);
      this.#ackTerminal(String(row.sender_id), String(row.message_id), now);
    }
    return rows.length;
  }
  claimAck(): AckRequest | null {
    const now = this.#now();
    const pending = this.#db
      .prepare(
        "SELECT a.request_id,a.sender_id,a.message_id,i.body,i.has_attachments,i.attachment_guard FROM relay_receiver_acks a JOIN relay_inbox i USING(sender_id,message_id) WHERE a.state='pending' AND a.next_retry_at<=? AND a.retry_until>? AND a.attempts<? ORDER BY a.next_retry_at,a.request_id LIMIT 1",
      )
      .get(now, now, this.#options.max_attempts);
    if (!pending) return this.#claimVerifiedAck(null);
    if (
      pending.attachment_guard !==
      this.#hash(
        JSON.stringify([
          "attachment-v1",
          pending.sender_id,
          pending.message_id,
          pending.has_attachments,
        ]),
      )
    )
      throw new RelayError("invalid_inbox_record");
    if (pending.has_attachments === 0)
      return this.#claimVerifiedAck(String(pending.request_id));
    if (String(pending.body) === "") {
      if (!this.#attachments)
        throw new RelayError("attachment_store_unavailable");
      return this.#attachmentAction(
        (cb) =>
          this.#attachments!.withRetained(
            String(pending.sender_id),
            String(pending.message_id),
            cb,
          ),
        () => this.#claimVerifiedAck(String(pending.request_id)),
      );
    }
    let message: Submission;
    try {
      message = parseSubmission(
        JSON.parse(String(pending.body)),
        this.#options.limits,
      );
    } catch {
      throw new RelayError("invalid_inbox_record");
    }
    return this.#withAttachments(String(pending.sender_id), message, () =>
      this.#claimVerifiedAck(String(pending.request_id)),
    );
  }
  #claimVerifiedAck(selected: string | null): AckRequest | null {
    return this.#tx(() => {
      const now = this.#now();
      this.#expireAcks(now, this.#options.max_ack_records);
      if (selected === null) return null;
      const row = this.#db
        .prepare(
          "SELECT * FROM relay_receiver_acks WHERE state='pending' AND next_retry_at<=? AND request_id=?",
        )
        .get(now, selected);
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
      const now = this.#now();
      const row = this.#db
        .prepare(
          "SELECT fingerprint,receipt,state FROM relay_receiver_acks WHERE request_id=? AND sender_id=? AND message_id=?",
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
      if (row.state === "confirmed") return;
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state='confirmed',request=NULL,receipt=?,reason=NULL,terminal_at=?,retain_until=max(retain_until,?+?) WHERE request_id=?",
        )
        .run(
          JSON.stringify(safe),
          now,
          now,
          RECORD_RETENTION_MS,
          request.request_id,
        );
      this.#ackTerminal(request.sender_id, request.message_id, now);
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
    if (
      !["invalid_ack", "forbidden", "ack_idempotency_conflict"].includes(reason)
    )
      throw new RelayError("invalid_failure_reason");
    this.#tx(() => {
      const now = this.#now();
      const row = this.#db
        .prepare(
          "SELECT fingerprint,state FROM relay_receiver_acks WHERE request_id=? AND sender_id=? AND message_id=?",
        )
        .get(request.request_id, request.sender_id, request.message_id);
      if (!row || row.fingerprint !== this.#leaseFingerprint(request))
        throw new RelayError("unknown_local_ack");
      if (row.state !== "pending") return;
      this.#db
        .prepare(
          "UPDATE relay_receiver_acks SET state=?,request=NULL,reason=?,terminal_at=?,retain_until=max(retry_until,?)+? WHERE request_id=? AND state='pending'",
        )
        .run(
          reason === "invalid_ack" ? "obsolete" : "quarantined",
          reason,
          now,
          now,
          RECORD_RETENTION_MS,
          request.request_id,
        );
      this.#ackTerminal(request.sender_id, request.message_id, now);
    });
  }
  /** Local durable handoff. No execution, network ACK or body release is implied. */
  withEntry<T>(
    senderId: string,
    messageId: string,
    action: (entry: InboxEntry) => T,
  ): T {
    if (
      !identifier(senderId) ||
      !identifier(messageId) ||
      typeof action !== "function"
    )
      throw new RelayError("invalid_request");
    return this.#tx(() => {
      this.#now();
      const row = this.#db
        .prepare(
          "SELECT body,fingerprint,received_at,receipt_confirmed FROM relay_inbox WHERE sender_id=? AND message_id=? AND released_at IS NULL",
        )
        .get(senderId, messageId);
      if (!row) throw new RelayError("not_found");
      const message = parseSubmission(
        JSON.parse(String(row.body)),
        this.#options.limits,
      );
      if (
        message.message_id !== messageId ||
        message.recipient_id !== this.#options.agent_id ||
        this.#hash(
          comparisonMaterial(senderId, message, this.#options.limits),
        ) !== row.fingerprint
      )
        throw new RelayError("inbox_content_conflict");
      const result = action({
        sender_id: senderId,
        message,
        received_at: new Date(Number(row.received_at)).toISOString(),
        receipt_confirmed: row.receipt_confirmed === 1,
      });
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("invalid_request");
      }
      return result;
    });
  }
  inbox(): InboxEntry[] {
    this.#now();
    return this.#db
      .prepare(
        "SELECT sender_id,body,received_at,receipt_confirmed FROM relay_inbox WHERE released_at IS NULL ORDER BY received_at,sender_id,message_id",
      )
      .all()
      .map((row) => ({
        sender_id: String(row.sender_id),
        message: JSON.parse(String(row.body)),
        received_at: new Date(Number(row.received_at)).toISOString(),
        receipt_confirmed: row.receipt_confirmed === 1,
      }));
  }
  /** Call only after a separate, durable application save; no execution is implied. */
  releaseBody(senderId: string, messageId: string): boolean {
    if (!identifier(senderId) || !identifier(messageId))
      throw new RelayError("invalid_request");
    return this.#tx(() => {
      const now = this.#now(),
        row = this.#db
          .prepare(
            "SELECT released_at FROM relay_inbox WHERE sender_id=? AND message_id=?",
          )
          .get(senderId, messageId);
      if (!row) throw new RelayError("not_found");
      if (row.released_at !== null) return false;
      this.#db
        .prepare(
          "UPDATE relay_inbox SET body='',released_at=?,retain_until=max(retain_until,?+?) WHERE sender_id=? AND message_id=?",
        )
        .run(now, now, RECORD_RETENTION_MS, senderId, messageId);
      return true;
    });
  }
  /** Local-only, bounded administration. Never deletes an unreleased inbox body. */
  maintain(limit: number): InboxMaintenanceResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RelayError("invalid_request");
    return this.#tx(() => {
      const now = this.#now(),
        cutoff = now - RECORD_RETENTION_MS;
      if (
        !this.#db
          .prepare("SELECT 1 FROM relay_inbox_maintenance_totals WHERE id=1")
          .get()
      )
        throw new RelayError("maintenance_state_unavailable");
      const expired = this.#expireAcks(now, limit);
      const acks = this.#db
        .prepare(
          `SELECT a.request_id FROM relay_receiver_acks a JOIN relay_inbox i USING(sender_id,message_id)
        WHERE a.state IN ('confirmed','obsolete','quarantined') AND a.request IS NULL
        AND a.terminal_at<=? AND a.retry_until<=? AND a.retain_until<=? AND i.expires_at<=?
        ORDER BY a.retain_until,a.request_id LIMIT ?`,
        )
        .all(cutoff, cutoff, now, cutoff, limit - expired);
      for (const row of acks)
        this.#db
          .prepare("DELETE FROM relay_receiver_acks WHERE request_id=?")
          .run(row.request_id!);
      const eligible = `released_at<=? AND body='' AND received_at<=? AND expires_at<=?
        AND ack_retry_until<=? AND coalesce(ack_terminal_at,0)<=? AND retain_until<=?
        AND NOT EXISTS(SELECT 1 FROM relay_receiver_acks a WHERE a.sender_id=relay_inbox.sender_id AND a.message_id=relay_inbox.message_id)`;
      const messages = this.#db
        .prepare(
          `SELECT sender_id,message_id FROM relay_inbox WHERE ${eligible}
        AND relay_inbox_gc_safe(message_id,expires_at)=1 ORDER BY retain_until,sender_id,message_id LIMIT ?`,
        )
        .all(
          cutoff,
          cutoff,
          cutoff,
          cutoff,
          cutoff,
          now,
          limit - expired - acks.length,
        );
      for (const row of messages)
        this.#db
          .prepare("DELETE FROM relay_inbox WHERE sender_id=? AND message_id=?")
          .run(row.sender_id!, row.message_id!);
      const held = Number(
        this.#db
          .prepare(
            `SELECT count(*) n FROM relay_inbox WHERE ${eligible} AND relay_inbox_gc_safe(message_id,expires_at)=0`,
          )
          .get(cutoff, cutoff, cutoff, cutoff, cutoff, now)!.n,
      );
      this.#db
        .prepare(
          "UPDATE relay_inbox_maintenance_totals SET last_at=?,expired_acks=expired_acks+?,purged_acks=purged_acks+?,purged_messages=purged_messages+? WHERE id=1",
        )
        .run(now, expired, acks.length, messages.length);
      return {
        expired_acks: expired,
        purged_acks: acks.length,
        purged_messages: messages.length,
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
