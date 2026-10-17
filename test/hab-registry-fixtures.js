import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { fixture as relayFixture, limits } from "./relay-http-fixtures.js";
export const options = {
  fingerprint_key: new Uint8Array(32).fill(61),
  max_products: 10,
  max_agents: 20,
  max_bindings: 40,
  max_requests: 200,
  max_blocks: 20,
  max_audit_records: 200,
  max_context_ms: 60000,
  busy_timeout_ms: 100,
  allowed_kinds: ["question", "answer", "notice"],
};
export const operations = ["submit", "status", "poll", "ack", "resolve"];
export function principal(name, patch = {}) {
  return {
    issuer: "https://issuer.example/",
    audience: "https://relay.example/mcp",
    subject: "shared-owner",
    client_id: "shared-client",
    connection_id: `verified-${name}`,
    ...patch,
  };
}
export const code = (wanted) => (e) =>
  e.code === wanted && e.message === wanted;
export function fixture(t, patch = {}) {
  const f = relayFixture(t),
    path = join(f.dir, "registry.sqlite"),
    admin = Symbol("management"),
    stores = new Set();
  const mutable = {
    admin: true,
    individual: true,
    expires_at: null,
    denied: new Set(),
  };
  const authority = {
    administrator(context, op) {
      return mutable.admin && context === admin && !mutable.denied.has(op)
        ? { actor_id: "administrator" }
        : undefined;
    },
    individual(context) {
      const name = Object.keys(f.contexts).find(
        (name) => f.contexts[name] === context,
      );
      return name && mutable.individual
        ? {
            principal: principal(name),
            expires_at:
              mutable.expires_at ?? new Date(Date.now() + 30000).toISOString(),
          }
        : undefined;
    },
  };
  const open = (config = {}, auth = authority) => {
    const registry = new SQLiteHabRegistry(
      path,
      { ...options, ...patch, ...config },
      auth,
    );
    stores.add(registry);
    return registry;
  };
  const registry = open();
  registry.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const product = registry.registerProduct(admin, {
    request_id: "product-grok",
    agent_name: "grok-bot",
  });
  const bindings = new Map();
  const enroll = (name, activate = true, selectedProduct = product) => {
    const agent = registry.enroll(admin, {
      request_id: `enroll-${name}`,
      product_id: selectedProduct.product_id,
      bot_name: name,
    });
    if (!activate) return agent;
    const binding = registry.bind(admin, {
      request_id: `bind-${name}`,
      agent_id: agent.agent_id,
      expected_epoch: agent.epoch,
      principal: principal(name),
    });
    bindings.set(name, binding);
    return registry.setAccess(admin, {
      request_id: `activate-${name}`,
      agent_id: agent.agent_id,
      expected_epoch: binding.agent_epoch,
      state: "active",
      operations,
    });
  };
  return {
    ...f,
    path,
    admin,
    mutable,
    authority,
    open,
    close,
    registry,
    registryRaw: raw,
    product,
    enroll,
    bindings,
    hab: new HabRelayService(registry, f.store, limits),
  };
}
