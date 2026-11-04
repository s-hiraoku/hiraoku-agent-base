import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical } from "./protocol.ts";
export interface TextJournalOptions {
  binding: string;
  fingerprintKey: Uint8Array;
  maxRecords: number;
  maxBytes: number;
}
export interface TextJournalEntry {
  id: string;
  version: number;
  data: unknown;
}
export class TextNatsJournal {
  readonly #db: DatabaseSync;
  readonly #options: TextJournalOptions;
  #transaction = false;
  #failed = false;
  constructor(path: string, options: TextJournalOptions) {
    if (
      !options.binding ||
      !(options.fingerprintKey instanceof Uint8Array) ||
      options.fingerprintKey.length < 32 ||
      !Number.isSafeInteger(options.maxRecords) ||
      options.maxRecords < 1 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1
    )
      throw Error("invalid_text_journal_options");
    this.#options = {
      ...options,
      fingerprintKey: new Uint8Array(options.fingerprintKey),
    };
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const s = fstatSync(fd);
      if (
        !s.isFile() ||
        s.mode & 0o077 ||
        (process.getuid && s.uid !== process.getuid())
      )
        throw Error("private_text_journal_required");
    } finally {
      closeSync(fd);
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
      );
      this.transaction(() => {
        const tables = this.#db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (
          tables.some(
            (row) =>
              !["generic_nats_meta", "generic_nats_records"].includes(
                String(row.name),
              ),
          )
        )
          throw Error("foreign_text_journal_database");
        this.#db.exec(
          "CREATE TABLE IF NOT EXISTS generic_nats_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,binding TEXT NOT NULL,key_check TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generic_nats_records(bucket TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,mac TEXT NOT NULL,PRIMARY KEY(bucket,id))",
        );
        const meta = this.#db
          .prepare("SELECT * FROM generic_nats_meta WHERE id=1")
          .get();
        const keyCheck = this.#mac("key-check");
        if (meta) {
          if (
            meta.version !== 1 ||
            meta.binding !== options.binding ||
            meta.key_check !== keyCheck
          )
            throw Error("text_journal_binding_mismatch");
        } else
          this.#db
            .prepare("INSERT INTO generic_nats_meta VALUES(1,1,?,?)")
            .run(options.binding, keyCheck);
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #mac(value: string): string {
    return createHmac("sha256", this.#options.fingerprintKey)
      .update(value)
      .digest("hex");
  }
  #names(bucket: string, id: string) {
    if (
      !/^[a-z_]{1,32}$/.test(bucket) ||
      typeof id !== "string" ||
      !id.length ||
      id.length > 200
    )
      throw Error("invalid_text_record_key");
  }
  #decode(bucket: string, row: Record<string, unknown>): TextJournalEntry {
    const id = String(row.id),
      version = Number(row.version),
      data = String(row.data),
      mac = String(row.mac);
    const expected = this.#mac(canonical([bucket, id, version, data]));
    if (
      !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))
    )
      throw Error("text_journal_corrupt");
    return { id, version, data: JSON.parse(data) };
  }
  entry(bucket: string, id: string): TextJournalEntry | null {
    this.#names(bucket, id);
    const row = this.#db
      .prepare("SELECT * FROM generic_nats_records WHERE bucket=? AND id=?")
      .get(bucket, id);
    return row ? this.#decode(bucket, row) : null;
  }
  list(bucket: string, limit = 32): TextJournalEntry[] {
    this.#names(bucket, "scan");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw Error("invalid_text_scan_limit");
    return this.#db
      .prepare(
        "SELECT * FROM generic_nats_records WHERE bucket=? ORDER BY rowid LIMIT ?",
      )
      .all(bucket, limit)
      .map((row) => this.#decode(bucket, row));
  }
  #invoke<T>(work: () => T): T {
    if (work.constructor.name === "AsyncFunction")
      throw Error("async_text_journal_transaction");
    const result = work();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    ) {
      void Promise.resolve(result).catch(() => {});
      throw Error("async_text_journal_transaction");
    }
    return result;
  }
  transaction<T>(work: () => T): T {
    if (this.#transaction) {
      try {
        return this.#invoke(work);
      } catch (error) {
        this.#failed = true;
        throw error;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transaction = true;
    this.#failed = false;
    try {
      const result = this.#invoke(work);
      if (this.#failed) throw Error("text_journal_transaction_failed");
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transaction = false;
      this.#failed = false;
    }
  }

  insert(bucket: string, id: string, data: unknown): void {
    this.transaction(() => {
      this.#names(bucket, id);
      const old = this.entry(bucket, id);
      if (old) {
        if (canonical(old.data) !== canonical(data))
          throw Error("text_record_conflict");
        return;
      }
      const text = canonical(data),
        mac = this.#mac(canonical([bucket, id, 1, text]));
      this.#db
        .prepare("INSERT INTO generic_nats_records VALUES(?,?,1,?,?)")
        .run(bucket, id, text, mac);
      this.#capacity();
    });
  }
  set(bucket: string, id: string, data: unknown, version: number): boolean {
    return this.transaction(() => {
      const old = this.entry(bucket, id);
      if (!old || old.version !== version) return false;
      const text = canonical(data),
        next = version + 1,
        mac = this.#mac(canonical([bucket, id, next, text]));
      const changed = this.#db
        .prepare(
          "UPDATE generic_nats_records SET version=?,data=?,mac=? WHERE bucket=? AND id=? AND version=?",
        )
        .run(next, text, mac, bucket, id, version).changes;
      this.#capacity();
      return changed === 1;
    });
  }
  #capacity() {
    const row = this.#db
      .prepare(
        "SELECT count(*) AS records,coalesce(sum(length(cast(data AS blob))),0) AS bytes FROM generic_nats_records",
      )
      .get()!;
    if (
      Number(row.records) > this.#options.maxRecords ||
      Number(row.bytes) > this.#options.maxBytes
    )
      throw Error("text_journal_capacity");
  }
  close() {
    this.#db.close();
  }
}
