/** Private sender source/progress journal. Dedicated schema; no server database or runtime activation. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { openSync, fstatSync, closeSync, constants } from "node:fs";
import { RelayError } from "./service.ts";
import { RECORD_RETENTION_MS } from "./contract.ts";
import { parseUploadIntent, uploadIdentifier } from "./attachments.ts";
import type { UploadIntent, UploadReceipt } from "./attachments.ts";
import {
  attachmentWirePolicy,
  parseWireUploadReceipt,
} from "./attachment-wire.ts";
import type {
  UploadJournalState,
  UploadJournalSnapshot,
  UploadJournalJob,
  UploadJournalStore,
  UploadJournalSources,
  UploadJournalFailure,
} from "./upload-journal.ts";
export interface UploadJournalOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  chunk_bytes: number;
  max_attachment_bytes: number;
  max_records: number;
  max_live_bytes: number;
  max_clock_skew_ms: number;
  busy_timeout_ms: number;
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
}
type Row = {
  request_id: string;
  intent: string;
  fingerprint: string;
  created_at: number;
  expires_at: number;
  size_bytes: number;
  state: UploadJournalState;
  source_bytes: number;
  source_retained: number;
  remote_id: string | null;
  remote_offset: number;
  operation: "begin" | "put" | "finalize";
  receipt: string | null;
  fence: number;
  lease_until: number | null;
  attempts: number;
  total_attempts: number;
  next_retry_at: number;
  reason: string | null;
  terminal_at: number | null;
  retain_until: number | null;
  guard: string;
};
const schema = [
  "CREATE TABLE upload_journal_meta(version INTEGER NOT NULL,agent_id TEXT NOT NULL,key_check TEXT NOT NULL,chunk_bytes INTEGER NOT NULL);",
  "CREATE TABLE upload_journal_entries(request_id TEXT PRIMARY KEY,intent TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),",
  "state TEXT NOT NULL CHECK(state IN ('preparing','queued','running','finalized','quarantined','expired','released')),",
  "source_bytes INTEGER NOT NULL DEFAULT 0,source_retained INTEGER NOT NULL DEFAULT 1 CHECK(source_retained IN (0,1)),",
  "remote_id TEXT,remote_offset INTEGER NOT NULL DEFAULT 0,operation TEXT NOT NULL CHECK(operation IN ('begin','put','finalize')),",
  "receipt TEXT,fence INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,total_attempts INTEGER NOT NULL DEFAULT 0,",
  "next_retry_at INTEGER NOT NULL DEFAULT 0,reason TEXT,terminal_at INTEGER,retain_until INTEGER,guard TEXT NOT NULL,",
  "CHECK(source_bytes>=0 AND source_bytes<=size_bytes),CHECK(remote_offset>=0 AND remote_offset<=size_bytes));",
  "CREATE TABLE upload_journal_chunks(request_id TEXT NOT NULL,offset INTEGER NOT NULL CHECK(offset>=0),data BLOB NOT NULL,fingerprint TEXT NOT NULL,",
  "PRIMARY KEY(request_id,offset),FOREIGN KEY(request_id) REFERENCES upload_journal_entries);",
  "CREATE UNIQUE INDEX upload_journal_single_running ON upload_journal_entries(state) WHERE state='running';",
  "CREATE INDEX upload_journal_due ON upload_journal_entries(state,next_retry_at,created_at);",
  "CREATE INDEX upload_journal_gc ON upload_journal_entries(source_retained,retain_until,expires_at);",
  "CREATE TRIGGER upload_journal_identity BEFORE UPDATE OF request_id,intent,fingerprint,created_at,expires_at,size_bytes ON upload_journal_entries BEGIN SELECT RAISE(ABORT,'immutable');END;",
  "CREATE TRIGGER upload_journal_terminal BEFORE UPDATE ON upload_journal_entries WHEN OLD.state IN ('expired','released') BEGIN SELECT RAISE(ABORT,'terminal');END;",
].join("\n");
const errors = new Set([
  "upload_journal_not_ready",
  "upload_journal_not_found",
  "upload_journal_busy",
  "upload_journal_conflict",
  "upload_journal_capacity",
  "upload_journal_closed",
  "upload_journal_incomplete",
  "upload_journal_integrity",
  "invalid_upload_chunk",
  "expired_before_acceptance",
  "upload_clock_skew",
  "stale_upload_job",
  "invalid_upload_journal_receipt",
  "invalid_upload_journal_request",
  "unsupported_upload_journal_schema",
  "unknown_upload_journal_schema",
  "upload_journal_identity_mismatch",
  "upload_journal_unavailable",
]);
export class SQLiteUploadJournal
  implements UploadJournalStore, UploadJournalSources
{
  readonly #db: DatabaseSync;
  readonly #options: UploadJournalOptions;
  #ready = false;
  #inside = false;
  #checks: Array<() => void> = [];
  constructor(path: string, options: UploadJournalOptions) {
    try {
      attachmentWirePolicy(options);
      uploadIdentifier(options.agent_id);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128
      )
        throw Error();
      for (const k of [
        "max_records",
        "max_live_bytes",
        "busy_timeout_ms",
        "lease_ms",
        "max_attempts",
        "retry_base_ms",
        "retry_cap_ms",
      ] as const)
        if (!Number.isSafeInteger(options[k]) || options[k] < 1) throw Error();
      if (
        options.max_records > 1000000 ||
        options.max_live_bytes > 1099511627776 ||
        options.busy_timeout_ms > 1000 ||
        options.lease_ms > 3600000 ||
        options.max_attempts > 1000 ||
        options.retry_cap_ms < options.retry_base_ms ||
        options.retry_cap_ms > 3600000 ||
        !Number.isSafeInteger(options.max_clock_skew_ms) ||
        options.max_clock_skew_ms < 0 ||
        options.max_clock_skew_ms > 60000
      )
        throw Error();
    } catch {
      throw new RelayError("invalid_upload_journal_options");
    }
    this.#options = {
      ...options,
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
          const file = fstatSync(fd);
          if (!file.isFile() || file.mode & 0o077) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path);
      db.exec(
        "PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;PRAGMA busy_timeout=" +
          options.busy_timeout_ms,
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new RelayError("upload_journal_unavailable");
    }
  }
  #tx<T>(action: () => T): T {
    if (this.#inside) throw new RelayError("upload_journal_busy");
    this.#inside = true;
    this.#checks = [];
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("upload_journal_busy");
      }
      for (const check of this.#checks) check();
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      if (began)
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
        }
      if (e instanceof RelayError && errors.has(e.code)) throw e;
      throw new RelayError("upload_journal_unavailable");
    } finally {
      this.#inside = false;
      this.#checks = [];
    }
  }
  #hash(domain: string, value: string | Uint8Array) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(value)
      .digest("hex");
  }
  #now() {
    return Number(
      this.#db
        .prepare(
          "SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) n",
        )
        .get()!.n,
    );
  }
  #check() {
    if (!this.#ready) throw new RelayError("upload_journal_not_ready");
  }
  #guard(r: Row) {
    return this.#hash(
      "entry-v1",
      JSON.stringify([
        r.request_id,
        r.fingerprint,
        r.state,
        r.source_bytes,
        r.source_retained,
        r.remote_id,
        r.remote_offset,
        r.operation,
        r.receipt,
        r.fence,
        r.lease_until,
        r.attempts,
        r.total_attempts,
        r.next_retry_at,
        r.reason,
        r.terminal_at,
        r.retain_until,
      ]),
    );
  }
  #intent(r: Row): UploadIntent {
    try {
      const v = parseUploadIntent(
        JSON.parse(r.intent),
        this.#options.max_attachment_bytes,
      );
      if (
        v.request_id !== r.request_id ||
        Date.parse(v.expires_at) !== r.expires_at ||
        v.attachment.size_bytes !== r.size_bytes ||
        this.#hash(
          "intent-v1",
          JSON.stringify([this.#options.agent_id, r.created_at, r.intent]),
        ) !== r.fingerprint ||
        this.#guard(r) !== r.guard
      )
        throw Error();
      return v;
    } catch {
      throw new RelayError("upload_journal_integrity");
    }
  }
  #row(id: string): Row {
    this.#check();
    try {
      uploadIdentifier(id);
    } catch {
      throw new RelayError("invalid_upload_journal_request");
    }
    const r = this.#db
      .prepare("SELECT * FROM upload_journal_entries WHERE request_id=?")
      .get(id) as Row | undefined;
    if (!r) throw new RelayError("upload_journal_not_found");
    this.#intent(r);
    return r;
  }
  #save(r: Row) {
    r.guard = this.#guard(r);
    this.#db
      .prepare(
        "UPDATE upload_journal_entries SET state=?,source_bytes=?,source_retained=?,remote_id=?,remote_offset=?,operation=?,receipt=?,fence=?,lease_until=?,attempts=?,total_attempts=?,next_retry_at=?,reason=?,terminal_at=?,retain_until=?,guard=? WHERE request_id=?",
      )
      .run(
        r.state,
        r.source_bytes,
        r.source_retained,
        r.remote_id,
        r.remote_offset,
        r.operation,
        r.receipt,
        r.fence,
        r.lease_until,
        r.attempts,
        r.total_attempts,
        r.next_retry_at,
        r.reason,
        r.terminal_at,
        r.retain_until,
        r.guard,
        r.request_id,
      );
  }
  #view(r: Row): UploadJournalSnapshot {
    const input = this.#intent(r);
    return {
      request_id: r.request_id,
      message_id: input.message_id,
      recipient_id: input.recipient_id,
      expires_at: input.expires_at,
      state: r.state,
      source_bytes: r.source_bytes,
      source_retained: r.source_retained === 1,
      attachment_id: r.remote_id,
      next_offset: r.remote_offset,
      attempts: r.attempts,
      total_attempts: r.total_attempts,
      reason: r.reason,
      receipt:
        r.receipt === null
          ? null
          : parseWireUploadReceipt(JSON.parse(r.receipt), this.#options),
    };
  }
  #close(
    r: Row,
    state: UploadJournalState,
    reason: string | null,
    now: number,
    retain: boolean,
  ) {
    if (!retain)
      this.#db
        .prepare("DELETE FROM upload_journal_chunks WHERE request_id=?")
        .run(r.request_id);
    r.state = state;
    r.reason = reason;
    r.lease_until = null;
    r.source_retained = retain ? 1 : 0;
    r.terminal_at = now;
    r.retain_until = Math.max(now, r.expires_at) + RECORD_RETENTION_MS;
    this.#save(r);
  }
  #expire(r: Row, now: number) {
    if (
      ["preparing", "queued", "running"].includes(r.state) &&
      r.expires_at <= now
    )
      this.#close(r, "expired", "expired", now, false);
    return r;
  }
  migrate() {
    this.#ready = false;
    this.#tx(() => {
      const names = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r) => r.name);
      if (names.length === 0) {
        this.#db.exec(schema);
        this.#db
          .prepare("INSERT INTO upload_journal_meta VALUES(1,?,?,?)")
          .run(
            this.#options.agent_id,
            this.#hash("key-check-v1", "upload-journal"),
            this.#options.chunk_bytes,
          );
      } else if (!names.includes("upload_journal_meta"))
        throw new RelayError("unknown_upload_journal_schema");
      const meta = this.#db.prepare("SELECT * FROM upload_journal_meta").all();
      if (meta.length !== 1 || meta[0].version !== 1)
        throw new RelayError("unsupported_upload_journal_schema");
      if (
        meta[0].agent_id !== this.#options.agent_id ||
        meta[0].key_check !== this.#hash("key-check-v1", "upload-journal") ||
        meta[0].chunk_bytes !== this.#options.chunk_bytes
      )
        throw new RelayError("upload_journal_identity_mismatch");
    });
    this.#ready = true;
  }
  prepare(input: UploadIntent): UploadJournalSnapshot {
    const intent = parseUploadIntent(input, this.#options.max_attachment_bytes),
      text = JSON.stringify(intent);
    return this.#tx(() => {
      this.#check();
      const now = this.#now();
      const old = this.#db
        .prepare("SELECT * FROM upload_journal_entries WHERE request_id=?")
        .get(intent.request_id) as Row | undefined;
      if (old) {
        this.#intent(old);
        if (old.intent !== text)
          throw new RelayError("upload_journal_conflict");
        return this.#view(this.#expire(old, now));
      }
      if (Date.parse(intent.expires_at) <= now)
        throw new RelayError("expired_before_acceptance");
      if (
        Date.parse(intent.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new RelayError("upload_clock_skew");
      const count = Number(
        this.#db.prepare("SELECT count(*) n FROM upload_journal_entries").get()!
          .n,
      );
      const live = Number(
        this.#db
          .prepare(
            "SELECT coalesce(sum(size_bytes),0) n FROM upload_journal_entries WHERE source_retained=1",
          )
          .get()!.n,
      );
      if (
        count >= this.#options.max_records ||
        live + intent.attachment.size_bytes > this.#options.max_live_bytes
      )
        throw new RelayError("upload_journal_capacity");
      const r: Row = {
        request_id: intent.request_id,
        intent: text,
        created_at: now,
        expires_at: Date.parse(intent.expires_at),
        size_bytes: intent.attachment.size_bytes,
        fingerprint: this.#hash(
          "intent-v1",
          JSON.stringify([this.#options.agent_id, now, text]),
        ),
        state: "preparing",
        source_bytes: 0,
        source_retained: 1,
        remote_id: null,
        remote_offset: 0,
        operation: "begin",
        receipt: null,
        fence: 0,
        lease_until: null,
        attempts: 0,
        total_attempts: 0,
        next_retry_at: 0,
        reason: null,
        terminal_at: null,
        retain_until: null,
        guard: "",
      };
      r.guard = this.#guard(r);
      this.#db
        .prepare(
          "INSERT INTO upload_journal_entries VALUES(" +
            Array(22).fill("?").join(",") +
            ")",
        )
        .run(
          r.request_id,
          r.intent,
          r.fingerprint,
          r.created_at,
          r.expires_at,
          r.size_bytes,
          r.state,
          r.source_bytes,
          r.source_retained,
          r.remote_id,
          r.remote_offset,
          r.operation,
          r.receipt,
          r.fence,
          r.lease_until,
          r.attempts,
          r.total_attempts,
          r.next_retry_at,
          r.reason,
          r.terminal_at,
          r.retain_until,
          r.guard,
        );
      return this.#view(r);
    });
  }
  #chunk(r: Row, offset: number): Uint8Array {
    const length = Math.min(this.#options.chunk_bytes, r.size_bytes - offset);
    const c = this.#db
      .prepare(
        "SELECT substr(data,1,?) data,fingerprint FROM upload_journal_chunks WHERE request_id=? AND offset=?",
      )
      .get(length + 1, r.request_id, offset);
    if (
      !c ||
      !(c.data instanceof Uint8Array) ||
      c.data.byteLength !== length ||
      c.fingerprint !==
        this.#hash(
          "source-v1",
          r.request_id +
            "\0" +
            offset +
            "\0" +
            Buffer.from(c.data).toString("base64"),
        )
    )
      throw new RelayError("upload_journal_integrity");
    return Uint8Array.from(c.data);
  }
  putSource(
    requestId: string,
    offset: number,
    bytes: Uint8Array,
  ): UploadJournalSnapshot {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % this.#options.chunk_bytes !== 0 ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > this.#options.chunk_bytes
    )
      throw new RelayError("invalid_upload_chunk");
    const data = Uint8Array.from(bytes);
    return this.#tx(() => {
      const r = this.#expire(this.#row(requestId), this.#now());
      if (r.state !== "preparing") {
        if (
          r.source_retained === 1 &&
          offset < r.source_bytes &&
          !Buffer.from(this.#chunk(r, offset)).equals(Buffer.from(data))
        )
          throw new RelayError("upload_journal_conflict");
        return this.#view(r);
      }
      const length = Math.min(this.#options.chunk_bytes, r.size_bytes - offset);
      if (
        offset >= r.size_bytes ||
        data.byteLength !== length ||
        offset > r.source_bytes
      )
        throw new RelayError("invalid_upload_chunk");
      if (offset < r.source_bytes) {
        if (!Buffer.from(this.#chunk(r, offset)).equals(Buffer.from(data)))
          throw new RelayError("upload_journal_conflict");
        return this.#view(r);
      }
      const tag = this.#hash(
        "source-v1",
        r.request_id +
          "\0" +
          offset +
          "\0" +
          Buffer.from(data).toString("base64"),
      );
      this.#db
        .prepare("INSERT INTO upload_journal_chunks VALUES(?,?,?,?)")
        .run(r.request_id, offset, data, tag);
      r.source_bytes += data.byteLength;
      this.#save(r);
      this.#checks.push(() => {
        if (r.expires_at <= this.#now())
          throw new RelayError("expired_before_acceptance");
      });
      return this.#view(r);
    });
  }
  #verify(r: Row) {
    const input = this.#intent(r);
    if (r.source_retained !== 1 || r.source_bytes !== r.size_bytes)
      throw new RelayError("upload_journal_incomplete");
    const hash = createHash("sha256");
    let count = 0;
    for (
      let offset = 0;
      offset < r.size_bytes;
      offset += this.#options.chunk_bytes
    ) {
      hash.update(this.#chunk(r, offset));
      count++;
    }
    if (
      Number(
        this.#db
          .prepare(
            "SELECT count(*) n FROM upload_journal_chunks WHERE request_id=?",
          )
          .get(r.request_id)!.n,
      ) !== count ||
      hash.digest("hex") !== input.attachment.sha256
    )
      throw new RelayError("upload_journal_integrity");
  }
  seal(requestId: string): UploadJournalSnapshot {
    return this.#tx(() => {
      const r = this.#expire(this.#row(requestId), this.#now());
      if (r.state !== "preparing") return this.#view(r);
      if (r.source_bytes !== r.size_bytes)
        throw new RelayError("upload_journal_incomplete");
      try {
        this.#verify(r);
      } catch (e) {
        if (e instanceof RelayError && e.code === "upload_journal_integrity") {
          this.#close(r, "quarantined", "source_integrity", this.#now(), false);
          return this.#view(r);
        }
        throw e;
      }
      r.state = "queued";
      this.#save(r);
      this.#expire(r, this.#now());
      return this.#view(r);
    });
  }
  status(requestId: string) {
    return this.#tx(() =>
      this.#view(this.#expire(this.#row(requestId), this.#now())),
    );
  }
  #job(r: Row, now: number) {
    this.#intent(r);
    if (r.attempts >= this.#options.max_attempts) {
      this.#close(r, "quarantined", "retry_exhausted", now, true);
      return null;
    }
    if (r.fence >= Number.MAX_SAFE_INTEGER)
      throw new RelayError("upload_journal_integrity");
    if (r.operation === "put") {
      if (r.source_retained !== 1 || r.source_bytes !== r.size_bytes)
        throw new RelayError("upload_journal_incomplete");
    } else this.#verify(r);
    const at = this.#now();
    if (r.expires_at <= at) {
      this.#close(r, "expired", "expired", at, false);
      return null;
    }
    r.fence++;
    r.state = "running";
    r.attempts++;
    r.total_attempts++;
    r.lease_until = Math.min(at + this.#options.lease_ms, r.expires_at);
    this.#save(r);
    const until = r.lease_until;
    this.#checks.push(() => {
      if (this.#now() >= until) throw new RelayError("stale_upload_job");
    });
    return {
      request_id: r.request_id,
      fence: r.fence,
      lease_until: new Date(until).toISOString(),
      operation: r.operation,
      intent: this.#intent(r),
      attachment_id: r.remote_id,
      offset: r.remote_offset,
      data: r.operation === "put" ? this.#chunk(r, r.remote_offset) : null,
    } satisfies UploadJournalJob;
  }
  claim(): UploadJournalJob | null {
    return this.#tx(() => {
      this.#check();
      const now = this.#now();
      const running = this.#db
        .prepare("SELECT * FROM upload_journal_entries WHERE state='running'")
        .get() as Row | undefined;
      if (running) {
        this.#intent(running);
        this.#expire(running, now);
        if (running.state === "running") {
          if (running.lease_until === null)
            throw new RelayError("upload_journal_integrity");
          if (running.lease_until > now) return null;
          return this.#job(running, now);
        }
      }
      const r = this.#db
        .prepare(
          "SELECT * FROM upload_journal_entries WHERE state='queued' AND next_retry_at<=? AND expires_at>? ORDER BY created_at,request_id LIMIT 1",
        )
        .get(now, now) as Row | undefined;
      return r ? this.#job(r, now) : null;
    });
  }
  #current(job: UploadJournalJob): Row {
    const r = this.#row(job.request_id),
      now = this.#now();
    if (
      r.state !== "running" ||
      r.fence !== job.fence ||
      r.lease_until === null ||
      r.lease_until <= now ||
      r.expires_at <= now ||
      job.operation !== r.operation ||
      job.attachment_id !== r.remote_id ||
      job.offset !== r.remote_offset ||
      job.lease_until !== new Date(r.lease_until).toISOString() ||
      JSON.stringify(
        parseUploadIntent(job.intent, this.#options.max_attachment_bytes),
      ) !== r.intent
    )
      throw new RelayError("stale_upload_job");
    const until = r.lease_until;
    this.#checks.push(() => {
      if (this.#now() >= until) throw new RelayError("stale_upload_job");
    });
    return r;
  }
  accept(job: UploadJournalJob, value: UploadReceipt): UploadJournalSnapshot {
    return this.#tx(() => {
      const r = this.#current(job),
        input = this.#intent(r);
      let receipt: UploadReceipt;
      try {
        receipt = parseWireUploadReceipt(value, this.#options);
        const {
          version,
          request_id,
          message_id,
          recipient_id,
          kind,
          first_sent_at,
          expires_at,
          attachment,
        } = receipt;
        if (
          receipt.owner_id !== this.#options.agent_id ||
          JSON.stringify({
            version,
            request_id,
            message_id,
            recipient_id,
            kind,
            first_sent_at,
            expires_at,
            attachment,
          }) !== r.intent ||
          (r.remote_id !== null && receipt.attachment_id !== r.remote_id) ||
          receipt.next_offset < r.remote_offset ||
          (job.operation === "put" &&
            ["uploading", "finalized"].includes(receipt.state) &&
            receipt.next_offset <
              job.offset +
                Math.min(
                  this.#options.chunk_bytes,
                  input.attachment.size_bytes - job.offset,
                ))
        )
          throw Error();
      } catch {
        throw new RelayError("invalid_upload_journal_receipt");
      }
      const next = receipt.next_offset >= r.size_bytes ? "finalize" : "put",
        progress =
          next !== r.operation || receipt.next_offset > r.remote_offset;
      r.remote_id = receipt.attachment_id;
      r.remote_offset = receipt.next_offset;
      r.receipt = JSON.stringify(receipt);
      const now = this.#now();
      if (receipt.state === "finalized")
        this.#close(r, "finalized", null, now, true);
      else if (receipt.state !== "uploading")
        this.#close(r, "quarantined", "remote_closed", now, true);
      else {
        r.state = "queued";
        r.operation = next;
        r.lease_until = null;
        r.next_retry_at = 0;
        r.reason = null;
        if (progress) r.attempts = 0;
        this.#save(r);
      }
      return this.#view(r);
    });
  }
  fail(job: UploadJournalJob, reason: UploadJournalFailure): void {
    if (
      ![
        "transport",
        "forbidden",
        "invalid_receipt",
        "remote_conflict",
      ].includes(reason)
    )
      throw new RelayError("invalid_upload_journal_request");
    this.#tx(() => {
      const r = this.#current(job),
        now = this.#now();
      if (reason !== "transport" || r.attempts >= this.#options.max_attempts) {
        this.#close(
          r,
          "quarantined",
          reason === "transport" ? "retry_exhausted" : reason,
          now,
          true,
        );
        return;
      }
      r.state = "queued";
      r.lease_until = null;
      r.reason = "transport";
      r.next_retry_at =
        now +
        Math.min(
          this.#options.retry_cap_ms,
          this.#options.retry_base_ms * 2 ** Math.min(r.attempts - 1, 30),
        );
      this.#save(r);
    });
  }
  withFinalized<T>(
    requestId: string,
    action: (receipt: UploadReceipt) => T,
  ): T {
    return this.#tx(() => {
      const r = this.#row(requestId);
      if (
        r.state !== "finalized" ||
        r.receipt === null ||
        r.remote_id === null ||
        r.expires_at <= this.#now()
      )
        throw new RelayError("upload_journal_closed");
      this.#verify(r);
      const receipt = parseWireUploadReceipt(
        JSON.parse(r.receipt),
        this.#options,
      );
      if (
        receipt.state !== "finalized" ||
        receipt.owner_id !== this.#options.agent_id ||
        receipt.attachment_id !== r.remote_id
      )
        throw new RelayError("upload_journal_integrity");
      this.#checks.push(() => {
        if (r.expires_at <= this.#now())
          throw new RelayError("upload_journal_closed");
      });
      return action(receipt);
    });
  }
  release(requestId: string): boolean {
    return this.#tx(() => {
      const r = this.#row(requestId);
      if (["released", "expired"].includes(r.state)) return false;
      if (r.state === "running") throw new RelayError("upload_journal_busy");
      this.#close(r, "released", "released", this.#now(), false);
      return true;
    });
  }
  maintain(limit: number): { expired: number; purged: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RelayError("invalid_upload_journal_request");
    return this.#tx(() => {
      this.#check();
      const now = this.#now();
      const rows = this.#db
        .prepare(
          "SELECT * FROM upload_journal_entries WHERE state IN ('preparing','queued','running') AND expires_at<=? ORDER BY expires_at,request_id LIMIT ?",
        )
        .all(now, limit) as Row[];
      for (const r of rows) {
        this.#intent(r);
        this.#expire(r, now);
      }
      const old = this.#db
        .prepare(
          "SELECT * FROM upload_journal_entries WHERE source_retained=0 AND state IN ('released','expired','quarantined') AND retain_until<=? AND expires_at<=? AND terminal_at<=? ORDER BY retain_until,request_id LIMIT ?",
        )
        .all(
          now,
          now - RECORD_RETENTION_MS,
          now - RECORD_RETENTION_MS,
          limit - rows.length,
        ) as Row[];
      for (const r of old) {
        this.#intent(r);
        this.#db
          .prepare("DELETE FROM upload_journal_chunks WHERE request_id=?")
          .run(r.request_id);
        this.#db
          .prepare("DELETE FROM upload_journal_entries WHERE request_id=?")
          .run(r.request_id);
      }
      return { expired: rows.length, purged: old.length };
    });
  }
  close() {
    this.#ready = false;
    this.#db.close();
  }
}
