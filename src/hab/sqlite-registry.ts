/** Explicit private HAB infrastructure. No credential verifier, listener or automatic enrollment. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { z } from "zod";
import { RelayError } from "../relay/service.ts";
import { ContractError } from "../relay/contract.ts";
import type { Authorization } from "../relay/service.ts";
import {
  RegistryError,
  habSlug,
  habAddress,
  parseHabAddress,
  relayOperations,
} from "./registry.ts";
import type {
  AgentOperation,
  AgentRecord,
  AdminOperation,
  BindingRecord,
  ProductRecord,
  RegistryAuthority,
  IndividualPrincipal,
} from "./registry.ts";

export interface RegistryOptions {
  fingerprint_key: Uint8Array;
  max_products: number;
  max_agents: number;
  max_bindings: number;
  max_requests: number;
  max_blocks: number;
  max_audit_records: number;
  max_context_ms: number;
  busy_timeout_ms: number;
  allowed_kinds: readonly string[];
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const slug = z.string().refine((value) => {
  try {
    habSlug(value);
    return true;
  } catch {
    return false;
  }
});
const claim = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const principalSchema = z.strictObject({
  issuer: claim,
  audience: claim,
  subject: claim,
  client_id: claim,
  connection_id: claim,
});
const rights = z
  .array(z.enum(relayOperations))
  .max(relayOperations.length)
  .refine((v) => new Set(v).size === v.length)
  .transform((v) => v.sort());
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const productInput = z.strictObject({ request_id: id, agent_name: slug });
const enrollInput = z.strictObject({
  request_id: id,
  product_id: id,
  bot_name: slug,
});
const bindingInput = z.strictObject({
  request_id: id,
  agent_id: id,
  expected_epoch: epoch,
  principal: principalSchema,
});
const revokeInput = z.strictObject({
  request_id: id,
  binding_id: id,
  expected_epoch: epoch,
});
const accessInput = z.strictObject({
  request_id: id,
  agent_id: id,
  expected_epoch: epoch,
  state: z.enum(["active", "stopped", "retired"]),
  operations: rights,
});
const blockInput = z.strictObject({
  request_id: id,
  sender_id: id,
  recipient_id: id,
  sender_epoch: epoch,
  recipient_epoch: epoch,
  blocked: z.boolean(),
});
const verifiedSchema = z.strictObject({
  principal: principalSchema,
  expires_at: z.string(),
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RegistryError("invalid_registry_request");
  return parsed.data;
}
function canonical(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const v = value as Record<string, unknown>;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}
const SCHEMA = `
CREATE TABLE hab_registry_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,key_check TEXT NOT NULL,epoch INTEGER NOT NULL CHECK(epoch>=0));
CREATE TABLE hab_registry_stop(id INTEGER PRIMARY KEY CHECK(id=1),stopped INTEGER NOT NULL CHECK(stopped IN (0,1)),at TEXT,actor_hash TEXT,epoch INTEGER);
INSERT INTO hab_registry_stop VALUES(1,0,NULL,NULL,NULL);
CREATE TABLE hab_products(product_id TEXT PRIMARY KEY,agent_name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
CREATE TABLE hab_agents(agent_id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES hab_products(product_id),agent_name TEXT NOT NULL,bot_name TEXT NOT NULL,address TEXT NOT NULL UNIQUE,normalization_version INTEGER NOT NULL CHECK(normalization_version=1),state TEXT NOT NULL CHECK(state IN ('waiting_connection','active','stopped','retired')),epoch INTEGER NOT NULL CHECK(epoch>0),operations TEXT NOT NULL CHECK(json_valid(operations)),created_at TEXT NOT NULL);
CREATE TABLE hab_bindings(binding_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES hab_agents(agent_id),fingerprint TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('active','revoked')),created_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX hab_bindings_agent ON hab_bindings(agent_id,state);
CREATE TABLE hab_blocks(sender_id TEXT NOT NULL REFERENCES hab_agents(agent_id),recipient_id TEXT NOT NULL REFERENCES hab_agents(agent_id),PRIMARY KEY(sender_id,recipient_id));
CREATE TABLE hab_admin_requests(actor_hash TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(actor_hash,request_id));
CREATE TABLE hab_registry_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,event TEXT NOT NULL,actor_hash TEXT NOT NULL,object_id TEXT NOT NULL,epoch INTEGER NOT NULL);
CREATE TRIGGER hab_products_immutable BEFORE UPDATE ON hab_products BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_products_reserved BEFORE DELETE ON hab_products BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_agents_immutable BEFORE UPDATE OF agent_id,product_id,agent_name,bot_name,address,normalization_version,created_at ON hab_agents BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_agents_reserved BEFORE DELETE ON hab_agents BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_agents_retired BEFORE UPDATE ON hab_agents WHEN OLD.state='retired' BEGIN SELECT RAISE(ABORT,'retired'); END;
CREATE TRIGGER hab_bindings_immutable BEFORE UPDATE OF binding_id,agent_id,fingerprint,created_at ON hab_bindings BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER hab_bindings_revoked BEFORE UPDATE ON hab_bindings WHEN OLD.state='revoked' BEGIN SELECT RAISE(ABORT,'revoked'); END;
CREATE TRIGGER hab_bindings_reserved BEFORE DELETE ON hab_bindings BEGIN SELECT RAISE(ABORT,'reserved'); END;
CREATE TRIGGER hab_stop_monotonic BEFORE UPDATE ON hab_registry_stop WHEN OLD.stopped=1 BEGIN SELECT RAISE(ABORT,'stopped'); END;
`;
type AgentRow = Omit<AgentRecord, "operations" | "normalization_version"> & {
  operations: string;
  normalization_version: number;
};
type BindingRow = Omit<BindingRecord, "agent_epoch"> & { fingerprint: string };

export class SQLiteHabRegistry {
  readonly #db: DatabaseSync;
  readonly #options: RegistryOptions;
  readonly #authority: RegistryAuthority;
  #ready = false;
  #inside = false;
  constructor(
    path: string,
    options: RegistryOptions,
    authority: RegistryAuthority = {},
  ) {
    try {
      if (
        !(options.fingerprint_key instanceof Uint8Array) ||
        options.fingerprint_key.byteLength < 32 ||
        options.fingerprint_key.byteLength > 128
      )
        throw Error();
      for (const key of [
        "max_products",
        "max_agents",
        "max_bindings",
        "max_requests",
        "max_blocks",
        "max_audit_records",
        "max_context_ms",
        "busy_timeout_ms",
      ] as const) {
        if (
          !Number.isSafeInteger(options[key]) ||
          options[key] < 1 ||
          options[key] > 1000000
        )
          throw Error();
      }
      if (
        options.max_context_ms > 300000 ||
        options.busy_timeout_ms > 1000 ||
        !Array.isArray(options.allowed_kinds) ||
        !options.allowed_kinds.length ||
        options.allowed_kinds.length > 64 ||
        new Set(options.allowed_kinds).size !== options.allowed_kinds.length ||
        options.allowed_kinds.some((v) => !id.safeParse(v).success)
      )
        throw Error();
      if (
        (authority.administrator !== undefined &&
          typeof authority.administrator !== "function") ||
        (authority.individual !== undefined &&
          typeof authority.individual !== "function")
      )
        throw Error();
    } catch {
      throw new RegistryError("invalid_registry_options");
    }
    this.#options = {
      ...options,
      fingerprint_key: Uint8Array.from(options.fingerprint_key),
      allowed_kinds: Object.freeze([...options.allowed_kinds]),
    };
    this.#authority = Object.freeze({ ...authority });
    if (path !== ":memory:") {
      const fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0)
          throw new RegistryError("insecure_registry_file");
      } finally {
        closeSync(fd);
      }
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(
        `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busy_timeout_ms}`,
      );
    } catch {
      this.#db.close();
      throw new RegistryError("registry_unavailable");
    }
  }
  #tx<T>(action: () => T): T {
    if (this.#inside) throw new RegistryError("registry_busy");
    this.#inside = true;
    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = action();
      if (result && typeof result === "object" && "then" in result)
        throw new RegistryError("async_registry_boundary");
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
      if (
        error instanceof RegistryError ||
        error instanceof RelayError ||
        error instanceof ContractError
      )
        throw error;
      throw new RegistryError("registry_unavailable");
    } finally {
      this.#inside = false;
    }
  }
  #hash(domain: string, value: unknown): string {
    return createHmac("sha256", this.#options.fingerprint_key)
      .update(canonical([domain, value]))
      .digest("hex");
  }
  #keyCheck() {
    return createHash("sha256")
      .update(this.#options.fingerprint_key)
      .digest("hex");
  }
  #now(): number {
    return Number(
      this.#db
        .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) n")
        .get()!.n,
    );
  }
  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
  #assertReady() {
    if (!this.#ready) throw new RegistryError("registry_not_migrated");
  }
  #globalEpoch(): number {
    const row = this.#db
      .prepare("SELECT epoch FROM hab_registry_meta WHERE id=1")
      .get();
    if (
      !row ||
      !Number.isSafeInteger(row.epoch) ||
      Number(row.epoch) < 0 ||
      Number(row.epoch) >= Number.MAX_SAFE_INTEGER
    )
      throw new RegistryError("registry_unavailable");
    return Number(row.epoch);
  }
  #stopRecord() {
    const parsed = z
      .strictObject({
        id: z.literal(1),
        stopped: z.union([z.literal(0), z.literal(1)]),
        at: z.string().nullable(),
        actor_hash: z.string().nullable(),
        epoch: epoch.nullable(),
      })
      .safeParse(
        this.#db.prepare("SELECT * FROM hab_registry_stop WHERE id=1").get(),
      );
    if (!parsed.success) throw new RegistryError("registry_unavailable");
    const row = parsed.data;
    if (row.stopped === 0) {
      if (row.at !== null || row.actor_hash !== null || row.epoch !== null)
        throw new RegistryError("registry_unavailable");
    } else {
      const at = row.at === null ? NaN : Date.parse(row.at);
      if (
        !Number.isFinite(at) ||
        new Date(at).toISOString() !== row.at ||
        !row.actor_hash ||
        !/^[a-f0-9]{64}$/.test(row.actor_hash) ||
        row.epoch === null ||
        row.epoch > this.#globalEpoch()
      )
        throw new RegistryError("registry_unavailable");
    }
    return row;
  }
  migrate(): void {
    this.#ready = false;
    this.#tx(() => {
      if (
        !this.#db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='hab_registry_meta'")
          .get()
      ) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()
        )
          throw new RegistryError("unknown_registry_schema");
        this.#db.exec(SCHEMA);
        this.#db
          .prepare("INSERT INTO hab_registry_meta VALUES(1,1,?,0)")
          .run(this.#keyCheck());
      }
      const rows = this.#db.prepare("SELECT * FROM hab_registry_meta").all();
      if (rows.length !== 1 || rows[0].version !== 1)
        throw new RegistryError("unsupported_registry_schema");
      if (rows[0].key_check !== this.#keyCheck())
        throw new RegistryError("registry_key_mismatch");
      this.#globalEpoch();
      this.#stopRecord();
    });
    this.#ready = true;
  }
  #admin(context: unknown, op: AdminOperation): string {
    let decision;
    try {
      decision = this.#authority.administrator?.(context, op);
    } catch {
      throw new RegistryError("registry_forbidden");
    }
    if (!decision || !id.safeParse(decision.actor_id).success)
      throw new RegistryError("registry_forbidden");
    return this.#hash("administrator", decision.actor_id);
  }
  #capacity(table: string, cap: number) {
    // Only private static table constants below reach this function.
    if (
      Number(this.#db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) >=
      cap
    )
      throw new RegistryError("registry_capacity_exceeded");
  }
  #mutate<T extends object>(
    context: unknown,
    op: AdminOperation,
    input: { request_id: string },
    action: () => { result: T; object_id: string },
  ): T {
    this.#assertReady();
    return this.#tx(() => {
      const actor = this.#admin(context, op),
        fingerprint = this.#hash("request", [op, input]);
      const old = this.#db
        .prepare(
          "SELECT fingerprint,response FROM hab_admin_requests WHERE actor_hash=? AND request_id=?",
        )
        .get(actor, input.request_id);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new RegistryError("registry_idempotency_conflict");
        return JSON.parse(String(old.response)) as T;
      }
      this.#capacity("hab_admin_requests", this.#options.max_requests);
      this.#capacity("hab_registry_audit", this.#options.max_audit_records);
      const current = this.#globalEpoch();
      const { result, object_id: objectId } = action();
      this.#db
        .prepare("UPDATE hab_registry_meta SET epoch=? WHERE id=1")
        .run(current + 1);
      this.#db
        .prepare(
          "INSERT INTO hab_registry_audit(at,event,actor_hash,object_id,epoch) VALUES(?,?,?,?,?)",
        )
        .run(this.#iso(), op, actor, objectId, current + 1);
      this.#db
        .prepare("INSERT INTO hab_admin_requests VALUES(?,?,?,?)")
        .run(actor, input.request_id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  #agent(agentId: string): AgentRecord {
    const row = this.#db
      .prepare("SELECT * FROM hab_agents WHERE agent_id=?")
      .get(agentId) as AgentRow | undefined;
    if (!row) throw new RegistryError("registry_not_found");
    const operations = parse(rights, JSON.parse(row.operations));
    const product = this.#db
      .prepare("SELECT agent_name FROM hab_products WHERE product_id=?")
      .get(row.product_id);
    if (
      row.normalization_version !== 1 ||
      product?.agent_name !== row.agent_name ||
      habAddress(row.bot_name, row.agent_name) !== row.address ||
      !epoch.safeParse(row.epoch).success ||
      !["waiting_connection", "active", "stopped", "retired"].includes(
        row.state,
      )
    )
      throw new RegistryError("registry_unavailable");
    return { ...row, normalization_version: 1, operations };
  }
  #expected(agentId: string, expected: number): AgentRecord {
    const agent = this.#agent(agentId);
    if (agent.epoch !== expected)
      throw new RegistryError("registry_stale_epoch");
    if (agent.state === "retired") throw new RegistryError("registry_retired");
    if (agent.epoch >= Number.MAX_SAFE_INTEGER)
      throw new RegistryError("registry_unavailable");
    return agent;
  }
  #bump(agentId: string) {
    this.#db
      .prepare("UPDATE hab_agents SET epoch=epoch+1 WHERE agent_id=?")
      .run(agentId);
  }
  registerProduct(context: unknown, value: unknown): ProductRecord {
    const input = parse(productInput, value);
    return this.#mutate(context, "product", input, () => {
      if (
        this.#db
          .prepare("SELECT 1 FROM hab_products WHERE agent_name=?")
          .get(input.agent_name)
      )
        throw new RegistryError("registry_name_reserved");
      this.#capacity("hab_products", this.#options.max_products);
      const result = {
        product_id: randomUUID(),
        agent_name: input.agent_name,
        created_at: this.#iso(),
      };
      this.#db
        .prepare("INSERT INTO hab_products VALUES(?,?,?)")
        .run(result.product_id, result.agent_name, result.created_at);
      return { result, object_id: result.product_id };
    });
  }
  preview(context: unknown, value: unknown) {
    const input = parse(
      z.strictObject({ product_id: id, bot_name: slug }),
      value,
    );
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "preview");
      const product = this.#db
        .prepare("SELECT agent_name FROM hab_products WHERE product_id=?")
        .get(input.product_id);
      if (!product) throw new RegistryError("registry_not_found");
      const address = habAddress(input.bot_name, product.agent_name);
      return {
        bot_name: input.bot_name,
        agent_name: String(product.agent_name),
        address,
        normalization_version: 1 as const,
        available: !this.#db
          .prepare("SELECT 1 FROM hab_agents WHERE address=?")
          .get(address),
      };
    });
  }
  enroll(context: unknown, value: unknown): AgentRecord {
    const input = parse(enrollInput, value);
    return this.#mutate(context, "enroll", input, () => {
      const product = this.#db
        .prepare("SELECT agent_name FROM hab_products WHERE product_id=?")
        .get(input.product_id);
      if (!product) throw new RegistryError("registry_not_found");
      const address = habAddress(input.bot_name, product.agent_name);
      if (
        this.#db
          .prepare("SELECT 1 FROM hab_agents WHERE address=?")
          .get(address)
      )
        throw new RegistryError("registry_name_reserved");
      this.#capacity("hab_agents", this.#options.max_agents);
      const agentId = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO hab_agents VALUES(?,?,?,?,?,1,'waiting_connection',1,'[]',?)",
        )
        .run(
          agentId,
          input.product_id,
          product.agent_name,
          input.bot_name,
          address,
          this.#iso(),
        );
      return { result: this.#agent(agentId), object_id: agentId };
    });
  }
  inspect(context: unknown, agentId: string): AgentRecord {
    parse(id, agentId);
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "inspect");
      return this.#agent(agentId);
    });
  }
  #binding(bindingId: string): BindingRecord {
    const row = this.#db
      .prepare("SELECT * FROM hab_bindings WHERE binding_id=?")
      .get(bindingId) as BindingRow | undefined;
    if (!row) throw new RegistryError("registry_not_found");
    return {
      binding_id: row.binding_id,
      agent_id: row.agent_id,
      state: row.state,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      agent_epoch: this.#agent(row.agent_id).epoch,
    };
  }
  bind(context: unknown, value: unknown): BindingRecord {
    const input = parse(bindingInput, value);
    return this.#mutate(context, "bind", input, () => {
      this.#expected(input.agent_id, input.expected_epoch);
      const fingerprint = this.#principalHash(input.principal);
      if (
        this.#db
          .prepare("SELECT 1 FROM hab_bindings WHERE fingerprint=?")
          .get(fingerprint)
      )
        throw new RegistryError("registry_binding_reserved");
      this.#capacity("hab_bindings", this.#options.max_bindings);
      const bindingId = randomUUID();
      this.#db
        .prepare("INSERT INTO hab_bindings VALUES(?,?,?,'active',?,NULL)")
        .run(bindingId, input.agent_id, fingerprint, this.#iso());
      this.#bump(input.agent_id);
      return { result: this.#binding(bindingId), object_id: bindingId };
    });
  }
  revoke(context: unknown, value: unknown): BindingRecord {
    const input = parse(revokeInput, value);
    return this.#mutate(context, "revoke", input, () => {
      const binding = this.#binding(input.binding_id);
      this.#expected(binding.agent_id, input.expected_epoch);
      if (binding.state === "revoked")
        throw new RegistryError("registry_binding_revoked");
      this.#db
        .prepare(
          "UPDATE hab_bindings SET state='revoked',revoked_at=? WHERE binding_id=?",
        )
        .run(this.#iso(), input.binding_id);
      this.#bump(binding.agent_id);
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM hab_bindings WHERE agent_id=? AND state='active'",
          )
          .get(binding.agent_id)
      )
        this.#db
          .prepare(
            "UPDATE hab_agents SET state='stopped',operations='[]' WHERE agent_id=?",
          )
          .run(binding.agent_id);
      return {
        result: this.#binding(input.binding_id),
        object_id: input.binding_id,
      };
    });
  }
  setAccess(context: unknown, value: unknown): AgentRecord {
    const input = parse(accessInput, value);
    return this.#mutate(context, "access", input, () => {
      this.#expected(input.agent_id, input.expected_epoch);
      if (input.state !== "active" && input.operations.length)
        throw new RegistryError("invalid_registry_request");
      if (
        input.state === "active" &&
        !this.#db
          .prepare(
            "SELECT 1 FROM hab_bindings WHERE agent_id=? AND state='active'",
          )
          .get(input.agent_id)
      )
        throw new RegistryError("registry_binding_required");
      if (input.state === "retired")
        this.#db
          .prepare(
            "UPDATE hab_bindings SET state='revoked',revoked_at=? WHERE agent_id=? AND state='active'",
          )
          .run(this.#iso(), input.agent_id);
      this.#db
        .prepare(
          "UPDATE hab_agents SET state=?,operations=?,epoch=epoch+1 WHERE agent_id=?",
        )
        .run(input.state, JSON.stringify(input.operations), input.agent_id);
      return { result: this.#agent(input.agent_id), object_id: input.agent_id };
    });
  }
  setBlock(
    context: unknown,
    value: unknown,
  ): { blocked: boolean; sender_epoch: number; recipient_epoch: number } {
    const input = parse(blockInput, value);
    return this.#mutate(context, "block", input, () => {
      this.#expected(input.sender_id, input.sender_epoch);
      this.#expected(input.recipient_id, input.recipient_epoch);
      const exists = this.#blocked(input.sender_id, input.recipient_id);
      if (input.blocked && !exists) {
        this.#capacity("hab_blocks", this.#options.max_blocks);
        this.#db
          .prepare("INSERT INTO hab_blocks VALUES(?,?)")
          .run(input.sender_id, input.recipient_id);
      }
      if (!input.blocked)
        this.#db
          .prepare(
            "DELETE FROM hab_blocks WHERE sender_id=? AND recipient_id=?",
          )
          .run(input.sender_id, input.recipient_id);
      this.#bump(input.sender_id);
      if (input.sender_id !== input.recipient_id)
        this.#bump(input.recipient_id);
      return {
        result: {
          blocked: input.blocked,
          sender_epoch: this.#agent(input.sender_id).epoch,
          recipient_epoch: this.#agent(input.recipient_id).epoch,
        },
        object_id: input.sender_id,
      };
    });
  }
  #principalHash(principal: IndividualPrincipal) {
    return this.#hash("principal-v1", parse(principalSchema, principal));
  }
  #blocked(sender: string, recipient: string): boolean {
    return !!this.#db
      .prepare("SELECT 1 FROM hab_blocks WHERE sender_id=? AND recipient_id=?")
      .get(sender, recipient);
  }
  #peer(agentId: string): AgentRecord {
    const agent = this.#agent(agentId);
    if (agent.state !== "active") throw new RelayError("forbidden");
    return agent;
  }
  /** Monotonic fail-closed latch; independent of append-only management quotas. */
  emergencyStop(context: unknown): {
    stopped: true;
    stopped_at: string;
    epoch: number;
  } {
    this.#assertReady();
    return this.#tx(() => {
      const actor = this.#admin(context, "emergency_stop");
      const row = this.#stopRecord();
      if (row.stopped === 1)
        return {
          stopped: true,
          stopped_at: String(row.at),
          epoch: Number(row.epoch),
        };
      const current = this.#globalEpoch(),
        at = this.#iso();
      this.#db
        .prepare("UPDATE hab_registry_meta SET epoch=? WHERE id=1")
        .run(current + 1);
      this.#db
        .prepare(
          "UPDATE hab_registry_stop SET stopped=1,at=?,actor_hash=?,epoch=? WHERE id=1",
        )
        .run(at, actor, current + 1);
      return { stopped: true, stopped_at: at, epoch: current + 1 };
    });
  }
  /** Registry lock precedes Relay's write lock and remains held through Relay COMMIT. */
  withRelay<T>(
    context: unknown,
    operation: AgentOperation,
    action: (authorization: Authorization, agentId: string) => T,
  ): T {
    this.#assertReady();
    return this.#tx(() => {
      try {
        if (this.#stopRecord().stopped !== 0) throw new RelayError("forbidden");
      } catch {
        throw new RelayError("forbidden");
      }
      let individual;
      try {
        individual = verifiedSchema.parse(
          this.#authority.individual?.(context),
        );
      } catch {
        throw new RelayError("forbidden");
      }
      const expiry = Date.parse(individual.expires_at),
        now = this.#now();
      if (
        !Number.isFinite(expiry) ||
        new Date(expiry).toISOString() !== individual.expires_at ||
        expiry <= now ||
        expiry - now > this.#options.max_context_ms
      )
        throw new RelayError("forbidden");
      const binding = this.#db
        .prepare(
          "SELECT * FROM hab_bindings WHERE fingerprint=? AND state='active'",
        )
        .get(this.#principalHash(individual.principal)) as
        BindingRow | undefined;
      if (!binding) throw new RelayError("forbidden");
      const local = this.#peer(binding.agent_id),
        policyEpoch = this.#globalEpoch();
      if (
        !local.operations.includes(operation) ||
        (operation === "resolve" && !local.operations.includes("submit"))
      )
        throw new RelayError("forbidden");
      let alive = true;
      const authorization: Authorization = {
        authorize: (incoming, op, peerId, kind) => {
          try {
            if (
              !alive ||
              incoming !== context ||
              op !== operation ||
              expiry <= this.#now() ||
              this.#globalEpoch() !== policyEpoch
            )
              return undefined;
            if (
              kind !== undefined &&
              !this.#options.allowed_kinds.includes(kind)
            )
              return undefined;
            if (peerId !== undefined) {
              this.#peer(peerId);
              const sender = op === "submit" ? local.agent_id : peerId,
                recipient = op === "submit" ? peerId : local.agent_id;
              if (this.#blocked(sender, recipient)) return undefined;
            }
            return { agent_id: local.agent_id };
          } catch {
            return undefined;
          }
        },
      };
      try {
        return action(authorization, local.agent_id);
      } finally {
        alive = false;
      }
    });
  }
  resolve(
    context: unknown,
    address: string,
  ): { recipient_id: string; address: string; normalization_version: 1 } {
    const canonicalAddress = parseHabAddress(address).address;
    return this.withRelay(context, "resolve", (_authorization, senderId) => {
      const row = this.#db
        .prepare(
          "SELECT agent_id FROM hab_agents WHERE address=? AND state='active'",
        )
        .get(canonicalAddress);
      if (!row || this.#blocked(senderId, String(row.agent_id)))
        throw new RelayError("forbidden");
      this.#peer(String(row.agent_id));
      return {
        recipient_id: String(row.agent_id),
        address: canonicalAddress,
        normalization_version: 1,
      };
    });
  }
  close(): void {
    this.#db.close();
    this.#options.fingerprint_key.fill(0);
    this.#ready = false;
  }
}
