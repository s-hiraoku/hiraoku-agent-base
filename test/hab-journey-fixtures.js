/** Entirely synthetic lifecycle; no existing configuration, service or credential is read. */
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { SQLiteEnrollmentJournal } from "../src/hab/sqlite-enrollment-journal.ts";
import { runHabEnrollment } from "../src/hab/enrollment.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { options, operations, principal } from "./hab-registry-fixtures.js";
import { limits, message } from "./relay-http-fixtures.js";
import { setup } from "./hab-http-fixtures.js";

export async function journey(t, productNames = ["grok-bot", "dot", "hermes"]) {
  const dir = mkdtempSync(join(tmpdir(), "hab-journey-"));
  chmodSync(dir, 0o700);
  const admin = Symbol("synthetic-administrator"),
    contexts = {},
    identities = new Map(),
    tokens = new Map();
  const authority = {
    administrator: (ctx) =>
      ctx === admin ? { actor_id: "synthetic-administrator" } : undefined,
    individual: (ctx) =>
      identities.has(ctx)
        ? {
            principal: identities.get(ctx),
            expires_at: new Date(Date.now() + 30000).toISOString(),
          }
        : undefined,
  };
  const addIdentity = (name) => {
    const ctx = Symbol(`synthetic-${name}`);
    contexts[name] = ctx;
    identities.set(ctx, principal(name));
    tokens.set(`Bearer fixture-${name}`, ctx);
    return ctx;
  };
  for (const name of ["a", "b", "c"]) addIdentity(name);
  const events = [],
    choices = [],
    agents = {},
    products = {};
  let registry, store, journal;
  const opened = new Set();
  const track = (s) => {
    opened.add(s);
    return s;
  };
  const close = (s) => {
    s.close();
    opened.delete(s);
  };
  const open = () => {
    registry = track(
      new SQLiteHabRegistry(join(dir, "registry.sqlite"), options, authority),
    );
    registry.migrate();
    store = track(
      new SQLiteRelayStore(join(dir, "relay.sqlite"), {
        fingerprint_key: new Uint8Array(32).fill(43),
        max_pending: 20,
        max_records: 100,
        max_pending_per_recipient: 10,
        max_body_bytes: 100000,
        max_clock_skew_ms: 1000,
        lease_ms: 30000,
        max_attempts: 3,
        retry_base_ms: 10,
        retry_cap_ms: 100,
        poll_scan_limit: 20,
      }),
    );
    store.migrate();
    journal = track(
      new SQLiteEnrollmentJournal(join(dir, "enrollment.sqlite"), {
        max_sessions: 10,
        busy_timeout_ms: 100,
      }),
    );
    journal.migrate();
  };
  // One hook owns cleanup, including partially completed setup.
  let net;
  t.after(async () => {
    await net?.dispose();
    for (const s of opened) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  open();
  for (const agent_name of new Set(productNames))
    products[agent_name] = registry.registerProduct(admin, {
      request_id: `product-${agent_name}`,
      agent_name,
    });
  const run = async (name, ui = {}) => {
    const product = products[productNames[["a", "b", "c"].indexOf(name)]];
    const result = await runHabEnrollment(
      {
        registry,
        journal,
        managementContext: () => admin,
        connection: async () => ({
          context: contexts[name],
          label: `Synthetic ${name}`,
        }),
        ui: {
          product: async () => product.product_id,
          botName: async () => name,
          confirm: async (p) => {
            choices.push({ name, kind: p.kind });
            return true;
          },
          operations: async () => [...operations],
          ...ui,
        },
      },
      `flow-${name}`,
    );
    const saved = journal.load(`flow-${name}`)?.checkpoint;
    if (saved && "agent_id" in saved)
      agents[name] = registry.inspect(admin, saved.agent_id);
    return result;
  };
  const hab = () => new HabRelayService(registry, store, limits);
  const f = {
    dir,
    audit: {
      record: (category, correlation) => events.push({ category, correlation }),
    },
    verifier: ({ authorization }) => tokens.get(authorization) ?? null,
  };
  net = await setup(t, f, hab());
  const raw = (file, callback) => {
    const db = new DatabaseSync(join(dir, file));
    chmodSync(join(dir, file), 0o600);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  };
  let sequence = 0;
  return {
    dir,
    admin,
    contexts,
    identities,
    tokens,
    agents,
    events,
    choices,
    net,
    run,
    addIdentity,
    get registry() {
      return registry;
    },
    get journal() {
      return journal;
    },
    get store() {
      return store;
    },
    client: (name, fetch = globalThis.fetch) =>
      net.clients(name, agents[name], fetch),
    raw,
    count: (table) =>
      raw(table.startsWith("hab_") ? "registry.sqlite" : "relay.sqlite", (db) =>
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n),
      ),
    async enrollAll() {
      for (const name of ["a", "b", "c"]) await run(name);
    },
    async restart() {
      await net.stop();
      close(journal);
      close(registry);
      close(store);
      open();
      await net.start(hab());
    },
    makeMessage(to, patch = {}) {
      sequence++;
      return {
        ...message(sequence.toString(16).padStart(32, "0")),
        recipient_id: agents[to].agent_id,
        thread_id: `journey-thread-${sequence}`,
        ...patch,
      };
    },
    // Fault injection only in newly created test DBs; never alter original payload IDs/deadlines.
    dueOutbox(name) {
      raw(`outbox-${name}.sqlite`, (db) =>
        db.exec("UPDATE relay_outbox SET next_retry_at=0"),
      );
    },
    dueAck(name) {
      raw(`inbox-${name}.sqlite`, (db) =>
        db.exec("UPDATE relay_receiver_acks SET next_retry_at=0"),
      );
    },
    expireLeases() {
      raw("relay.sqlite", (db) =>
        db.exec(
          "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0 WHERE state='leased'",
        ),
      );
    },
  };
}
