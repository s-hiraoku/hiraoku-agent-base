/** Durable question-answer producer. Trusted synchronous local port; no network or Task IO. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  comparisonMaterial,
  parseSubmission,
  validateLimits,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
  DELIVERY_TTL_MS,
  RECORD_RETENTION_MS,
} from "../relay/contract.ts";
import type { ContractLimits, Submission } from "../relay/contract.ts";
import {
  id,
  sourceKey,
  sourceSchema,
  checkGuard,
  ReplyBudgetError,
} from "../adapter-policy/contract.ts";
import type {
  ReplySource,
  ReplySourceKey,
} from "../adapter-policy/contract.ts";

export interface AnswerJournalOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
}
const recordSchema = z.strictObject({
  source: sourceSchema,
  source_expires_at: z.number().int().nonnegative(),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  actor_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reply_id: id,
  first_sent_at: z.string(),
  expires_at: z.string(),
  reply_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["prepared", "enqueued", "expired"]),
  created_at: z.number().int().nonnegative(),
  closed_at: z.number().int().nonnegative().nullable(),
  retain_until: z.number().int().nonnegative().nullable(),
});
type RecordData = z.infer<typeof recordSchema>;
interface Stored {
  data: RecordData;
  message: Submission | null;
}
export interface AnswerIntent {
  source: ReplySourceKey;
  reply_id: string;
  first_sent_at: string;
  expires_at: string;
  state: "prepared" | "enqueued" | "expired";
}
const schema = `
CREATE TABLE answer_intent_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,
 binding TEXT NOT NULL,last_at INTEGER NOT NULL,record_count INTEGER NOT NULL,body_bytes INTEGER NOT NULL,seal TEXT NOT NULL);
CREATE TABLE answer_intents(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,reply_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),message TEXT,fingerprint TEXT NOT NULL,
 PRIMARY KEY(sender_id,message_id));
`;
export class SQLiteAnswerJournal {
  readonly #db: DatabaseSync;
  readonly #options: AnswerJournalOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: AnswerJournalOptions) {
    try {
      id.parse(options.agent_id);
      validateLimits(options.limits);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128 ||
        !Number.isSafeInteger(options.max_records) ||
        options.max_records < 1 ||
        options.max_records > 10000 ||
        !Number.isSafeInteger(options.max_body_bytes) ||
        options.max_body_bytes < 1 ||
        options.max_body_bytes > 67108864 ||
        !Number.isSafeInteger(options.max_clock_skew_ms) ||
        options.max_clock_skew_ms < 0 ||
        options.max_clock_skew_ms > 60000
      )
        throw Error();
    } catch {
      throw new ReplyBudgetError("invalid_answer_intent_options");
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
          const s = fstatSync(fd);
          if (!s.isFile() || s.mode & 0o077) throw Error();
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
      throw new ReplyBudgetError("answer_intent_unavailable");
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
    const { agent_id, limits, max_records, max_body_bytes, max_clock_skew_ms } =
      this.#options;
    return this.#hash("binding-v1", {
      agent_id,
      limits,
      max_records,
      max_body_bytes,
      max_clock_skew_ms,
    });
  }
  #tx<T>(guard: () => void, action: () => T): T {
    checkGuard(guard);
    if (this.#inside) throw new ReplyBudgetError("answer_intent_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const value = action();
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw new ReplyBudgetError("invalid_answer_intent_action");
      }
      checkGuard(guard);
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
          throw new ReplyBudgetError("answer_intent_unavailable");
        }
      }
      if (error instanceof ReplyBudgetError) throw error;
      throw new ReplyBudgetError("answer_intent_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #usage() {
    const row = this.#db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(CAST(message AS BLOB))),0) bytes FROM answer_intents",
      )
      .get()!;
    return [Number(row.n), Number(row.bytes)];
  }
  #meta() {
    const rows = this.#db.prepare("SELECT * FROM answer_intent_meta").all(),
      v = rows[0];
    if (rows.length !== 1 || v.id !== 1 || v.version !== 1)
      throw new ReplyBudgetError("unsupported_answer_intent_schema");
    if (v.binding !== this.#binding())
      throw new ReplyBudgetError("answer_intent_binding_mismatch");
    const [count, bytes] = this.#usage();
    if (
      !Number.isSafeInteger(v.last_at) ||
      Number(v.last_at) < 0 ||
      count !== v.record_count ||
      bytes !== v.body_bytes ||
      count > this.#options.max_records ||
      bytes > this.#options.max_body_bytes ||
      v.seal !== this.#hash("meta-v1", [v.last_at, count, bytes])
    )
      throw new ReplyBudgetError("answer_intent_integrity_failed");
    return Number(v.last_at);
  }
  #seal(now: number) {
    const [count, bytes] = this.#usage();
    if (
      count > this.#options.max_records ||
      bytes > this.#options.max_body_bytes
    )
      throw new ReplyBudgetError("answer_intent_capacity_exceeded");
    this.#db
      .prepare(
        "UPDATE answer_intent_meta SET last_at=?,record_count=?,body_bytes=?,seal=? WHERE id=1",
      )
      .run(now, count, bytes, this.#hash("meta-v1", [now, count, bytes]));
  }
  #now(previous: number) {
    const now = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
        .get()!.at,
    );
    if (!Number.isSafeInteger(now) || now < previous)
      throw new ReplyBudgetError("answer_intent_clock_regressed");
    return now;
  }
  #records(): Stored[] {
    if (!this.#ready) throw new ReplyBudgetError("answer_intent_not_migrated");
    const previous = this.#meta();
    return this.#db
      .prepare("SELECT * FROM answer_intents")
      .all()
      .map((row) => {
        try {
          if (
            typeof row.data !== "string" ||
            row.data.length > 8192 ||
            (row.message !== null &&
              (typeof row.message !== "string" ||
                Buffer.byteLength(row.message) >
                  this.#options.max_body_bytes)) ||
            row.fingerprint !== this.#hash("record-v1", [row.data, row.message])
          )
            throw Error();
          const d = recordSchema.parse(JSON.parse(row.data));
          const expires = Date.parse(d.expires_at),
            first = Date.parse(d.first_sent_at);
          if (
            row.sender_id !== d.source.sender_id ||
            row.message_id !== d.source.message_id ||
            row.reply_id !== d.reply_id ||
            row.state !== d.state ||
            d.source.recipient_id !== this.agentId ||
            d.source.sender_id === this.agentId ||
            d.source.kind !== "question" ||
            first !== d.created_at ||
            new Date(first).toISOString() !== d.first_sent_at ||
            expires - first !== DELIVERY_TTL_MS ||
            new Date(expires).toISOString() !== d.expires_at ||
            !isReplayBoundMessageId(d.reply_id, expires) ||
            d.created_at > previous ||
            (d.state === "prepared"
              ? row.message === null ||
                d.closed_at !== null ||
                d.retain_until !== null
              : row.message !== null ||
                d.closed_at === null ||
                d.closed_at < d.created_at ||
                d.closed_at > previous ||
                d.retain_until !==
                  Math.max(d.source_expires_at, expires, d.closed_at) +
                    RECORD_RETENTION_MS)
          )
            throw Error();
          const message =
            row.message === null
              ? null
              : parseSubmission(
                  JSON.parse(String(row.message)),
                  this.#options.limits,
                );
          if (message && this.#fingerprint(message) !== d.reply_fingerprint)
            throw Error();
          if (
            message &&
            (message.kind !== "answer" ||
              message.message_id !== d.reply_id ||
              message.recipient_id !== d.source.sender_id ||
              message.thread_id !== d.source.thread_id ||
              message.in_reply_to?.sender_id !== d.source.sender_id ||
              message.in_reply_to?.message_id !== d.source.message_id ||
              message.first_sent_at !== d.first_sent_at ||
              message.expires_at !== d.expires_at)
          )
            throw Error();
          return { data: d, message };
        } catch {
          throw new ReplyBudgetError("answer_intent_integrity_failed");
        }
      });
  }
  #fingerprint(message: Submission) {
    return this.#hash(
      "reply-v1",
      comparisonMaterial(this.agentId, message, this.#options.limits),
    );
  }
  #summary(d: RecordData): AnswerIntent {
    return {
      source: {
        sender_id: d.source.sender_id,
        message_id: d.source.message_id,
      },
      reply_id: d.reply_id,
      first_sent_at: d.first_sent_at,
      expires_at: d.expires_at,
      state: d.state,
    };
  }
  #save(d: RecordData, message: Submission | null, insert = false) {
    const data = JSON.stringify(d),
      text = message === null ? null : JSON.stringify(message),
      fingerprint = this.#hash("record-v1", [data, text]);
    if (insert)
      this.#db
        .prepare("INSERT INTO answer_intents VALUES(?,?,?,?,?,?,?)")
        .run(
          d.source.sender_id,
          d.source.message_id,
          d.reply_id,
          d.state,
          data,
          text,
          fingerprint,
        );
    else
      this.#db
        .prepare(
          "UPDATE answer_intents SET state=?,data=?,message=?,fingerprint=? WHERE sender_id=? AND message_id=?",
        )
        .run(
          d.state,
          data,
          text,
          fingerprint,
          d.source.sender_id,
          d.source.message_id,
        );
  }
  #close(d: RecordData, state: "enqueued" | "expired", now: number) {
    d.state = state;
    d.closed_at = now;
    d.retain_until =
      Math.max(d.source_expires_at, Date.parse(d.expires_at), now) +
      RECORD_RETENTION_MS;
    this.#save(d, null);
  }
  migrate() {
    this.#ready = false;
    this.#tx(
      () => {},
      () => {
        if (
          !this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name='answer_intent_meta'",
            )
            .get()
        ) {
          if (
            this.#db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
              )
              .get()
          )
            throw new ReplyBudgetError("unknown_answer_intent_schema");
          this.#db.exec(schema);
          this.#db
            .prepare("INSERT INTO answer_intent_meta VALUES(1,1,?,0,0,0,?)")
            .run(this.#binding(), this.#hash("meta-v1", [0, 0, 0]));
        }
        this.#meta();
        this.#db
          .prepare(
            "SELECT sender_id,message_id,reply_id,state,data,message,fingerprint FROM answer_intents LIMIT 0",
          )
          .all();
      },
    );
    this.#ready = true;
    try {
      this.#tx(
        () => {},
        () => this.#records(),
      );
    } catch (e) {
      this.#ready = false;
      throw e;
    }
  }
  get(input: ReplySourceKey, guard: () => void): AnswerIntent | null {
    const key = sourceKey.parse(input);
    return this.#tx(guard, () => {
      const row = this.#records().find(
        (r) =>
          r.data.source.sender_id === key.sender_id &&
          r.data.source.message_id === key.message_id,
      );
      return row ? this.#summary(row.data) : null;
    });
  }
  /** proof is supplied only by the confirmed inbox facade, never a wire argument. */
  prepare(
    input: ReplySourceKey,
    body: unknown,
    actor: string,
    proof: {
      source: ReplySource;
      expires_at: string;
      fingerprint_material: string;
    } | null,
    guard: () => void,
  ): AnswerIntent {
    const key = sourceKey.parse(input);
    id.parse(actor);
    return this.#tx(guard, () => {
      const records = this.#records(),
        now = this.#now(this.#meta());
      const old = records.find(
        (r) =>
          r.data.source.sender_id === key.sender_id &&
          r.data.source.message_id === key.message_id,
      );
      let d: RecordData;
      if (old) d = old.data;
      else {
        if (!proof) throw new ReplyBudgetError("invalid_reply_source");
        const source = sourceSchema.parse(proof.source),
          expiry = Date.parse(proof.expires_at);
        if (
          source.sender_id !== key.sender_id ||
          source.message_id !== key.message_id ||
          source.recipient_id !== this.agentId ||
          source.sender_id === this.agentId ||
          source.kind !== "question" ||
          !Number.isSafeInteger(expiry) ||
          expiry - DELIVERY_TTL_MS > now + this.#options.max_clock_skew_ms
        )
          throw new ReplyBudgetError("invalid_reply_source");
        if (
          isReplayBoundMessageId(key.message_id, expiry) &&
          now >= expiry + RECORD_RETENTION_MS
        )
          throw new ReplyBudgetError("answer_intent_source_horizon_closed");
        const first = new Date(now).toISOString();
        d = {
          source,
          source_expires_at: expiry,
          source_fingerprint: this.#hash(
            "source-v1",
            proof.fingerprint_material,
          ),
          actor_fingerprint: this.#hash("actor-v1", [actor, key, now]),
          reply_id: makeReplayBoundMessageId(
            first,
            randomUUID().replaceAll("-", ""),
          ),
          first_sent_at: first,
          expires_at: new Date(now + DELIVERY_TTL_MS).toISOString(),
          reply_fingerprint: "",
          state: "prepared",
          created_at: now,
          closed_at: null,
          retain_until: null,
        };
      }
      const message = parseSubmission(
        {
          version: 1,
          message_id: d.reply_id,
          recipient_id: d.source.sender_id,
          kind: "answer",
          body,
          thread_id: d.source.thread_id,
          in_reply_to: key,
          first_sent_at: d.first_sent_at,
          expires_at: d.expires_at,
        },
        this.#options.limits,
      );
      const fp = this.#fingerprint(message);
      if (old) {
        if (fp !== d.reply_fingerprint)
          throw new ReplyBudgetError("answer_intent_conflict");
      } else {
        d.reply_fingerprint = fp;
        this.#save(d, message, true);
      }
      this.#seal(now);
      return this.#summary(d);
    });
  }
  /** Synchronous handoff may commit in another DB before this confirmation commits. Exact retry is mandatory. */
  handoff(
    input: ReplySourceKey,
    guard: () => void,
    enqueue: (source: ReplySource, message: Submission) => void,
  ): AnswerIntent {
    const key = sourceKey.parse(input);
    return this.#tx(guard, () => {
      const row = this.#records().find(
        (r) =>
          r.data.source.sender_id === key.sender_id &&
          r.data.source.message_id === key.message_id,
      );
      if (!row) throw new ReplyBudgetError("answer_intent_not_found");
      const now = this.#now(this.#meta()),
        d = row.data;
      if (d.state === "prepared") {
        if (Date.parse(d.expires_at) <= now) this.#close(d, "expired", now);
        else {
          checkGuard(guard);
          const result: unknown = enqueue(
            structuredClone(d.source),
            structuredClone(row.message!),
          );
          if (result && typeof result === "object" && "then" in result) {
            void Promise.resolve(result).catch(() => {});
            throw new ReplyBudgetError("invalid_answer_intent_action");
          }
          checkGuard(guard);
          this.#close(d, "enqueued", now);
        }
      }
      this.#seal(now);
      return this.#summary(d);
    });
  }
  pending(limit: number, after: string | null, guard: () => void) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (after !== null && !id.safeParse(after).success)
    )
      throw new ReplyBudgetError("invalid_answer_intent_page");
    return this.#tx(guard, () => {
      const rows = this.#records()
        .filter(
          (r) =>
            r.data.state === "prepared" &&
            (after === null || r.data.reply_id > after),
        )
        .sort((a, b) => (a.data.reply_id < b.data.reply_id ? -1 : 1));
      const items = rows.slice(0, limit).map((r) => this.#summary(r.data));
      return {
        items,
        next_after: rows.length > limit ? items.at(-1)!.reply_id : null,
      };
    });
  }
  maintain(limit: number, guard: () => void) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new ReplyBudgetError("invalid_answer_intent_page");
    return this.#tx(guard, () => {
      const records = this.#records(),
        now = this.#now(this.#meta());
      let expired = 0,
        purged = 0,
        safety_held = 0;
      for (const { data: d } of records) {
        if (expired + purged >= limit) break;
        if (d.state === "prepared" && Date.parse(d.expires_at) <= now) {
          this.#close(d, "expired", now);
          expired++;
        } else if (d.state !== "prepared" && d.retain_until! <= now) {
          if (
            !isReplayBoundMessageId(d.source.message_id, d.source_expires_at)
          ) {
            safety_held++;
            continue;
          }
          this.#db
            .prepare(
              "DELETE FROM answer_intents WHERE sender_id=? AND message_id=?",
            )
            .run(d.source.sender_id, d.source.message_id);
          purged++;
        }
      }
      this.#seal(now);
      return { expired, purged, safety_held };
    });
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
