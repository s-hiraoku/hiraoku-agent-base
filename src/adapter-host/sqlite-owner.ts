/** Local process-lifetime ownership. Dedicated SQLite file; never a task lease or credential. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, lstatSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { createHmac } from "node:crypto";
import { id, checkGuard } from "../adapter-policy/contract.ts";
import { HostError } from "./sqlite-control.ts";
export interface HostOwnerOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
}
export interface HostOwnership {
  readonly agentId: string;
  check(): void;
  release(): void;
}
function busy(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "errcode" in error &&
    [5, 6].includes(Number(error.errcode) & 255)
  );
}
export class SQLiteHostOwner {
  readonly #path: string;
  readonly #options: HostOwnerOptions;
  readonly #db: DatabaseSync;
  readonly #identityKey: { dev: number; ino: number };
  #ready = false;
  #held = false;
  #attached = false;
  #closed = false;
  #poisoned = false;
  constructor(path: string, options: HostOwnerOptions) {
    try {
      id.parse(options.agent_id);
      if (
        !isAbsolute(path) ||
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.length < 32 ||
        options.fingerprint_key.length > 128
      )
        throw Error();
    } catch {
      throw new HostError("invalid_host_owner_options");
    }
    this.#path = path;
    this.#options = {
      ...options,
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
    };
    let db: DatabaseSync | undefined;
    try {
      // Never open/close an extra fd on an existing SQLite file: POSIX fcntl locks are process-wide.
      try {
        const fd = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(fd);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        stat.nlink !== 1
      )
        throw Error();
      this.#identityKey = { dev: stat.dev, ino: stat.ino };
      db = new DatabaseSync(path, { timeout: 0 });
      this.#db = db;
      this.#identity();
      // WAL does not provide the exclusive reader/writer ownership used by this component.
      if (db.prepare("PRAGMA journal_mode").get()!.journal_mode !== "delete")
        throw Error();
    } catch (error) {
      db?.close();
      throw new HostError(
        busy(error) ? "host_owner_busy" : "host_owner_unavailable",
      );
    }
  }
  get agentId() {
    return this.#options.agent_id;
  }
  #identity() {
    const before = this.#identityKey,
      current = lstatSync(this.#path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.mode & 0o077 ||
      current.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new HostError("host_owner_identity_changed");
  }
  #binding() {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update("hab-host-owner-v1\0" + this.agentId)
      .digest("hex");
  }
  #read() {
    this.#identity();
    const rows = this.#db.prepare("SELECT * FROM adapter_host_owner").all(),
      row = rows[0];
    if (
      rows.length !== 1 ||
      row.id !== 1 ||
      row.version !== 1 ||
      row.binding !== this.#binding()
    )
      throw new HostError("host_owner_binding_mismatch");
    const tables = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all();
    if (tables.length !== 1 || tables[0].name !== "adapter_host_owner")
      throw new HostError("unsupported_host_owner_schema");
  }
  migrate() {
    if (this.#closed || this.#held || this.#attached)
      throw new HostError("host_owner_busy");
    this.#ready = false;
    let began = false;
    try {
      this.#identity();
      this.#db.exec("BEGIN EXCLUSIVE");
      began = true;
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='adapter_host_owner'",
          )
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new HostError("unknown_host_owner_schema");
        this.#db.exec(
          "CREATE TABLE adapter_host_owner(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,binding TEXT NOT NULL)",
        );
        this.#db
          .prepare("INSERT INTO adapter_host_owner VALUES(1,1,?)")
          .run(this.#binding());
      }
      this.#read();
      this.#db.exec("COMMIT");
      this.#ready = true;
      this.#poisoned = false;
    } catch (error) {
      if (began)
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#poisoned = true;
        }
      if (error instanceof HostError) throw error;
      throw new HostError(
        busy(error) ? "host_owner_busy" : "host_owner_unavailable",
      );
    }
  }
  /** Explicitly authorized composition action; acquisition never starts work or resumes control. */
  acquire(guard: () => void) {
    checkGuard(guard);
    if (!this.#ready || this.#closed || this.#poisoned)
      throw new HostError("host_owner_not_ready");
    if (this.#held || this.#attached) throw new HostError("host_owner_busy");
    let began = false;
    try {
      this.#identity();
      this.#db.exec("BEGIN EXCLUSIVE");
      began = true;
      this.#read();
      checkGuard(guard);
      this.#held = true;
    } catch (error) {
      if (began)
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#poisoned = true;
        }
      if (error instanceof HostError) throw error;
      if (busy(error)) throw new HostError("host_owner_busy");
      throw new HostError("host_owner_unavailable");
    }
  }
  #check() {
    if (!this.#held || !this.#ready || this.#closed || this.#poisoned)
      throw new HostError("host_owner_not_held");
    try {
      if (this.#db.isTransaction !== true) throw Error();
      this.#read();
    } catch {
      this.#poisoned = true;
      throw new HostError("host_owner_lost");
    }
  }
  /** A held lock can be attached to exactly one host instance. No name or wire input is authority. */
  attach(): HostOwnership {
    if (this.#attached) throw new HostError("host_owner_already_attached");
    this.#check();
    this.#attached = true;
    return Object.freeze({
      agentId: this.agentId,
      check: () => this.#check(),
      release: () => {
        this.#check();
        try {
          this.#db.exec("ROLLBACK");
          this.#held = false;
        } catch {
          this.#poisoned = true;
          throw new HostError("host_owner_unavailable");
        }
      },
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#held = false;
    try {
      this.#db.close();
    } finally {
      this.#options.fingerprint_key.fill(0);
    }
  }
}
