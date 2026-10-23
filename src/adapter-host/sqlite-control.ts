/** Private local stop gate; never edits an agent, credential or remote registry. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { id, checkGuard } from "../adapter-policy/contract.ts";
export class HostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export interface HostControlOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  max_audit_records: number;
}
export interface HostState {
  agent_id: string;
  paused: boolean;
  epoch: number;
}
class ActionFailure {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}
const stateSchema = z.strictObject({
  agent_id: id,
  paused: z.boolean(),
  epoch: z.number().int().nonnegative(),
});
const auditSchema = z.strictObject({
  epoch: z.number().int().positive(),
  paused: z.boolean(),
  at: z.number().int().nonnegative(),
  actor_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const schema = `
CREATE TABLE adapter_host_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,binding TEXT NOT NULL,data TEXT NOT NULL,fingerprint TEXT NOT NULL);
CREATE TABLE adapter_host_audit(epoch INTEGER PRIMARY KEY,data TEXT NOT NULL,fingerprint TEXT NOT NULL);
CREATE TRIGGER adapter_host_audit_identity BEFORE UPDATE ON adapter_host_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER adapter_host_audit_retain BEFORE DELETE ON adapter_host_audit BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
export class SQLiteHostControl {
  readonly #db: DatabaseSync;
  readonly #options: HostControlOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: HostControlOptions) {
    try {
      id.parse(options.agent_id);
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128 ||
        !Number.isSafeInteger(options.max_audit_records) ||
        options.max_audit_records < 2 ||
        options.max_audit_records > 10000
      )
        throw Error();
    } catch {
      throw new HostError("invalid_host_control_options");
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
          const st = fstatSync(fd);
          if (!st.isFile() || st.mode & 0o077) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path, { timeout: 1000 });
      db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON",
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new HostError("host_store_unavailable");
    }
  }
  get agentId() {
    return this.#options.agent_id;
  }
  #hash(domain: string, data: unknown) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(domain + "\0")
      .update(JSON.stringify(data))
      .digest("hex");
  }
  #binding() {
    return this.#hash("binding-v1", [
      this.agentId,
      this.#options.max_audit_records,
    ]);
  }
  #tx<T>(action: () => T, guard: () => void = () => {}) {
    if (this.#inside) throw new HostError("host_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const value = action();
      checkGuard(guard);
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began)
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
          throw new HostError("host_store_unavailable");
        }
      if (error instanceof ActionFailure) throw error.error;
      if (error instanceof HostError) throw error;
      throw new HostError("host_store_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #write(state: HostState) {
    const text = JSON.stringify(state);
    this.#db
      .prepare("UPDATE adapter_host_meta SET data=?,fingerprint=? WHERE id=1")
      .run(text, this.#hash("state-v1", text));
  }
  #read(): HostState {
    try {
      const rows = this.#db.prepare("SELECT * FROM adapter_host_meta").all(),
        row = rows[0];
      if (
        rows.length !== 1 ||
        row.id !== 1 ||
        row.version !== 1 ||
        row.binding !== this.#binding()
      )
        throw Error();
      if (
        typeof row.data !== "string" ||
        row.data.length > 1024 ||
        row.fingerprint !== this.#hash("state-v1", row.data)
      )
        throw Error();
      const state = stateSchema.parse(JSON.parse(row.data));
      const audits = this.#db
        .prepare("SELECT * FROM adapter_host_audit ORDER BY epoch")
        .all();
      if (
        state.agent_id !== this.agentId ||
        audits.length !== state.epoch ||
        state.epoch > this.#options.max_audit_records
      )
        throw Error();
      for (const [index, a] of audits.entries()) {
        if (
          typeof a.data !== "string" ||
          a.data.length > 1024 ||
          a.fingerprint !== this.#hash("audit-v1", a.data)
        )
          throw Error();
        const v = auditSchema.parse(JSON.parse(a.data));
        if (
          a.epoch !== index + 1 ||
          v.epoch !== a.epoch ||
          (index === audits.length - 1 && v.paused !== state.paused)
        )
          throw Error();
      }
      if (state.epoch === 0 && !state.paused) throw Error();
      return state;
    } catch {
      throw new HostError("host_integrity_failed");
    }
  }
  migrate() {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='adapter_host_meta'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new HostError("unknown_host_schema");
        this.#db.exec(schema);
        const text = JSON.stringify({
          agent_id: this.agentId,
          paused: true,
          epoch: 0,
        });
        this.#db
          .prepare("INSERT INTO adapter_host_meta VALUES(1,1,?,?,?)")
          .run(this.#binding(), text, this.#hash("state-v1", text));
      }
      this.#read();
      for (const name of [
        "adapter_host_audit_identity",
        "adapter_host_audit_retain",
      ])
        if (
          !this.#db
            .prepare("SELECT 1 FROM sqlite_master WHERE name=?")
            .get(name)
        )
          throw new HostError("unsupported_host_schema");
    });
    this.#ready = true;
  }
  snapshot() {
    if (!this.#ready) throw new HostError("host_not_migrated");
    // Short write guard prevents mixing metadata/audit generations across processes.
    return this.#tx(() => this.#read());
  }
  #check(epoch: number) {
    if (!this.#ready) throw new HostError("host_not_migrated");
    const state = this.#read();
    if (state.epoch !== epoch) throw new HostError("host_epoch_changed");
    if (state.paused) throw new HostError("host_paused");
  }
  check(epoch: number) {
    if (this.#inside) return this.#check(epoch);
    return this.#tx(() => this.#check(epoch));
  }
  withActive<T>(epoch: number, guard: () => void, action: () => T): T {
    return this.#tx(() => {
      this.#check(epoch);
      checkGuard(guard);
      let value: T;
      try {
        value = action();
      } catch (error) {
        throw new ActionFailure(error);
      }
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw new HostError("invalid_host_action");
      }
      this.#check(epoch);
      return value;
    }, guard);
  }
  setPaused(
    paused: boolean,
    expectedEpoch: number,
    actor: string,
    guard: () => void,
  ): HostState {
    if (
      typeof paused !== "boolean" ||
      !Number.isSafeInteger(expectedEpoch) ||
      expectedEpoch < 0
    )
      throw new HostError("invalid_host_control_request");
    id.parse(actor);
    checkGuard(guard);
    try {
      return this.#tx(() => {
        if (!this.#ready) throw new HostError("host_not_migrated");
        const old = this.#read();
        if (old.epoch !== expectedEpoch)
          throw new HostError("host_epoch_changed");
        if (old.paused === paused) return old;
        // Keep one durable audit slot available for stopping an active host.
        if (old.epoch >= this.#options.max_audit_records - (paused ? 0 : 1))
          throw new HostError("host_control_capacity_exceeded");
        const state = { ...old, paused, epoch: old.epoch + 1 };
        const at = Number(
          this.#db
            .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
            .get()!.at,
        );
        const data = auditSchema.parse({
          epoch: state.epoch,
          paused,
          at,
          actor_fingerprint: this.#hash("actor-v1", actor),
        });
        const text = JSON.stringify(data);
        this.#db
          .prepare("INSERT INTO adapter_host_audit VALUES(?,?,?)")
          .run(state.epoch, text, this.#hash("audit-v1", text));
        this.#write(state);
        return state;
      }, guard);
    } catch (error) {
      if (error instanceof HostError && error.code === "host_store_unavailable")
        this.#ready = false;
      throw error;
    }
  }
  close() {
    this.#ready = false;
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
  }
}
