/** Explicit private HAB infrastructure. No credential verifier, listener or automatic enrollment. */
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { z } from "zod";
import { RelayError } from "../relay/service.ts";
import { AUTH_GROUP_SCHEMA } from "./auth-groups.ts";
import type { AuthenticationGroup, GroupBinding } from "./auth-groups.ts";
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
  /** Explicit opt-in to the additive group schema; never inferred from claims. */
  authentication_groups?: boolean;
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
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
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
  .regex(/^[^\x00-\x1f\x7f]+$(?![\s\S])/);
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
const groupBindingInput = z.strictObject({
  request_id: id,
  group_id: id,
  expected_epoch: epoch,
  principal: principalSchema,
});
const groupAccessInput = z.strictObject({
  request_id: id,
  group_id: id,
  expected_epoch: epoch,
  state: z.enum(["active", "stopped", "retired"]),
  operations: rights,
});
const groupMemberInput = z.strictObject({
  request_id: id,
  group_id: id,
  expected_group_epoch: epoch,
  agent_id: id,
  expected_epoch: epoch,
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
  #groupsPresent = false;
  #schemaVersion: number | undefined;
  readonly #selections = new WeakMap<
    object,
    { context: unknown; address: string }
  >();
  #inside = false;
  constructor(
    path: string,
    options: RegistryOptions,
    authority: RegistryAuthority = {},
  ) {
    try {
      if (
        options.authentication_groups !== undefined &&
        typeof options.authentication_groups !== "boolean"
      )
        throw Error();
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
      if (this.#ready) this.#assertReady();
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
    if (
      this.#db.prepare("SELECT version FROM hab_registry_meta WHERE id=1").get()
        ?.version !== this.#schemaVersion
    )
      throw new RegistryError("registry_schema_changed");
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
    this.#groupsPresent = false;
    this.#schemaVersion = undefined;
    const version = this.#tx(() => {
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
      if (rows.length !== 1 || ![1, 2].includes(Number(rows[0].version)))
        throw new RegistryError("unsupported_registry_schema");
      if (rows[0].key_check !== this.#keyCheck())
        throw new RegistryError("registry_key_mismatch");
      this.#globalEpoch();
      this.#stopRecord();
      let groupMeta = this.#db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='hab_auth_group_meta'")
        .get();
      if ((rows[0].version === 2) !== Boolean(groupMeta))
        throw new RegistryError("unsupported_registry_schema");
      if (!groupMeta && this.#options.authentication_groups === true) {
        this.#db.exec(AUTH_GROUP_SCHEMA);
        this.#db
          .prepare("UPDATE hab_registry_meta SET version=2 WHERE id=1")
          .run();
        groupMeta = { found: 1 };
      }
      if (groupMeta) {
        const meta = this.#db
          .prepare("SELECT * FROM hab_auth_group_meta")
          .all();
        if (meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1)
          throw new RegistryError("unsupported_registry_group_schema");
        this.#groupsPresent = true;
      }
      return groupMeta ? 2 : 1;
    });
    this.#schemaVersion = version;
    this.#ready = true;
  }
  #admin(context: unknown, op: AdminOperation): string {
    let decision;
    try {
      decision = this.#authority.administrator?.(context, op);
      if (decision && typeof decision === "object" && "then" in decision) {
        void Promise.resolve(decision).catch(() => {});
        throw Error();
      }
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
    return this.#tx(() => this.#mutateLocked(context, op, input, action));
  }
  #mutateLocked<T extends object>(
    context: unknown,
    op: AdminOperation,
    input: { request_id: string },
    action: () => { result: T; object_id: string },
  ): T {
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
  /** Bounded keyset pagination for the separately authorized management UI. */
  catalog(
    context: unknown,
    value: unknown,
  ): {
    products: ProductRecord[];
    next: string | null;
  } {
    const input = parse(
      z.strictObject({
        after: id.optional(),
        limit: z.number().int().min(1).max(100),
      }),
      value,
    );
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "catalog");
      const rows = this.#db
        .prepare(
          "SELECT product_id,agent_name,created_at FROM hab_products WHERE product_id>? ORDER BY product_id LIMIT ?",
        )
        .all(input.after ?? "", input.limit + 1) as unknown as ProductRecord[];
      const products = rows.slice(0, input.limit);
      return {
        products,
        next: rows.length > input.limit ? products.at(-1)!.product_id : null,
      };
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
  inspectBinding(context: unknown, bindingId: string): BindingRecord {
    parse(id, bindingId);
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "inspect");
      return this.#binding(bindingId);
    });
  }
  /** A comparison digest, not a credential or a substitute for fresh verification. */
  inspectConnection(
    context: unknown,
    individualContext: unknown,
  ): { connection_fingerprint: string } {
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "bind");
      return {
        connection_fingerprint: this.#principalHash(
          this.#verified(individualContext).principal,
        ),
      };
    });
  }
  /** Management flow supplies an opaque host context, never pasted principal claims. */
  bindVerified(
    context: unknown,
    value: unknown,
    individualContext: unknown,
  ): BindingRecord {
    const input = parse(
      z.strictObject({
        request_id: id,
        agent_id: id,
        expected_epoch: epoch,
        connection_fingerprint: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
      }),
      value,
    );
    this.#assertReady();
    return this.#tx(() => {
      this.#admin(context, "bind");
      const individual = this.#verified(individualContext);
      if (
        this.#principalHash(individual.principal) !==
        input.connection_fingerprint
      )
        throw new RegistryError("registry_connection_changed");
      // Same canonical request as the existing trusted-host bind port.
      const prepared = {
        request_id: input.request_id,
        agent_id: input.agent_id,
        expected_epoch: input.expected_epoch,
        principal: individual.principal,
      };
      return this.#mutateLocked(context, "bind", prepared, () =>
        this.#createBinding(prepared),
      );
    });
  }
  bind(context: unknown, value: unknown): BindingRecord {
    const input = parse(bindingInput, value);
    return this.#mutate(context, "bind", input, () =>
      this.#createBinding(input),
    );
  }
  #createBinding(input: z.infer<typeof bindingInput>): {
    result: BindingRecord;
    object_id: string;
  } {
    this.#expected(input.agent_id, input.expected_epoch);
    const fingerprint = this.#principalHash(input.principal);
    if (
      this.#groupsPresent &&
      (this.#db
        .prepare("SELECT 1 FROM hab_auth_group_bindings WHERE fingerprint=?")
        .get(fingerprint) ||
        this.#db
          .prepare("SELECT 1 FROM hab_auth_group_members WHERE agent_id=?")
          .get(input.agent_id))
    )
      throw new RegistryError("registry_binding_reserved");
    if (
      this.#db
        .prepare("SELECT 1 FROM hab_bindings WHERE fingerprint=?")
        .get(fingerprint)
    )
      throw new RegistryError("registry_binding_reserved");
    this.#bindingCapacity();
    const bindingId = randomUUID();
    this.#db
      .prepare("INSERT INTO hab_bindings VALUES(?,?,?,'active',?,NULL)")
      .run(bindingId, input.agent_id, fingerprint, this.#iso());
    this.#bump(input.agent_id);
    return { result: this.#binding(bindingId), object_id: bindingId };
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
          .get(input.agent_id) &&
        !(
          this.#options.authentication_groups === true &&
          this.#groupsPresent &&
          this.#db
            .prepare(
              "SELECT 1 FROM hab_auth_group_members m JOIN hab_auth_group_bindings b USING(group_id) JOIN hab_auth_groups g USING(group_id) WHERE m.agent_id=? AND b.state='active' AND g.state!='retired'",
            )
            .get(input.agent_id)
        )
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
  #verified(context: unknown) {
    let individual;
    try {
      const value = this.#authority.individual?.(context);
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw Error();
      }
      individual = verifiedSchema.parse(value);
    } catch {
      throw new RegistryError("registry_forbidden");
    }
    const expiry = Date.parse(individual.expires_at),
      now = this.#now();
    if (
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== individual.expires_at ||
      expiry <= now ||
      expiry - now > this.#options.max_context_ms
    )
      throw new RegistryError("registry_forbidden");
    return individual;
  }
  #blocked(sender: string, recipient: string): boolean {
    return !!this.#db
      .prepare("SELECT 1 FROM hab_blocks WHERE sender_id=? AND recipient_id=?")
      .get(sender, recipient);
  }
  #peer(agentId: string): AgentRecord {
    const agent = this.#agent(agentId);
    if (agent.state !== "active") throw new RelayError("forbidden");
    if (this.#groupsPresent) {
      const member = this.#db
        .prepare("SELECT group_id FROM hab_auth_group_members WHERE agent_id=?")
        .get(agentId);
      if (
        member &&
        (this.#options.authentication_groups !== true ||
          this.#group(String(member.group_id)).state !== "active" ||
          !this.#db
            .prepare(
              "SELECT 1 FROM hab_auth_group_bindings WHERE group_id=? AND state='active'",
            )
            .get(member.group_id))
      )
        throw new RelayError("forbidden");
    }
    return agent;
  }
  #requireGroups() {
    this.#assertReady();
    if (this.#options.authentication_groups !== true || !this.#groupsPresent)
      throw new RegistryError("registry_groups_disabled");
  }
  #group(groupId: string): AuthenticationGroup {
    const row = this.#db
      .prepare("SELECT * FROM hab_auth_groups WHERE group_id=?")
      .get(groupId);
    if (!row) throw new RegistryError("registry_not_found");
    return parse(
      z.strictObject({
        group_id: id,
        state: z.enum(["waiting_connection", "active", "stopped", "retired"]),
        epoch,
        operations: rights,
        created_at: z.string(),
      }),
      { ...row, operations: JSON.parse(String(row.operations)) },
    );
  }
  #expectedGroup(groupId: string, expected: number) {
    const group = this.#group(groupId);
    if (group.epoch !== expected)
      throw new RegistryError("registry_stale_epoch");
    if (group.state === "retired") throw new RegistryError("registry_retired");
    if (group.epoch >= Number.MAX_SAFE_INTEGER)
      throw new RegistryError("registry_unavailable");
    return group;
  }
  #bumpGroup(groupId: string) {
    this.#db
      .prepare("UPDATE hab_auth_groups SET epoch=epoch+1 WHERE group_id=?")
      .run(groupId);
  }
  #bindingCapacity() {
    const legacy = Number(
      this.#db.prepare("SELECT count(*) n FROM hab_bindings").get()!.n,
    );
    const groups = this.#groupsPresent
      ? Number(
          this.#db
            .prepare("SELECT count(*) n FROM hab_auth_group_bindings")
            .get()!.n,
        )
      : 0;
    if (legacy + groups >= this.#options.max_bindings)
      throw new RegistryError("registry_capacity_exceeded");
  }
  createGroup(context: unknown, value: unknown): AuthenticationGroup {
    const input = parse(z.strictObject({ request_id: id }), value);
    this.#requireGroups();
    return this.#mutate(context, "group_create", input, () => {
      this.#capacity("hab_auth_groups", this.#options.max_agents);
      const groupId = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO hab_auth_groups VALUES(?,'waiting_connection',1,'[]',?)",
        )
        .run(groupId, this.#iso());
      return { result: this.#group(groupId), object_id: groupId };
    });
  }
  inspectGroup(context: unknown, groupId: string): AuthenticationGroup {
    parse(id, groupId);
    this.#requireGroups();
    return this.#tx(() => {
      this.#admin(context, "inspect");
      return this.#group(groupId);
    });
  }
  #groupBinding(bindingId: string): GroupBinding {
    const row = this.#db
      .prepare(
        "SELECT binding_id,group_id,state,created_at,revoked_at FROM hab_auth_group_bindings WHERE binding_id=?",
      )
      .get(bindingId);
    if (!row) throw new RegistryError("registry_not_found");
    return parse(
      z.strictObject({
        binding_id: id,
        group_id: id,
        state: z.enum(["active", "revoked"]),
        created_at: z.string(),
        revoked_at: z.string().nullable(),
        group_epoch: epoch,
      }),
      { ...row, group_epoch: this.#group(String(row.group_id)).epoch },
    );
  }
  #createGroupBinding(input: z.infer<typeof groupBindingInput>) {
    this.#expectedGroup(input.group_id, input.expected_epoch);
    const fingerprint = this.#principalHash(input.principal);
    if (
      this.#db
        .prepare("SELECT 1 FROM hab_bindings WHERE fingerprint=?")
        .get(fingerprint) ||
      this.#db
        .prepare("SELECT 1 FROM hab_auth_group_bindings WHERE fingerprint=?")
        .get(fingerprint)
    )
      throw new RegistryError("registry_binding_reserved");
    this.#bindingCapacity();
    const bindingId = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO hab_auth_group_bindings VALUES(?,?,?,'active',?,NULL)",
      )
      .run(bindingId, input.group_id, fingerprint, this.#iso());
    this.#bumpGroup(input.group_id);
    return { result: this.#groupBinding(bindingId), object_id: bindingId };
  }
  /** Trusted administration port; never exposed as a delivery MCP tool. */
  bindGroup(context: unknown, value: unknown): GroupBinding {
    const input = parse(groupBindingInput, value);
    this.#requireGroups();
    return this.#mutate(context, "group_bind", input, () =>
      this.#createGroupBinding(input),
    );
  }
  bindGroupVerified(
    context: unknown,
    value: unknown,
    connectionContext: unknown,
  ): GroupBinding {
    const input = parse(
      z.strictObject({
        request_id: id,
        group_id: id,
        expected_epoch: epoch,
        connection_fingerprint: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
      }),
      value,
    );
    this.#requireGroups();
    return this.#tx(() => {
      this.#admin(context, "group_bind");
      const verified = this.#verified(connectionContext);
      if (
        this.#principalHash(verified.principal) !== input.connection_fingerprint
      )
        throw new RegistryError("registry_connection_changed");
      const prepared = {
        request_id: input.request_id,
        group_id: input.group_id,
        expected_epoch: input.expected_epoch,
        principal: verified.principal,
      };
      return this.#mutateLocked(context, "group_bind", prepared, () =>
        this.#createGroupBinding(prepared),
      );
    });
  }
  addGroupMember(context: unknown, value: unknown) {
    const input = parse(groupMemberInput, value);
    this.#requireGroups();
    return this.#mutate(context, "group_member", input, () => {
      this.#expectedGroup(input.group_id, input.expected_group_epoch);
      this.#expected(input.agent_id, input.expected_epoch);
      if (
        this.#db
          .prepare("SELECT 1 FROM hab_auth_group_members WHERE agent_id=?")
          .get(input.agent_id) ||
        this.#db
          .prepare(
            "SELECT 1 FROM hab_bindings WHERE agent_id=? AND state='active'",
          )
          .get(input.agent_id)
      )
        throw new RegistryError("registry_binding_reserved");
      this.#capacity("hab_auth_group_members", this.#options.max_agents);
      this.#db
        .prepare("INSERT INTO hab_auth_group_members VALUES(?,?,?)")
        .run(input.agent_id, input.group_id, this.#iso());
      this.#bump(input.agent_id);
      this.#bumpGroup(input.group_id);
      return {
        result: {
          group_id: input.group_id,
          agent_id: input.agent_id,
          agent_epoch: this.#agent(input.agent_id).epoch,
          group_epoch: this.#group(input.group_id).epoch,
        },
        object_id: input.agent_id,
      };
    });
  }
  setGroupAccess(context: unknown, value: unknown): AuthenticationGroup {
    const input = parse(groupAccessInput, value);
    this.#requireGroups();
    return this.#mutate(context, "group_access", input, () => {
      this.#expectedGroup(input.group_id, input.expected_epoch);
      if (input.state !== "active" && input.operations.length)
        throw new RegistryError("invalid_registry_request");
      if (
        input.state === "active" &&
        !this.#db
          .prepare(
            "SELECT 1 FROM hab_auth_group_bindings WHERE group_id=? AND state='active'",
          )
          .get(input.group_id)
      )
        throw new RegistryError("registry_binding_required");
      if (input.state === "retired")
        this.#db
          .prepare(
            "UPDATE hab_auth_group_bindings SET state='revoked',revoked_at=? WHERE group_id=? AND state='active'",
          )
          .run(this.#iso(), input.group_id);
      this.#db
        .prepare(
          "UPDATE hab_auth_groups SET state=?,operations=?,epoch=epoch+1 WHERE group_id=?",
        )
        .run(input.state, JSON.stringify(input.operations), input.group_id);
      return { result: this.#group(input.group_id), object_id: input.group_id };
    });
  }
  revokeGroupBinding(context: unknown, value: unknown): GroupBinding {
    const input = parse(revokeInput, value);
    this.#requireGroups();
    return this.#mutate(context, "group_revoke", input, () => {
      const binding = this.#groupBinding(input.binding_id);
      this.#expectedGroup(binding.group_id, input.expected_epoch);
      if (binding.state !== "active")
        throw new RegistryError("registry_binding_revoked");
      this.#db
        .prepare(
          "UPDATE hab_auth_group_bindings SET state='revoked',revoked_at=? WHERE binding_id=?",
        )
        .run(this.#iso(), input.binding_id);
      this.#bumpGroup(binding.group_id);
      if (
        !this.#db
          .prepare(
            "SELECT 1 FROM hab_auth_group_bindings WHERE group_id=? AND state='active'",
          )
          .get(binding.group_id)
      )
        this.#db
          .prepare(
            "UPDATE hab_auth_groups SET state='stopped',operations='[]' WHERE group_id=?",
          )
          .run(binding.group_id);
      return {
        result: this.#groupBinding(input.binding_id),
        object_id: input.binding_id,
      };
    });
  }
  /** Selection is untrusted until withRelay verifies its group membership under the registry lock. */
  selectAddress(context: unknown, address: string): unknown {
    const canonical = parseHabAddress(address).address;
    if (context && typeof context === "object" && this.#selections.has(context))
      throw new RelayError("forbidden");
    const selected = Object.freeze({});
    this.#selections.set(selected, { context, address: canonical });
    return selected;
  }
  groupAuthorizations(context: unknown, value: unknown) {
    const input = parse(
      z.strictObject({
        group_id: id,
        after_id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        limit: z.number().int().min(1).max(100),
      }),
      value,
    );
    this.#requireGroups();
    return this.#tx(() => {
      this.#admin(context, "inspect");
      this.#group(input.group_id);
      return this.#db
        .prepare(
          "SELECT id,at,group_id,agent_id,operation FROM hab_auth_group_authorizations WHERE group_id=? AND id>? ORDER BY id LIMIT ?",
        )
        .all(input.group_id, input.after_id, input.limit);
    });
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
        const selected =
          context && typeof context === "object"
            ? this.#selections.get(context)
            : undefined;
        individual = this.#verified(selected ? selected.context : context);
      } catch {
        throw new RelayError("forbidden");
      }
      const expiry = Date.parse(individual.expires_at);
      const binding = this.#db
        .prepare(
          "SELECT * FROM hab_bindings WHERE fingerprint=? AND state='active'",
        )
        .get(this.#principalHash(individual.principal)) as
        BindingRow | undefined;
      const selected =
        context && typeof context === "object"
          ? this.#selections.get(context)
          : undefined;
      let group: AuthenticationGroup | undefined;
      let local: AgentRecord;
      if (binding) {
        local = this.#peer(binding.agent_id);
        if (selected && local.address !== selected.address)
          throw new RelayError("forbidden");
      } else {
        if (
          this.#options.authentication_groups !== true ||
          !this.#groupsPresent
        )
          throw new RelayError("forbidden");
        const shared = this.#db
          .prepare(
            "SELECT group_id FROM hab_auth_group_bindings WHERE fingerprint=? AND state='active'",
          )
          .get(this.#principalHash(individual.principal));
        if (!shared) throw new RelayError("forbidden");
        group = this.#group(String(shared.group_id));
        if (
          group.state !== "active" ||
          !group.operations.includes(operation) ||
          (operation === "resolve" && !group.operations.includes("submit"))
        )
          throw new RelayError("forbidden");
        const members = selected
          ? this.#db
              .prepare(
                "SELECT m.agent_id FROM hab_auth_group_members m JOIN hab_agents a USING(agent_id) WHERE m.group_id=? AND a.address=?",
              )
              .all(group.group_id, selected.address)
          : this.#db
              .prepare(
                "SELECT agent_id FROM hab_auth_group_members WHERE group_id=? LIMIT 2",
              )
              .all(group.group_id);
        if (members.length !== 1) throw new RelayError("forbidden");
        local = this.#peer(String(members[0].agent_id));
      }
      const policyEpoch = this.#globalEpoch();
      if (
        !local.operations.includes(operation) ||
        (operation === "resolve" && !local.operations.includes("submit"))
      )
        throw new RelayError("forbidden");
      if (group) {
        this.#capacity(
          "hab_auth_group_authorizations",
          this.#options.max_audit_records,
        );
        this.#db
          .prepare(
            "INSERT INTO hab_auth_group_authorizations(at,group_id,agent_id,operation) VALUES(?,?,?,?)",
          )
          .run(this.#iso(), group.group_id, local.agent_id, operation);
      }
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
