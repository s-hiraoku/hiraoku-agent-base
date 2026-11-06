import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { MessagingError } from "../../../src/messaging/delivery-service.ts";
import {
  agentCapacityPolicy,
  assertAgentCapacity,
} from "../../../src/hab/agent-capacity.ts";
import type {
  AgentCapacityPolicy,
  SenderCapacityUsage,
} from "../../../src/hab/agent-capacity.ts";
import type {
  Receipt,
  Delivery,
  AckReceipt,
} from "../../../src/messaging/delivery-service.ts";
import type {
  Submission,
  AckRequest,
} from "../../../src/messaging/contract.ts";
import {
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  isReplayBoundMessageId,
} from "../../../src/messaging/contract.ts";

export interface JournalOptions {
  fair_poll?: boolean;
  poll_scan_limit?: number;
  prefetch_per_recipient?: number;
  migrate_journal?: boolean;
  agent_capacity?: AgentCapacityPolicy;
  fingerprint_key: Uint8Array;
  max_records: number;
  max_pending: number;
  max_pending_per_recipient: number;
  max_body_bytes: number;
  max_clock_skew_ms: number;
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
}
export interface Row {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  receipt_id: string;
  accepted_at: number;
  expires_at: number;
  kind: string;
  thread_key: string;
  fingerprint: string;
  subject: string;
  state: "staging" | Receipt["state"];
  outbox: string | null;
  candidate: string | null;
  scan_order: number;
  body_bytes: number;
  sequence: number | null;
  generation: number;
  token_hash: string | null;
  lease_until: number;
  next_visible_at: number;
  ack_request_id: string | null;
  ack_fingerprint: string | null;
  ack_receipt_id: string | null;
  acked_at: number | null;
  retain_until: number | null;
  cleaned: number;
}
const schema = `
CREATE TABLE IF NOT EXISTS nats_meta(version INTEGER NOT NULL, key_check TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nats_messages(
 sender_id TEXT NOT NULL,message_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
 receipt_id TEXT NOT NULL UNIQUE,accepted_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 kind TEXT NOT NULL,thread_key TEXT NOT NULL,fingerprint TEXT NOT NULL,subject TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('staging','pending','leased','acked','expired','quarantined')),
 outbox TEXT,candidate TEXT,scan_order INTEGER NOT NULL DEFAULT 0,body_bytes INTEGER NOT NULL,sequence INTEGER,
 generation INTEGER NOT NULL DEFAULT 0,token_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 next_visible_at INTEGER NOT NULL DEFAULT 0,ack_request_id TEXT,
 ack_fingerprint TEXT,ack_receipt_id TEXT,acked_at INTEGER,retain_until INTEGER,
 cleaned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sender_id,message_id),
 UNIQUE(recipient_id,ack_request_id));
CREATE UNIQUE INDEX IF NOT EXISTS nats_one_live_lease ON nats_messages(recipient_id) WHERE state='leased';
CREATE INDEX IF NOT EXISTS nats_terminal ON nats_messages(state,cleaned,retain_until);
CREATE TABLE IF NOT EXISTS nats_pulls(recipient_id TEXT PRIMARY KEY,token TEXT NOT NULL,until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nats_poll_turns(recipient_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,last_sender_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nats_delivery_audit(id INTEGER PRIMARY KEY,sender_id TEXT NOT NULL,message_id TEXT NOT NULL,at INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('accepted','leased','requeued','quarantined','expired','acked')));
CREATE INDEX IF NOT EXISTS nats_delivery_audit_message ON nats_delivery_audit(sender_id,message_id);
CREATE TABLE IF NOT EXISTS nats_maintenance_totals(id INTEGER PRIMARY KEY CHECK(id=1),last_at INTEGER NOT NULL,expired INTEGER NOT NULL,purged INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nats_cached_candidates ON nats_messages(recipient_id,accepted_at) WHERE candidate IS NOT NULL AND state IN ('pending','leased');
`;

export class NatsJournal {
  readonly #db: DatabaseSync;
  readonly #options: JournalOptions;
  constructor(path: string, options: JournalOptions, binding: string) {
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
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new MessagingError("invalid_store_options");
    if (
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.length < 32 ||
      !Number.isSafeInteger(options.max_clock_skew_ms) ||
      options.max_clock_skew_ms < 0 ||
      options.max_clock_skew_ms > 60_000 ||
      options.lease_ms > 3_600_000 ||
      options.retry_cap_ms < options.retry_base_ms ||
      options.retry_cap_ms > 3_600_000 ||
      options.max_attempts > 1000
    )
      throw new MessagingError("invalid_store_options");
    if (
      options.prefetch_per_recipient !== undefined &&
      (!Number.isSafeInteger(options.prefetch_per_recipient) ||
        options.prefetch_per_recipient < 1 ||
        options.prefetch_per_recipient > options.max_pending_per_recipient)
    )
      throw new MessagingError("invalid_store_options");
    if (
      options.migrate_journal !== undefined &&
      typeof options.migrate_journal !== "boolean"
    )
      throw new MessagingError("invalid_store_options");
    if (
      (options.fair_poll !== undefined &&
        typeof options.fair_poll !== "boolean") ||
      (options.poll_scan_limit !== undefined &&
        (!Number.isSafeInteger(options.poll_scan_limit) ||
          options.poll_scan_limit < 1))
    )
      throw new MessagingError("invalid_store_options");
    this.#options = {
      ...options,
      fair_poll: options.fair_poll ?? false,
      poll_scan_limit:
        options.poll_scan_limit ?? options.prefetch_per_recipient ?? 1,
      prefetch_per_recipient: options.prefetch_per_recipient ?? 1,
      agent_capacity:
        options.agent_capacity === undefined
          ? undefined
          : agentCapacityPolicy(options.agent_capacity, options),
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    if (path === ":memory:")
      throw new MessagingError("durable_journal_required");
    const fd = openSync(
      path,
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
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.function(
      "nats_gc_safe",
      { deterministic: true },
      (messageId, expiresAt) =>
        isReplayBoundMessageId(messageId, expiresAt) ? 1 : 0,
    );
    try {
      const check = this.hash("key", "nats-journal-v1:" + binding);
      const inspect = () => {
        const tables = this.#db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => String(row.name))
          .sort();
        const v1 = ["nats_messages", "nats_meta", "nats_pulls"];
        const v3 = [
          "nats_messages",
          "nats_meta",
          "nats_poll_turns",
          "nats_pulls",
          "nats_routing",
        ];
        const current = [
          "nats_delivery_audit",
          "nats_maintenance_totals",
          "nats_messages",
          "nats_meta",
          "nats_poll_turns",
          "nats_pulls",
        ];
        let version = 0;
        if (tables.length) {
          if (!tables.includes("nats_meta"))
            throw new MessagingError("unknown_journal_schema");
          const meta = this.#db.prepare("SELECT * FROM nats_meta").all();
          if (meta.length !== 1 || meta[0].key_check !== check)
            throw new MessagingError("journal_key_or_version_mismatch");
          version = Number(meta[0].version);
          if (![1, 2, 3, 4].includes(version))
            throw new MessagingError("journal_key_or_version_mismatch");
          if (
            JSON.stringify(tables) !==
            JSON.stringify(version === 1 ? v1 : version === 4 ? current : v3)
          )
            throw new MessagingError("unknown_journal_schema");
          if (
            version >= 3 &&
            !this.#db
              .prepare("PRAGMA table_info(nats_messages)")
              .all()
              .some((row) => row.name === "scan_order")
          )
            throw new MessagingError("unknown_journal_schema");
          if (version < 4 && options.migrate_journal !== true)
            throw new MessagingError("journal_migration_required");
          if (
            version === 3 &&
            !this.#db
              .prepare("PRAGMA table_info(nats_poll_turns)")
              .all()
              .some((row) => row.name === "last_sender_id")
          )
            throw new MessagingError("unknown_journal_schema");
        }
        return version;
      };
      inspect();
      this.#db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#tx(() => {
        const version = inspect();
        if (version === 1)
          this.#db.exec(
            "ALTER TABLE nats_messages ADD COLUMN candidate TEXT; ALTER TABLE nats_messages ADD COLUMN scan_order INTEGER NOT NULL DEFAULT 0",
          );
        if (version === 2)
          this.#db.exec(
            "ALTER TABLE nats_messages ADD COLUMN scan_order INTEGER NOT NULL DEFAULT 0; ALTER TABLE nats_messages DROP COLUMN route_epoch; DROP TABLE nats_routing; DROP TABLE nats_poll_turns",
          );
        // Schema 4 retires the SQLite/JetStream routing state and keeps only the fair-poll cursor.
        if (version === 3)
          this.#db.exec(
            "ALTER TABLE nats_messages DROP COLUMN route_epoch; DROP TABLE nats_routing; CREATE TABLE nats_poll_turns_v4(recipient_id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,last_sender_id TEXT NOT NULL); INSERT INTO nats_poll_turns_v4 SELECT recipient_id,updated_at,last_sender_id FROM nats_poll_turns WHERE last_sender_id IS NOT NULL; DROP TABLE nats_poll_turns; ALTER TABLE nats_poll_turns_v4 RENAME TO nats_poll_turns",
          );
        this.#db.exec(schema);
        if (version < 4)
          this.#db
            .prepare(
              "INSERT INTO nats_maintenance_totals(id,last_at,expired,purged) VALUES(1,0,0,0)",
            )
            .run();
        if (version === 0)
          this.#db.prepare("INSERT INTO nats_meta VALUES(4,?)").run(check);
        else if (version < 4) this.#db.exec("UPDATE nats_meta SET version=4");
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #tx<T>(action: () => T): T {
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
  hash(domain: string, value: string): string {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + ":" + value)
      .digest("hex");
  }
  hasLivePublished(): boolean {
    return this.#tx(() => {
      this.#refresh(Date.now());
      return !!this.#db
        .prepare(
          "SELECT 1 FROM nats_messages WHERE sequence IS NOT NULL AND state IN ('pending','leased','quarantined') LIMIT 1",
        )
        .get();
    });
  }
  row(sender: string, message: string): Row | undefined {
    return this.#db
      .prepare("SELECT * FROM nats_messages WHERE sender_id=? AND message_id=?")
      .get(sender, message) as unknown as Row | undefined;
  }
  receipt(row: Row): Receipt {
    return {
      sender_id: row.sender_id,
      message_id: row.message_id,
      recipient_id: row.recipient_id,
      receipt_id: row.receipt_id,
      accepted_at: new Date(row.accepted_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      state: row.state === "staging" ? "pending" : row.state,
    };
  }
  #audit(sender: string, message: string, at: number, event: string) {
    this.#db
      .prepare(
        "INSERT INTO nats_delivery_audit(sender_id,message_id,at,event) VALUES(?,?,?,?)",
      )
      .run(sender, message, at, event);
  }
  #refresh(now: number) {
    const expired = this.#db
      .prepare(
        "UPDATE nats_messages SET state='expired',outbox=NULL,candidate=NULL,body_bytes=0,token_hash=NULL,retain_until=expires_at+? WHERE state IN ('staging','pending','leased','quarantined') AND expires_at<=? RETURNING sender_id,message_id",
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
          "UPDATE nats_maintenance_totals SET expired=expired+? WHERE id=1",
        )
        .run(expired.length).changes !== 1
    )
      throw new MessagingError("maintenance_state_unavailable");
    const requeued = this.#db
      .prepare(
        "UPDATE nats_messages SET state=CASE WHEN generation>=? THEN 'quarantined' ELSE 'pending' END,candidate=CASE WHEN generation>=? THEN NULL ELSE candidate END,token_hash=NULL WHERE state='leased' AND lease_until<=? RETURNING sender_id,message_id,state",
      )
      .all(this.#options.max_attempts, this.#options.max_attempts, now);
    for (const row of requeued)
      this.#audit(
        String(row.sender_id),
        String(row.message_id),
        now,
        row.state === "quarantined" ? "quarantined" : "requeued",
      );
  }
  stage(
    sender: string,
    message: Submission,
    material: string,
    subject: string,
    authorize: () => void,
  ): Row {
    return this.#tx(() => {
      authorize();
      const now = Date.now();
      this.#refresh(now);
      const fingerprint = this.hash("submission", material);
      const existing = this.row(sender, message.message_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new MessagingError("idempotency_conflict");
        return existing;
      }
      const expires = Date.parse(message.expires_at);
      if (
        Date.parse(message.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new MessagingError("clock_skew");
      if (expires <= now) throw new MessagingError("expired_before_acceptance");
      const outbox = JSON.stringify({ sender_id: sender, message });
      const size = Buffer.byteLength(outbox);
      const usage = this.#db
        .prepare(
          "SELECT count(*) records,coalesce(sum(CASE WHEN state IN ('staging','pending','leased','quarantined') THEN 1 ELSE 0 END),0) pending,coalesce(sum(body_bytes),0) bytes,coalesce(sum(CASE WHEN recipient_id=? AND state IN ('staging','pending','leased','quarantined') THEN 1 ELSE 0 END),0) recipient FROM nats_messages",
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
            "SELECT sender_id,count(*) records,sum(CASE WHEN state IN ('staging','pending','leased','quarantined') THEN 1 ELSE 0 END) pending,coalesce(sum(body_bytes),0) body_bytes FROM nats_messages GROUP BY sender_id",
          )
          .all() as unknown as SenderCapacityUsage[];
        const recipient = this.#db
          .prepare(
            "SELECT count(*) records,coalesce(sum(body_bytes),0) body_bytes FROM nats_messages WHERE recipient_id=?",
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
        const parent = this.row(
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
          "INSERT INTO nats_messages(sender_id,message_id,recipient_id,receipt_id,accepted_at,expires_at,kind,thread_key,fingerprint,subject,state,outbox,body_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,'staging',?,?)",
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
          subject,
          outbox,
          size,
        );
      this.#audit(sender, message.message_id, now, "accepted");
      return this.row(sender, message.message_id)!;
    });
  }
  published(sender: string, message: string, sequence: number): Row {
    return this.#tx(() => {
      this.#refresh(Date.now());
      this.#db
        .prepare(
          "UPDATE nats_messages SET state=CASE WHEN state='staging' THEN 'pending' ELSE state END,sequence=?,outbox=NULL,cleaned=CASE WHEN state IN ('acked','expired') THEN 0 ELSE cleaned END WHERE sender_id=? AND message_id=?",
        )
        .run(sequence, sender, message);
      return this.row(sender, message)!;
    });
  }
  status(
    sender: string,
    message: string,
    authorize: () => void = () => {},
  ): Receipt {
    return this.#tx(() => {
      authorize();
      this.#refresh(Date.now());
      const row = this.row(sender, message);
      if (!row) throw new MessagingError("not_found");
      return this.receipt(row);
    });
  }
  lookupReceipt(sender: string, message: string): Receipt | null {
    return this.#tx(() => {
      this.#refresh(Date.now());
      const row = this.row(sender, message);
      return row ? this.receipt(row) : null;
    });
  }
  hasActiveLease(recipient: string): boolean {
    return this.#tx(() => {
      this.#refresh(Date.now());
      return !!this.#db
        .prepare(
          "SELECT 1 FROM nats_messages WHERE recipient_id=? AND state='leased'",
        )
        .get(recipient);
    });
  }
  prefetchRecipients(limit: number): string[] {
    return this.#tx(() => {
      this.#refresh(Date.now());
      return this.#db
        .prepare(
          "SELECT DISTINCT recipient_id FROM nats_messages m WHERE state='pending' AND sequence IS NOT NULL AND candidate IS NULL AND next_visible_at<=? AND NOT EXISTS(SELECT 1 FROM nats_messages l WHERE l.recipient_id=m.recipient_id AND l.state='leased') AND (SELECT count(*) FROM nats_messages c WHERE c.recipient_id=m.recipient_id AND c.candidate IS NOT NULL AND c.state IN ('pending','leased'))<? ORDER BY recipient_id LIMIT ?",
        )
        .all(Date.now(), this.#options.prefetch_per_recipient!, limit)
        .map((row) => String(row.recipient_id));
    });
  }
  nextUncached(recipient: string): Row | null {
    return this.#tx(() => {
      this.#refresh(Date.now());
      return (
        (this.#db
          .prepare(
            "SELECT * FROM nats_messages WHERE recipient_id=? AND state='pending' AND sequence IS NOT NULL AND candidate IS NULL AND next_visible_at<=? ORDER BY accepted_at,sender_id,message_id LIMIT 1",
          )
          .get(recipient, Date.now()) as unknown as Row | undefined) ?? null
      );
    });
  }
  prefetchCapacity(recipient: string): number {
    const cached = this.#db
      .prepare(
        "SELECT count(*) n FROM nats_messages WHERE recipient_id=? AND candidate IS NOT NULL AND state IN ('pending','leased')",
      )
      .get(recipient)!;
    const pending = this.#db
      .prepare(
        "SELECT count(*) n FROM nats_messages WHERE recipient_id=? AND state='pending' AND sequence IS NOT NULL AND candidate IS NULL AND next_visible_at<=? AND expires_at>?",
      )
      .get(recipient, Date.now(), Date.now())!;
    return Math.min(
      Number(pending.n),
      Math.max(0, this.#options.prefetch_per_recipient! - Number(cached.n)),
    );
  }
  cacheCandidate(
    sender: string,
    message: string,
    sequence: number,
    candidate: string,
  ): boolean {
    return this.#tx(() => {
      this.#refresh(Date.now());
      const row = this.row(sender, message);
      if (
        !row ||
        row.state !== "pending" ||
        row.sequence !== sequence ||
        Buffer.byteLength(candidate) > row.body_bytes
      )
        return false;
      if (row.candidate !== null) return row.candidate === candidate;
      if (this.prefetchCapacity(row.recipient_id) === 0) return false;
      this.#db
        .prepare(
          "UPDATE nats_messages SET candidate=? WHERE sender_id=? AND message_id=?",
        )
        .run(candidate, sender, message);
      return true;
    });
  }
  cachedCandidates(recipient: string): Row[] {
    return this.#tx(() => {
      this.#refresh(Date.now());
      if (this.#options.fair_poll) {
        const previous =
          this.#db
            .prepare(
              "SELECT last_sender_id FROM nats_poll_turns WHERE recipient_id=?",
            )
            .get(recipient)?.last_sender_id ?? null;
        return this.#db
          .prepare(
            "SELECT * FROM nats_messages WHERE recipient_id=? AND state='pending' AND candidate IS NOT NULL AND next_visible_at<=? ORDER BY CASE WHEN ? IS NULL OR sender_id>? THEN 0 ELSE 1 END,sender_id,scan_order,accepted_at,message_id LIMIT ?",
          )
          .all(
            recipient,
            Date.now(),
            previous,
            previous,
            this.#options.poll_scan_limit!,
          ) as unknown as Row[];
      }
      return this.#db
        .prepare(
          "SELECT * FROM nats_messages WHERE recipient_id=? AND state='pending' AND candidate IS NOT NULL AND next_visible_at<=? ORDER BY accepted_at,sender_id,message_id LIMIT ?",
        )
        .all(
          recipient,
          Date.now(),
          this.#options.poll_scan_limit!,
        ) as unknown as Row[];
    });
  }
  notePollCandidate(recipient: string, sender: string, message: string): void {
    if (!this.#options.fair_poll) return;
    this.#tx(() => {
      this.#db
        .prepare(
          "UPDATE nats_messages SET scan_order=(SELECT coalesce(max(scan_order),0)+1 FROM nats_messages WHERE recipient_id=?) WHERE recipient_id=? AND sender_id=? AND message_id=?",
        )
        .run(recipient, recipient, sender, message);
      this.#db
        .prepare(
          "INSERT INTO nats_poll_turns(recipient_id,updated_at,last_sender_id) VALUES(?,?,?) ON CONFLICT(recipient_id) DO UPDATE SET last_sender_id=excluded.last_sender_id,updated_at=excluded.updated_at",
        )
        .run(recipient, Date.now(), sender);
      this.#db
        .prepare(
          "DELETE FROM nats_poll_turns WHERE recipient_id IN (SELECT recipient_id FROM nats_poll_turns ORDER BY updated_at DESC,recipient_id LIMIT -1 OFFSET ?)",
        )
        .run(this.#options.max_records);
    });
  }
  claimPull(recipient: string, timeout: number): string | null {
    return this.#tx(() => {
      const now = Date.now();
      this.#refresh(now);
      if (
        this.#db
          .prepare(
            "SELECT 1 FROM nats_messages WHERE recipient_id=? AND state='leased'",
          )
          .get(recipient) ||
        this.#db
          .prepare("SELECT 1 FROM nats_pulls WHERE recipient_id=? AND until>?")
          .get(recipient, now)
      )
        return null;
      const token = randomUUID();
      this.#db
        .prepare("INSERT OR REPLACE INTO nats_pulls VALUES(?,?,?)")
        .run(recipient, token, now + timeout);
      return token;
    });
  }
  releasePull(recipient: string, token: string): void {
    this.#db
      .prepare("DELETE FROM nats_pulls WHERE recipient_id=? AND token=?")
      .run(recipient, token);
  }
  lease(
    sender: string,
    message: Submission,
    sequence: number,
    authorize: () => void,
  ): Delivery | null {
    return this.#tx(() => {
      authorize();
      const now = Date.now();
      this.#refresh(now);
      const row = this.row(sender, message.message_id);
      if (
        !row ||
        row.state !== "pending" ||
        row.sequence !== sequence ||
        row.next_visible_at > now ||
        this.#db
          .prepare(
            "SELECT 1 FROM nats_messages WHERE recipient_id=? AND state='leased'",
          )
          .get(message.recipient_id)
      )
        return null;
      const token = Buffer.from(randomBytes(32)).toString("base64url");
      const generation = row.generation + 1;
      const until = Math.min(now + this.#options.lease_ms, row.expires_at);
      const backoff = Math.min(
        this.#options.retry_cap_ms,
        this.#options.retry_base_ms * 2 ** Math.min(generation - 1, 30),
      );
      this.#db
        .prepare(
          "UPDATE nats_messages SET state='leased',generation=?,token_hash=?,lease_until=?,next_visible_at=? WHERE sender_id=? AND message_id=?",
        )
        .run(
          generation,
          this.hash("lease", token),
          until,
          until + backoff,
          sender,
          message.message_id,
        );
      this.#audit(sender, message.message_id, now, "leased");
      return {
        message: { ...message, sender_id: sender },
        generation,
        lease_token: token,
        lease_until: new Date(until).toISOString(),
      };
    });
  }
  acknowledge(
    recipient: string,
    request: AckRequest,
    authorize: (row: Row) => void,
  ): Row {
    return this.#tx(() => {
      const row = this.row(request.sender_id, request.message_id);
      if (!row || row.recipient_id !== recipient)
        throw new MessagingError("invalid_ack");
      authorize(row);
      const fingerprint = this.hash("ack", JSON.stringify(request));
      const existing = this.#db
        .prepare(
          "SELECT * FROM nats_messages WHERE recipient_id=? AND ack_request_id=?",
        )
        .get(recipient, request.request_id) as unknown as Row | undefined;
      if (existing) {
        if (existing.ack_fingerprint !== fingerprint)
          throw new MessagingError("ack_idempotency_conflict");
        return existing;
      }
      const now = Date.now();
      if (
        row.state !== "leased" ||
        row.generation !== request.generation ||
        row.token_hash !== this.hash("lease", request.lease_token) ||
        row.lease_until <= now ||
        row.expires_at <= now
      )
        throw new MessagingError("invalid_ack");
      this.#db
        .prepare(
          "UPDATE nats_messages SET state='acked',outbox=NULL,candidate=NULL,body_bytes=0,token_hash=NULL,ack_request_id=?,ack_fingerprint=?,ack_receipt_id=?,acked_at=?,retain_until=? WHERE sender_id=? AND message_id=?",
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
      return this.row(row.sender_id, row.message_id)!;
    });
  }
  ackReceipt(row: Row): AckReceipt {
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
  pendingCleanup(limit: number): Row[] {
    return this.#tx(() => {
      this.#refresh(Date.now());
      return this.#db
        .prepare(
          "SELECT * FROM nats_messages WHERE state IN ('acked','expired') AND cleaned=0 LIMIT ?",
        )
        .all(limit) as unknown as Row[];
    });
  }
  cleaned(row: Row): void {
    this.#db
      .prepare(
        "UPDATE nats_messages SET cleaned=1,outbox=NULL,candidate=NULL,body_bytes=0 WHERE sender_id=? AND message_id=? AND state IN ('acked','expired')",
      )
      .run(row.sender_id, row.message_id);
  }
  staging(limit: number): Row[] {
    return this.#db
      .prepare("SELECT * FROM nats_messages WHERE state='staging' LIMIT ?")
      .all(limit) as unknown as Row[];
  }
  diagnostics() {
    const count = (where: string) =>
      Number(
        this.#db
          .prepare("SELECT count(*) n FROM nats_messages WHERE " + where)
          .get()!.n,
      );
    return {
      pending_publication: count("state='staging'"),
      pending_cleanup: count("state IN ('acked','expired') AND cleaned=0"),
      quarantined: count("state='quarantined'"),
    };
  }
  collect(limit: number): { purged: number; safety_held: number } {
    return this.#tx(() => {
      const now = Date.now();
      if (
        !this.#db
          .prepare("SELECT 1 FROM nats_maintenance_totals WHERE id=1")
          .get()
      )
        throw new MessagingError("maintenance_state_unavailable");
      this.#db.prepare("DELETE FROM nats_pulls WHERE until<=?").run(now);
      const due =
        "FROM nats_messages WHERE state IN ('acked','expired') AND cleaned=1 AND retain_until<=? AND nats_gc_safe(message_id,expires_at)=?";
      // Held IDs never take a batch slot, so a held backlog cannot starve purgeable records.
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
            "DELETE FROM nats_delivery_audit WHERE sender_id=? AND message_id=?",
          )
          .run(row.sender_id, row.message_id);
        purged += Number(
          this.#db
            .prepare(
              "DELETE FROM nats_messages WHERE sender_id=? AND message_id=?",
            )
            .run(row.sender_id, row.message_id).changes,
        );
      }
      this.#db
        .prepare(
          "UPDATE nats_maintenance_totals SET last_at=?,purged=purged+? WHERE id=1",
        )
        .run(now, purged);
      return { purged, safety_held };
    });
  }
  close(): void {
    this.#db.close();
  }
}
