/** Optional chunk-BLOB backend in a dedicated private DB, separate from Relay message SQL. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, fstatSync, closeSync, constants } from "node:fs";
import { RelayError } from "./service.ts";
import { RECORD_RETENTION_MS } from "./contract.ts";
import { parseUploadIntent, uploadIdentifier } from "./attachments.ts";
import type {
  AttachmentUploadStore,
  UploadAuthorize,
  UploadIntent,
  UploadReceipt,
  UploadState,
} from "./attachments.ts";

export interface AttachmentStoreOptions {
  fingerprint_key: Uint8Array;
  chunk_bytes: number;
  max_attachment_bytes: number;
  max_records: number;
  max_open_uploads: number;
  max_open_per_owner: number;
  max_live_bytes: number;
  max_live_bytes_per_owner: number;
  upload_ttl_ms: number;
  max_clock_skew_ms: number;
  busy_timeout_ms: number;
}
type UploadRow = {
  attachment_id: string;
  owner_id: string;
  request_id: string;
  fingerprint: string;
  intent: string;
  state: UploadState;
  size_bytes: number;
  received_bytes: number;
  chunk_bytes: number;
  created_at: number;
  upload_expires_at: number;
  finalized_at: number | null;
  terminal_at: number | null;
  reason: UploadReceipt["reason"];
  retain_until: number | null;
};
const schema = `
CREATE TABLE attachment_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,key_check TEXT NOT NULL,chunk_bytes INTEGER NOT NULL);
CREATE TABLE attachment_uploads(
 attachment_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 intent TEXT NOT NULL CHECK(json_valid(intent)),state TEXT NOT NULL CHECK(state IN ('uploading','finalized','cancelled','expired','rejected')),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),received_bytes INTEGER NOT NULL CHECK(received_bytes>=0 AND received_bytes<=size_bytes),
 chunk_bytes INTEGER NOT NULL CHECK(chunk_bytes>0),created_at INTEGER NOT NULL,upload_expires_at INTEGER NOT NULL,
 finalized_at INTEGER,terminal_at INTEGER,reason TEXT,retain_until INTEGER,UNIQUE(owner_id,request_id));
CREATE INDEX attachment_owner_live ON attachment_uploads(owner_id,state);
CREATE INDEX attachment_expiry ON attachment_uploads(state,upload_expires_at);
CREATE TABLE attachment_chunks(attachment_id TEXT NOT NULL REFERENCES attachment_uploads(attachment_id),offset INTEGER NOT NULL CHECK(offset>=0),fingerprint TEXT NOT NULL,data BLOB NOT NULL,
 PRIMARY KEY(attachment_id,offset));
CREATE TRIGGER attachment_identity_immutable BEFORE UPDATE OF attachment_id,owner_id,request_id,fingerprint,intent,size_bytes,chunk_bytes,created_at,upload_expires_at ON attachment_uploads BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER attachment_reservation_retained BEFORE DELETE ON attachment_uploads WHEN OLD.state NOT IN ('cancelled','expired','rejected') OR OLD.retain_until IS NULL OR OLD.retain_until>CAST(unixepoch('subsec')*1000 AS INTEGER) BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER attachment_terminal BEFORE UPDATE ON attachment_uploads WHEN OLD.state IN ('cancelled','expired','rejected') BEGIN SELECT RAISE(ABORT,'terminal'); END;
CREATE TRIGGER attachment_no_reopen BEFORE UPDATE ON attachment_uploads WHEN OLD.state='finalized' AND NEW.state='uploading' BEGIN SELECT RAISE(ABORT,'finalized'); END;
`;
const knownErrors = new Set([
  "forbidden",
  "invalid_upload_request",
  "invalid_upload_chunk",
  "upload_not_found",
  "upload_busy",
  "upload_not_migrated",
  "upload_idempotency_conflict",
  "upload_capacity_exceeded",
  "upload_closed",
  "upload_invalid_offset",
  "upload_chunk_conflict",
  "upload_incomplete",
  "expired_before_acceptance",
  "upload_clock_skew",
  "unknown_attachment_schema",
  "unsupported_attachment_schema",
  "attachment_key_mismatch",
  "attachment_chunk_policy_mismatch",
  "attachment_store_unavailable",
]);

export class SQLiteAttachmentStore implements AttachmentUploadStore {
  readonly #db: DatabaseSync;
  readonly #options: AttachmentStoreOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: AttachmentStoreOptions) {
    try {
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.byteLength < 32 ||
        options.fingerprint_key.byteLength > 128
      )
        throw Error();
      for (const key of [
        "max_records",
        "max_open_uploads",
        "max_open_per_owner",
      ] as const)
        if (
          !Number.isSafeInteger(options[key]) ||
          options[key] < 1 ||
          options[key] > 1000000
        )
          throw Error();
      for (const key of ["max_live_bytes", "max_live_bytes_per_owner"] as const)
        if (
          !Number.isSafeInteger(options[key]) ||
          options[key] < 1 ||
          options[key] > 1099511627776
        )
          throw Error();
      if (
        !Number.isSafeInteger(options.chunk_bytes) ||
        options.chunk_bytes < 1 ||
        options.chunk_bytes > 1048576 ||
        !Number.isSafeInteger(options.max_attachment_bytes) ||
        options.max_attachment_bytes < 1 ||
        options.max_attachment_bytes > 268435456 ||
        Math.ceil(options.max_attachment_bytes / options.chunk_bytes) > 1024 ||
        !Number.isSafeInteger(options.upload_ttl_ms) ||
        options.upload_ttl_ms < 1 ||
        options.upload_ttl_ms > 3600000 ||
        !Number.isSafeInteger(options.max_clock_skew_ms) ||
        options.max_clock_skew_ms < 0 ||
        options.max_clock_skew_ms > 60000 ||
        !Number.isSafeInteger(options.busy_timeout_ms) ||
        options.busy_timeout_ms < 1 ||
        options.busy_timeout_ms > 1000
      )
        throw Error();
    } catch {
      throw new RelayError("invalid_attachment_options");
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
        `PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=${options.busy_timeout_ms}`,
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new RelayError("attachment_store_unavailable");
    }
  }
  #tx<T>(action: () => T): T {
    if (this.#inside) throw new RelayError("upload_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw Error();
      }
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
        }
      }
      if (error instanceof RelayError && knownErrors.has(error.code))
        throw error;
      throw new RelayError("attachment_store_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #key() {
    return createHash("sha256")
      .update(this.#options.fingerprint_key)
      .digest("hex");
  }
  #hash(domain: string, data: string | Uint8Array) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(data)
      .digest("hex");
  }
  #now() {
    if (!this.#ready) throw new RelayError("upload_not_migrated");
    const now = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) n")
        .get()!.n,
    );
    if (!Number.isSafeInteger(now))
      throw new RelayError("attachment_store_unavailable");
    return now;
  }
  migrate() {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='attachment_schema'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new RelayError("unknown_attachment_schema");
        this.#db.exec(schema);
        this.#db
          .prepare("INSERT INTO attachment_schema VALUES(1,1,?,?)")
          .run(this.#key(), this.#options.chunk_bytes);
      }
      const rows = this.#db.prepare("SELECT * FROM attachment_schema").all();
      if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1)
        throw new RelayError("unsupported_attachment_schema");
      if (rows[0].key_check !== this.#key())
        throw new RelayError("attachment_key_mismatch");
      if (rows[0].chunk_bytes !== this.#options.chunk_bytes)
        throw new RelayError("attachment_chunk_policy_mismatch");
      this.#db
        .prepare("SELECT attachment_id FROM attachment_uploads LIMIT 0")
        .all();
      this.#db
        .prepare(
          "SELECT attachment_id,offset,fingerprint,data FROM attachment_chunks LIMIT 0",
        )
        .all();
    });
    this.#ready = true;
  }
  #identity(
    authorize: UploadAuthorize,
    peer?: { recipient_id: string; kind: string },
  ): string {
    try {
      const result = authorize(peer);
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw Error();
      }
      return uploadIdentifier(result);
    } catch {
      throw new RelayError("forbidden");
    }
  }
  #intent(row: UploadRow) {
    const intent = parseUploadIntent(JSON.parse(row.intent), 268435456);
    if (
      this.#hash("intent-v1", JSON.stringify(intent)) !== row.fingerprint ||
      intent.request_id !== row.request_id ||
      intent.attachment.size_bytes !== row.size_bytes ||
      !Number.isSafeInteger(row.received_bytes) ||
      row.received_bytes < 0 ||
      row.received_bytes > row.size_bytes ||
      row.chunk_bytes !== this.#options.chunk_bytes
    )
      throw Error();
    return intent;
  }
  #receipt(row: UploadRow): UploadReceipt {
    const iso = (value: number | null) =>
      value === null ? null : new Date(value).toISOString();
    return {
      ...this.#intent(row),
      attachment_id: row.attachment_id,
      owner_id: row.owner_id,
      state: row.state,
      created_at: iso(row.created_at)!,
      upload_expires_at: iso(row.upload_expires_at)!,
      finalized_at: iso(row.finalized_at),
      terminal_at: iso(row.terminal_at),
      received_bytes: row.received_bytes,
      next_offset: row.received_bytes,
      chunk_bytes: row.chunk_bytes,
      reason: row.reason,
    };
  }
  #row(id: string): UploadRow {
    const row = this.#db
      .prepare("SELECT * FROM attachment_uploads WHERE attachment_id=?")
      .get(id) as UploadRow | undefined;
    if (!row) throw new RelayError("upload_not_found");
    return row;
  }
  #close(
    row: UploadRow,
    state: "cancelled" | "expired" | "rejected",
    reason: UploadReceipt["reason"],
    now: number,
  ): UploadRow {
    this.#db
      .prepare("DELETE FROM attachment_chunks WHERE attachment_id=?")
      .run(row.attachment_id);
    this.#db
      .prepare(
        "UPDATE attachment_uploads SET state=?,reason=?,terminal_at=?,retain_until=? WHERE attachment_id=?",
      )
      .run(
        state,
        reason,
        now,
        Math.max(
          now,
          row.upload_expires_at,
          Date.parse(this.#intent(row).expires_at),
        ) + RECORD_RETENTION_MS,
        row.attachment_id,
      );
    return this.#row(row.attachment_id);
  }
  #expire(row: UploadRow, now: number) {
    return ["uploading", "finalized"].includes(row.state) &&
      row.upload_expires_at <= now
      ? this.#close(row, "expired", "expired", now)
      : row;
  }
  #scoped(id: string, authorize: UploadAuthorize, now: number): UploadRow {
    const owner = this.#identity(authorize);
    const row = this.#db
      .prepare(
        "SELECT * FROM attachment_uploads WHERE attachment_id=? AND owner_id=?",
      )
      .get(uploadIdentifier(id), owner) as UploadRow | undefined;
    if (!row) throw new RelayError("upload_not_found");
    const intent = this.#intent(row);
    if (this.#identity(authorize, intent) !== owner)
      throw new RelayError("forbidden");
    return this.#expire(row, now);
  }
  #capacity(owner: string, size: number) {
    if (
      Number(
        this.#db.prepare("SELECT count(*) n FROM attachment_uploads").get()!.n,
      ) >= this.#options.max_records
    )
      throw new RelayError("upload_capacity_exceeded");
    const global = this.#db
      .prepare(
        "SELECT count(*) n,coalesce(sum(size_bytes),0) bytes FROM attachment_uploads WHERE state IN ('uploading','finalized')",
      )
      .get()!;
    const local = this.#db
      .prepare(
        "SELECT count(*) n,coalesce(sum(size_bytes),0) bytes FROM attachment_uploads WHERE owner_id=? AND state IN ('uploading','finalized')",
      )
      .get(owner)!;
    if (
      Number(global.n) >= this.#options.max_open_uploads ||
      Number(local.n) >= this.#options.max_open_per_owner ||
      Number(global.bytes) + size > this.#options.max_live_bytes ||
      Number(local.bytes) + size > this.#options.max_live_bytes_per_owner
    )
      throw new RelayError("upload_capacity_exceeded");
  }
  begin(value: UploadIntent, authorize: UploadAuthorize): UploadReceipt {
    const intent = parseUploadIntent(value, this.#options.max_attachment_bytes);
    return this.#tx(() => {
      const now = this.#now(),
        owner = this.#identity(authorize, intent),
        fingerprint = this.#hash("intent-v1", JSON.stringify(intent));
      const old = this.#db
        .prepare(
          "SELECT * FROM attachment_uploads WHERE owner_id=? AND request_id=?",
        )
        .get(owner, intent.request_id) as UploadRow | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new RelayError("upload_idempotency_conflict");
        return this.#receipt(this.#expire(old, now));
      }
      if (Date.parse(intent.expires_at) <= now)
        throw new RelayError("expired_before_acceptance");
      if (
        Date.parse(intent.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new RelayError("upload_clock_skew");
      this.#capacity(owner, intent.attachment.size_bytes);
      const id = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO attachment_uploads VALUES(?,?,?,?,?,'uploading',?,0,?,?,?,NULL,NULL,NULL,NULL)",
        )
        .run(
          id,
          owner,
          intent.request_id,
          fingerprint,
          JSON.stringify(intent),
          intent.attachment.size_bytes,
          this.#options.chunk_bytes,
          now,
          Math.min(
            now + this.#options.upload_ttl_ms,
            Date.parse(intent.expires_at),
          ),
        );
      return this.#receipt(this.#row(id));
    });
  }
  status(id: string, authorize: UploadAuthorize): UploadReceipt {
    return this.#tx(() =>
      this.#receipt(this.#scoped(id, authorize, this.#now())),
    );
  }
  put(
    id: string,
    offset: number,
    input: Uint8Array,
    authorize: UploadAuthorize,
  ): UploadReceipt {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !(input instanceof Uint8Array) ||
      input.byteLength < 1 ||
      input.byteLength > this.#options.chunk_bytes
    )
      throw new RelayError("invalid_upload_chunk");
    const bytes = Uint8Array.from(input);
    return this.#tx(() => {
      const row = this.#scoped(id, authorize, this.#now());
      if (!["uploading", "finalized"].includes(row.state))
        throw new RelayError("upload_closed");
      if (
        offset % row.chunk_bytes !== 0 ||
        offset >= row.size_bytes ||
        bytes.byteLength !== Math.min(row.chunk_bytes, row.size_bytes - offset)
      )
        throw new RelayError("invalid_upload_chunk");
      const fingerprint = this.#hash("chunk-v1", bytes);
      const old = this.#db
        .prepare(
          "SELECT fingerprint FROM attachment_chunks WHERE attachment_id=? AND offset=?",
        )
        .get(id, offset);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new RelayError("upload_chunk_conflict");
        return this.#receipt(row);
      }
      if (row.state !== "uploading") throw new RelayError("upload_closed");
      if (offset !== row.received_bytes)
        throw new RelayError("upload_invalid_offset");
      this.#db
        .prepare("INSERT INTO attachment_chunks VALUES(?,?,?,?)")
        .run(id, offset, fingerprint, bytes);
      this.#db
        .prepare(
          "UPDATE attachment_uploads SET received_bytes=received_bytes+? WHERE attachment_id=?",
        )
        .run(bytes.byteLength, id);
      return this.#receipt(this.#row(id));
    });
  }
  finalize(id: string, authorize: UploadAuthorize): UploadReceipt {
    return this.#tx(() => {
      const now = this.#now(),
        row = this.#scoped(id, authorize, now);
      if (row.state !== "uploading") return this.#receipt(row);
      if (row.received_bytes !== row.size_bytes)
        throw new RelayError("upload_incomplete");
      const digest = createHash("sha256");
      let offset = 0;
      for (const chunk of this.#db
        .prepare(
          "SELECT offset,fingerprint,data FROM attachment_chunks WHERE attachment_id=? ORDER BY offset",
        )
        .iterate(id)) {
        if (
          !(chunk.data instanceof Uint8Array) ||
          chunk.offset !== offset ||
          chunk.data.byteLength !==
            Math.min(row.chunk_bytes, row.size_bytes - offset) ||
          chunk.fingerprint !== this.#hash("chunk-v1", chunk.data)
        )
          return this.#receipt(
            this.#close(row, "rejected", "integrity_failed", now),
          );
        digest.update(chunk.data);
        offset += chunk.data.byteLength;
      }
      if (offset !== row.size_bytes)
        return this.#receipt(
          this.#close(row, "rejected", "integrity_failed", now),
        );
      if (digest.digest("hex") !== this.#intent(row).attachment.sha256)
        return this.#receipt(
          this.#close(row, "rejected", "digest_mismatch", now),
        );
      this.#db
        .prepare(
          "UPDATE attachment_uploads SET state='finalized',finalized_at=? WHERE attachment_id=?",
        )
        .run(now, id);
      return this.#receipt(this.#row(id));
    });
  }
  cancel(id: string, authorize: UploadAuthorize): UploadReceipt {
    return this.#tx(() => {
      const now = this.#now(),
        row = this.#scoped(id, authorize, now);
      return this.#receipt(
        ["uploading", "finalized"].includes(row.state)
          ? this.#close(row, "cancelled", "cancelled", now)
          : row,
      );
    });
  }
  maintain(
    authorize: () => void,
    limit: number,
  ): { expired: number; purged: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RelayError("invalid_upload_request");
    return this.#tx(() => {
      const now = this.#now();
      const result: unknown = authorize();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("forbidden");
      }
      const rows = this.#db
        .prepare(
          "SELECT * FROM attachment_uploads WHERE state IN ('uploading','finalized') AND upload_expires_at<=? ORDER BY upload_expires_at,attachment_id LIMIT ?",
        )
        .all(now, limit) as UploadRow[];
      for (const row of rows) this.#close(row, "expired", "expired", now);
      const old = this.#db
        .prepare(
          "SELECT attachment_id FROM attachment_uploads WHERE state IN ('cancelled','expired','rejected') AND retain_until<=? AND terminal_at+?<=? AND upload_expires_at+?<=? ORDER BY retain_until,attachment_id LIMIT ?",
        )
        .all(
          now,
          RECORD_RETENTION_MS,
          now,
          RECORD_RETENTION_MS,
          now,
          limit - rows.length,
        );
      for (const row of old)
        this.#db
          .prepare("DELETE FROM attachment_uploads WHERE attachment_id=?")
          .run(row.attachment_id!);
      return { expired: rows.length, purged: old.length };
    });
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
