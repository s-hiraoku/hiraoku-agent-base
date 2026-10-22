/** Append-only reservations commit before outbox IO. No timers or network calls. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { createHmac, createHash } from "node:crypto";
import { z } from "zod";
import {
  comparisonMaterial,
  parseSubmission,
  isReplayBoundMessageId,
  validateLimits,
} from "../relay/contract.ts";
import type { ContractLimits, Submission } from "../relay/contract.ts";
import {
  ReplyBudgetError,
  id,
  sourceSchema,
  sourceKey,
  replyKind,
  checkGuard,
} from "./contract.ts";
import type {
  ReplySource,
  ReplySourceKey,
  AutomaticReplyKind,
  ReplyAdmission,
} from "./contract.ts";
export interface ReplyBudgetOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  max_thread_replies: number;
  max_per_window: number;
  window_ms: number;
  max_clock_skew_ms: number;
}
const recordSchema = z.strictObject({
  source: sourceSchema,
  kind: replyKind,
  reply_id: id,
  reply_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reserved_at: z.number().int().nonnegative(),
});
export type ReplyReservation = z.infer<typeof recordSchema>;
const schema = `
CREATE TABLE reply_budget_meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
 binding TEXT NOT NULL, key_check TEXT NOT NULL, last_at INTEGER NOT NULL, record_count INTEGER NOT NULL, clock_check TEXT NOT NULL);
CREATE TABLE reply_budget_reservations(sender_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL,
 reply_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)), fingerprint TEXT NOT NULL,
 PRIMARY KEY(sender_id,message_id,kind));
CREATE TRIGGER reply_budget_no_update BEFORE UPDATE ON reply_budget_reservations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER reply_budget_no_delete BEFORE DELETE ON reply_budget_reservations BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
export class SQLiteReplyBudget implements ReplyAdmission {
  readonly #db: DatabaseSync;
  readonly #options: ReplyBudgetOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: ReplyBudgetOptions) {
    try {
      id.parse(options.agent_id);
      validateLimits(options.limits);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128
      )
        throw Error();
      for (const name of [
        "max_records",
        "max_thread_replies",
        "max_per_window",
        "window_ms",
        "max_clock_skew_ms",
      ] as const)
        if (
          !Number.isSafeInteger(options[name]) ||
          options[name] < (name === "max_clock_skew_ms" ? 0 : 1)
        )
          throw Error();
      if (
        options.max_records > 10000 ||
        options.max_thread_replies > 1000 ||
        options.max_per_window > 10000 ||
        options.window_ms > 86400000 ||
        options.max_clock_skew_ms > 60000
      )
        throw Error();
    } catch {
      throw new ReplyBudgetError("invalid_reply_budget_options");
    }
    this.#options = {
      ...options,
      limits: Object.freeze({ ...options.limits }),
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    let db: DatabaseSync | undefined;
    try {
      if (path !== ":memory:") {
        const fd = openSync(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.mode & 0o077) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path, { timeout: 1000 });
      db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new ReplyBudgetError("reply_budget_unavailable");
    }
  }
  get agentId() {
    return this.#options.agent_id;
  }
  #hash(domain: string, value: unknown) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(JSON.stringify(value))
      .digest("hex");
  }
  #binding() {
    const {
      agent_id,
      limits,
      max_records,
      max_thread_replies,
      max_per_window,
      window_ms,
      max_clock_skew_ms,
    } = this.#options;
    return this.#hash("policy-v1", {
      agent_id,
      limits,
      max_records,
      max_thread_replies,
      max_per_window,
      window_ms,
      max_clock_skew_ms,
    });
  }
  #keyCheck() {
    return createHash("sha256")
      .update(this.#options.fingerprint_key)
      .digest("hex");
  }
  #tx<T>(action: () => T, guard: () => void = () => {}) {
    if (this.#inside) throw new ReplyBudgetError("reply_budget_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const value = action();
      checkGuard(guard);
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
          throw new ReplyBudgetError("reply_budget_unavailable");
        }
      }
      if (error instanceof ReplyBudgetError) throw error;
      throw new ReplyBudgetError("reply_budget_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #meta() {
    const rows = this.#db.prepare("SELECT * FROM reply_budget_meta").all();
    const v = rows[0];
    if (rows.length !== 1 || v.id !== 1 || v.version !== 1)
      throw new ReplyBudgetError("unsupported_reply_budget_schema");
    if (v.binding !== this.#binding() || v.key_check !== this.#keyCheck())
      throw new ReplyBudgetError("reply_budget_binding_mismatch");
    if (
      !Number.isSafeInteger(v.last_at) ||
      Number(v.last_at) < 0 ||
      !Number.isSafeInteger(v.record_count) ||
      Number(v.record_count) < 0 ||
      v.clock_check !== this.#hash("clock-v1", [v.last_at, v.record_count])
    )
      throw new ReplyBudgetError("reply_budget_integrity_failed");
    return { last_at: Number(v.last_at), record_count: Number(v.record_count) };
  }
  migrate() {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='reply_budget_meta'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new ReplyBudgetError("unknown_reply_budget_schema");
        this.#db.exec(schema);
        this.#db
          .prepare("INSERT INTO reply_budget_meta VALUES(1,1,?,?,0,0,?)")
          .run(
            this.#binding(),
            this.#keyCheck(),
            this.#hash("clock-v1", [0, 0]),
          );
      }
      this.#meta();
      this.#db
        .prepare(
          "SELECT sender_id,message_id,kind,reply_id,data,fingerprint FROM reply_budget_reservations LIMIT 0",
        )
        .all();
      for (const name of ["reply_budget_no_update", "reply_budget_no_delete"])
        if (
          !this.#db
            .prepare("SELECT 1 FROM sqlite_master WHERE name=?")
            .get(name)
        )
          throw new ReplyBudgetError("unsupported_reply_budget_schema");
    });
    this.#ready = true;
  }
  #readyCheck() {
    if (!this.#ready) throw new ReplyBudgetError("reply_budget_not_migrated");
  }
  #records() {
    const rows = this.#db
      .prepare("SELECT * FROM reply_budget_reservations")
      .all();
    if (
      rows.length !== this.#meta().record_count ||
      rows.length > this.#options.max_records
    )
      throw new ReplyBudgetError("reply_budget_integrity_failed");
    return rows.map((row) => {
      try {
        if (
          typeof row.data !== "string" ||
          row.data.length > 4096 ||
          this.#hash("reservation-v1", row.data) !== row.fingerprint
        )
          throw Error();
        const v = recordSchema.parse(JSON.parse(row.data));
        if (
          v.source.recipient_id !== this.agentId ||
          v.source.sender_id === this.agentId ||
          row.sender_id !== v.source.sender_id ||
          row.message_id !== v.source.message_id ||
          row.kind !== v.kind ||
          row.reply_id !== v.reply_id
        )
          throw Error();
        this.#relationship(v.source.kind, v.kind);
        return v;
      } catch {
        throw new ReplyBudgetError("reply_budget_integrity_failed");
      }
    });
  }
  #relationship(sourceKind: string, kind: string) {
    if (!(
      (sourceKind === "question" && kind === "answer") ||
      (sourceKind === "execution_request" &&
        ["execution_accepted", "execution_result"].includes(kind))
    ))
      throw new ReplyBudgetError("automatic_reply_forbidden");
  }
  lookup(
    input: ReplySourceKey,
    kind: AutomaticReplyKind,
  ): ReplyReservation | null {
    const key = sourceKey.parse(input);
    replyKind.parse(kind);
    return this.#tx(() => {
      this.#readyCheck();
      this.#meta();
      return (
        this.#records().find(
          (r) =>
            r.source.sender_id === key.sender_id &&
            r.source.message_id === key.message_id &&
            r.kind === kind,
        ) ?? null
      );
    });
  }
  withReply<T>(
    rawSource: ReplySource,
    input: Submission,
    guard: () => void,
    action: () => T,
  ): T {
    checkGuard(guard);
    const source = sourceSchema.parse(rawSource),
      message = parseSubmission(input, this.#options.limits);
    this.#relationship(source.kind, message.kind);
    if (
      source.recipient_id !== this.agentId ||
      source.sender_id === this.agentId ||
      message.recipient_id !== source.sender_id ||
      message.thread_id !== source.thread_id ||
      message.in_reply_to?.sender_id !== source.sender_id ||
      message.in_reply_to?.message_id !== source.message_id ||
      !isReplayBoundMessageId(
        message.message_id,
        Date.parse(message.expires_at),
      ) ||
      typeof action !== "function"
    )
      throw new ReplyBudgetError("invalid_automatic_reply");
    const kind = replyKind.parse(message.kind);
    const fingerprint = this.#hash(
      "reply-content-v1",
      comparisonMaterial(this.agentId, message, this.#options.limits),
    );
    this.#tx(() => {
      this.#readyCheck();
      const previous = this.#meta().last_at;
      const now = Number(
        this.#db
          .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
          .get()!.at,
      );
      if (!Number.isSafeInteger(now) || now < previous)
        throw new ReplyBudgetError("reply_budget_clock_regressed");
      const records = this.#records();
      if (records.some((r) => r.reserved_at > previous))
        throw new ReplyBudgetError("reply_budget_integrity_failed");
      const existing = records.find(
        (r) =>
          r.source.sender_id === source.sender_id &&
          r.source.message_id === source.message_id &&
          r.kind === kind,
      );
      if (existing) {
        if (
          existing.reply_id !== message.message_id ||
          existing.reply_fingerprint !== fingerprint ||
          JSON.stringify(existing.source) !== JSON.stringify(source)
        )
          throw new ReplyBudgetError("reply_budget_conflict");
      } else {
        if (
          Date.parse(message.expires_at) <= now ||
          Date.parse(message.first_sent_at) >
            now + this.#options.max_clock_skew_ms
        )
          throw new ReplyBudgetError("reply_budget_invalid_time");
        if (records.some((r) => r.reply_id === message.message_id))
          throw new ReplyBudgetError("reply_budget_conflict");
        if (records.length >= this.#options.max_records)
          throw new ReplyBudgetError("reply_budget_capacity_exceeded");
        if (
          records.filter((r) => r.source.thread_id === source.thread_id)
            .length >= this.#options.max_thread_replies
        )
          throw new ReplyBudgetError("reply_thread_exhausted");
        if (
          records.filter((r) => r.reserved_at > now - this.#options.window_ms)
            .length >= this.#options.max_per_window
        )
          throw new ReplyBudgetError("reply_rate_exhausted");
        const data: ReplyReservation = {
          source,
          kind,
          reply_id: message.message_id,
          reply_fingerprint: fingerprint,
          reserved_at: now,
        };
        const text = JSON.stringify(data);
        this.#db
          .prepare("INSERT INTO reply_budget_reservations VALUES(?,?,?,?,?,?)")
          .run(
            source.sender_id,
            source.message_id,
            kind,
            message.message_id,
            text,
            this.#hash("reservation-v1", text),
          );
      }
      const count = records.length + (existing ? 0 : 1);
      this.#db
        .prepare(
          "UPDATE reply_budget_meta SET last_at=?,record_count=?,clock_check=? WHERE id=1",
        )
        .run(now, count, this.#hash("clock-v1", [now, count]));
    }, guard);
    // The reservation survives all failures after this point. Never refund on an uncertain outcome.
    checkGuard(guard);
    const value = action();
    if (value && typeof value === "object" && "then" in value) {
      void Promise.resolve(value).catch(() => {});
      throw new ReplyBudgetError("invalid_reply_action");
    }
    return value;
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
