/** Optional chunk-BLOB backend in a dedicated private DB, separate from Relay message SQL. */
import { DatabaseSync } from "node:sqlite";
import {
  attachmentCapacityPolicy,
  assertUploadCapacity,
  assertBindingCapacity,
} from "./attachment-capacity.ts";
import type {
  AttachmentCapacityPolicy,
  UploadCapacityUsage,
  BindingCapacityUsage,
} from "./attachment-capacity.ts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, fstatSync, closeSync, constants } from "node:fs";
import { RelayError } from "./service.ts";
import { RECORD_RETENTION_MS, comparisonMaterial } from "./contract.ts";
import type { ContractLimits, Submission } from "./contract.ts";
import type {
  AttachmentDeletionGrant,
  BoundAttachmentDeletion,
} from "./attachment-deletion.ts";
import type { Acceptance, Receipt, ReceiveAuthorization } from "./service.ts";
import { parseAttachmentRead } from "./attachment-read.ts";
import type {
  AttachmentReadRequest,
  AttachmentReadGrant,
  AttachmentChunk,
  AttachmentChunkStore,
} from "./attachment-read.ts";
import { parseAttachmentMessage } from "./attachment-bindings.ts";
import type {
  AttachmentBindingStore,
  AttachmentBindingReceipt,
} from "./attachment-bindings.ts";
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
  owner_capacity?: AttachmentCapacityPolicy;
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
const bindingSchema = `
CREATE TABLE attachment_bindings(owner_id TEXT NOT NULL,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 recipient_id TEXT NOT NULL,kind TEXT NOT NULL,expires_at INTEGER NOT NULL,prepared_at INTEGER NOT NULL,
 receipt TEXT,confirmed_at INTEGER,retain_until INTEGER NOT NULL,PRIMARY KEY(owner_id,message_id));
CREATE TABLE attachment_refs(attachment_id TEXT PRIMARY KEY REFERENCES attachment_uploads(attachment_id),
 owner_id TEXT NOT NULL,message_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
 FOREIGN KEY(owner_id,message_id) REFERENCES attachment_bindings(owner_id,message_id),UNIQUE(owner_id,message_id,ordinal));
CREATE INDEX attachment_binding_gc ON attachment_bindings(expires_at,retain_until);
CREATE TRIGGER attachment_binding_immutable BEFORE UPDATE OF owner_id,message_id,fingerprint,recipient_id,kind,expires_at,prepared_at,retain_until ON attachment_bindings BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
type BindingRow = {
  owner_id: string;
  message_id: string;
  fingerprint: string;
  recipient_id: string;
  kind: string;
  expires_at: number;
  prepared_at: number;
  receipt: string | null;
  confirmed_at: number | null;
  retain_until: number;
};
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
  "attachment_reference_mismatch",
  "attachment_not_finalized",
  "attachment_binding_conflict",
  "attachment_binding_not_found",
  "attachment_receipt_mismatch",
  "upload_bound",
  "invalid_attachment_message",
  "attachment_binding_unavailable",
  "attachment_deletion_conflict",
  "stale_attachment_deletion",
  "invalid_attachment_read",
  "attachment_read_not_found",
  "attachment_integrity_failed",
]);

export class SQLiteAttachmentStore
  implements
    AttachmentUploadStore,
    AttachmentBindingStore,
    AttachmentChunkStore,
    BoundAttachmentDeletion
{
  readonly #db: DatabaseSync;
  readonly #options: AttachmentStoreOptions;
  #ready = false;
  #inside = false;
  #guards: Array<() => void> = [];
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
      owner_capacity:
        options.owner_capacity === undefined
          ? undefined
          : attachmentCapacityPolicy(options.owner_capacity, options),
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
      db = new DatabaseSync(path, { timeout: options.busy_timeout_ms });
      db.exec(
        `PRAGMA busy_timeout=${options.busy_timeout_ms}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON`,
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
    this.#guards = [];
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw Error();
      }
      for (const guard of this.#guards) guard();
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
      this.#guards = [];
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
      if (
        rows.length !== 1 ||
        rows[0].id !== 1 ||
        ![1, 2].includes(Number(rows[0].version))
      )
        throw new RelayError("unsupported_attachment_schema");
      if (rows[0].key_check !== this.#key())
        throw new RelayError("attachment_key_mismatch");
      if (rows[0].chunk_bytes !== this.#options.chunk_bytes)
        throw new RelayError("attachment_chunk_policy_mismatch");
      if (rows[0].version === 1) {
        this.#db.exec(bindingSchema);
        this.#db.exec("UPDATE attachment_schema SET version=2 WHERE id=1");
      }
      this.#db
        .prepare("SELECT attachment_id FROM attachment_uploads LIMIT 0")
        .all();
      this.#db
        .prepare("SELECT owner_id,message_id FROM attachment_bindings LIMIT 0")
        .all();
      this.#db
        .prepare("SELECT attachment_id,ordinal FROM attachment_refs LIMIT 0")
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
    const resolve = () => {
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
    };
    const identity = resolve();
    this.#guards.push(() => {
      if (resolve() !== identity) throw new RelayError("forbidden");
    });
    return identity;
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
    const bound = this.#db
      .prepare(
        "SELECT b.expires_at FROM attachment_refs r JOIN attachment_bindings b USING(owner_id,message_id) WHERE r.attachment_id=?",
      )
      .get(row.attachment_id);
    return ["uploading", "finalized"].includes(row.state) &&
      Number(bound?.expires_at ?? row.upload_expires_at) <= now
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
    if (this.#options.owner_capacity) {
      const usage = this.#db
        .prepare(
          "SELECT owner_id,count(*) records,sum(CASE WHEN state IN ('uploading','finalized') THEN 1 ELSE 0 END) open_uploads,sum(CASE WHEN state IN ('uploading','finalized') THEN size_bytes ELSE 0 END) live_bytes FROM attachment_uploads GROUP BY owner_id",
        )
        .all() as unknown as UploadCapacityUsage[];
      assertUploadCapacity(
        this.#options.owner_capacity,
        this.#options,
        owner,
        size,
        usage,
      );
      return;
    }

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
      this.#guards.push(() => {
        if (
          Math.min(
            now + this.#options.upload_ttl_ms,
            Date.parse(intent.expires_at),
          ) <= this.#now()
        )
          throw new RelayError("expired_before_acceptance");
      });
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
      if (
        ["uploading", "finalized"].includes(row.state) &&
        this.#db
          .prepare("SELECT 1 FROM attachment_refs WHERE attachment_id=?")
          .get(id)
      )
        throw new RelayError("upload_bound");
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
      this.#guards.push(() => {
        const current: unknown = authorize();
        if (current && typeof current === "object" && "then" in current) {
          void Promise.resolve(current).catch(() => {});
          throw new RelayError("forbidden");
        }
      });
      const rows = this.#db
        .prepare(
          "SELECT u.* FROM attachment_uploads u LEFT JOIN attachment_refs r USING(attachment_id) LEFT JOIN attachment_bindings b USING(owner_id,message_id) WHERE u.state IN ('uploading','finalized') AND coalesce(b.expires_at,u.upload_expires_at)<=? ORDER BY u.upload_expires_at,u.attachment_id LIMIT ?",
        )
        .all(now, limit) as UploadRow[];
      for (const row of rows) this.#close(row, "expired", "expired", now);
      const bindings = this.#db
        .prepare(
          "SELECT b.owner_id,b.message_id FROM attachment_bindings b WHERE b.retain_until<=? AND NOT EXISTS(SELECT 1 FROM attachment_refs r JOIN attachment_uploads u USING(attachment_id) WHERE r.owner_id=b.owner_id AND r.message_id=b.message_id AND (u.state IN ('uploading','finalized') OR u.retain_until IS NULL OR u.retain_until>?)) ORDER BY b.retain_until,b.owner_id,b.message_id LIMIT ?",
        )
        .all(now, now, limit);
      for (const row of bindings) {
        this.#db
          .prepare(
            "DELETE FROM attachment_refs WHERE owner_id=? AND message_id=?",
          )
          .run(row.owner_id!, row.message_id!);
        this.#db
          .prepare(
            "DELETE FROM attachment_bindings WHERE owner_id=? AND message_id=?",
          )
          .run(row.owner_id!, row.message_id!);
      }
      const old = this.#db
        .prepare(
          "SELECT attachment_id FROM attachment_uploads WHERE state IN ('cancelled','expired','rejected') AND retain_until<=? AND terminal_at+?<=? AND upload_expires_at+?<=? AND NOT EXISTS(SELECT 1 FROM attachment_refs r WHERE r.attachment_id=attachment_uploads.attachment_id) ORDER BY retain_until,attachment_id LIMIT ?",
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
  #bindingRow(owner: string, messageId: string): BindingRow {
    const row = this.#db
      .prepare(
        "SELECT * FROM attachment_bindings WHERE owner_id=? AND message_id=?",
      )
      .get(owner, messageId) as BindingRow | undefined;
    if (!row) throw new RelayError("attachment_binding_not_found");
    return row;
  }
  #bindingReceipt(row: BindingRow, now: number): AttachmentBindingReceipt {
    const ids = this.#db
      .prepare(
        "SELECT attachment_id FROM attachment_refs WHERE owner_id=? AND message_id=? ORDER BY ordinal",
      )
      .all(row.owner_id, row.message_id)
      .map((r) => String(r.attachment_id));
    if (!ids.length || ids.length > 64)
      throw new RelayError("attachment_binding_unavailable");
    return {
      owner_id: row.owner_id,
      message_id: row.message_id,
      recipient_id: row.recipient_id,
      expires_at: new Date(row.expires_at).toISOString(),
      attachment_ids: ids,
      state:
        row.expires_at <= now
          ? "expired"
          : row.receipt === null
            ? "prepared"
            : "accepted",
      receipt:
        row.receipt === null ? null : (JSON.parse(row.receipt) as Receipt),
    };
  }
  prepare(
    input: Submission,
    limits: ContractLimits,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt {
    const message = parseAttachmentMessage(input, limits);
    return this.#tx(() => {
      const now = this.#now(),
        owner = this.#identity(authorize, message),
        material = comparisonMaterial(owner, message, limits),
        fingerprint = this.#hash("binding-v1", material);
      const old = this.#db
        .prepare(
          "SELECT * FROM attachment_bindings WHERE owner_id=? AND message_id=?",
        )
        .get(owner, message.message_id) as BindingRow | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new RelayError("attachment_binding_conflict");
        return this.#bindingReceipt(old, now);
      }
      if (Date.parse(message.expires_at) <= now)
        throw new RelayError("expired_before_acceptance");
      if (
        Date.parse(message.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new RelayError("upload_clock_skew");
      if (
        Number(
          this.#db.prepare("SELECT count(*) n FROM attachment_bindings").get()!
            .n,
        ) >= this.#options.max_records
      )
        throw new RelayError("upload_capacity_exceeded");
      if (this.#options.owner_capacity) {
        const usage = this.#db
          .prepare(
            "SELECT owner_id,count(*) bindings FROM attachment_bindings GROUP BY owner_id",
          )
          .all() as unknown as BindingCapacityUsage[];
        assertBindingCapacity(
          this.#options.owner_capacity,
          this.#options,
          owner,
          usage,
        );
      }
      const parts = message.body.parts.filter((p) => p.type === "attachment"),
        deadlines: number[] = [];
      for (const part of parts) {
        const row = this.#scoped(part.attachment_id, authorize, now),
          intent = this.#intent(row);
        if (row.state !== "finalized")
          throw new RelayError("attachment_not_finalized");
        const { type: _type, attachment_id: _id, ...descriptor } = part;
        void _type;
        void _id;
        if (
          intent.message_id !== message.message_id ||
          intent.recipient_id !== message.recipient_id ||
          intent.kind !== message.kind ||
          intent.first_sent_at !== message.first_sent_at ||
          intent.expires_at !== message.expires_at ||
          JSON.stringify(intent.attachment) !== JSON.stringify(descriptor)
        )
          throw new RelayError("attachment_reference_mismatch");
        if (
          this.#db
            .prepare("SELECT 1 FROM attachment_refs WHERE attachment_id=?")
            .get(part.attachment_id)
        )
          throw new RelayError("attachment_binding_conflict");
        deadlines.push(row.upload_expires_at);
      }
      this.#db
        .prepare(
          "INSERT INTO attachment_bindings VALUES(?,?,?,?,?,?,?,NULL,NULL,?)",
        )
        .run(
          owner,
          message.message_id,
          fingerprint,
          message.recipient_id,
          message.kind,
          Date.parse(message.expires_at),
          now,
          Math.max(now, Date.parse(message.expires_at)) + RECORD_RETENTION_MS,
        );
      parts.forEach((part, ordinal) =>
        this.#db
          .prepare("INSERT INTO attachment_refs VALUES(?,?,?,?)")
          .run(part.attachment_id, owner, message.message_id, ordinal),
      );
      this.#guards.push(() => {
        if (
          Math.min(...deadlines, Date.parse(message.expires_at)) <= this.#now()
        )
          throw new RelayError("upload_closed");
      });
      return this.#bindingReceipt(
        this.#bindingRow(owner, message.message_id),
        now,
      );
    });
  }
  binding(
    messageId: string,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt {
    uploadIdentifier(messageId);
    return this.#tx(() => {
      const now = this.#now(),
        owner = this.#identity(authorize),
        row = this.#bindingRow(owner, messageId);
      if (this.#identity(authorize, row) !== owner)
        throw new RelayError("forbidden");
      return this.#bindingReceipt(row, now);
    });
  }
  confirm(
    messageId: string,
    receipt: Receipt,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt {
    uploadIdentifier(messageId);
    return this.#tx(() => {
      const now = this.#now(),
        owner = this.#identity(authorize),
        row = this.#bindingRow(owner, messageId);
      if (this.#identity(authorize, row) !== owner)
        throw new RelayError("forbidden");
      if (
        !receipt ||
        receipt.sender_id !== owner ||
        receipt.message_id !== messageId ||
        receipt.recipient_id !== row.recipient_id ||
        receipt.expires_at !== new Date(row.expires_at).toISOString() ||
        typeof receipt.receipt_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(
          receipt.receipt_id,
        ) ||
        !["pending", "leased", "acked", "expired", "quarantined"].includes(
          receipt.state,
        ) ||
        !Number.isFinite(Date.parse(receipt.accepted_at)) ||
        new Date(Date.parse(receipt.accepted_at)).toISOString() !==
          receipt.accepted_at ||
        Date.parse(receipt.accepted_at) >= row.expires_at
      )
        throw new RelayError("attachment_receipt_mismatch");
      if (row.receipt !== null) {
        const old = JSON.parse(row.receipt) as Receipt;
        if (
          old.receipt_id !== receipt.receipt_id ||
          old.accepted_at !== receipt.accepted_at
        )
          throw new RelayError("attachment_receipt_mismatch");
      }
      const saved: Receipt = {
        sender_id: owner,
        message_id: messageId,
        recipient_id: row.recipient_id,
        receipt_id: receipt.receipt_id,
        accepted_at: receipt.accepted_at,
        expires_at: receipt.expires_at,
        state: receipt.state,
      };
      this.#db
        .prepare(
          "UPDATE attachment_bindings SET receipt=?,confirmed_at=coalesce(confirmed_at,?) WHERE owner_id=? AND message_id=?",
        )
        .run(JSON.stringify(saved), now, owner, messageId);
      return this.#bindingReceipt(this.#bindingRow(owner, messageId), now);
    });
  }
  checkPrepared(acceptance: Acceptance, limits: ContractLimits): void {
    try {
      const message = parseAttachmentMessage(acceptance.message, limits);
      const material = comparisonMaterial(
        acceptance.sender_id,
        message,
        limits,
      );
      const now = this.#now(),
        row = this.#bindingRow(
          acceptance.sender_id,
          acceptance.message.message_id,
        );
      if (
        row.expires_at <= now ||
        material !== acceptance.comparison_material ||
        row.fingerprint !== this.#hash("binding-v1", material)
      )
        throw Error();
      const refs = this.#db
        .prepare(
          "SELECT u.attachment_id,u.state,u.received_bytes,u.size_bytes FROM attachment_refs r JOIN attachment_uploads u USING(attachment_id) WHERE r.owner_id=? AND r.message_id=? ORDER BY r.ordinal",
        )
        .all(row.owner_id, row.message_id);
      const parts = acceptance.message.body.parts.filter(
        (p) => p.type === "attachment",
      );
      if (
        !parts.length ||
        refs.length !== parts.length ||
        refs.some(
          (r, i) =>
            r.attachment_id !== parts[i].attachment_id ||
            r.state !== "finalized" ||
            r.received_bytes !== r.size_bytes,
        )
      )
        throw Error();
    } catch {
      throw new RelayError("attachment_binding_unavailable");
    }
  }
  /** Return at most one authenticated chunk under the live Relay read guard. */
  read(
    input: AttachmentReadRequest,
    grant: AttachmentReadGrant,
    limits: ContractLimits,
    authorize: ReceiveAuthorization,
  ): AttachmentChunk {
    const request = parseAttachmentRead(input);
    return this.#tx(() => {
      grant.assertCurrent();
      const now = this.#now();
      const identity = () => {
        try {
          const id = authorize({
            sender_id: grant.sender_id,
            kind: grant.message.kind,
          });
          if (id && typeof id === "object" && "then" in id) {
            void Promise.resolve(id).catch(() => {});
            throw Error();
          }
          return uploadIdentifier(id);
        } catch {
          throw new RelayError("forbidden");
        }
      };
      const receiver = identity();
      if (
        grant.sender_id !== request.sender_id ||
        grant.message.message_id !== request.message_id ||
        grant.message.recipient_id !== receiver ||
        Date.parse(grant.message.expires_at) <= now ||
        grant.receipt.sender_id !== grant.sender_id ||
        grant.receipt.recipient_id !== receiver ||
        grant.receipt.message_id !== request.message_id ||
        grant.receipt.expires_at !== grant.message.expires_at ||
        !["pending", "leased"].includes(grant.receipt.state)
      )
        throw new RelayError("attachment_read_not_found");
      const binding = this.#bindingRow(grant.sender_id, request.message_id);
      const confirmed =
        binding.receipt === null
          ? null
          : (JSON.parse(binding.receipt) as Receipt);
      if (
        !confirmed ||
        confirmed.receipt_id !== grant.receipt.receipt_id ||
        confirmed.accepted_at !== grant.receipt.accepted_at
      )
        throw new RelayError("attachment_read_not_found");
      this.checkPrepared(
        {
          sender_id: grant.sender_id,
          message: grant.message,
          comparison_material: comparisonMaterial(
            grant.sender_id,
            grant.message,
            limits,
          ),
        },
        limits,
      );
      const part = grant.message.body.parts.find(
        (p) =>
          p.type === "attachment" && p.attachment_id === request.attachment_id,
      );
      if (!part || part.type !== "attachment")
        throw new RelayError("attachment_read_not_found");
      const ref = this.#db
        .prepare(
          "SELECT 1 FROM attachment_refs WHERE attachment_id=? AND owner_id=? AND message_id=?",
        )
        .get(request.attachment_id, grant.sender_id, request.message_id);
      if (!ref) throw new RelayError("attachment_read_not_found");
      const row = this.#row(request.attachment_id),
        intent = this.#intent(row);
      const { type: _type, attachment_id: _id, ...descriptor } = part;
      void _type;
      void _id;
      if (
        row.owner_id !== grant.sender_id ||
        intent.message_id !== request.message_id ||
        intent.recipient_id !== receiver ||
        intent.kind !== grant.message.kind ||
        intent.first_sent_at !== grant.message.first_sent_at ||
        intent.expires_at !== grant.message.expires_at ||
        JSON.stringify(intent.attachment) !== JSON.stringify(descriptor)
      )
        throw new RelayError("attachment_integrity_failed");
      if (
        request.offset > row.size_bytes ||
        (request.offset !== row.size_bytes &&
          request.offset % row.chunk_bytes !== 0)
      )
        throw new RelayError("invalid_attachment_read");
      let data = new Uint8Array();
      if (request.offset < row.size_bytes) {
        const chunk = this.#db
          .prepare(
            "SELECT fingerprint,length(data) bytes,substr(data,1,?) data FROM attachment_chunks WHERE attachment_id=? AND offset=?",
          )
          .get(row.chunk_bytes + 1, request.attachment_id, request.offset);
        if (
          !chunk ||
          !(chunk.data instanceof Uint8Array) ||
          chunk.bytes !== chunk.data.byteLength ||
          chunk.data.byteLength !==
            Math.min(row.chunk_bytes, row.size_bytes - request.offset) ||
          chunk.fingerprint !== this.#hash("chunk-v1", chunk.data)
        )
          throw new RelayError("attachment_integrity_failed");
        data = Uint8Array.from(chunk.data);
      }
      this.#guards.push(() => {
        grant.assertCurrent();
        if (identity() !== receiver) throw new RelayError("forbidden");
        if (Date.parse(grant.message.expires_at) <= this.#now())
          throw new RelayError("attachment_read_not_found");
      });
      return {
        version: 1,
        sender_id: grant.sender_id,
        recipient_id: receiver,
        message_id: request.message_id,
        attachment_id: request.attachment_id,
        expires_at: grant.message.expires_at,
        ...descriptor,
        offset: request.offset,
        next_offset: request.offset + data.byteLength,
        chunk_bytes: row.chunk_bytes,
        eof: request.offset + data.byteLength === row.size_bytes,
        data,
      };
    });
  }
  /** Terminal proof must originate from the fixed Relay queue while its guard is held. */
  deleteBound(grant: AttachmentDeletionGrant): { deleted: number } {
    return this.#tx(() => {
      grant.assertCurrent();
      const now = this.#now(),
        r = grant.receipt;
      if (
        !["acked", "expired"].includes(grant.reason) ||
        r.state !== grant.reason ||
        !grant.attachment_ids.length ||
        grant.attachment_ids.length > 64 ||
        new Set(grant.attachment_ids).size !== grant.attachment_ids.length
      )
        throw new RelayError("attachment_deletion_conflict");
      const binding = this.#db
        .prepare(
          "SELECT * FROM attachment_bindings WHERE owner_id=? AND message_id=?",
        )
        .get(r.sender_id, r.message_id) as BindingRow | undefined;
      if (!binding) {
        for (const id of grant.attachment_ids) {
          const row = this.#db
            .prepare("SELECT * FROM attachment_uploads WHERE attachment_id=?")
            .get(id) as UploadRow | undefined;
          if (!row) continue;
          const intent = this.#intent(row);
          if (
            row.owner_id !== r.sender_id ||
            intent.message_id !== r.message_id ||
            intent.recipient_id !== r.recipient_id ||
            intent.expires_at !== r.expires_at ||
            row.state === "uploading" ||
            row.state === "finalized"
          )
            throw new RelayError("attachment_deletion_conflict");
          this.#db
            .prepare("DELETE FROM attachment_chunks WHERE attachment_id=?")
            .run(id);
        }
        this.#guards.push(() => grant.assertCurrent());
        return { deleted: 0 };
      }
      const snapshot = this.#bindingReceipt(binding, now),
        old =
          binding.receipt === null
            ? null
            : (JSON.parse(binding.receipt) as Receipt);
      if (
        binding.recipient_id !== r.recipient_id ||
        new Date(binding.expires_at).toISOString() !== r.expires_at ||
        JSON.stringify(snapshot.attachment_ids) !==
          JSON.stringify(grant.attachment_ids) ||
        (old &&
          (old.receipt_id !== r.receipt_id ||
            old.accepted_at !== r.accepted_at))
      )
        throw new RelayError("attachment_deletion_conflict");
      let deleted = 0;
      for (const id of grant.attachment_ids) {
        const row = this.#row(id),
          intent = this.#intent(row);
        if (
          row.owner_id !== r.sender_id ||
          intent.message_id !== r.message_id ||
          intent.recipient_id !== r.recipient_id ||
          intent.expires_at !== r.expires_at
        )
          throw new RelayError("attachment_deletion_conflict");
        if (row.state === "uploading" || row.state === "finalized") {
          this.#close(
            row,
            grant.reason === "acked" ? "cancelled" : "expired",
            grant.reason === "acked" ? "cancelled" : "expired",
            now,
          );
          deleted++;
        } else {
          this.#db
            .prepare("DELETE FROM attachment_chunks WHERE attachment_id=?")
            .run(id);
        }
      }
      this.#db
        .prepare(
          "UPDATE attachment_bindings SET receipt=?,confirmed_at=coalesce(confirmed_at,?) WHERE owner_id=? AND message_id=?",
        )
        .run(JSON.stringify(r), now, r.sender_id, r.message_id);
      this.#guards.push(() => grant.assertCurrent());
      return { deleted };
    });
  }
  checkDeliverable(
    acceptance: Acceptance,
    serverReceipt: Receipt,
    limits: ContractLimits,
  ): void {
    this.checkPrepared(acceptance, limits);
    const binding = this.#bindingRow(
      acceptance.sender_id,
      acceptance.message.message_id,
    );
    const confirmed =
      binding.receipt === null
        ? null
        : (JSON.parse(binding.receipt) as Receipt);
    if (
      !confirmed ||
      confirmed.receipt_id !== serverReceipt.receipt_id ||
      confirmed.accepted_at !== serverReceipt.accepted_at ||
      serverReceipt.sender_id !== binding.owner_id ||
      serverReceipt.message_id !== binding.message_id ||
      serverReceipt.recipient_id !== binding.recipient_id ||
      serverReceipt.expires_at !== new Date(binding.expires_at).toISOString() ||
      !["pending", "leased"].includes(serverReceipt.state)
    )
      throw new RelayError("attachment_binding_unavailable");
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
