import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { z } from "zod";
import {
  bindingSchema,
  identifier,
  keySchema,
  taskEvidence,
  taskSchema,
  TaskBridgeError,
} from "../task-bridge/contract.ts";
import type {
  SourceKey,
  TaskBinding,
  TaskEvidence,
} from "../task-bridge/contract.ts";

export interface SubmissionReceipts {
  readonly receiverId: string;
  readonly binding: Readonly<TaskBinding>;
  prepare(source: SourceKey, requestKey: string): void;
  read(source: SourceKey, requestKey: string): TaskEvidence | undefined;
  record(source: SourceKey, requestKey: string, task: TaskEvidence): void;
}
const receiptSchema = z.strictObject({
  source: keySchema,
  request_key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  task: taskSchema.nullable(),
});

export class SQLiteSubmissionReceipts implements SubmissionReceipts {
  readonly receiverId: string;
  readonly #db: DatabaseSync;
  readonly #binding: TaskBinding;
  readonly #key: Uint8Array;
  readonly #max: number;
  constructor(
    path: string,
    options: {
      receiver_id: string;
      binding: TaskBinding;
      fingerprint_key: Uint8Array;
      max_records: number;
    },
  ) {
    this.#binding = Object.freeze(bindingSchema.parse(options.binding));
    this.receiverId = identifier.parse(options.receiver_id);
    if (
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.length < 32 ||
      options.fingerprint_key.length > 128 ||
      !Number.isSafeInteger(options.max_records) ||
      options.max_records < 1 ||
      options.max_records > 10000
    )
      throw new TaskBridgeError("invalid_bridge_options");
    this.#key = new Uint8Array(options.fingerprint_key);
    this.#max = options.max_records;
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new TaskBridgeError("bridge_integrity_failed");
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA busy_timeout=5000");
      const tables = this.#db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      const owned = tables.some(
        (row) => row.name === "a2a_submission_receipts",
      );
      if (tables.length && !owned)
        throw new TaskBridgeError("bridge_integrity_failed");
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("BEGIN IMMEDIATE");
      if (!owned) {
        this.#db.exec(
          "CREATE TABLE a2a_receipt_meta(binding_check TEXT NOT NULL); CREATE TABLE a2a_submission_receipts(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(sender_id,message_id));",
        );
        this.#db
          .prepare("INSERT INTO a2a_receipt_meta VALUES(?)")
          .run(
            this.#hash(JSON.stringify([options.receiver_id, this.#binding])),
          );
      }
      if (
        this.#db.prepare("SELECT binding_check FROM a2a_receipt_meta").get()
          ?.binding_check !==
        this.#hash(JSON.stringify([options.receiver_id, this.#binding]))
      )
        throw new TaskBridgeError("bridge_integrity_failed");
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      this.#db.close();
      this.#key.fill(0);
      throw error;
    }
  }
  get binding() {
    return this.#binding;
  }
  #hash(value: string) {
    return createHmac("sha256", this.#key)
      .update("hab-a2a-submission-v1\n")
      .update(value)
      .digest("hex");
  }
  #load(source: SourceKey, requestKey: string) {
    const key = keySchema.parse(source);
    const row = this.#db
      .prepare(
        "SELECT data,fingerprint FROM a2a_submission_receipts WHERE sender_id=? AND message_id=?",
      )
      .get(key.sender_id, key.message_id);
    if (!row) return undefined;
    if (
      typeof row.data !== "string" ||
      row.data.length > 8192 ||
      row.fingerprint !== this.#hash(row.data)
    )
      throw new TaskBridgeError("bridge_integrity_failed");
    const receipt = receiptSchema.parse(JSON.parse(row.data));
    if (
      receipt.source.sender_id !== key.sender_id ||
      receipt.source.message_id !== key.message_id ||
      receipt.request_key !== requestKey
    )
      throw new TaskBridgeError("bridge_source_conflict");
    return receipt;
  }
  prepare(source: SourceKey, requestKey: string) {
    const receipt = receiptSchema.parse({
      source,
      request_key: requestKey,
      task: null,
    });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#load(source, requestKey)) {
        if (
          Number(
            this.#db
              .prepare("SELECT count(*) n FROM a2a_submission_receipts")
              .get()?.n,
          ) >= this.#max
        )
          throw new TaskBridgeError("bridge_capacity_exceeded");
        const data = JSON.stringify(receipt);
        this.#db
          .prepare("INSERT INTO a2a_submission_receipts VALUES(?,?,?,?)")
          .run(
            receipt.source.sender_id,
            receipt.source.message_id,
            data,
            this.#hash(data),
          );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  read(source: SourceKey, requestKey: string) {
    const receipt = this.#load(source, requestKey);
    return receipt?.task
      ? taskEvidence(receipt.task, this.#binding, requestKey)
      : undefined;
  }
  record(source: SourceKey, requestKey: string, raw: TaskEvidence) {
    const task = taskEvidence(raw, this.#binding, requestKey);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#load(source, requestKey);
      if (!receipt) throw new TaskBridgeError("bridge_invalid_request");
      if (receipt.task && receipt.task.id !== task.id)
        throw new TaskBridgeError("bridge_source_conflict");
      if (!receipt.task) {
        const data = JSON.stringify({ ...receipt, task });
        this.#db
          .prepare(
            "UPDATE a2a_submission_receipts SET data=?,fingerprint=? WHERE sender_id=? AND message_id=?",
          )
          .run(data, this.#hash(data), source.sender_id, source.message_id);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.#db.close();
    this.#key.fill(0);
  }
}
