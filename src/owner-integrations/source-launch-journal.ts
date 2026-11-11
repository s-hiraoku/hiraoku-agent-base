/** Optional owner-local native launch deduplication. No model, transport, Task or owner acquisition. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, lstatSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, sourceKey, checkGuard } from "../adapter-policy/contract.ts";
import { comparisonMaterial, parseSubmission, validateLimits } from "../messaging/contract.ts";
import type { ContractLimits } from "../messaging/contract.ts";
import type { SQLiteInbox } from "../agent-sdk/sqlite-inbox.ts";
import type { RecipientAuthorization, MessageSource } from "../recipient-messages/contract.ts";

export class SourceLaunchError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export type SourceLaunchRecord = Readonly<{
  source: Readonly<MessageSource>;
  launch_id: string;
  claimed_at: number;
}>;
export type SourceLaunchOptions = {
  agent_id: string;
  /** Stable approved local policy identity; neither a credential nor a source of authority. */
  policy_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_records: number;
  inbox: SQLiteInbox;
  /** Existing trusted current recipient handoff/inspect policy. Default is denial. */
  authorization?: RecipientAuthorization;
  /** Check the already-held host and current lifecycle. Must be synchronous; never attach again. */
  checkOwner(): void;
};
const storedSchema = z.strictObject({
  source: sourceKey,
  launch_id: z.string().regex(/^sl_[a-f0-9]{32}$/),
  claimed_at: z.number().int().nonnegative(),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  authority_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
type Stored = z.infer<typeof storedSchema>;
const schema = `
CREATE TABLE source_launch_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,binding TEXT NOT NULL,
 record_count INTEGER NOT NULL,last_at INTEGER NOT NULL,seal TEXT NOT NULL);
CREATE TABLE source_launch_claims(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,launch_id TEXT NOT NULL UNIQUE,
 data TEXT NOT NULL CHECK(json_valid(data)),fingerprint TEXT NOT NULL,PRIMARY KEY(sender_id,message_id));
`;

/**
 * A committed claim reserves one possible native launch forever; it proves no native outcome.
 * Call claim BEFORE create/prompt. Only newly_claimed may begin a launch. Response loss,
 * restart and all existing claims prohibit another launch without separate reconciliation.
 * No automatic lease takeover, deletion, retry, budget reset or source/body forwarding exists.
 */
export class SQLiteSourceLaunchJournal {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #identity: { dev: number; ino: number };
  readonly #options: SourceLaunchOptions;
  #ready = false;
  #inside = false;
  #closed = false;
  #poisoned = false;
  constructor(path: string, options: SourceLaunchOptions) {
    try {
      id.parse(options.agent_id); id.parse(options.policy_id); validateLimits(options.limits);
      if (!isAbsolute(path) || !(options.fingerprint_key instanceof Uint8Array) ||
          options.fingerprint_key.length < 32 || options.fingerprint_key.length > 128 ||
          !Number.isSafeInteger(options.max_records) || options.max_records < 1 || options.max_records > 10000 ||
          options.inbox?.agentId !== options.agent_id || typeof options.inbox?.withEntry !== "function" ||
          typeof options.checkOwner !== "function" ||
          (options.authorization !== undefined && typeof options.authorization !== "function")) throw Error();
    } catch { throw new SourceLaunchError("invalid_source_launch_options"); }
    this.#path = path;
    this.#options = { ...options, fingerprint_key: Uint8Array.from(options.fingerprint_key),
      limits: Object.freeze({ envelope_bytes: options.limits.envelope_bytes, text_bytes: options.limits.text_bytes,
        data_bytes: options.limits.data_bytes, parts: options.limits.parts, json_depth: options.limits.json_depth,
        json_nodes: options.limits.json_nodes }) };
    let db: DatabaseSync | undefined;
    try {
      try {
        const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        closeSync(fd);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.nlink !== 1) throw Error();
      this.#identity = { dev: stat.dev, ino: stat.ino };
      db = new DatabaseSync(path, { timeout: 1000 });
      db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON");
      this.#db = db;
    } catch { db?.close(); throw new SourceLaunchError("source_launch_unavailable"); }
  }
  get agentId() { return this.#options.agent_id; }
  #context() {
    return { agent_id: this.agentId, policy_id: this.#options.policy_id,
      limits: this.#options.limits, max_records: this.#options.max_records };
  }
  #hash(domain: string, value: unknown) {
    return createHmac("sha256", this.#options.fingerprint_key).update(domain + "\0")
      .update(JSON.stringify([this.#context(), value])).digest("hex");
  }
  #binding() { return this.#hash("binding-v1", null); }
  #membership() {
    return this.#db.prepare("SELECT sender_id,message_id,launch_id,fingerprint FROM source_launch_claims ORDER BY sender_id,message_id")
      .all().map(row => [row.sender_id, row.message_id, row.launch_id, row.fingerprint]);
  }
  #file() {
    if (this.#closed || this.#poisoned) throw new SourceLaunchError("source_launch_unavailable");
    const s = lstatSync(this.#path);
    if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.nlink !== 1 ||
        s.dev !== this.#identity.dev || s.ino !== this.#identity.ino) throw new SourceLaunchError("source_launch_identity_changed");
  }
  #schema() {
    const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
    const expected = schema.split(";").map(sql => sql.trim()).filter(Boolean);
    const rows = this.#db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (rows.length !== expected.length || rows.some(row => row.type !== "table" || row.tbl_name !== row.name ||
        typeof row.sql !== "string" || !expected.some(sql => normalize(sql) === normalize(String(row.sql)))))
      throw new SourceLaunchError("unsupported_source_launch_schema");
  }
  #tx<T>(check: () => void, action: () => T): T {
    let began = false;
    if (this.#inside) throw new SourceLaunchError("source_launch_busy");
    this.#inside = true;
    try {
      this.#file(); checkGuard(check);
      this.#db.exec("BEGIN IMMEDIATE"); began = true;
      const value = action();
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {}); throw Error();
      }
      this.#file(); checkGuard(check); this.#schema();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try { this.#db.exec("ROLLBACK"); }
        catch { this.#poisoned = true; this.#ready = false; throw new SourceLaunchError("source_launch_unavailable"); }
      }
      if (error instanceof SourceLaunchError) throw error;
      throw new SourceLaunchError("source_launch_unavailable");
    } finally { this.#inside = false; }
  }
  #read(): { records: Stored[]; last_at: number } {
    if (!this.#ready) throw new SourceLaunchError("source_launch_not_migrated");
    this.#schema();
    const meta = this.#db.prepare("SELECT * FROM source_launch_meta").all();
    const m = meta[0];
    if (meta.length !== 1 || m.id !== 1 || m.version !== 1 || m.binding !== this.#binding())
      throw new SourceLaunchError("source_launch_binding_mismatch");
    const count = Number(this.#db.prepare("SELECT count(*) n FROM source_launch_claims").get()!.n);
    if (!Number.isSafeInteger(m.last_at) || Number(m.last_at) < 0 || count !== m.record_count ||
        count > this.#options.max_records)
      throw new SourceLaunchError("source_launch_integrity_failed");
    if (m.seal !== this.#hash("meta-v1", [count, m.last_at, this.#membership()]))
      throw new SourceLaunchError("source_launch_integrity_failed");
    const rows = this.#db.prepare("SELECT * FROM source_launch_claims ORDER BY sender_id,message_id").all();
    const records = rows.map(row => {
      try {
        if (typeof row.data !== "string" || row.data.length > 2048 || row.fingerprint !== this.#hash("record-v1", row.data)) throw Error();
        const r = storedSchema.parse(JSON.parse(row.data));
        if (r.source.sender_id !== row.sender_id || r.source.message_id !== row.message_id ||
            r.launch_id !== row.launch_id || r.claimed_at > Number(m.last_at)) throw Error();
        return r;
      } catch { throw new SourceLaunchError("source_launch_integrity_failed"); }
    });
    return { records, last_at: Number(m.last_at) };
  }
  #guard(context: unknown, operation: "handoff" | "inspect", source: MessageSource) {
    const resolve = () => {
      try {
        checkGuard(this.#options.checkOwner);
        const v = this.#options.authorization?.(context, operation, Object.freeze({ ...source }));
        if (v && typeof v === "object" && "then" in v) { void Promise.resolve(v).catch(() => {}); throw Error(); }
        if (!v || v.agent_id !== this.agentId) throw Error();
        const authority = JSON.stringify([id.parse(v.actor_id), id.parse(v.authority_epoch)]);
        checkGuard(this.#options.checkOwner);
        return authority;
      } catch { throw new SourceLaunchError("source_launch_forbidden"); }
    };
    const authority = resolve();
    return { authority, check: () => { if (resolve() !== authority) throw new SourceLaunchError("source_launch_forbidden"); } };
  }
  #public(record: Stored): SourceLaunchRecord {
    return Object.freeze({ source: Object.freeze({ ...record.source }), launch_id: record.launch_id, claimed_at: record.claimed_at });
  }
  migrate() {
    this.#ready = false;
    try { this.#tx(() => checkGuard(this.#options.checkOwner), () => {
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (tables.length === 0) {
        this.#db.exec(schema);
        this.#db.prepare("INSERT INTO source_launch_meta VALUES(1,1,?,0,0,?)").run(this.#binding(), this.#hash("meta-v1", [0, 0, []]));
      } else if (tables.length !== 2 || !tables.every(t => ["source_launch_meta", "source_launch_claims"].includes(String(t.name))))
        throw new SourceLaunchError("unsupported_source_launch_schema");
      this.#ready = true;
      this.#read();
    }); } catch (error) { this.#ready = false; throw error; }
  }
  inspect(context: unknown, input: MessageSource): SourceLaunchRecord | null {
    const source = sourceKey.parse(input), guard = this.#guard(context, "inspect", source);
    return this.#tx(guard.check, () => {
      const record = this.#read().records.find(r => r.source.sender_id === source.sender_id && r.source.message_id === source.message_id);
      return record ? this.#public(record) : null;
    });
  }
  claim(context: unknown, input: MessageSource): Readonly<{ newly_claimed: boolean; record: SourceLaunchRecord }> {
    const source = sourceKey.parse(input), guard = this.#guard(context, "handoff", source);
    const existing = this.#tx(guard.check, () => this.#read().records.find(r =>
      r.source.sender_id === source.sender_id && r.source.message_id === source.message_id));
    if (existing) return Object.freeze({ newly_claimed: false, record: this.#public(existing) });
    return this.#options.inbox.withEntry(source.sender_id, source.message_id, entry => {
      guard.check();
      const message = parseSubmission(entry.message, this.#options.limits);
      if (!entry.receipt_confirmed || entry.sender_id !== source.sender_id || message.message_id !== source.message_id ||
          message.recipient_id !== this.agentId || message.kind !== "question" || message.in_reply_to !== null ||
          message.body.parts.some(part => part.type !== "text")) throw new SourceLaunchError("invalid_source_launch_question");
      return this.#tx(guard.check, () => {
        const { records, last_at } = this.#read();
        const found = records.find(r => r.source.sender_id === source.sender_id && r.source.message_id === source.message_id);
        if (found) return Object.freeze({ newly_claimed: false, record: this.#public(found) });
        if (records.length >= this.#options.max_records) throw new SourceLaunchError("source_launch_capacity_exceeded");
        const now = Number(this.#db.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at").get()!.at);
        if (!Number.isSafeInteger(now) || now < last_at) throw new SourceLaunchError("source_launch_clock_regressed");
        const record: Stored = { source, launch_id: `sl_${randomUUID().replaceAll("-", "")}`, claimed_at: now,
          source_fingerprint: this.#hash("source-v1", comparisonMaterial(source.sender_id, message, this.#options.limits)),
          authority_fingerprint: this.#hash("authority-v1", guard.authority) };
        const data = JSON.stringify(record);
        const inserted = this.#db.prepare("INSERT INTO source_launch_claims VALUES(?,?,?,?,?)").run(source.sender_id, source.message_id,
          record.launch_id, data, this.#hash("record-v1", data));
        if (Number(inserted.changes) !== 1) throw new SourceLaunchError("source_launch_integrity_failed");
        const sealed = this.#db.prepare("UPDATE source_launch_meta SET record_count=?,last_at=?,seal=? WHERE id=1")
          .run(records.length + 1, now, this.#hash("meta-v1", [records.length + 1, now, this.#membership()]));
        if (Number(sealed.changes) !== 1 || !this.#read().records.some(r => r.launch_id === record.launch_id))
          throw new SourceLaunchError("source_launch_integrity_failed");
        return Object.freeze({ newly_claimed: true, record: this.#public(record) });
      });
    });
  }
  close() {
    if (this.#closed) return;
    if (this.#inside) throw new SourceLaunchError("source_launch_busy");
    this.#closed = true; this.#ready = false;
    try { this.#db.close(); } finally { this.#options.fingerprint_key.fill(0); }
  }
}
