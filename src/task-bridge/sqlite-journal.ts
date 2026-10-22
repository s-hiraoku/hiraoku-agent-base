/** Private integration journal. Schema2 replies; never joins or migrates Relay/Task tables. */
import { ReplyBudgetError } from "../adapter-policy/contract.ts";
import { DatabaseSync } from "node:sqlite";
import { openSync, fstatSync, closeSync, constants } from "node:fs";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  comparisonMaterial,
  validateLimits,
  parseSubmission,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
} from "../relay/contract.ts";
import { RelayError } from "../relay/service.ts";
import type { OutboxRecord } from "../relay/sender.ts";
import {
  replyKindSchema,
  replyRecordSchema,
  replyMessage,
} from "./reply-contract.ts";
import type { BridgeReply, ReplyKind } from "./reply-contract.ts";
import type { Submission, ContractLimits } from "../relay/contract.ts";
import type { InboxEntry } from "../relay/receiver.ts";
import {
  TaskBridgeError,
  identifier,
  keySchema,
  bindingSchema,
  taskSchema,
  executionRequest,
  taskEvidence,
  closedTask,
} from "./contract.ts";
import type { SourceKey, TaskBinding, TaskEvidence } from "./contract.ts";
export interface BridgeJournalOptions {
  receiver_id: string;
  binding: TaskBinding;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  max_audit_records: number;
  lease_ms: number;
  max_submit_attempts: number;
}
const linkSchema = z.strictObject({
  sender_id: identifier,
  message_id: identifier,
  receiver_id: identifier,
  thread_id: identifier,
  first_sent_at: z.string().max(32),
  expires_at: z.string().max(32),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decision_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  accepted_at: z.number().int().nonnegative(),
  request_key: z.string().regex(/^br_[a-f0-9]{32}$(?![\s\S])/),
  state: z.enum([
    "prepared",
    "submitting",
    "uncertain",
    "linked",
    "waiting_approval",
  ]),
  attempts: z.number().int().nonnegative(),
  fence: z.number().int().nonnegative(),
  lease_until: z.number().int().nonnegative().nullable(),
  task: taskSchema.nullable(),
});
export type BridgeLink = z.infer<typeof linkSchema>;
export type BridgeAttempt = SourceKey & { request_key: string; fence: number };
type Row = {
  sender_id: string;
  message_id: string;
  request_key: string;
  state: string;
  lease_until: number | null;
  data: string;
  fingerprint: string;
};
const schema = `
CREATE TABLE task_bridge_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,binding_check TEXT NOT NULL,key_check TEXT NOT NULL);
CREATE TABLE task_bridge_links(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL,lease_until INTEGER,data TEXT NOT NULL CHECK(json_valid(data)),fingerprint TEXT NOT NULL,PRIMARY KEY(sender_id,message_id));
CREATE UNIQUE INDEX task_bridge_one_unresolved ON task_bridge_links((1)) WHERE state IN ('submitting','uncertain','waiting_approval');
CREATE TRIGGER task_bridge_identity BEFORE UPDATE OF sender_id,message_id,request_key ON task_bridge_links BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE task_bridge_audit(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,message_id TEXT NOT NULL,event TEXT NOT NULL,fence INTEGER NOT NULL,at INTEGER NOT NULL,fingerprint TEXT NOT NULL);
`;
const replySchema = `
CREATE TABLE task_bridge_replies(
 sender_id TEXT NOT NULL,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('execution_accepted','execution_result')),
 reply_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('prepared','enqueued','expired')),
 data TEXT NOT NULL CHECK(json_valid(data)),fingerprint TEXT NOT NULL,
 PRIMARY KEY(sender_id,message_id,kind),FOREIGN KEY(sender_id,message_id) REFERENCES task_bridge_links(sender_id,message_id));
CREATE TRIGGER task_bridge_reply_identity BEFORE UPDATE OF sender_id,message_id,kind,reply_id ON task_bridge_replies BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
export class SQLiteTaskBridgeJournal {
  readonly #db: DatabaseSync;
  readonly #options: BridgeJournalOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: BridgeJournalOptions) {
    try {
      identifier.parse(options.receiver_id);
      bindingSchema.parse(options.binding);
      validateLimits(options.limits);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128
      )
        throw Error();
      for (const k of [
        "max_records",
        "max_audit_records",
        "lease_ms",
        "max_submit_attempts",
      ] as const)
        if (!Number.isSafeInteger(options[k]) || options[k] < 1) throw Error();
      if (
        options.max_records > 10000 ||
        options.max_audit_records > 100000 ||
        options.lease_ms > 30000 ||
        options.max_submit_attempts > 10
      )
        throw Error();
    } catch {
      throw new TaskBridgeError("invalid_bridge_options");
    }
    this.#options = {
      ...options,
      binding: Object.freeze(bindingSchema.parse(options.binding)),
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
      limits: Object.freeze({ ...options.limits }),
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
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.mode & 0o077) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path, { timeout: 1000 });
      db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new TaskBridgeError("bridge_store_unavailable");
    }
  }
  get receiverId() {
    return this.#options.receiver_id;
  }
  get binding(): Readonly<TaskBinding> {
    return this.#options.binding;
  }
  #hash(domain: string, value: unknown) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(JSON.stringify(value))
      .digest("hex");
  }
  #bindingCheck() {
    return this.#hash("binding-v1", [this.receiverId, this.binding]);
  }
  #tx<T>(action: () => T, guard: () => void = () => {}) {
    if (this.#inside) throw new TaskBridgeError("bridge_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const value = action();
      const checked: unknown = guard();
      if (checked && typeof checked === "object" && "then" in checked) {
        void Promise.resolve(checked).catch(() => {});
        throw new TaskBridgeError("bridge_forbidden");
      }
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
          throw new TaskBridgeError("bridge_store_unavailable");
        }
      }
      if (error instanceof TaskBridgeError) throw error;
      throw new TaskBridgeError("bridge_store_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #now() {
    if (!this.#ready) throw new TaskBridgeError("bridge_not_migrated");
    const now = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
        .get()!.at,
    );
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TaskBridgeError("bridge_store_unavailable");
    return now;
  }
  migrate() {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='task_bridge_meta'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new TaskBridgeError("unknown_bridge_schema");
        this.#db.exec(schema);
        this.#db
          .prepare("INSERT INTO task_bridge_meta VALUES(1,1,?,?)")
          .run(
            this.#bindingCheck(),
            createHash("sha256")
              .update(this.#options.fingerprint_key)
              .digest("hex"),
          );
      }
      const meta = this.#db.prepare("SELECT * FROM task_bridge_meta").all();
      if (
        meta.length !== 1 ||
        ![1, 2].includes(Number(meta[0].version)) ||
        meta[0].id !== 1
      )
        throw new TaskBridgeError("unsupported_bridge_schema");
      if (
        meta[0].binding_check !== this.#bindingCheck() ||
        meta[0].key_check !==
          createHash("sha256")
            .update(this.#options.fingerprint_key)
            .digest("hex")
      )
        throw new TaskBridgeError("bridge_binding_mismatch");
      this.#db
        .prepare(
          "SELECT sender_id,message_id,request_key,state,lease_until,data,fingerprint FROM task_bridge_links LIMIT 0",
        )
        .all();
      this.#db
        .prepare(
          "SELECT id,sender_id,message_id,event,fence,at,fingerprint FROM task_bridge_audit LIMIT 0",
        )
        .all();
      for (const name of ["task_bridge_one_unresolved", "task_bridge_identity"])
        if (
          !this.#db
            .prepare("SELECT 1 FROM sqlite_master WHERE name=?")
            .get(name)
        )
          throw new TaskBridgeError("unsupported_bridge_schema");
      if (meta[0].version === 1) {
        this.#db.exec(replySchema);
        this.#db.exec("UPDATE task_bridge_meta SET version=2 WHERE id=1");
      }
      this.#db
        .prepare(
          "SELECT sender_id,message_id,kind,reply_id,state,data,fingerprint FROM task_bridge_replies LIMIT 0",
        )
        .all();
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='task_bridge_reply_identity'",
          )
          .get()
      )
        throw new TaskBridgeError("unsupported_bridge_schema");
    });
    this.#ready = true;
  }
  #decode(row: Row): BridgeLink {
    try {
      if (
        row.data.length > 16384 ||
        this.#hash("link-v1", row.data) !== row.fingerprint
      )
        throw Error();
      const data = linkSchema.parse(JSON.parse(row.data));
      if (
        data.sender_id !== row.sender_id ||
        data.message_id !== row.message_id ||
        data.request_key !== row.request_key ||
        data.state !== row.state ||
        data.lease_until !== row.lease_until ||
        data.receiver_id !== this.receiverId ||
        (data.state === "submitting") !== (data.lease_until !== null) ||
        (data.state === "linked") !== (data.task !== null)
      )
        throw Error();
      if (data.task) taskEvidence(data.task, this.binding, data.request_key);
      return data;
    } catch {
      throw new TaskBridgeError("bridge_integrity_failed");
    }
  }
  #read(key: SourceKey) {
    const row = this.#db
      .prepare(
        "SELECT * FROM task_bridge_links WHERE sender_id=? AND message_id=?",
      )
      .get(key.sender_id, key.message_id) as Row | undefined;
    if (!row) throw new TaskBridgeError("bridge_not_found");
    return this.#decode(row);
  }
  #write(data: BridgeLink, insert = false) {
    const text = JSON.stringify(linkSchema.parse(data)),
      fingerprint = this.#hash("link-v1", text);
    if (insert)
      this.#db
        .prepare("INSERT INTO task_bridge_links VALUES(?,?,?,?,?,?,?)")
        .run(
          data.sender_id,
          data.message_id,
          data.request_key,
          data.state,
          data.lease_until,
          text,
          fingerprint,
        );
    else
      this.#db
        .prepare(
          "UPDATE task_bridge_links SET state=?,lease_until=?,data=?,fingerprint=? WHERE sender_id=? AND message_id=?",
        )
        .run(
          data.state,
          data.lease_until,
          text,
          fingerprint,
          data.sender_id,
          data.message_id,
        );
  }
  #audit(data: BridgeLink, event: string) {
    if (
      Number(
        this.#db.prepare("SELECT count(*) n FROM task_bridge_audit").get()!.n,
      ) >= this.#options.max_audit_records
    )
      throw new TaskBridgeError("bridge_capacity_exceeded");
    const id = randomUUID(),
      at = this.#now();
    this.#db
      .prepare("INSERT INTO task_bridge_audit VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        data.sender_id,
        data.message_id,
        event,
        data.fence,
        at,
        this.#hash("audit-v1", [
          id,
          data.sender_id,
          data.message_id,
          event,
          data.fence,
          at,
        ]),
      );
  }
  get(input: SourceKey): BridgeLink {
    const key = keySchema.parse(input);
    return this.#tx(() => {
      this.#now();
      return this.#read(key);
    });
  }
  prepare(entry: InboxEntry, actorId: string, guard: () => void): BridgeLink {
    const accepted = executionRequest(
      entry,
      this.receiverId,
      this.#options.limits,
    );
    return this.#tx(() => {
      const now = this.#now(),
        key = {
          sender_id: accepted.sender_id,
          message_id: accepted.message.message_id,
        },
        fingerprint = this.#hash(
          "source-v1",
          comparisonMaterial(
            accepted.sender_id,
            accepted.message,
            this.#options.limits,
          ),
        );
      const old = this.#db
        .prepare(
          "SELECT * FROM task_bridge_links WHERE sender_id=? AND message_id=?",
        )
        .get(key.sender_id, key.message_id) as Row | undefined;
      if (old) {
        const link = this.#decode(old);
        if (link.source_fingerprint !== fingerprint)
          throw new TaskBridgeError("bridge_source_conflict");
        return link;
      }
      if (
        Number(
          this.#db.prepare("SELECT count(*) n FROM task_bridge_links").get()!.n,
        ) >= this.#options.max_records
      )
        throw new TaskBridgeError("bridge_capacity_exceeded");
      const data: BridgeLink = {
        ...key,
        receiver_id: this.receiverId,
        thread_id: accepted.message.thread_id,
        first_sent_at: accepted.message.first_sent_at,
        expires_at: accepted.message.expires_at,
        source_fingerprint: fingerprint,
        decision_fingerprint: this.#hash("decision-v1", [
          actorId,
          fingerprint,
          now,
        ]),
        accepted_at: now,
        request_key: "br_" + randomUUID().replaceAll("-", ""),
        state: "prepared",
        attempts: 0,
        fence: 0,
        lease_until: null,
        task: null,
      };
      this.#write(data, true);
      this.#audit(data, "accepted");
      return data;
    }, guard);
  }
  begin(
    input: SourceKey,
    reconcile: boolean,
    guard: () => void,
  ): BridgeAttempt | null {
    const key = keySchema.parse(input);
    return this.#tx(() => {
      const now = this.#now(),
        data = this.#read(key);
      if (data.state === "linked" || data.state === "waiting_approval")
        return null;
      if (data.state === "submitting" && data.lease_until! > now)
        throw new TaskBridgeError("bridge_busy");
      if (data.state === "prepared" ? reconcile : !reconcile)
        throw new TaskBridgeError("bridge_reconciliation_required");
      const all = this.#db
        .prepare("SELECT * FROM task_bridge_links")
        .all() as Row[];
      for (const row of all) {
        const other = this.#decode(row);
        if (
          other.request_key !== data.request_key &&
          ["submitting", "uncertain", "waiting_approval"].includes(other.state)
        )
          throw new TaskBridgeError("bridge_busy");
      }
      if (data.attempts >= this.#options.max_submit_attempts) {
        data.state = "waiting_approval";
        data.lease_until = null;
        this.#write(data);
        this.#audit(data, "manual_required");
        return null;
      }
      data.state = "submitting";
      data.attempts++;
      data.fence++;
      data.lease_until = now + this.#options.lease_ms;
      this.#write(data);
      this.#audit(data, "attempted");
      return { ...key, request_key: data.request_key, fence: data.fence };
    }, guard);
  }
  confirm(
    job: BridgeAttempt,
    evidence: TaskEvidence,
    guard: () => void,
  ): BridgeLink {
    return this.#tx(() => {
      const now = this.#now(),
        data = this.#read(job);
      if (
        data.state !== "submitting" ||
        data.fence !== job.fence ||
        data.request_key !== job.request_key ||
        data.lease_until! <= now
      )
        throw new TaskBridgeError("stale_bridge_attempt");
      data.task = taskEvidence(evidence, this.binding, data.request_key);
      data.state = "linked";
      data.lease_until = null;
      this.#write(data);
      this.#audit(data, "linked");
      return data;
    }, guard);
  }
  uncertain(job: BridgeAttempt): void {
    this.#tx(() => {
      this.#now();
      const data = this.#read(job);
      if (
        data.state !== "submitting" ||
        data.fence !== job.fence ||
        data.request_key !== job.request_key
      )
        return;
      data.state = "uncertain";
      data.lease_until = null;
      this.#write(data);
      this.#audit(data, "uncertain");
    });
  }
  observe(
    key: SourceKey,
    evidence: TaskEvidence,
    guard: () => void,
  ): BridgeLink {
    return this.#tx(() => {
      this.#now();
      const data = this.#read(key);
      if (data.state !== "linked" || !data.task)
        throw new TaskBridgeError("bridge_not_linked");
      const task = taskEvidence(evidence, this.binding, data.request_key);
      if (
        task.id !== data.task.id ||
        task.fence < data.task.fence ||
        (closedTask(data.task) &&
          JSON.stringify(task) !== JSON.stringify(data.task))
      )
        throw new TaskBridgeError("bridge_task_regressed");
      if (JSON.stringify(task) !== JSON.stringify(data.task)) {
        data.task = task;
        this.#write(data);
        this.#audit(data, "observed");
      }
      return data;
    }, guard);
  }
  #readReply(key: SourceKey, kind: ReplyKind): BridgeReply | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM task_bridge_replies WHERE sender_id=? AND message_id=? AND kind=?",
      )
      .get(key.sender_id, key.message_id, kind);
    if (!row) return null;
    try {
      if (
        typeof row.data !== "string" ||
        row.data.length > 16384 ||
        this.#hash("reply-v1", row.data) !== row.fingerprint
      )
        throw Error();
      const record = replyRecordSchema.parse(JSON.parse(row.data));
      const link = this.#read(key);
      const task = taskEvidence(record.task, this.binding, link.request_key);
      const message = parseSubmission(record.message, this.#options.limits);
      if (
        record.kind !== kind ||
        row.kind !== kind ||
        row.state !== record.state ||
        row.reply_id !== message.message_id ||
        !link.task ||
        task.fence > link.task.fence ||
        (kind === "execution_result" &&
          JSON.stringify(task) !== JSON.stringify(link.task)) ||
        !isReplayBoundMessageId(
          message.message_id,
          Date.parse(message.expires_at),
        ) ||
        JSON.stringify(message) !==
          JSON.stringify(
            replyMessage(
              link,
              kind,
              task,
              message.message_id,
              message.first_sent_at,
              this.#options.limits,
            ),
          )
      )
        throw Error();
      return { ...record, task, message };
    } catch {
      throw new TaskBridgeError("bridge_integrity_failed");
    }
  }
  #writeReply(key: SourceKey, reply: BridgeReply, insert = false) {
    const text = JSON.stringify(reply);
    if (insert)
      this.#db
        .prepare("INSERT INTO task_bridge_replies VALUES(?,?,?,?,?,?,?)")
        .run(
          key.sender_id,
          key.message_id,
          reply.kind,
          reply.message.message_id,
          reply.state,
          text,
          this.#hash("reply-v1", text),
        );
    else
      this.#db
        .prepare(
          "UPDATE task_bridge_replies SET state=?,data=?,fingerprint=? WHERE sender_id=? AND message_id=? AND kind=?",
        )
        .run(
          reply.state,
          text,
          this.#hash("reply-v1", text),
          key.sender_id,
          key.message_id,
          reply.kind,
        );
  }
  /** Private inspection; application entry points must check current authority. */
  getReply(input: SourceKey, kind: ReplyKind): BridgeReply | null {
    const key = keySchema.parse(input);
    replyKindSchema.parse(kind);
    return this.#tx(() => {
      this.#now();
      return this.#readReply(key, kind);
    });
  }
  prepareReply(
    input: SourceKey,
    kind: ReplyKind,
    guard: () => void,
  ): BridgeReply {
    const key = keySchema.parse(input);
    replyKindSchema.parse(kind);
    return this.#tx(() => {
      const now = this.#now(),
        link = this.#read(key);
      const existing = this.#readReply(key, kind);
      if (existing) return existing;
      if (link.state !== "linked" || !link.task)
        throw new TaskBridgeError("bridge_not_linked");
      const first = new Date(now).toISOString();
      const reply: BridgeReply = {
        kind,
        state: "prepared",
        task: link.task,
        message: replyMessage(
          link,
          kind,
          link.task,
          makeReplayBoundMessageId(first, randomUUID().replaceAll("-", "")),
          first,
          this.#options.limits,
        ),
      };
      this.#writeReply(key, reply, true);
      this.#audit(link, kind + "_prepared");
      return reply;
    }, guard);
  }
  /** Outbox commits first; a lost journal commit is recovered with the exact saved message. */
  handoffReply(
    input: SourceKey,
    kind: ReplyKind,
    enqueue: (message: Submission, guard: () => void) => OutboxRecord,
    guard: () => void,
  ): BridgeReply {
    const key = keySchema.parse(input);
    replyKindSchema.parse(kind);
    if (typeof enqueue !== "function")
      throw new TaskBridgeError("invalid_bridge_composition");
    return this.#tx(() => {
      const now = this.#now(),
        link = this.#read(key);
      const reply = this.#readReply(key, kind);
      if (!reply) throw new TaskBridgeError("bridge_reply_not_prepared");
      if (reply.state !== "prepared") return reply;
      if (Date.parse(reply.message.expires_at) <= now) {
        reply.state = "expired";
        this.#writeReply(key, reply);
        this.#audit(link, kind + "_expired");
        return reply;
      }
      // Reserve finite audit space before attempting a separate durable write.
      this.#audit(link, kind + "_enqueued");
      guard();
      let record;
      try {
        record = enqueue(structuredClone(reply.message), guard);
      } catch (error) {
        if (error instanceof TaskBridgeError) throw error;
        if (error instanceof ReplyBudgetError)
          throw new TaskBridgeError(
            [
              "reply_thread_exhausted",
              "reply_rate_exhausted",
              "reply_budget_capacity_exceeded",
              "reply_budget_conflict",
              "reply_forbidden",
              "reply_budget_clock_regressed",
            ].includes(error.code)
              ? error.code
              : "bridge_reply_budget_unavailable",
          );
        if (error instanceof RelayError)
          throw new TaskBridgeError(
            error.code === "outbox_capacity_exceeded"
              ? "bridge_outbox_capacity_exceeded"
              : "bridge_outbox_unavailable",
          );
        throw error;
      }
      if (record && typeof record === "object" && "then" in record) {
        void Promise.resolve(record).catch(() => {});
        throw new TaskBridgeError("bridge_invalid_outbox_record");
      }
      if (
        !record ||
        record.message_id !== reply.message.message_id ||
        record.recipient_id !== reply.message.recipient_id ||
        record.expires_at !== reply.message.expires_at ||
        ![
          "queued",
          "sending",
          "accepted",
          "quarantined",
          "expired_unknown",
        ].includes(record.state)
      )
        throw new TaskBridgeError("bridge_invalid_outbox_record");
      reply.state = "enqueued";
      this.#writeReply(key, reply);
      return reply;
    }, guard);
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
