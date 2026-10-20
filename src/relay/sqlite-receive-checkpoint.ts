/** Private dedicated DB. No listener, token provisioning, agent execution or automatic loop. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import {
  parseSubmission,
  comparisonMaterial,
  validateLimits,
} from "./contract.ts";
import type { ContractLimits } from "./contract.ts";
import { RelayError } from "./service.ts";
import type { Delivery } from "./service.ts";
import type {
  ReceiveCheckpoint,
  ReceiveJob,
  ReceiveFailure,
} from "./receive-checkpoint.ts";
export interface ReceiveCheckpointOptions {
  agent_id: string;
  fingerprint_key: Uint8Array;
  limits: ContractLimits;
  max_payload_bytes: number;
  busy_timeout_ms: number;
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
}
type Row = {
  state: "idle" | "receiving" | "quarantined";
  payload: string | null;
  expires_at: number | null;
  fence: number;
  lease_until: number | null;
  attempts: number;
  next_retry_at: number;
  reason: ReceiveFailure | "expired" | null;
  guard: string;
};
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export class SQLiteReceiveCheckpoint implements ReceiveCheckpoint {
  readonly #db: DatabaseSync;
  readonly #options: ReceiveCheckpointOptions;
  #ready = false;
  #inside = false;
  constructor(path: string, options: ReceiveCheckpointOptions) {
    validateLimits(options.limits);
    if (
      !identifier(options.agent_id) ||
      !(options.fingerprint_key instanceof Uint8Array) ||
      options.fingerprint_key.length < 32
    )
      throw new RelayError("invalid_receive_checkpoint_options");
    for (const key of [
      "max_payload_bytes",
      "busy_timeout_ms",
      "lease_ms",
      "max_attempts",
      "retry_base_ms",
      "retry_cap_ms",
    ] as const)
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new RelayError("invalid_receive_checkpoint_options");
    if (
      options.max_payload_bytes > 16777216 ||
      options.busy_timeout_ms > 5000 ||
      options.lease_ms > 3600000 ||
      options.max_attempts > 1000 ||
      options.retry_cap_ms < options.retry_base_ms ||
      options.retry_cap_ms > 3600000
    )
      throw new RelayError("invalid_receive_checkpoint_options");
    this.#options = {
      ...options,
      limits: { ...options.limits },
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
          const info = fstatSync(fd);
          if (!info.isFile() || (info.mode & 0o077) !== 0) throw Error();
        } finally {
          closeSync(fd);
        }
      }
      db = new DatabaseSync(path);
      db.exec(
        "PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;PRAGMA busy_timeout=" +
          options.busy_timeout_ms,
      );
      this.#db = db;
    } catch {
      db?.close();
      throw new RelayError("receive_checkpoint_unavailable");
    }
  }
  #hash(value: string) {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update("receive-checkpoint-v1\0")
      .update(value)
      .digest("hex");
  }
  #guard(r: Row) {
    return this.#hash(
      JSON.stringify([
        this.#options.agent_id,
        r.state,
        r.payload,
        r.expires_at,
        r.fence,
        r.lease_until,
        r.attempts,
        r.next_retry_at,
        r.reason,
      ]),
    );
  }
  #now() {
    return Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) n")
        .get()!.n,
    );
  }
  #tx<T>(action: () => T, check?: () => void): T {
    if (this.#inside) throw new RelayError("receive_checkpoint_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const value = action();
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw new RelayError("receive_checkpoint_busy");
      }
      check?.();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          this.#ready = false;
        }
      }
      if (error instanceof RelayError) throw error;
      throw new RelayError("receive_checkpoint_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  migrate(): void {
    this.#ready = false;
    this.#tx(() => {
      const exists = this.#db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='receive_checkpoint_meta'",
        )
        .get();
      const key = createHash("sha256")
        .update(this.#options.fingerprint_key)
        .digest("hex");
      if (!exists) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new RelayError("unknown_receive_checkpoint_schema");
        this.#db.exec(
          "CREATE TABLE receive_checkpoint_meta(version INTEGER NOT NULL,agent_id TEXT NOT NULL,key_check TEXT NOT NULL); CREATE TABLE receive_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('idle','receiving','quarantined')),payload TEXT,expires_at INTEGER,fence INTEGER NOT NULL,lease_until INTEGER,attempts INTEGER NOT NULL,next_retry_at INTEGER NOT NULL,reason TEXT,guard TEXT NOT NULL);",
        );
        this.#db
          .prepare("INSERT INTO receive_checkpoint_meta VALUES(1,?,?)")
          .run(this.#options.agent_id, key);
        const r: Row = {
          state: "idle",
          payload: null,
          expires_at: null,
          fence: 0,
          lease_until: null,
          attempts: 0,
          next_retry_at: 0,
          reason: null,
          guard: "",
        };
        this.#db
          .prepare(
            "INSERT INTO receive_checkpoint VALUES(1,?,?,?,0,NULL,0,0,NULL,?)",
          )
          .run(r.state, null, null, this.#guard(r));
      }
      const rows = this.#db
        .prepare("SELECT * FROM receive_checkpoint_meta")
        .all();
      if (rows.length !== 1 || rows[0].version !== 1)
        throw new RelayError("unsupported_receive_checkpoint_schema");
      if (
        rows[0].agent_id !== this.#options.agent_id ||
        rows[0].key_check !== key
      )
        throw new RelayError("receive_checkpoint_identity_mismatch");
    });
    this.#ready = true;
    try {
      this.#row();
    } catch (e) {
      this.#ready = false;
      throw e;
    }
  }
  #row(): Row {
    if (!this.#ready) throw new RelayError("receive_checkpoint_not_ready");
    const size = this.#db
      .prepare(
        "SELECT length(cast(payload AS BLOB)) n FROM receive_checkpoint WHERE id=1",
      )
      .get();
    if (!size || Number(size.n ?? 0) > this.#options.max_payload_bytes)
      throw new RelayError("receive_checkpoint_integrity");
    const r = this.#db
      .prepare("SELECT * FROM receive_checkpoint WHERE id=1")
      .get() as Row;
    if (
      !r ||
      r.guard !== this.#guard(r) ||
      !Number.isSafeInteger(r.fence) ||
      r.fence < 0 ||
      !Number.isSafeInteger(r.attempts) ||
      r.attempts < 0 ||
      !Number.isSafeInteger(r.next_retry_at) ||
      (r.lease_until !== null && !Number.isSafeInteger(r.lease_until)) ||
      (r.payload === null) !== (r.expires_at === null) ||
      (r.state === "receiving" && r.payload === null) ||
      (r.state === "idle" && r.payload !== null)
    )
      throw new RelayError("receive_checkpoint_integrity");
    if (r.payload !== null) {
      try {
        const d = this.#delivery(JSON.parse(r.payload));
        if (
          Date.parse(d.message.expires_at) !== r.expires_at ||
          JSON.stringify(d) !== r.payload
        )
          throw Error();
      } catch {
        throw new RelayError("receive_checkpoint_integrity");
      }
    }
    return r;
  }
  #write(r: Row) {
    this.#db
      .prepare(
        "UPDATE receive_checkpoint SET state=?,payload=?,expires_at=?,fence=?,lease_until=?,attempts=?,next_retry_at=?,reason=?,guard=? WHERE id=1",
      )
      .run(
        r.state,
        r.payload,
        r.expires_at,
        r.fence,
        r.lease_until,
        r.attempts,
        r.next_retry_at,
        r.reason,
        this.#guard(r),
      );
  }
  #delivery(input: unknown): Delivery {
    try {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error();
      const v = input as Delivery,
        keys = Object.keys(v).sort().join(",");
      if (keys !== "generation,lease_token,lease_until,message") throw Error();
      const { sender_id, ...wire } = v.message;
      const message = parseSubmission(wire, this.#options.limits);
      if (
        !identifier(sender_id) ||
        message.recipient_id !== this.#options.agent_id ||
        !Number.isSafeInteger(v.generation) ||
        v.generation < 1 ||
        typeof v.lease_token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(v.lease_token) ||
        typeof v.lease_until !== "string" ||
        !Number.isFinite(Date.parse(v.lease_until)) ||
        new Date(v.lease_until).toISOString() !== v.lease_until ||
        Date.parse(v.lease_until) > Date.parse(message.expires_at)
      )
        throw Error();
      return {
        message: { ...message, sender_id },
        generation: v.generation,
        lease_token: v.lease_token,
        lease_until: v.lease_until,
      };
    } catch {
      throw new RelayError("invalid_receive_delivery");
    }
  }
  #owned(job: ReceiveJob): Row {
    const r = this.#row();
    if (
      r.lease_until === null ||
      r.lease_until <= this.#now() ||
      r.fence !== job.fence ||
      new Date(r.lease_until).toISOString() !== job.lease_until
    )
      throw new RelayError("stale_receive_job");
    return r;
  }
  #clear(r: Row) {
    r.payload = null;
    r.expires_at = null;
    r.state = "idle";
    r.attempts = 0;
    r.next_retry_at = 0;
    r.reason = null;
  }
  claim(): ReceiveJob | null {
    let deadline = 0;
    return this.#tx(
      () => {
        const r = this.#row(),
          now = this.#now();
        if (r.lease_until !== null && r.lease_until > now) return null;
        if (r.expires_at !== null && r.expires_at <= now) {
          this.#clear(r);
          r.reason = "expired";
        }
        if (r.state === "quarantined" || r.next_retry_at > now) {
          r.lease_until = null;
          this.#write(r);
          return null;
        }
        r.fence++;
        r.lease_until = now + this.#options.lease_ms;
        deadline = r.lease_until;
        this.#write(r);
        return {
          fence: r.fence,
          lease_until: new Date(r.lease_until).toISOString(),
          delivery:
            r.payload === null ? null : this.#delivery(JSON.parse(r.payload)),
        };
      },
      () => {
        if (deadline && deadline <= this.#now())
          throw new RelayError("stale_receive_job");
      },
    );
  }
  save(job: ReceiveJob, input: Delivery): void {
    const d = this.#delivery(input),
      payload = JSON.stringify(d),
      expiry = Date.parse(d.message.expires_at);
    if (Buffer.byteLength(payload) > this.#options.max_payload_bytes)
      throw new RelayError("receive_checkpoint_capacity");
    this.#tx(
      () => {
        const r = this.#owned(job);
        if (expiry <= this.#now() || Date.parse(d.lease_until) <= this.#now())
          throw new RelayError("expired_receive_delivery");
        if (r.payload !== null) {
          const old = this.#delivery(JSON.parse(r.payload));
          const material = (v: Delivery) => {
            const { sender_id, ...message } = v.message;
            return comparisonMaterial(sender_id, message, this.#options.limits);
          };
          if (
            material(old) !== material(d) ||
            d.generation < old.generation ||
            (d.generation === old.generation &&
              JSON.stringify(d) !== JSON.stringify(old))
          )
            throw new RelayError("receive_delivery_changed");
        }
        r.payload = payload;
        r.expires_at = expiry;
        r.state = "receiving";
        this.#write(r);
      },
      () => {
        this.#owned(job);
        if (expiry <= this.#now() || Date.parse(d.lease_until) <= this.#now())
          throw new RelayError("expired_receive_delivery");
      },
    );
  }
  release(job: ReceiveJob): void {
    this.#tx(
      () => {
        const r = this.#owned(job);
        r.lease_until = null;
        r.attempts = 0;
        r.next_retry_at = 0;
        r.reason = null;
        this.#write(r);
      },
      () => {
        if (Date.parse(job.lease_until) <= this.#now())
          throw new RelayError("stale_receive_job");
      },
    );
  }
  complete(job: ReceiveJob): void {
    this.#tx(
      () => {
        const r = this.#owned(job);
        this.#clear(r);
        r.lease_until = null;
        this.#write(r);
      },
      () => {
        if (Date.parse(job.lease_until) <= this.#now())
          throw new RelayError("stale_receive_job");
      },
    );
  }
  fail(job: ReceiveJob, reason: ReceiveFailure): void {
    if (
      ![
        "transport",
        "forbidden",
        "integrity",
        "delivery_changed",
        "local_store",
      ].includes(reason)
    )
      throw new RelayError("invalid_receive_failure");
    this.#tx(
      () => {
        const r = this.#owned(job);
        r.attempts++;
        r.lease_until = null;
        r.reason = reason;
        if (
          ["forbidden", "integrity", "delivery_changed"].includes(reason) ||
          r.attempts >= this.#options.max_attempts
        )
          r.state = "quarantined";
        else
          r.next_retry_at =
            this.#now() +
            Math.min(
              this.#options.retry_cap_ms,
              this.#options.retry_base_ms * 2 ** Math.min(r.attempts - 1, 30),
            );
        this.#write(r);
      },
      () => {
        if (Date.parse(job.lease_until) <= this.#now())
          throw new RelayError("stale_receive_job");
      },
    );
  }
  status() {
    const r = this.#row(),
      delivery =
        r.payload === null ? null : this.#delivery(JSON.parse(r.payload));
    return {
      sender_id: delivery?.message.sender_id ?? null,
      message_id: delivery?.message.message_id ?? null,
      expires_at: delivery?.message.expires_at ?? null,
      state: r.state,
      pending: r.payload !== null,
      attempts: r.attempts,
      reason: r.reason,
      next_retry_at: new Date(r.next_retry_at).toISOString(),
    };
  }
  /** Local operator only: no remote ACK, no file/body release, no new network call. */
  discard(): void {
    this.#tx(() => {
      const r = this.#row();
      if (r.lease_until !== null && r.lease_until > this.#now())
        throw new RelayError("receive_checkpoint_busy");
      this.#clear(r);
      r.fence++;
      r.lease_until = null;
      this.#write(r);
    });
  }
  maintain(): boolean {
    return this.#tx(() => {
      const r = this.#row(),
        now = this.#now();
      if (
        r.expires_at === null ||
        r.expires_at > now ||
        (r.lease_until !== null && r.lease_until > now)
      )
        return false;
      this.#clear(r);
      r.fence++;
      r.lease_until = null;
      r.reason = "expired";
      this.#write(r);
      return true;
    });
  }
  close(): void {
    this.#ready = false;
    this.#db.close();
  }
}
