import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomInt } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import {
  comparisonMaterial,
  parseSubmission,
  validateLimits,
  RECORD_RETENTION_MS,
  isReplayBoundMessageId,
} from "./contract.ts";
import type { AttachmentOutboxAdmission } from "./attachment-outbox.ts";
import type { ContractLimits } from "./contract.ts";
import { RelayError } from "./service.ts";
import type { Receipt } from "./service.ts";
import type {
  OutboxRecord,
  OutboxState,
  SendJob,
  SenderStore,
  OutboxMaintenanceResult,
} from "./sender.ts";
export interface OutboxOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
  lease_ms: number;
  retry_base_ms: number;
  retry_cap_ms: number;
  max_submit_attempts: number;
  max_status_attempts: number;
  status_retry_ms: number;
}
const SCHEMA = `CREATE TABLE relay_outbox_meta(version INTEGER NOT NULL,agent_id TEXT NOT NULL,key_check TEXT NOT NULL);
CREATE TABLE relay_outbox(message_id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL,expires_at INTEGER NOT NULL,first_sent_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,body TEXT,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','accepted','quarantined','expired_unknown')),
 fence INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,next_retry_at INTEGER NOT NULL DEFAULT 0,
 submit_attempts INTEGER NOT NULL DEFAULT 0,status_attempts INTEGER NOT NULL DEFAULT 0,status_only INTEGER NOT NULL DEFAULT 0,
 status_until INTEGER NOT NULL,operation TEXT CHECK(operation IN ('submit','status')),receipt TEXT,reason TEXT);
CREATE UNIQUE INDEX relay_outbox_one_active ON relay_outbox(state) WHERE state='sending';`;
const MIGRATION_2 = `ALTER TABLE relay_outbox ADD COLUMN terminal_at INTEGER;
ALTER TABLE relay_outbox ADD COLUMN retain_until INTEGER;
CREATE INDEX relay_outbox_retention ON relay_outbox(state,retain_until);
CREATE TABLE relay_outbox_maintenance_totals(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL,expired INTEGER NOT NULL,purged INTEGER NOT NULL);
INSERT INTO relay_outbox_maintenance_totals VALUES(1,0,0,0);`;
type Row = {
  message_id: string;
  recipient_id: string;
  expires_at: number;
  first_sent_at: number;
  fingerprint: string;
  body: string | null;
  state: OutboxState;
  fence: number;
  lease_until: number | null;
  next_retry_at: number;
  submit_attempts: number;
  status_attempts: number;
  status_only: number;
  status_until: number;
  operation: "submit" | "status" | null;
  receipt: string | null;
  reason: string | null;
  terminal_at: number | null;
  retain_until: number | null;
};
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function view(row: Row): OutboxRecord {
  return {
    message_id: row.message_id,
    recipient_id: row.recipient_id,
    expires_at: new Date(row.expires_at).toISOString(),
    state: row.state,
    submit_attempts: row.submit_attempts,
    status_attempts: row.status_attempts,
    reason: row.reason,
    receipt: row.receipt ? JSON.parse(row.receipt) : null,
  };
}
function utc(value: unknown): number {
  if (typeof value !== "string")
    throw new RelayError("invalid_acceptance_receipt");
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value)
    throw new RelayError("invalid_acceptance_receipt");
  return at;
}
export class SQLiteOutbox implements SenderStore {
  readonly #db: DatabaseSync;
  readonly #options: OutboxOptions;
  #ready = false;
  #inside = false;
  readonly #attachments?: AttachmentOutboxAdmission;
  constructor(
    path: string,
    options: OutboxOptions,
    attachments?: AttachmentOutboxAdmission,
  ) {
    if (attachments) {
      if (
        typeof attachments.withReady !== "function" ||
        typeof attachments.withClaim !== "function"
      )
        throw new RelayError("invalid_outbox_admission");
      this.#attachments = Object.freeze({
        withReady: attachments.withReady.bind(attachments),
        withClaim: attachments.withClaim.bind(attachments),
      });
    }
    validateLimits(options.limits);
    if (
      !identifier(options.agent_id) ||
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.byteLength < 32
    )
      throw new RelayError("invalid_outbox_options");
    for (const key of [
      "max_records",
      "max_body_bytes",
      "lease_ms",
      "retry_base_ms",
      "retry_cap_ms",
      "max_submit_attempts",
      "max_status_attempts",
      "status_retry_ms",
    ] as const)
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new RelayError("invalid_outbox_options");
    if (
      !Number.isSafeInteger(options.max_clock_skew_ms) ||
      options.max_clock_skew_ms < 0 ||
      options.max_clock_skew_ms > 60000 ||
      options.lease_ms > 3600000 ||
      options.retry_cap_ms < options.retry_base_ms ||
      options.retry_cap_ms > 3600000 ||
      options.max_submit_attempts > 1000 ||
      options.max_status_attempts > 1000 ||
      options.status_retry_ms > 30 * 86400000
    )
      throw new RelayError("invalid_outbox_options");
    this.#options = {
      ...options,
      limits: { ...options.limits },
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    if (path !== ":memory:") {
      const fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0)
          throw new RelayError("insecure_outbox_file");
      } finally {
        closeSync(fd);
      }
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(
        "PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON",
      );
      this.#db.function(
        "relay_outbox_gc_safe",
        { deterministic: true },
        (id, expiry) => Number(isReplayBoundMessageId(id, expiry)),
      );
    } catch (e) {
      this.#db.close();
      throw e;
    }
  }
  #tx<T>(fn: () => T): T {
    if (this.#inside) throw new RelayError("outbox_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const out = fn();
      if (out && typeof out === "object" && "then" in out) {
        void Promise.resolve(out).catch(() => {});
        throw new RelayError("outbox_busy");
      }
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      if (began) this.#db.exec("ROLLBACK");
      throw e;
    } finally {
      this.#inside = false;
    }
  }
  #admit<T>(action: (run: () => T) => T, run: () => T): T {
    let live = true,
      called = false,
      failed = false;
    let failure: unknown;
    try {
      const result = action(() => {
        if (!live || called) throw new RelayError("invalid_outbox_admission");
        called = true;
        try {
          return run();
        } catch (e) {
          failed = true;
          failure = e;
          throw e;
        }
      });
      if (
        !called ||
        (result && typeof result === "object" && "then" in result)
      ) {
        if (result && typeof result === "object" && "then" in result)
          void Promise.resolve(result).catch(() => {});
        throw new RelayError("invalid_outbox_admission");
      }
      return result;
    } catch (e) {
      throw failed ? failure : e;
    } finally {
      live = false;
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
          .prepare("SELECT 1 FROM sqlite_master WHERE name='relay_outbox_meta'")
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
          .prepare("INSERT INTO relay_outbox_meta VALUES(1,?,?)")
          .run(this.#options.agent_id, this.#keyCheck());
      }
      const rows = this.#db.prepare("SELECT * FROM relay_outbox_meta").all();
      if (rows.length !== 1 || ![1, 2].includes(Number(rows[0].version)))
        throw new RelayError("unsupported_schema");
      if (
        rows[0].agent_id !== this.#options.agent_id ||
        rows[0].key_check !== this.#keyCheck()
      )
        throw new RelayError("outbox_identity_mismatch");
      if (rows[0].version === 1) {
        const now = this.#clock();
        this.#db.exec(MIGRATION_2);
        // Local confirmation time was not recorded in v1. Start a conservative
        // retention window at this explicit upgrade, without changing receipts.
        this.#db
          .prepare(
            "UPDATE relay_outbox SET terminal_at=?,retain_until=max(expires_at,status_until,?)+? WHERE state IN ('accepted','expired_unknown')",
          )
          .run(now, now, RECORD_RETENTION_MS);
        this.#db.exec("UPDATE relay_outbox_meta SET version=2");
      }
    });
    this.#ready = true;
  }
  #clock() {
    const at = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
        .get()!.at,
    );
    if (!Number.isSafeInteger(at)) throw new RelayError("invalid_clock");
    return at;
  }
  #now() {
    if (!this.#ready) throw new RelayError("schema_not_ready");
    return this.#clock();
  }
  #row(id: string) {
    return this.#db
      .prepare("SELECT * FROM relay_outbox WHERE message_id=?")
      .get(id) as Row | undefined;
  }
  #expire(now: number, limit: number): number {
    const rows = this.#db
      .prepare(
        `SELECT * FROM relay_outbox WHERE expires_at<=? AND (
        (body IS NOT NULL AND state IN ('queued','sending','quarantined')) OR state='quarantined' OR
        (state IN ('queued','sending') AND (status_until<=? OR status_attempts>=?)
          AND (state='queued' OR lease_until<=?)))
       ORDER BY expires_at,message_id LIMIT ?`,
      )
      .all(now, now, this.#options.max_status_attempts, now, limit) as Row[];
    for (const row of rows) {
      const closed =
        row.state === "quarantined" ||
        ((row.state === "queued" ||
          (row.lease_until !== null && row.lease_until <= now)) &&
          (row.status_until <= now ||
            row.status_attempts >= this.#options.max_status_attempts));
      if (closed) {
        this.#db
          .prepare(
            "UPDATE relay_outbox SET state='expired_unknown',body=NULL,status_only=1,fence=fence+1,lease_until=NULL,operation=NULL,reason=?,terminal_at=?,retain_until=max(expires_at,status_until,?)+? WHERE message_id=?",
          )
          .run(
            row.state === "quarantined"
              ? "delivery_window_closed"
              : "status_retry_exhausted",
            now,
            now,
            RECORD_RETENTION_MS,
            row.message_id,
          );
      } else {
        // An in-flight request keeps its fence and may still commit acceptance.
        this.#db
          .prepare(
            "UPDATE relay_outbox SET body=NULL,status_only=1 WHERE message_id=?",
          )
          .run(row.message_id);
      }
    }
    return rows.length;
  }
  #cleanup(now: number) {
    this.#expire(now, this.#options.max_records);
  }
  enqueue(input: unknown): OutboxRecord {
    const message = parseSubmission(input, this.#options.limits);
    const attached = message.body.parts.some((p) => p.type === "attachment");
    if (attached && !this.#attachments)
      throw new RelayError("attachment_store_unavailable");
    const fingerprint = createHmac("sha256", this.#options.fingerprint_key)
      .update(
        comparisonMaterial(
          this.#options.agent_id,
          message,
          this.#options.limits,
        ),
      )
      .digest("hex");
    const enqueue = () =>
      this.#tx(() => {
        const now = this.#now();
        this.#cleanup(now);
        const existing = this.#row(message.message_id);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new RelayError("outbox_content_conflict");
          return view(existing);
        }
        const expires = Date.parse(message.expires_at);
        if (expires <= now) throw new RelayError("expired_before_enqueue");
        if (
          Date.parse(message.first_sent_at) >
          now + this.#options.max_clock_skew_ms
        )
          throw new RelayError("clock_skew");
        const body = JSON.stringify(message),
          usage = this.#db
            .prepare(
              "SELECT count(*) n,coalesce(sum(length(cast(body AS BLOB))),0) bytes FROM relay_outbox",
            )
            .get()!;
        if (
          Number(usage.n) >= this.#options.max_records ||
          Number(usage.bytes) + Buffer.byteLength(body) >
            this.#options.max_body_bytes
        )
          throw new RelayError("outbox_capacity_exceeded");
        this.#db
          .prepare(
            "INSERT INTO relay_outbox(message_id,recipient_id,expires_at,first_sent_at,fingerprint,body,state,status_until) VALUES(?,?,?,?,?,?,'queued',?)",
          )
          .run(
            message.message_id,
            message.recipient_id,
            expires,
            Date.parse(message.first_sent_at),
            fingerprint,
            body,
            expires + this.#options.status_retry_ms,
          );
        return view(this.#row(message.message_id)!);
      });
    if (!attached) return enqueue();
    // Exact retries do not create work and remain valid after explicit source release.
    const existing = this.#tx(() => {
      this.#now();
      const row = this.#row(message.message_id);
      if (row && row.fingerprint !== fingerprint)
        throw new RelayError("outbox_content_conflict");
      return row ? view(row) : null;
    });
    if (existing) return existing;
    return this.#admit(
      (run) =>
        this.#attachments!.withReady(
          this.#options.agent_id,
          message,
          this.#options.limits,
          run,
        ),
      enqueue,
    );
  }
  get(messageId: string): OutboxRecord {
    if (!identifier(messageId)) throw new RelayError("invalid_request");
    this.#now();
    const row = this.#row(messageId);
    if (!row) throw new RelayError("not_found");
    return view(row);
  }
  claim(): SendJob | null {
    if (!this.#attachments) return this.#claim();
    let check:
      ((message: import("./contract.ts").Submission) => void) | undefined;
    return this.#admit(
      (run) =>
        this.#attachments!.withClaim(
          this.#options.agent_id,
          this.#options.limits,
          (verified) => {
            if (typeof verified !== "function")
              throw new RelayError("invalid_outbox_admission");
            check = verified;
            return run();
          },
        ),
      () => this.#claim(check),
    );
  }
  #claim(
    check?: (message: import("./contract.ts").Submission) => void,
  ): SendJob | null {
    return this.#tx(() => {
      const now = this.#now();
      this.#cleanup(now);
      this.#db
        .prepare(
          "UPDATE relay_outbox SET state='queued',fence=fence+1,lease_until=NULL,reason='lease_expired' WHERE state='sending' AND lease_until<=?",
        )
        .run(now);
      if (
        this.#db
          .prepare("SELECT 1 FROM relay_outbox WHERE state='sending'")
          .get()
      )
        return null;
      const rows = this.#db
        .prepare(
          "SELECT * FROM relay_outbox WHERE state='queued' AND next_retry_at<=? ORDER BY next_retry_at,message_id",
        )
        .all(now) as Row[];
      for (const row of rows) {
        const operation =
          row.status_only ||
          row.expires_at <= now ||
          row.submit_attempts >= this.#options.max_submit_attempts
            ? "status"
            : "submit";
        if (
          operation === "status" &&
          (row.status_attempts >= this.#options.max_status_attempts ||
            row.status_until <= now)
        ) {
          const expired = row.expires_at <= now;
          this.#db
            .prepare(
              "UPDATE relay_outbox SET state=?,body=CASE WHEN ? THEN NULL ELSE body END,reason='status_retry_exhausted',terminal_at=?,retain_until=? WHERE message_id=?",
            )
            .run(
              expired ? "expired_unknown" : "quarantined",
              Number(expired),
              expired ? now : null,
              expired
                ? Math.max(now, row.expires_at, row.status_until) +
                    RECORD_RETENTION_MS
                : null,
              row.message_id,
            );
          continue;
        }
        const message =
          operation === "submit"
            ? parseSubmission(JSON.parse(row.body!), this.#options.limits)
            : null;
        if (message) {
          const fingerprint = createHmac(
            "sha256",
            this.#options.fingerprint_key,
          )
            .update(
              comparisonMaterial(
                this.#options.agent_id,
                message,
                this.#options.limits,
              ),
            )
            .digest("hex");
          if (
            fingerprint !== row.fingerprint ||
            message.message_id !== row.message_id ||
            message.recipient_id !== row.recipient_id ||
            Date.parse(message.expires_at) !== row.expires_at
          )
            throw new RelayError("outbox_integrity");
          if (message.body.parts.some((p) => p.type === "attachment")) {
            if (!check) continue;
            const result: unknown = check(message);
            if (result && typeof result === "object" && "then" in result) {
              void Promise.resolve(result).catch(() => {});
              throw new RelayError("invalid_outbox_admission");
            }
          }
        }
        const column =
          operation === "submit" ? "submit_attempts" : "status_attempts";
        this.#db
          .prepare(
            `UPDATE relay_outbox SET state='sending',fence=fence+1,lease_until=?,operation=?,${column}=${column}+1 WHERE message_id=?`,
          )
          .run(now + this.#options.lease_ms, operation, row.message_id);
        if (operation === "status")
          return {
            message_id: row.message_id,
            fence: row.fence + 1,
            operation,
          };
        return {
          message_id: row.message_id,
          message: message!,
          fence: row.fence + 1,
          operation,
        };
      }
      return null;
    });
  }
  #owned(job: SendJob, now: number): Row {
    const row = this.#row(job.message_id);
    if (
      !row ||
      row.state !== "sending" ||
      row.fence !== job.fence ||
      row.operation !== job.operation ||
      row.lease_until === null ||
      row.lease_until <= now
    )
      throw new RelayError("stale_sender_lease");
    return row;
  }
  confirm(job: SendJob, receipt: Receipt): void {
    this.#tx(() => {
      const now = this.#now(),
        row = this.#owned(job, now);
      const at = utc(receipt.accepted_at),
        expiry = utc(receipt.expires_at);
      if (
        receipt.sender_id !== this.#options.agent_id ||
        receipt.message_id !== row.message_id ||
        receipt.recipient_id !== row.recipient_id ||
        expiry !== row.expires_at ||
        !identifier(receipt.receipt_id) ||
        !["pending", "leased", "acked", "expired", "quarantined"].includes(
          receipt.state,
        ) ||
        at >= expiry ||
        at < row.first_sent_at - this.#options.max_clock_skew_ms
      )
        throw new RelayError("invalid_acceptance_receipt");
      const safe: Receipt = {
        sender_id: receipt.sender_id,
        message_id: receipt.message_id,
        recipient_id: receipt.recipient_id,
        receipt_id: receipt.receipt_id,
        accepted_at: receipt.accepted_at,
        expires_at: receipt.expires_at,
        state: receipt.state,
      };
      this.#db
        .prepare(
          "UPDATE relay_outbox SET state='accepted',body=NULL,receipt=?,lease_until=NULL,reason=NULL,terminal_at=?,retain_until=max(expires_at,status_until,?)+? WHERE message_id=?",
        )
        .run(
          JSON.stringify(safe),
          now,
          now,
          RECORD_RETENTION_MS,
          row.message_id,
        );
    });
  }
  defer(job: SendJob, forceStatus = false): void {
    this.#tx(() => {
      const now = this.#now(),
        row = this.#owned(job, now);
      const n = row.submit_attempts + row.status_attempts;
      const base = Math.min(
        this.#options.retry_cap_ms,
        this.#options.retry_base_ms * 2 ** Math.min(n - 1, 1000),
      );
      const delay = Math.min(
        this.#options.retry_cap_ms,
        base + randomInt(Math.max(1, Math.floor(base / 5) + 1)),
      );
      this.#db
        .prepare(
          "UPDATE relay_outbox SET state='queued',lease_until=NULL,next_retry_at=?,status_only=max(status_only,?),reason='retry_pending' WHERE message_id=?",
        )
        .run(now + delay, Number(forceStatus), row.message_id);
    });
  }
  quarantine(job: SendJob, reason: string): void {
    const allowed = [
      "forbidden",
      "idempotency_conflict",
      "attachment_store_unavailable",
      "invalid_contract",
      "invalid_reference",
      "unsupported_version",
    ];
    if (!allowed.includes(reason))
      throw new RelayError("invalid_failure_reason");
    this.#tx(() => {
      const now = this.#now(),
        row = this.#owned(job, now);
      this.#db
        .prepare(
          "UPDATE relay_outbox SET state='quarantined',lease_until=NULL,reason=? WHERE message_id=?",
        )
        .run(reason, row.message_id);
      this.#cleanup(now);
    });
  }
  notFound(job: SendJob): void {
    if (job.operation !== "status")
      throw new RelayError("invalid_status_result");
    this.defer(job, true);
  }
  /** Explicit local administration; never transmits, schedules or replaces a message. */
  maintain(limit: number): OutboxMaintenanceResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RelayError("invalid_request");
    return this.#tx(() => {
      const now = this.#now();
      if (
        !this.#db
          .prepare("SELECT 1 FROM relay_outbox_maintenance_totals WHERE id=1")
          .get()
      )
        throw new RelayError("maintenance_state_unavailable");
      const expired = this.#expire(now, limit),
        cutoff = now - RECORD_RETENTION_MS;
      const eligible = `state IN ('accepted','expired_unknown') AND body IS NULL AND lease_until IS NULL
        AND terminal_at<=? AND expires_at<=? AND status_until<=? AND retain_until<=?`;
      const rows = this.#db
        .prepare(
          `SELECT message_id FROM relay_outbox WHERE ${eligible} AND relay_outbox_gc_safe(message_id,expires_at)=1
         ORDER BY retain_until,message_id LIMIT ?`,
        )
        .all(cutoff, cutoff, cutoff, now, limit - expired);
      for (const row of rows)
        this.#db
          .prepare("DELETE FROM relay_outbox WHERE message_id=?")
          .run(row.message_id);
      const safetyHeld = Number(
        this.#db
          .prepare(
            `SELECT count(*) n FROM relay_outbox WHERE ${eligible} AND relay_outbox_gc_safe(message_id,expires_at)=0`,
          )
          .get(cutoff, cutoff, cutoff, now)!.n,
      );
      this.#db
        .prepare(
          "UPDATE relay_outbox_maintenance_totals SET last_at=?,expired=expired+?,purged=purged+? WHERE id=1",
        )
        .run(now, expired, rows.length);
      return { expired, purged: rows.length, safety_held: safetyHeld };
    });
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
