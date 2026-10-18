/** Private SQLite receiver BLOB journal, separate from server uploads and ordinary inbox SQL. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { openSync, fstatSync, closeSync, constants } from "node:fs";
import { RelayError } from "./service.ts";
import {
  comparisonMaterial,
  validateLimits,
  RECORD_RETENTION_MS,
} from "./contract.ts";
import type { Submission, ContractLimits } from "./contract.ts";
import { parseAttachmentMessage } from "./attachment-bindings.ts";
import { uploadIdentifier } from "./attachments.ts";
import type { AttachmentPart } from "./attachments.ts";
import type { AttachmentChunk } from "./attachment-read.ts";
import type {
  AttachmentInboxState,
  AttachmentInboxSnapshot,
  AttachmentInboxStore,
} from "./attachment-inbox.ts";
export interface AttachmentInboxOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  chunk_bytes: number;
  max_attachment_bytes: number;
  max_records: number;
  max_live_bytes: number;
  max_clock_skew_ms: number;
  busy_timeout_ms: number;
}
type Row = {
  sender_id: string;
  message_id: string;
  fingerprint: string;
  expires_at: number;
  state: AttachmentInboxState;
  created_at: number;
  file_count: number;
  terminal_at: number | null;
  retain_until: number | null;
};
type File = {
  sender_id: string;
  message_id: string;
  attachment_id: string;
  ordinal: number;
  manifest: string;
  fingerprint: string;
  size_bytes: number;
  received_bytes: number;
};
const schema = `
CREATE TABLE attachment_inbox_meta(version INTEGER NOT NULL,agent_id TEXT NOT NULL,key_check TEXT NOT NULL,chunk_bytes INTEGER NOT NULL);
CREATE TABLE attachment_inbox_messages(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('receiving','verified','released','rejected','expired')),file_count INTEGER NOT NULL CHECK(file_count BETWEEN 1 AND 64),created_at INTEGER NOT NULL,verified_at INTEGER,terminal_at INTEGER,retain_until INTEGER,PRIMARY KEY(sender_id,message_id));
CREATE TABLE attachment_inbox_files(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,attachment_id TEXT NOT NULL,ordinal INTEGER NOT NULL,manifest TEXT NOT NULL,fingerprint TEXT NOT NULL,size_bytes INTEGER NOT NULL,received_bytes INTEGER NOT NULL DEFAULT 0 CHECK(received_bytes>=0 AND received_bytes<=size_bytes),PRIMARY KEY(sender_id,message_id,attachment_id),UNIQUE(sender_id,message_id,ordinal),FOREIGN KEY(sender_id,message_id) REFERENCES attachment_inbox_messages);
CREATE TABLE attachment_inbox_chunks(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,attachment_id TEXT NOT NULL,offset INTEGER NOT NULL CHECK(offset>=0),fingerprint TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(sender_id,message_id,attachment_id,offset),FOREIGN KEY(sender_id,message_id,attachment_id) REFERENCES attachment_inbox_files);
CREATE INDEX attachment_inbox_gc ON attachment_inbox_messages(state,expires_at,retain_until);
CREATE TRIGGER attachment_inbox_identity BEFORE UPDATE OF sender_id,message_id,fingerprint,expires_at,created_at,file_count ON attachment_inbox_messages BEGIN SELECT RAISE(ABORT,'immutable');END;
CREATE TRIGGER attachment_inbox_terminal BEFORE UPDATE ON attachment_inbox_messages WHEN OLD.state IN ('released','rejected','expired') OR OLD.state='verified' AND NEW.state='receiving' BEGIN SELECT RAISE(ABORT,'terminal');END;
CREATE TRIGGER attachment_inbox_manifest BEFORE UPDATE OF sender_id,message_id,attachment_id,ordinal,manifest,fingerprint,size_bytes ON attachment_inbox_files BEGIN SELECT RAISE(ABORT,'immutable');END;
`;
const errors = new Set([
  "attachment_inbox_not_ready",
  "attachment_inbox_not_found",
  "attachment_inbox_busy",
  "attachment_inbox_conflict",
  "attachment_inbox_capacity",
  "attachment_inbox_closed",
  "attachment_inbox_incomplete",
  "attachment_inbox_integrity",
  "invalid_attachment_chunk",
  "foreign_delivery",
  "expired_delivery",
  "clock_skew",
  "attachment_inbox_unverified",
  "unsupported_attachment_inbox_schema",
  "unknown_attachment_inbox_schema",
  "attachment_inbox_identity_mismatch",
]);
export class SQLiteAttachmentInbox implements AttachmentInboxStore {
  readonly #db: DatabaseSync;
  readonly #options: AttachmentInboxOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: AttachmentInboxOptions) {
    try {
      validateLimits(options.limits);
      uploadIdentifier(options.agent_id);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128
      )
        throw Error();
      for (const k of [
        "chunk_bytes",
        "max_attachment_bytes",
        "max_records",
        "max_live_bytes",
        "busy_timeout_ms",
      ] as const)
        if (!Number.isSafeInteger(options[k]) || options[k] < 1) throw Error();
      if (
        options.chunk_bytes > 1048576 ||
        options.max_attachment_bytes > 268435456 ||
        Math.ceil(options.max_attachment_bytes / options.chunk_bytes) > 1024 ||
        options.max_records > 1000000 ||
        options.max_live_bytes > 1099511627776 ||
        options.busy_timeout_ms > 1000 ||
        !Number.isSafeInteger(options.max_clock_skew_ms) ||
        options.max_clock_skew_ms < 0 ||
        options.max_clock_skew_ms > 60000
      )
        throw Error();
    } catch {
      throw new RelayError("invalid_attachment_inbox_options");
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
          const file = fstatSync(fd);
          if (!file.isFile() || file.mode & 0o077) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path);
      db.exec(
        `PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;PRAGMA busy_timeout=${options.busy_timeout_ms}`,
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new RelayError("attachment_inbox_unavailable");
    }
  }
  #tx<T>(action: () => T): T {
    if (this.#inside) throw new RelayError("attachment_inbox_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("attachment_inbox_unverified");
      }
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (began)
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
        }
      if (error instanceof RelayError && errors.has(error.code)) throw error;
      throw new RelayError("attachment_inbox_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #hash(domain: string, data: string | Uint8Array) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(data)
      .digest("hex");
  }
  #now() {
    if (!this.#ready) throw new RelayError("attachment_inbox_not_ready");
    const now = Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) n")
        .get()!.n,
    );
    if (!Number.isSafeInteger(now))
      throw new RelayError("attachment_inbox_unavailable");
    return now;
  }
  migrate(): void {
    this.#ready = false;
    this.#tx(() => {
      const key = createHash("sha256")
        .update(this.#options.fingerprint_key)
        .digest("hex");
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='attachment_inbox_meta'",
          )
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new RelayError("unknown_attachment_inbox_schema");
        this.#db.exec(schema);
        this.#db
          .prepare("INSERT INTO attachment_inbox_meta VALUES(1,?,?,?)")
          .run(this.#options.agent_id, key, this.#options.chunk_bytes);
      }
      const rows = this.#db
        .prepare("SELECT * FROM attachment_inbox_meta")
        .all();
      if (rows.length !== 1 || rows[0].version !== 1)
        throw new RelayError("unsupported_attachment_inbox_schema");
      if (
        rows[0].agent_id !== this.#options.agent_id ||
        rows[0].key_check !== key ||
        rows[0].chunk_bytes !== this.#options.chunk_bytes
      )
        throw new RelayError("attachment_inbox_identity_mismatch");
      this.#db
        .prepare(
          "SELECT sender_id,message_id FROM attachment_inbox_messages LIMIT 0",
        )
        .all();
      this.#db
        .prepare("SELECT attachment_id FROM attachment_inbox_files LIMIT 0")
        .all();
      this.#db
        .prepare("SELECT offset FROM attachment_inbox_chunks LIMIT 0")
        .all();
    });
    this.#ready = true;
  }
  #row(sender: string, id: string): Row {
    uploadIdentifier(sender);
    uploadIdentifier(id);
    const row = this.#db
      .prepare(
        "SELECT * FROM attachment_inbox_messages WHERE sender_id=? AND message_id=?",
      )
      .get(sender, id) as Row | undefined;
    if (!row) throw new RelayError("attachment_inbox_not_found");
    return row;
  }
  #files(row: Row): File[] {
    return this.#db
      .prepare(
        "SELECT * FROM attachment_inbox_files WHERE sender_id=? AND message_id=? ORDER BY ordinal",
      )
      .all(row.sender_id, row.message_id) as File[];
  }
  #part(file: File): AttachmentPart {
    if (this.#hash("manifest", file.manifest) !== file.fingerprint)
      throw new RelayError("attachment_inbox_integrity");
    const part = JSON.parse(file.manifest) as AttachmentPart;
    if (
      part.attachment_id !== file.attachment_id ||
      part.size_bytes !== file.size_bytes ||
      !Number.isSafeInteger(file.received_bytes) ||
      file.received_bytes < 0 ||
      file.received_bytes > file.size_bytes
    )
      throw new RelayError("attachment_inbox_integrity");
    return part;
  }
  #snapshot(row: Row): AttachmentInboxSnapshot {
    const files = this.#files(row);
    if (
      !files.length ||
      files.length !== row.file_count ||
      files.some((f, i) => f.ordinal !== i)
    )
      throw new RelayError("attachment_inbox_integrity");
    return {
      sender_id: row.sender_id,
      message_id: row.message_id,
      recipient_id: this.#options.agent_id,
      expires_at: new Date(row.expires_at).toISOString(),
      state: row.state,
      files: files.map((f) => ({
        ...this.#part(f),
        next_offset: f.received_bytes,
        chunk_bytes: this.#options.chunk_bytes,
      })),
    };
  }
  prepare(sender: string, input: Submission): AttachmentInboxSnapshot {
    const message = parseAttachmentMessage(input, this.#options.limits);
    uploadIdentifier(sender);
    if (message.recipient_id !== this.#options.agent_id)
      throw new RelayError("foreign_delivery");
    return this.#tx(() => {
      const now = this.#now(),
        fingerprint = this.#hash(
          "message",
          comparisonMaterial(sender, message, this.#options.limits),
        );
      const old = this.#db
        .prepare(
          "SELECT * FROM attachment_inbox_messages WHERE sender_id=? AND message_id=?",
        )
        .get(sender, message.message_id) as Row | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new RelayError("attachment_inbox_conflict");
        return this.#snapshot(old);
      }
      if (Date.parse(message.expires_at) <= now)
        throw new RelayError("expired_delivery");
      if (
        Date.parse(message.first_sent_at) >
        now + this.#options.max_clock_skew_ms
      )
        throw new RelayError("clock_skew");
      const parts = message.body.parts.filter((p) => p.type === "attachment"),
        size = parts.reduce((n, p) => n + p.size_bytes, 0);
      if (parts.some((p) => p.size_bytes > this.#options.max_attachment_bytes))
        throw new RelayError("attachment_inbox_capacity");
      const count = Number(
        this.#db
          .prepare("SELECT count(*) n FROM attachment_inbox_messages")
          .get()!.n,
      );
      const live = Number(
        this.#db
          .prepare(
            "SELECT coalesce(sum(f.size_bytes),0) n FROM attachment_inbox_files f JOIN attachment_inbox_messages m USING(sender_id,message_id) WHERE m.state IN ('receiving','verified')",
          )
          .get()!.n,
      );
      if (
        count >= this.#options.max_records ||
        live + size > this.#options.max_live_bytes
      )
        throw new RelayError("attachment_inbox_capacity");
      this.#db
        .prepare(
          "INSERT INTO attachment_inbox_messages(sender_id,message_id,fingerprint,expires_at,state,file_count,created_at) VALUES(?,?,?,?,'receiving',?,?)",
        )
        .run(
          sender,
          message.message_id,
          fingerprint,
          Date.parse(message.expires_at),
          parts.length,
          now,
        );
      parts.forEach((part, ordinal) => {
        const manifest = JSON.stringify(part);
        this.#db
          .prepare("INSERT INTO attachment_inbox_files VALUES(?,?,?,?,?,?,?,0)")
          .run(
            sender,
            message.message_id,
            part.attachment_id,
            ordinal,
            manifest,
            this.#hash("manifest", manifest),
            part.size_bytes,
          );
      });
      if (Date.parse(message.expires_at) <= this.#now())
        throw new RelayError("expired_delivery");
      return this.#snapshot(this.#row(sender, message.message_id));
    });
  }
  status(sender: string, id: string): AttachmentInboxSnapshot {
    return this.#tx(() => {
      this.#now();
      return this.#snapshot(this.#row(sender, id));
    });
  }
  #open(row: Row) {
    if (row.state !== "receiving" && row.state !== "verified")
      throw new RelayError("attachment_inbox_closed");
    if (row.state === "receiving" && row.expires_at <= this.#now())
      throw new RelayError("expired_delivery");
  }
  #chunk(file: File, offset: number): Uint8Array {
    const chunk = this.#db
      .prepare(
        "SELECT length(data) bytes,substr(data,1,?) data,fingerprint FROM attachment_inbox_chunks WHERE sender_id=? AND message_id=? AND attachment_id=? AND offset=?",
      )
      .get(
        this.#options.chunk_bytes + 1,
        file.sender_id,
        file.message_id,
        file.attachment_id,
        offset,
      );
    if (
      !chunk ||
      !(chunk.data instanceof Uint8Array) ||
      chunk.bytes !== chunk.data.byteLength ||
      chunk.data.byteLength !==
        Math.min(this.#options.chunk_bytes, file.size_bytes - offset) ||
      this.#hash("chunk", chunk.data) !== chunk.fingerprint
    )
      throw new RelayError("attachment_inbox_integrity");
    return Uint8Array.from(chunk.data);
  }
  put(
    sender: string,
    id: string,
    input: AttachmentChunk,
  ): AttachmentInboxSnapshot {
    // Copy only a strictly bounded data field after validating own data descriptors.
    let packet: AttachmentChunk;
    try {
      if (
        !input ||
        typeof input !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw Error();
      const keys = [
          "version",
          "sender_id",
          "recipient_id",
          "message_id",
          "attachment_id",
          "expires_at",
          "media_type",
          "size_bytes",
          "sha256",
          "offset",
          "next_offset",
          "chunk_bytes",
          "eof",
          "data",
        ],
        ds = Object.getOwnPropertyDescriptors(input);
      if (
        Reflect.ownKeys(input).some(
          (k) =>
            typeof k !== "string" ||
            !keys.concat("filename").includes(k) ||
            !("value" in ds[k]) ||
            !ds[k].enumerable,
        ) ||
        keys.some((k) => !Object.hasOwn(ds, k)) ||
        !(input.data instanceof Uint8Array) ||
        input.data.length > this.#options.chunk_bytes
      )
        throw Error();
      packet = { ...input, data: Uint8Array.from(input.data) };
    } catch {
      throw new RelayError("invalid_attachment_chunk");
    }
    return this.#tx(() => {
      this.#now();
      const row = this.#row(sender, id);
      this.#open(row);
      const file = this.#files(row).find(
        (f) => f.attachment_id === packet.attachment_id,
      );
      if (!file) throw new RelayError("invalid_attachment_chunk");
      const { type: _type, attachment_id: _id, ...manifest } = this.#part(file);
      void _type;
      void _id;
      const { media_type, size_bytes, sha256, filename } = packet;
      const descriptor = {
        media_type,
        size_bytes,
        sha256,
        ...(filename === undefined ? {} : { filename }),
      };
      if (
        packet.version !== 1 ||
        packet.sender_id !== sender ||
        packet.message_id !== id ||
        packet.recipient_id !== this.#options.agent_id ||
        packet.expires_at !== new Date(row.expires_at).toISOString() ||
        JSON.stringify(descriptor) !== JSON.stringify(manifest) ||
        packet.chunk_bytes !== this.#options.chunk_bytes ||
        !Number.isSafeInteger(packet.offset) ||
        packet.offset < 0 ||
        packet.offset > file.size_bytes ||
        (packet.offset !== file.size_bytes &&
          packet.offset % packet.chunk_bytes !== 0) ||
        packet.data.length !==
          Math.min(packet.chunk_bytes, file.size_bytes - packet.offset) ||
        packet.next_offset !== packet.offset + packet.data.length ||
        packet.eof !== (packet.next_offset === file.size_bytes)
      )
        throw new RelayError("invalid_attachment_chunk");
      if (packet.offset < file.received_bytes) {
        const old = this.#chunk(file, packet.offset);
        if (this.#hash("chunk", old) !== this.#hash("chunk", packet.data))
          throw new RelayError("attachment_inbox_conflict");
        return this.#snapshot(row);
      }
      if (packet.offset !== file.received_bytes)
        throw new RelayError("invalid_attachment_chunk");
      if (packet.data.length) {
        if (row.state !== "receiving")
          throw new RelayError("attachment_inbox_closed");
        this.#db
          .prepare("INSERT INTO attachment_inbox_chunks VALUES(?,?,?,?,?,?)")
          .run(
            sender,
            id,
            file.attachment_id,
            packet.offset,
            this.#hash("chunk", packet.data),
            packet.data,
          );
        this.#db
          .prepare(
            "UPDATE attachment_inbox_files SET received_bytes=received_bytes+? WHERE sender_id=? AND message_id=? AND attachment_id=?",
          )
          .run(packet.data.length, sender, id, file.attachment_id);
      }
      if (row.state === "receiving" && row.expires_at <= this.#now())
        throw new RelayError("expired_delivery");
      return this.#snapshot(row);
    });
  }
  #scan(row: Row): void {
    const files = this.#files(row);
    if (
      !files.length ||
      files.length !== row.file_count ||
      files.some((f, i) => f.ordinal !== i)
    )
      throw new RelayError("attachment_inbox_integrity");
    for (const file of files) {
      const part = this.#part(file);
      if (file.received_bytes !== file.size_bytes)
        throw new RelayError("attachment_inbox_incomplete");
      const digest = createHash("sha256");
      let offset = 0;
      for (; offset < file.size_bytes; offset += this.#options.chunk_bytes)
        digest.update(this.#chunk(file, offset));
      if (digest.digest("hex") !== part.sha256)
        throw new RelayError("attachment_inbox_integrity");
    }
  }
  #terminal(row: Row, state: "released" | "rejected" | "expired"): Row {
    const now = this.#now();
    this.#db
      .prepare(
        "DELETE FROM attachment_inbox_chunks WHERE sender_id=? AND message_id=?",
      )
      .run(row.sender_id, row.message_id);
    this.#db
      .prepare(
        "UPDATE attachment_inbox_messages SET state=?,terminal_at=?,retain_until=? WHERE sender_id=? AND message_id=?",
      )
      .run(
        state,
        now,
        Math.max(now, row.expires_at) + RECORD_RETENTION_MS,
        row.sender_id,
        row.message_id,
      );
    return this.#row(row.sender_id, row.message_id);
  }
  verify(sender: string, id: string): AttachmentInboxSnapshot {
    return this.#tx(() => {
      this.#now();
      let row = this.#row(sender, id);
      this.#open(row);
      try {
        this.#scan(row);
      } catch (error) {
        if (
          error instanceof RelayError &&
          error.code === "attachment_inbox_integrity"
        )
          return this.#snapshot(this.#terminal(row, "rejected"));
        throw error;
      }
      if (row.state === "receiving") {
        if (row.expires_at <= this.#now())
          throw new RelayError("expired_delivery");
        this.#db
          .prepare(
            "UPDATE attachment_inbox_messages SET state='verified',verified_at=? WHERE sender_id=? AND message_id=?",
          )
          .run(this.#now(), sender, id);
      }
      row = this.#row(sender, id);
      return this.#snapshot(row);
    });
  }
  withVerified<T>(sender: string, input: Submission, action: () => T): T {
    const message = parseAttachmentMessage(input, this.#options.limits);
    return this.#tx(() => {
      this.#now();
      const row = this.#row(sender, message.message_id);
      if (
        message.recipient_id !== this.#options.agent_id ||
        this.#hash(
          "message",
          comparisonMaterial(sender, message, this.#options.limits),
        ) !== row.fingerprint
      )
        throw new RelayError("attachment_inbox_conflict");
      if (row.state !== "verified")
        throw new RelayError("attachment_inbox_unverified");
      const parts = message.body.parts.filter((p) => p.type === "attachment");
      if (
        JSON.stringify(parts) !==
        JSON.stringify(this.#files(row).map((f) => this.#part(f)))
      )
        throw new RelayError("attachment_inbox_integrity");
      this.#scan(row);
      return action();
    });
  }
  read(
    sender: string,
    id: string,
    attachmentId: string,
    offset: number,
  ): Uint8Array {
    return this.#tx(() => {
      this.#now();
      const row = this.#row(sender, id);
      if (row.state !== "verified")
        throw new RelayError("attachment_inbox_unverified");
      const file = this.#files(row).find(
        (f) => f.attachment_id === attachmentId,
      );
      if (
        !file ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > file.size_bytes ||
        (offset !== file.size_bytes && offset % this.#options.chunk_bytes !== 0)
      )
        throw new RelayError("invalid_attachment_chunk");
      this.#part(file);
      return offset === file.size_bytes
        ? new Uint8Array()
        : this.#chunk(file, offset);
    });
  }
  /** Host confirms durable application handoff; never automatic on server expiry. */
  release(sender: string, id: string): boolean {
    return this.#tx(() => {
      this.#now();
      const row = this.#row(sender, id);
      if (row.state === "released") return false;
      if (row.state !== "verified")
        throw new RelayError("attachment_inbox_unverified");
      this.#terminal(row, "released");
      return true;
    });
  }
  maintain(limit: number): { expired: number; purged: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RelayError("invalid_attachment_inbox_limit");
    return this.#tx(() => {
      const now = this.#now(),
        expired = this.#db
          .prepare(
            "SELECT * FROM attachment_inbox_messages WHERE state='receiving' AND expires_at<=? ORDER BY expires_at LIMIT ?",
          )
          .all(now, limit) as Row[];
      for (const row of expired) this.#terminal(row, "expired");
      const doomed = this.#db
        .prepare(
          "SELECT sender_id,message_id FROM attachment_inbox_messages WHERE state IN ('released','rejected','expired') AND retain_until<=? AND terminal_at+?<=? AND expires_at+?<=? ORDER BY retain_until LIMIT ?",
        )
        .all(
          now,
          RECORD_RETENTION_MS,
          now,
          RECORD_RETENTION_MS,
          now,
          limit - expired.length,
        );
      for (const row of doomed) {
        this.#db
          .prepare(
            "DELETE FROM attachment_inbox_files WHERE sender_id=? AND message_id=?",
          )
          .run(row.sender_id!, row.message_id!);
        this.#db
          .prepare(
            "DELETE FROM attachment_inbox_messages WHERE sender_id=? AND message_id=?",
          )
          .run(row.sender_id!, row.message_id!);
      }
      return { expired: expired.length, purged: doomed.length };
    });
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
