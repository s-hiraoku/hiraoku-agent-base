import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { RelayError } from "../../../src/relay/service.ts";
import type {
  Receipt,
  Delivery,
  AckReceipt,
} from "../../../src/relay/service.ts";
import type { Submission, AckRequest } from "../../../src/relay/contract.ts";
import {
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  isReplayBoundMessageId,
} from "../../../src/relay/contract.ts";

export interface JournalOptions {
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
 outbox TEXT,body_bytes INTEGER NOT NULL,sequence INTEGER,
 generation INTEGER NOT NULL DEFAULT 0,token_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 next_visible_at INTEGER NOT NULL DEFAULT 0,ack_request_id TEXT,
 ack_fingerprint TEXT,ack_receipt_id TEXT,acked_at INTEGER,retain_until INTEGER,
 cleaned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sender_id,message_id),
 UNIQUE(recipient_id,ack_request_id));
CREATE UNIQUE INDEX IF NOT EXISTS nats_one_live_lease ON nats_messages(recipient_id) WHERE state='leased';
CREATE INDEX IF NOT EXISTS nats_terminal ON nats_messages(state,cleaned,retain_until);
CREATE TABLE IF NOT EXISTS nats_pulls(recipient_id TEXT PRIMARY KEY,token TEXT NOT NULL,until INTEGER NOT NULL);
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
        throw new RelayError("invalid_store_options");
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
      throw new RelayError("invalid_store_options");
    this.#options = {
      ...options,
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    if (path === ":memory:") throw new RelayError("durable_journal_required");
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new RelayError("insecure_journal_file");
    } finally {
      closeSync(fd);
    }
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      const tables = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => String(row.name))
        .sort();
      const expected = ["nats_messages", "nats_meta", "nats_pulls"];
      const check = this.hash("key", "nats-journal-v1:" + binding);
      if (tables.length) {
        if (JSON.stringify(tables) !== JSON.stringify(expected))
          throw new RelayError("unknown_journal_schema");
        const meta = this.#db.prepare("SELECT * FROM nats_meta").all();
        if (
          meta.length !== 1 ||
          meta[0].version !== 1 ||
          meta[0].key_check !== check
        )
          throw new RelayError("journal_key_or_version_mismatch");
      }
      this.#db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#tx(() => {
        this.#db.exec(schema);
        const meta = this.#db.prepare("SELECT * FROM nats_meta").get();
        if (!meta)
          this.#db.prepare("INSERT INTO nats_meta VALUES(1,?)").run(check);
        else if (meta.version !== 1 || meta.key_check !== check)
          throw new RelayError("journal_key_or_version_mismatch");
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
  #refresh(now: number) {
    this.#db
      .prepare(
        "UPDATE nats_messages SET state='expired',outbox=NULL,body_bytes=0,token_hash=NULL,retain_until=expires_at+? WHERE state IN ('staging','pending','leased','quarantined') AND expires_at<=?",
      )
      .run(RECORD_RETENTION_MS, now);
    this.#db
      .prepare(
        "UPDATE nats_messages SET state=CASE WHEN generation>=? THEN 'quarantined' ELSE 'pending' END,token_hash=NULL WHERE state='leased' AND lease_until<=?",
      )
      .run(this.#options.max_attempts, now);
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
          throw new RelayError("idempotency_conflict");
        return existing;
      }
      const expires = Date.parse(message.expires_at);
      if (
        Date.parse(message.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new RelayError("clock_skew");
      if (expires <= now) throw new RelayError("expired_before_acceptance");
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
        throw new RelayError("capacity_exceeded");
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
          throw new RelayError("invalid_reference");
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
  status(sender: string, message: string): Receipt {
    return this.#tx(() => {
      this.#refresh(Date.now());
      const row = this.row(sender, message);
      if (!row) throw new RelayError("not_found");
      return this.receipt(row);
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
      const token = randomBytes(32).toString("base64url");
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
        throw new RelayError("invalid_ack");
      authorize(row);
      const fingerprint = this.hash("ack", JSON.stringify(request));
      const existing = this.#db
        .prepare(
          "SELECT * FROM nats_messages WHERE recipient_id=? AND ack_request_id=?",
        )
        .get(recipient, request.request_id) as unknown as Row | undefined;
      if (existing) {
        if (existing.ack_fingerprint !== fingerprint)
          throw new RelayError("ack_idempotency_conflict");
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
        throw new RelayError("invalid_ack");
      this.#db
        .prepare(
          "UPDATE nats_messages SET state='acked',outbox=NULL,body_bytes=0,token_hash=NULL,ack_request_id=?,ack_fingerprint=?,ack_receipt_id=?,acked_at=?,retain_until=? WHERE sender_id=? AND message_id=?",
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
      throw new RelayError("invalid_ack");
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
        "UPDATE nats_messages SET cleaned=1,outbox=NULL,body_bytes=0 WHERE sender_id=? AND message_id=? AND state IN ('acked','expired')",
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
      this.#db.prepare("DELETE FROM nats_pulls WHERE until<=?").run(Date.now());
      const rows = this.#db
        .prepare(
          "SELECT * FROM nats_messages WHERE state IN ('acked','expired') AND cleaned=1 AND retain_until<=? LIMIT ?",
        )
        .all(Date.now(), limit) as unknown as Row[];
      let purged = 0,
        safety_held = 0;
      for (const row of rows) {
        if (!isReplayBoundMessageId(row.message_id, row.expires_at)) {
          safety_held++;
          continue;
        }
        purged += Number(
          this.#db
            .prepare(
              "DELETE FROM nats_messages WHERE sender_id=? AND message_id=?",
            )
            .run(row.sender_id, row.message_id).changes,
        );
      }
      return { purged, safety_held };
    });
  }
  close(): void {
    this.#db.close();
  }
}
