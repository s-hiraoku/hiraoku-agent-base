import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { MessagingError } from "../messaging/delivery-service.ts";
import type {
  Authorization,
  Receipt,
  Delivery,
  AckReceipt,
  InboxMessage,
  ReceivedMessage,
} from "../messaging/delivery-service.ts";
import {
  parseSubmission,
  parseAck,
  comparisonMaterial,
  validateLimits,
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  READ_BODY_RETENTION_MS,
  isReplayBoundMessageId,
} from "../messaging/contract.ts";
import type {
  ContractLimits,
  Submission,
  AckRequest,
} from "../messaging/contract.ts";
import {
  agentCapacityPolicy,
  assertAgentCapacity,
} from "../hab/agent-capacity.ts";
import type {
  AgentCapacityPolicy,
  SenderCapacityUsage,
} from "../hab/agent-capacity.ts";

/** Queue limits of the SQLite delivery store; the host config's `delivery.queue`. */
export interface DeliveryQueueOptions {
  max_records: number;
  max_pending: number;
  max_pending_per_recipient: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
  poll_scan_limit?: number;
  fair_poll?: boolean;
  agent_capacity?: AgentCapacityPolicy;
}
export interface SqliteDeliveryOptions extends DeliveryQueueOptions {
  path: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  authorization: Authorization;
}
interface Row {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  receipt_id: string;
  accepted_at: number;
  expires_at: number;
  kind: string;
  thread_key: string;
  fingerprint: string;
  state: Receipt["state"];
  body: string | null;
  scan_order: number;
  body_bytes: number;
  generation: number;
  token_hash: string | null;
  lease_until: number;
  next_visible_at: number;
  ack_request_id: string | null;
  ack_fingerprint: string | null;
  ack_receipt_id: string | null;
  acked_at: number | null;
  retain_until: number | null;
}
const VERSION = 1;
const LIVE = "('pending','leased','quarantined')";
const schema = `
CREATE TABLE IF NOT EXISTS delivery_meta(version INTEGER NOT NULL, key_check TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_messages(
 sender_id TEXT NOT NULL,message_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE,accepted_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 kind TEXT NOT NULL,thread_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','leased','acked','expired','quarantined')),
 body TEXT,scan_order INTEGER NOT NULL DEFAULT 0,body_bytes INTEGER NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0,token_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 next_visible_at INTEGER NOT NULL DEFAULT 0,ack_request_id TEXT,
 ack_fingerprint TEXT,ack_receipt_id TEXT,acked_at INTEGER,retain_until INTEGER,
 PRIMARY KEY(sender_id,message_id),UNIQUE(recipient_id,ack_request_id));
CREATE UNIQUE INDEX IF NOT EXISTS delivery_one_live_lease ON delivery_messages(recipient_id) WHERE state='leased';
CREATE INDEX IF NOT EXISTS delivery_terminal ON delivery_messages(state,retain_until);
CREATE INDEX IF NOT EXISTS delivery_pending ON delivery_messages(recipient_id,accepted_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS delivery_poll_turns(recipient_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,last_sender_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_audit(id INTEGER PRIMARY KEY,sender_id TEXT NOT NULL,message_id TEXT NOT NULL,at INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('accepted','leased','requeued','quarantined','expired','acked')));
CREATE INDEX IF NOT EXISTS delivery_audit_message ON delivery_audit(sender_id,message_id);
CREATE TABLE IF NOT EXISTS delivery_maintenance_totals(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL,expired INTEGER NOT NULL,purged INTEGER NOT NULL);
`;
const TABLES = [
  "delivery_audit",
  "delivery_maintenance_totals",
  "delivery_messages",
  "delivery_meta",
  "delivery_poll_turns",
];
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

/**
 * HAB's delivery store: one private SQLite file holds admission, the message body, leases,
 * retries, saved ACKs and the redacted delivery audit. Every public operation is one
 * synchronous transaction, so an accepted message is pollable at once and no Promise crosses
 * the Registry guard. Bodies are released at ACK or expiry; records follow the contract's
 * retention before collection.
 */
type ResolvedOptions = Required<
  Omit<SqliteDeliveryOptions, "agent_capacity" | "path">
> & { agent_capacity?: AgentCapacityPolicy };

/**
 * Upper estimate of one inbox message's share of an MCP tool response: the text appears
 * twice (as `text` and inside the notice), once in structuredContent and once more as an
 * escaped JSON string in `content`, plus fixed fields.
 */
function inboxResponseCost(message: Submission): number {
  const text = message.body.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  const once = Buffer.byteLength(JSON.stringify(text));
  const twice = Buffer.byteLength(JSON.stringify(JSON.stringify(text)));
  return 2 * once + 2 * twice + 4096;
}
export class SqliteDelivery {
  readonly #db: DatabaseSync;
  readonly #options: ResolvedOptions;
  #closed = false;
  private constructor(db: DatabaseSync, options: ResolvedOptions) {
    this.#db = db;
    this.#options = options;
  }
  static open(input: SqliteDeliveryOptions): SqliteDelivery {
    const limits = { ...input.limits };
    validateLimits(limits);
    for (const key of [
      "max_records",
      "max_pending",
      "max_pending_per_recipient",
      "max_body_bytes",
      "lease_ms",
      "max_attempts",
      "retry_base_ms",
      "retry_cap_ms",
    ] as const)
      if (!Number.isSafeInteger(input[key]) || input[key] < 1)
        throw new MessagingError("invalid_store_options");
    if (
      !(input.fingerprint_key instanceof Uint8Array) ||
      input.fingerprint_key.length < 32 ||
      !Number.isSafeInteger(input.max_clock_skew_ms) ||
      input.max_clock_skew_ms < 0 ||
      input.max_clock_skew_ms > 60_000 ||
      input.lease_ms > 3_600_000 ||
      input.retry_cap_ms < input.retry_base_ms ||
      input.retry_cap_ms > 3_600_000 ||
      input.max_attempts > 1000 ||
      (input.fair_poll !== undefined && typeof input.fair_poll !== "boolean") ||
      (input.poll_scan_limit !== undefined &&
        (!Number.isSafeInteger(input.poll_scan_limit) ||
          input.poll_scan_limit < 1)) ||
      !input.authorization
    )
      throw new MessagingError("invalid_store_options");
    if (typeof input.path !== "string" || input.path === ":memory:")
      throw new MessagingError("durable_journal_required");
    const options = {
      max_records: input.max_records,
      max_pending: input.max_pending,
      max_pending_per_recipient: input.max_pending_per_recipient,
      max_body_bytes: input.max_body_bytes,
      max_clock_skew_ms: input.max_clock_skew_ms,
      lease_ms: input.lease_ms,
      max_attempts: input.max_attempts,
      retry_base_ms: input.retry_base_ms,
      retry_cap_ms: input.retry_cap_ms,
      fair_poll: input.fair_poll ?? false,
      poll_scan_limit: input.poll_scan_limit ?? input.max_pending_per_recipient,
      agent_capacity:
        input.agent_capacity === undefined
          ? undefined
          : agentCapacityPolicy(input.agent_capacity, input),
      fingerprint_key: Uint8Array.from(input.fingerprint_key),
      limits,
      authorization: input.authorization,
    };
    const fd = openSync(
      input.path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new MessagingError("insecure_journal_file");
    } finally {
      closeSync(fd);
    }
    const db = new DatabaseSync(input.path, { timeout: 5000 });
    try {
      db.function("delivery_gc_safe", { deterministic: true }, (m, e) =>
        isReplayBoundMessageId(m, e) ? 1 : 0,
      );
      const store = new SqliteDelivery(db, options);
      store.#migrate();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  #migrate() {
    const check = this.#hash("key", "hab-delivery-v1");
    const inspect = () => {
      const tables = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => String(row.name))
        .sort();
      if (!tables.length) return false;
      if (JSON.stringify(tables) !== JSON.stringify(TABLES))
        throw new MessagingError("unknown_journal_schema");
      const meta = this.#db.prepare("SELECT * FROM delivery_meta").all();
      if (
        meta.length !== 1 ||
        meta[0].key_check !== check ||
        Number(meta[0].version) !== VERSION
      )
        throw new MessagingError("journal_key_or_version_mismatch");
      return true;
    };
    inspect();
    this.#db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
    );
    this.#tx(() => {
      if (inspect()) return;
      this.#db.exec(schema);
      this.#db
        .prepare(
          "INSERT INTO delivery_maintenance_totals(id,last_at,expired,purged) VALUES(1,0,0,0)",
        )
        .run();
      this.#db
        .prepare("INSERT INTO delivery_meta VALUES(?,?)")
        .run(VERSION, check);
    });
  }
  #tx<T>(action: () => T): T {
    if (this.#closed) throw new MessagingError("delivery_closed");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #hash(domain: string, value: string): string {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + ":" + value)
      .digest("hex");
  }
  #identity(
    context: unknown,
    operation: "submit" | "status" | "poll" | "ack" | "maintenance",
    authorization: Authorization,
    peer?: string,
    kind?: string,
  ): string {
    let decision;
    try {
      decision = authorization.authorize(context, operation, peer, kind);
    } catch (error) {
      // A policy refusal keeps its public code and audit reason; anything else is opaque.
      throw error instanceof MessagingError
        ? error
        : new MessagingError("forbidden", { reason: "authorization_failed" });
    }
    if (!decision || !id(decision.agent_id))
      throw new MessagingError("forbidden", { reason: "authorization_denied" });
    return decision.agent_id;
  }
  #row(sender: string, message: string): Row | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM delivery_messages WHERE sender_id=? AND message_id=?",
      )
      .get(sender, message) as unknown as Row | undefined;
  }
  #receipt(row: Row): Receipt {
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
  #audit(sender: string, message: string, at: number, event: string) {
    this.#db
      .prepare(
        "INSERT INTO delivery_audit(sender_id,message_id,at,event) VALUES(?,?,?,?)",
      )
      .run(sender, message, at, event);
  }
  /** The host's limit on the UTF-8 bytes of all text parts of one message. */
  get textLimit(): number {
    return this.#options.limits.text_bytes;
  }
  /** Expires overdue records and returns lapsed leases to the queue (or quarantine). */
  #refresh(now: number) {
    this.#db
      .prepare(
        "UPDATE delivery_messages SET body=NULL,body_bytes=0 WHERE state='acked' AND body IS NOT NULL AND acked_at<=?",
      )
      .run(now - READ_BODY_RETENTION_MS);
    const expired = this.#db
      .prepare(
        `UPDATE delivery_messages SET state='expired',body=NULL,body_bytes=0,token_hash=NULL,retain_until=expires_at+? WHERE state IN ${LIVE} AND expires_at<=? RETURNING sender_id,message_id`,
      )
      .all(RECORD_RETENTION_MS, now);
    for (const row of expired)
      this.#audit(
        String(row.sender_id),
        String(row.message_id),
        now,
        "expired",
      );
    if (
      expired.length &&
      this.#db
        .prepare(
          "UPDATE delivery_maintenance_totals SET expired=expired+? WHERE id=1",
        )
        .run(expired.length).changes !== 1
    )
      throw new MessagingError("maintenance_state_unavailable");
    const requeued = this.#db
      .prepare(
        "UPDATE delivery_messages SET state=CASE WHEN generation>=? THEN 'quarantined' ELSE 'pending' END,token_hash=NULL WHERE state='leased' AND lease_until<=? RETURNING sender_id,message_id,state",
      )
      .all(this.#options.max_attempts, now);
    for (const row of requeued)
      this.#audit(
        String(row.sender_id),
        String(row.message_id),
        now,
        row.state === "quarantined" ? "quarantined" : "requeued",
      );
  }
  #stored(row: Row): Submission {
    try {
      const envelope = JSON.parse(row.body!);
      if (
        !envelope ||
        envelope.sender_id !== row.sender_id ||
        Object.keys(envelope).sort().join(",") !== "message,sender_id"
      )
        throw new MessagingError("journal_integrity_failed");
      const message = parseSubmission(envelope.message, this.#options.limits);
      if (
        message.message_id !== row.message_id ||
        message.recipient_id !== row.recipient_id ||
        message.kind !== row.kind ||
        Date.parse(message.expires_at) !== row.expires_at ||
        row.fingerprint !==
          this.#hash(
            "submission",
            comparisonMaterial(row.sender_id, message, this.#options.limits),
          )
      )
        throw new MessagingError("journal_integrity_failed");
      return message;
    } catch {
      throw new MessagingError("journal_integrity_failed");
    }
  }

  admit(context: unknown, input: unknown): Receipt {
    return this.admitWithAuthorization(
      context,
      input,
      this.#options.authorization,
    );
  }
  /** Commits admission and the body in one transaction: that commit is the acceptance point. */
  admitWithAuthorization(
    context: unknown,
    input: unknown,
    authorization: Authorization,
  ): Receipt {
    const message = parseSubmission(input, this.#options.limits);
    const sender = this.#identity(
      context,
      "submit",
      authorization,
      message.recipient_id,
      message.kind,
    );
    const material = comparisonMaterial(sender, message, this.#options.limits);
    return this.#tx(() => {
      if (
        this.#identity(
          context,
          "submit",
          authorization,
          message.recipient_id,
          message.kind,
        ) !== sender
      )
        throw new MessagingError("forbidden");
      const now = Date.now();
      this.#refresh(now);
      const fingerprint = this.#hash("submission", material);
      const existing = this.#row(sender, message.message_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new MessagingError("idempotency_conflict");
        return this.#receipt(existing);
      }
      const expires = Date.parse(message.expires_at);
      if (
        Date.parse(message.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new MessagingError("clock_skew");
      if (expires <= now) throw new MessagingError("expired_before_acceptance");
      const body = JSON.stringify({ sender_id: sender, message });
      const size = Buffer.byteLength(body);
      const usage = this.#db
        .prepare(
          `SELECT count(*) records,coalesce(sum(CASE WHEN state IN ${LIVE} THEN 1 ELSE 0 END),0) pending,coalesce(sum(body_bytes),0) bytes,coalesce(sum(CASE WHEN recipient_id=? AND state IN ${LIVE} THEN 1 ELSE 0 END),0) recipient FROM delivery_messages`,
        )
        .get(message.recipient_id)!;
      if (
        Number(usage.records) >= this.#options.max_records ||
        Number(usage.pending) >= this.#options.max_pending ||
        Number(usage.recipient) >= this.#options.max_pending_per_recipient ||
        Number(usage.bytes) + size > this.#options.max_body_bytes
      )
        throw new MessagingError("capacity_exceeded");
      if (this.#options.agent_capacity) {
        const senders = this.#db
          .prepare(
            `SELECT sender_id,count(*) records,sum(CASE WHEN state IN ${LIVE} THEN 1 ELSE 0 END) pending,coalesce(sum(body_bytes),0) body_bytes FROM delivery_messages GROUP BY sender_id`,
          )
          .all() as unknown as SenderCapacityUsage[];
        const recipient = this.#db
          .prepare(
            "SELECT count(*) records,coalesce(sum(body_bytes),0) body_bytes FROM delivery_messages WHERE recipient_id=?",
          )
          .get(message.recipient_id) as unknown as {
          records: number;
          body_bytes: number;
        };
        assertAgentCapacity(
          this.#options.agent_capacity,
          this.#options,
          sender,
          size,
          senders,
          recipient,
        );
      }
      const thread = JSON.stringify([
        [sender, message.recipient_id].sort(),
        message.thread_id,
      ]);
      if (message.in_reply_to) {
        const parent = this.#row(
          message.in_reply_to.sender_id,
          message.in_reply_to.message_id,
        );
        if (
          !parent ||
          parent.sender_id !== message.recipient_id ||
          parent.recipient_id !== sender ||
          parent.thread_key !== thread
        )
          throw new MessagingError("invalid_reference");
      }
      this.#db
        .prepare(
          "INSERT INTO delivery_messages(sender_id,message_id,recipient_id,receipt_id,accepted_at,expires_at,kind,thread_key,fingerprint,state,body,body_bytes) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)",
        )
        .run(
          sender,
          message.message_id,
          message.recipient_id,
          randomUUID(),
          now,
          expires,
          message.kind,
          thread,
          fingerprint,
          body,
          size,
        );
      this.#audit(sender, message.message_id, now, "accepted");
      return this.#receipt(this.#row(sender, message.message_id)!);
    });
  }
  statusWithAuthorization(
    context: unknown,
    messageId: string,
    authorization: Authorization,
  ): Receipt {
    if (!id(messageId)) throw new MessagingError("invalid_request");
    const sender = this.#identity(context, "status", authorization);
    return this.#tx(() => {
      if (this.#identity(context, "status", authorization) !== sender)
        throw new MessagingError("forbidden");
      this.#refresh(Date.now());
      const row = this.#row(sender, messageId);
      if (!row) throw new MessagingError("not_found");
      return this.#receipt(row);
    });
  }
  lookupReceipt(senderId: string, messageId: string): Receipt | null {
    return this.#tx(() => {
      this.#refresh(Date.now());
      const row = this.#row(senderId, messageId);
      return row ? this.#receipt(row) : null;
    });
  }
  /**
   * Leases the recipient's next visible message. A recipient holds at most one lease. With
   * `fair_poll`, candidates rotate over senders; denied candidates still advance the cursor
   * while one poll scans at most `poll_scan_limit` rows.
   */
  pollWithAuthorization(
    context: unknown,
    authorization: Authorization,
  ): Delivery | null {
    const recipient = this.#identity(context, "poll", authorization);
    return this.#tx(() => {
      if (this.#identity(context, "poll", authorization) !== recipient)
        throw new MessagingError("forbidden");
      const now = Date.now();
      this.#refresh(now);
      if (
        this.#db
          .prepare(
            "SELECT 1 FROM delivery_messages WHERE recipient_id=? AND state='leased'",
          )
          .get(recipient)
      )
        return null;
      for (const row of this.#candidates(recipient, now)) {
        this.#notePollCandidate(recipient, row);
        const message = this.#stored(row);
        try {
          if (
            this.#identity(
              context,
              "poll",
              authorization,
              row.sender_id,
              message.kind,
            ) !== recipient
          )
            throw new MessagingError("forbidden");
        } catch (error) {
          // A candidate this pair may no longer exchange is skipped, as before.
          if (
            error instanceof MessagingError &&
            ["forbidden", "recipient_unavailable", "kind_not_allowed"].includes(
              error.code,
            )
          )
            continue;
          throw error;
        }
        return this.#lease(row, message, now);
      }
      return null;
    });
  }
  #candidates(recipient: string, now: number): Row[] {
    if (this.#options.fair_poll) {
      const previous =
        this.#db
          .prepare(
            "SELECT last_sender_id FROM delivery_poll_turns WHERE recipient_id=?",
          )
          .get(recipient)?.last_sender_id ?? null;
      return this.#db
        .prepare(
          "SELECT * FROM delivery_messages WHERE recipient_id=? AND state='pending' AND next_visible_at<=? ORDER BY CASE WHEN ? IS NULL OR sender_id>? THEN 0 ELSE 1 END,sender_id,scan_order,accepted_at,message_id LIMIT ?",
        )
        .all(
          recipient,
          now,
          previous,
          previous,
          this.#options.poll_scan_limit,
        ) as unknown as Row[];
    }
    return this.#db
      .prepare(
        "SELECT * FROM delivery_messages WHERE recipient_id=? AND state='pending' AND next_visible_at<=? ORDER BY accepted_at,sender_id,message_id LIMIT ?",
      )
      .all(recipient, now, this.#options.poll_scan_limit) as unknown as Row[];
  }
  #notePollCandidate(recipient: string, row: Row) {
    if (!this.#options.fair_poll) return;
    this.#db
      .prepare(
        "UPDATE delivery_messages SET scan_order=(SELECT coalesce(max(scan_order),0)+1 FROM delivery_messages WHERE recipient_id=?) WHERE recipient_id=? AND sender_id=? AND message_id=?",
      )
      .run(recipient, recipient, row.sender_id, row.message_id);
    this.#db
      .prepare(
        "INSERT INTO delivery_poll_turns(recipient_id,updated_at,last_sender_id) VALUES(?,?,?) ON CONFLICT(recipient_id) DO UPDATE SET last_sender_id=excluded.last_sender_id,updated_at=excluded.updated_at",
      )
      .run(recipient, Date.now(), row.sender_id);
    this.#db
      .prepare(
        "DELETE FROM delivery_poll_turns WHERE recipient_id IN (SELECT recipient_id FROM delivery_poll_turns ORDER BY updated_at DESC,recipient_id LIMIT -1 OFFSET ?)",
      )
      .run(this.#options.max_records);
  }
  #lease(row: Row, message: Submission, now: number): Delivery {
    const token = Buffer.from(randomBytes(32)).toString("base64url");
    const generation = row.generation + 1;
    const until = Math.min(now + this.#options.lease_ms, row.expires_at);
    const backoff = Math.min(
      this.#options.retry_cap_ms,
      this.#options.retry_base_ms * 2 ** Math.min(generation - 1, 30),
    );
    this.#db
      .prepare(
        "UPDATE delivery_messages SET state='leased',generation=?,token_hash=?,lease_until=?,next_visible_at=? WHERE sender_id=? AND message_id=?",
      )
      .run(
        generation,
        this.#hash("lease", token),
        until,
        until + backoff,
        row.sender_id,
        row.message_id,
      );
    this.#audit(row.sender_id, row.message_id, now, "leased");
    return {
      message: { ...message, sender_id: row.sender_id },
      generation,
      lease_token: token,
      lease_until: new Date(until).toISOString(),
    };
  }
  /**
   * The recipient's host inbox. Unread messages are marked read (ACKed) in the same
   * transaction and returned once with `new: true`; with `include_read`, messages read in
   * the last READ_BODY_RETENTION_MS follow, newest first. A message another client holds
   * under a poll lease is skipped until that lease ends. With `peek` (ADR-021, the arrival
   * notifier) unread messages are returned without marking them read and nothing changes.
   */
  readInboxWithAuthorization(
    context: unknown,
    authorization: Authorization,
    options: {
      limit: number;
      include_read: boolean;
      message_id?: string;
      /** Response budget: messages are taken (and marked read) only while they fit. */
      max_bytes?: number;
      /** Return unread messages only, leaving them unread. */
      peek?: boolean;
    },
  ): InboxMessage[] {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50
    )
      throw new MessagingError("invalid_request", {
        details: { field: "limit", min: 1, max: 50 },
      });
    if (options.message_id !== undefined && !id(options.message_id))
      throw new MessagingError("invalid_request", {
        details: { field: "message_id" },
      });
    const recipient = this.#identity(context, "poll", authorization);
    return this.#tx(() => {
      if (this.#identity(context, "poll", authorization) !== recipient)
        throw new MessagingError("forbidden");
      const now = Date.now();
      this.#refresh(now);
      const out: InboxMessage[] = [];
      const allowed = (row: Row) => {
        try {
          return (
            this.#identity(
              context,
              "poll",
              authorization,
              row.sender_id,
              row.kind,
            ) === recipient
          );
        } catch (error) {
          if (
            error instanceof MessagingError &&
            ["forbidden", "recipient_unavailable", "kind_not_allowed"].includes(
              error.code,
            )
          )
            return false;
          throw error;
        }
      };
      // No scan limit: pending rows per recipient are bounded by
      // max_pending_per_recipient, so denied senders cannot hide later messages.
      const only = options.message_id;
      const unread = this.#db
        .prepare(
          `SELECT * FROM delivery_messages WHERE recipient_id=? AND state='pending'${only ? " AND message_id=?" : ""} ORDER BY accepted_at,sender_id,message_id`,
        )
        .all(recipient, ...(only ? [only] : [])) as unknown as Row[];
      let spent = 0;
      // Whether one more message still fits the response; the first always does,
      // since a single message is bounded by the contract's text limit.
      const fits = (message: Submission) => {
        if (options.max_bytes === undefined) return true;
        const cost = inboxResponseCost(message);
        if (out.length > 0 && spent + cost > options.max_bytes) return false;
        spent += cost;
        return true;
      };
      for (const row of unread) {
        if (out.length >= options.limit) break;
        if (!allowed(row)) continue;
        const message = this.#stored(row);
        if (!fits(message)) break;
        if (options.peek) {
          out.push(this.#inboxMessage(row, message, null, true));
          continue;
        }
        const requestId = `inbox-${randomUUID()}`;
        this.#db
          .prepare(
            // The kept body stays charged to the byte quotas until #refresh releases it.
            "UPDATE delivery_messages SET state='acked',token_hash=NULL,ack_request_id=?,ack_fingerprint=?,ack_receipt_id=?,acked_at=?,retain_until=? WHERE sender_id=? AND message_id=? AND state='pending'",
          )
          .run(
            requestId,
            this.#hash("inbox-read", requestId),
            randomUUID(),
            now,
            Math.max(row.expires_at, now + MAX_ACK_RETRY_MS) +
              RECORD_RETENTION_MS,
            row.sender_id,
            row.message_id,
          );
        this.#audit(row.sender_id, row.message_id, now, "acked");
        out.push(this.#inboxMessage(row, message, now, true));
      }
      if (
        !options.peek &&
        (options.include_read || only) &&
        out.length < options.limit
      ) {
        const read = this.#db
          .prepare(
            `SELECT * FROM delivery_messages WHERE recipient_id=? AND state='acked' AND body IS NOT NULL AND acked_at>? AND acked_at<?${only ? " AND message_id=?" : ""} ORDER BY acked_at DESC,accepted_at DESC,sender_id,message_id`,
          )
          .all(
            recipient,
            now - READ_BODY_RETENTION_MS,
            now,
            ...(only ? [only] : []),
          ) as unknown as Row[];
        for (const row of read) {
          if (out.length >= options.limit) break;
          if (!allowed(row)) continue;
          const message = this.#stored(row);
          if (!fits(message)) break;
          out.push(this.#inboxMessage(row, message, row.acked_at!, false));
        }
      }
      return out;
    });
  }
  #inboxMessage(
    row: Row,
    message: Submission,
    readAt: number | null,
    fresh: boolean,
  ): InboxMessage {
    const thread = JSON.parse(row.thread_key) as [string[], string];
    const texts = message.body.parts.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    return {
      message_id: row.message_id,
      sender_id: row.sender_id,
      kind: row.kind,
      text: texts.join("\n\n"),
      data_parts: message.body.parts.filter((part) => part.type === "data")
        .length,
      thread_id: thread[1],
      in_reply_to: message.in_reply_to,
      sent_at: message.first_sent_at,
      received_at: new Date(row.accepted_at).toISOString(),
      read_at: readAt === null ? null : new Date(readAt).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      new: fresh,
    };
  }
  /**
   * A message the caller received with this ID, for building a reply. Metadata only; it
   * does not read the body or change its state. Refuses an ID that is ambiguous.
   */
  receivedWithAuthorization(
    context: unknown,
    messageId: string,
    authorization: Authorization,
  ): ReceivedMessage {
    if (!id(messageId))
      throw new MessagingError("invalid_request", {
        details: { field: "message_id" },
      });
    const recipient = this.#identity(context, "submit", authorization);
    return this.#tx(() => {
      this.#refresh(Date.now());
      const rows = this.#db
        .prepare(
          "SELECT * FROM delivery_messages WHERE recipient_id=? AND message_id=? LIMIT 2",
        )
        .all(recipient, messageId) as unknown as Row[];
      if (rows.length !== 1)
        throw new MessagingError("reply_target_not_found", {
          reason: rows.length
            ? "reply_target_ambiguous"
            : "reply_target_unknown",
        });
      const row = rows[0];
      return {
        message_id: row.message_id,
        sender_id: row.sender_id,
        kind: row.kind,
        thread_id: (JSON.parse(row.thread_key) as [string[], string])[1],
        state: row.state,
        expires_at: new Date(row.expires_at).toISOString(),
      };
    });
  }
  /**
   * Records the recipient's saved ACK and releases the body: an SDK receiver holds its own
   * durable copy. (Only a host-inbox read keeps the body for re-reading.) A matching retry
   * returns the same receipt.
   */
  ackWithAuthorization(
    context: unknown,
    input: unknown,
    authorization: Authorization,
  ): AckReceipt {
    const request: AckRequest = parseAck(input, this.#options.limits);
    const recipient = this.#identity(context, "ack", authorization);
    return this.#tx(() => {
      const row = this.#row(request.sender_id, request.message_id);
      if (!row || row.recipient_id !== recipient)
        throw new MessagingError("invalid_ack");
      if (
        this.#identity(
          context,
          "ack",
          authorization,
          row.sender_id,
          row.kind,
        ) !== recipient
      )
        throw new MessagingError("forbidden");
      const fingerprint = this.#hash("ack", JSON.stringify(request));
      const existing = this.#db
        .prepare(
          "SELECT * FROM delivery_messages WHERE recipient_id=? AND ack_request_id=?",
        )
        .get(recipient, request.request_id) as unknown as Row | undefined;
      if (existing) {
        if (existing.ack_fingerprint !== fingerprint)
          throw new MessagingError("ack_idempotency_conflict");
        return this.#ackReceipt(existing);
      }
      const now = Date.now();
      if (
        row.state !== "leased" ||
        row.generation !== request.generation ||
        row.token_hash !== this.#hash("lease", request.lease_token) ||
        row.lease_until <= now ||
        row.expires_at <= now
      )
        throw new MessagingError("invalid_ack");
      this.#db
        .prepare(
          "UPDATE delivery_messages SET state='acked',body=NULL,body_bytes=0,token_hash=NULL,ack_request_id=?,ack_fingerprint=?,ack_receipt_id=?,acked_at=?,retain_until=? WHERE sender_id=? AND message_id=?",
        )
        .run(
          request.request_id,
          fingerprint,
          randomUUID(),
          now,
          Math.max(row.expires_at, now + MAX_ACK_RETRY_MS) +
            RECORD_RETENTION_MS,
          row.sender_id,
          row.message_id,
        );
      this.#audit(row.sender_id, row.message_id, now, "acked");
      return this.#ackReceipt(this.#row(row.sender_id, row.message_id)!);
    });
  }
  #ackReceipt(row: Row): AckReceipt {
    if (
      row.state !== "acked" ||
      row.acked_at === null ||
      row.ack_request_id === null ||
      row.ack_receipt_id === null
    )
      throw new MessagingError("invalid_ack");
    return {
      recipient_id: row.recipient_id,
      sender_id: row.sender_id,
      message_id: row.message_id,
      request_id: row.ack_request_id,
      receipt_id: row.ack_receipt_id,
      acked_at: new Date(row.acked_at).toISOString(),
      state: "acked",
    };
  }
  /**
   * Expires overdue records and purges at most `limit` terminal records past retention.
   * Legacy (non replay-bound) IDs are held, and held IDs never take a batch slot.
   */
  maintainInternal(limit = 100): { purged: number; safety_held: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new MessagingError("invalid_maintenance_limit");
    return this.#tx(() => {
      const now = Date.now();
      if (
        !this.#db
          .prepare("SELECT 1 FROM delivery_maintenance_totals WHERE id=1")
          .get()
      )
        throw new MessagingError("maintenance_state_unavailable");
      this.#refresh(now);
      const due =
        "FROM delivery_messages WHERE state IN ('acked','expired') AND retain_until<=? AND delivery_gc_safe(message_id,expires_at)=?";
      const rows = this.#db
        .prepare(
          `SELECT sender_id,message_id ${due} ORDER BY retain_until,sender_id,message_id LIMIT ?`,
        )
        .all(now, 1, limit) as Array<{ sender_id: string; message_id: string }>;
      const safety_held = Number(
        this.#db.prepare(`SELECT count(*) n ${due}`).get(now, 0)!.n,
      );
      let purged = 0;
      for (const row of rows) {
        this.#db
          .prepare(
            "DELETE FROM delivery_audit WHERE sender_id=? AND message_id=?",
          )
          .run(row.sender_id, row.message_id);
        purged += Number(
          this.#db
            .prepare(
              "DELETE FROM delivery_messages WHERE sender_id=? AND message_id=?",
            )
            .run(row.sender_id, row.message_id).changes,
        );
      }
      this.#db
        .prepare(
          "UPDATE delivery_maintenance_totals SET last_at=?,purged=purged+? WHERE id=1",
        )
        .run(now, purged);
      return { purged, safety_held };
    });
  }
  maintain(context: unknown, limit = 100) {
    this.#identity(context, "maintenance", this.#options.authorization);
    return this.maintainInternal(limit);
  }
  diagnostics(context: unknown) {
    this.#identity(context, "maintenance", this.#options.authorization);
    const count = (where: string) =>
      Number(
        this.#db
          .prepare("SELECT count(*) n FROM delivery_messages WHERE " + where)
          .get()!.n,
      );
    return {
      pending: count("state IN ('pending','leased')"),
      quarantined: count("state='quarantined'"),
    };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
