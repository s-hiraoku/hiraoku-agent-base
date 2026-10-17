import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { habAddress, parseHabAddress } from "../src/hab/registry.ts";
import {
  fixture,
  options,
  principal,
  code,
  operations,
} from "./hab-registry-fixtures.js";

test("version-1 names are canonical ASCII slugs; address parser never normalizes or routes DNS", () => {
  assert.equal(habAddress("research", "grok-bot"), "research@grok-bot.hab");
  assert.equal(parseHabAddress("a@grok-bot.hab").normalization_version, 1);
  assert.equal(habAddress("x".repeat(48), "y".repeat(48)).length, 101);
  for (const s of [
    "A",
    "日本語",
    "a_b",
    "a.b",
    " a",
    "a ",
    "-a",
    "a-",
    "x".repeat(49),
    "a@b",
    "a\nb",
    "",
  ])
    assert.throws(
      () => habAddress(s, "grok-bot"),
      code("invalid_registry_request"),
    );
  for (const s of [
    "a@Grok-bot.hab",
    "a@grok-bot.HAB",
    "a@grok-bot.hab.",
    "a@grok-bot.hab/path",
    "a@grok-bot.hab?x",
    "a@@grok-bot.hab",
    "a@grok-bot",
    "a@grok-bot.hab ",
  ])
    assert.throws(() => parseHabAddress(s), code("invalid_registry_request"));
});

test("preview is read-only, enrollment atomically reserves immutable names and starts without rights", (t) => {
  const f = fixture(t),
    before = f.registryRaw
      .prepare("SELECT epoch FROM hab_registry_meta")
      .get().epoch;
  const proposal = f.registry.preview(f.admin, {
    product_id: f.product.product_id,
    bot_name: "research",
  });
  assert.deepEqual(proposal, {
    bot_name: "research",
    agent_name: "grok-bot",
    address: "research@grok-bot.hab",
    normalization_version: 1,
    available: true,
  });
  assert.equal(
    f.registryRaw.prepare("SELECT epoch FROM hab_registry_meta").get().epoch,
    before,
  );
  const a = f.enroll("research", false);
  assert.equal(a.address, proposal.address);
  assert.equal(a.state, "waiting_connection");
  assert.deepEqual(a.operations, []);
  assert.equal(a.epoch, 1);
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: f.product.product_id,
      bot_name: "research",
    }).available,
    false,
  );
  assert.throws(
    () =>
      f.registry.enroll(f.admin, {
        request_id: "duplicate",
        product_id: f.product.product_id,
        bot_name: "research",
      }),
    code("registry_name_reserved"),
  );
  for (const patch of [
    { agent_id: "chosen" },
    { address: "other@grok-bot.hab" },
    { agent_name: "hermes" },
  ])
    assert.throws(
      () =>
        f.registry.enroll(f.admin, {
          request_id: "bad",
          product_id: f.product.product_id,
          bot_name: "other",
          ...patch,
        }),
      code("invalid_registry_request"),
    );
});

test("only catalog product selects agent_name; same bot name on different products is a different permanent individual", (t) => {
  const f = fixture(t),
    second = f.registry.registerProduct(f.admin, {
      request_id: "product-hermes",
      agent_name: "hermes",
    });
  const a = f.enroll("lab", false),
    b = f.registry.enroll(f.admin, {
      request_id: "second-lab",
      product_id: second.product_id,
      bot_name: "lab",
    });
  assert.notEqual(a.agent_id, b.agent_id);
  assert.equal(b.address, "lab@hermes.hab");
  assert.throws(
    () =>
      f.registry.registerProduct(f.admin, {
        request_id: "duplicate-product",
        agent_name: "grok-bot",
      }),
    code("registry_name_reserved"),
  );
  assert.throws(
    () =>
      f.registry.enroll(f.admin, {
        request_id: "unknown-product",
        product_id: "unregistered",
        bot_name: "lab",
      }),
    code("registry_not_found"),
  );
});

test("registration retry survives reopen with same ID and conflicts on changed content", (t) => {
  const f = fixture(t),
    input = {
      request_id: "same-request",
      product_id: f.product.product_id,
      bot_name: "a",
    };
  const a = f.registry.enroll(f.admin, input),
    reopened = f.open();
  reopened.migrate();
  assert.deepEqual(reopened.enroll(f.admin, { bot_name: "a", ...input }), a);
  assert.throws(
    () => reopened.enroll(f.admin, { ...input, bot_name: "b" }),
    code("registry_idempotency_conflict"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_agents").get().n,
    1,
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_registry_audit").get().n,
    2,
  );
});

test("management authority is separate, rechecked on exact retries, operation-specific and absent by default", (t) => {
  const f = fixture(t),
    request = {
      request_id: "enroll-a",
      product_id: f.product.product_id,
      bot_name: "a",
    };
  f.registry.enroll(f.admin, request);
  for (const context of [
    null,
    f.contexts.a,
    "administrator",
    { actor_id: "administrator" },
  ])
    assert.throws(
      () => f.registry.enroll(context, request),
      code("registry_forbidden"),
    );
  f.mutable.admin = false;
  assert.throws(
    () => f.registry.enroll(f.admin, request),
    code("registry_forbidden"),
  );
  f.mutable.admin = true;
  f.mutable.denied.add("preview");
  assert.throws(
    () =>
      f.registry.preview(f.admin, {
        product_id: f.product.product_id,
        bot_name: "a",
      }),
    code("registry_forbidden"),
  );
  const missing = f.open({}, {});
  missing.migrate();
  assert.throws(
    () => missing.enroll(f.admin, request),
    code("registry_forbidden"),
  );
  const throwing = f.open(
    {},
    {
      administrator() {
        throw Error("synthetic private failure");
      },
    },
  );
  throwing.migrate();
  assert.throws(
    () => throwing.enroll(f.admin, request),
    code("registry_forbidden"),
  );
});

test("binding and activation require distinct authorized steps and stale epochs cannot mutate state", (t) => {
  const f = fixture(t),
    a = f.enroll("a", false);
  const activate = {
    request_id: "access-a",
    agent_id: a.agent_id,
    expected_epoch: 1,
    state: "active",
    operations,
  };
  assert.throws(
    () => f.registry.setAccess(f.admin, activate),
    code("registry_binding_required"),
  );
  const bind = {
    request_id: "bind-a",
    agent_id: a.agent_id,
    expected_epoch: 1,
    principal: principal("a"),
  };
  const b = f.registry.bind(f.admin, bind);
  assert.equal(
    f.registry.inspect(f.admin, a.agent_id).state,
    "waiting_connection",
  );
  assert.deepEqual(f.registry.bind(f.admin, bind), b);
  assert.throws(
    () => f.registry.setAccess(f.admin, activate),
    code("registry_stale_epoch"),
  );
  const active = f.registry.setAccess(f.admin, {
    ...activate,
    expected_epoch: 2,
  });
  assert.equal(active.state, "active");
  assert.equal(active.epoch, 3);
  assert.throws(
    () =>
      f.registry.setAccess(f.admin, {
        ...activate,
        request_id: "stale",
        expected_epoch: 2,
      }),
    code("registry_stale_epoch"),
  );
  assert.throws(
    () =>
      f.registry.setAccess(f.admin, {
        ...activate,
        request_id: "bad-right",
        expected_epoch: 3,
        operations: ["maintenance"],
      }),
    code("invalid_registry_request"),
  );
});

test("full principal tuple is exclusive and never rebound, including after revocation", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b", false),
    binding = f.bindings.get("a");
  assert.throws(
    () =>
      f.registry.bind(f.admin, {
        request_id: "steal",
        agent_id: b.agent_id,
        expected_epoch: 1,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
  const input = {
    request_id: "revoke-a",
    binding_id: binding.binding_id,
    expected_epoch: a.epoch,
  };
  const revoked = f.registry.revoke(f.admin, input);
  assert.equal(revoked.state, "revoked");
  assert.deepEqual(f.registry.revoke(f.admin, input), revoked);
  assert.equal(f.registry.inspect(f.admin, a.agent_id).state, "stopped");
  assert.throws(
    () =>
      f.registry.bind(f.admin, {
        request_id: "reuse",
        agent_id: b.agent_id,
        expected_epoch: 1,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
  const fresh = f.registry.bind(f.admin, {
    request_id: "rotate",
    agent_id: a.agent_id,
    expected_epoch: revoked.agent_epoch,
    principal: principal("a", { connection_id: "verified-a-rotated" }),
  });
  assert.notEqual(fresh.binding_id, binding.binding_id);
  assert.equal(f.registry.inspect(f.admin, a.agent_id).state, "stopped");
  assert.throws(
    () =>
      f.registry.bind(f.admin, {
        request_id: "owner-only",
        agent_id: b.agent_id,
        expected_epoch: 1,
        principal: {
          issuer: "https://issuer.example/",
          audience: "resource",
          subject: "owner",
          client_id: "shared",
        },
      }),
    code("invalid_registry_request"),
  );
});

test("retirement is terminal and database guards preserve ID/address/principal reservations", (t) => {
  const f = fixture(t),
    a = f.enroll("a");
  const retired = f.registry.setAccess(f.admin, {
    request_id: "retire-a",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    state: "retired",
    operations: [],
  });
  assert.throws(
    () =>
      f.registry.setAccess(f.admin, {
        request_id: "revive",
        agent_id: a.agent_id,
        expected_epoch: retired.epoch,
        state: "active",
        operations,
      }),
    code("registry_retired"),
  );
  assert.throws(
    () =>
      f.registry.enroll(f.admin, {
        request_id: "reassign",
        product_id: f.product.product_id,
        bot_name: "a",
      }),
    code("registry_name_reserved"),
  );
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: f.product.product_id,
      bot_name: "a",
    }).available,
    false,
  );
  for (const sql of [
    "DELETE FROM hab_agents",
    "UPDATE hab_agents SET bot_name='renamed'",
    "UPDATE hab_agents SET agent_id='renamed'",
    "DELETE FROM hab_bindings",
    "UPDATE hab_bindings SET fingerprint='rebound'",
    "UPDATE hab_products SET agent_name='other'",
    "DELETE FROM hab_products",
  ])
    assert.throws(() => f.registryRaw.exec(sql));
  const next = f.enroll("other", false);
  assert.notEqual(next.agent_id, a.agent_id);
});

test("management state, audit, idempotency receipt and epoch roll back together on storage failure", (t) => {
  const f = fixture(t),
    before = f.registryRaw
      .prepare("SELECT epoch FROM hab_registry_meta")
      .get().epoch;
  f.registryRaw.exec(
    "CREATE TRIGGER simulate_disk_full BEFORE INSERT ON hab_registry_audit BEGIN SELECT RAISE(ABORT,'synthetic private disk failure'); END",
  );
  const input = {
    request_id: "rollback",
    product_id: f.product.product_id,
    bot_name: "a",
  };
  assert.throws(
    () => f.registry.enroll(f.admin, input),
    code("registry_unavailable"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_agents").get().n,
    0,
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_admin_requests").get().n,
    1,
  );
  assert.equal(
    f.registryRaw.prepare("SELECT epoch FROM hab_registry_meta").get().epoch,
    before,
  );
  f.registryRaw.exec("DROP TRIGGER simulate_disk_full");
  assert.equal(f.registry.enroll(f.admin, input).address, "a@grok-bot.hab");
});

test("management storage contains no raw principal claims or input bodies in audit/request ledger", (t) => {
  const f = fixture(t);
  f.enroll("a");
  const rows = f.registryRaw.prepare("SELECT * FROM hab_registry_audit").all();
  assert.ok(
    rows.every((r) =>
      ["product", "enroll", "bind", "access"].includes(r.event),
    ),
  );
  const persisted = JSON.stringify([
    rows,
    f.registryRaw.prepare("SELECT * FROM hab_admin_requests").all(),
    f.registryRaw.prepare("SELECT * FROM hab_bindings").all(),
  ]);
  for (const s of [
    "shared-owner",
    "shared-client",
    "verified-a",
    "issuer.example",
    "Bearer",
    "principal",
    "connection_id",
  ])
    assert.equal(persisted.includes(s), false);
});

test("registry caps refuse growth, and exact requests recover even when capacity is full", (t) => {
  const f = fixture(t, { max_agents: 1, max_products: 1 });
  const a = f.enroll("a", false);
  assert.deepEqual(f.enroll("a", false), a);
  assert.throws(() => f.enroll("b", false), code("registry_capacity_exceeded"));
  assert.throws(
    () =>
      f.registry.registerProduct(f.admin, {
        request_id: "second",
        agent_name: "hermes",
      }),
    code("registry_capacity_exceeded"),
  );
  const capped = f.open({ max_requests: 2, max_audit_records: 2 });
  capped.migrate();
  assert.deepEqual(
    capped.enroll(f.admin, {
      request_id: "enroll-a",
      product_id: f.product.product_id,
      bot_name: "a",
    }),
    a,
  );
  assert.throws(
    () =>
      capped.enroll(f.admin, {
        request_id: "third",
        product_id: f.product.product_id,
        bot_name: "b",
      }),
    code("registry_capacity_exceeded"),
  );
});

test("file mode, key, schema and explicit migration are checked without changing other databases", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const unopened = f.open();
  assert.throws(
    () => unopened.inspect(f.admin, "a"),
    code("registry_not_migrated"),
  );
  const wrong = f.open({ fingerprint_key: new Uint8Array(32).fill(62) });
  assert.throws(() => wrong.migrate(), code("registry_key_mismatch"));
  f.registryRaw.exec("UPDATE hab_registry_meta SET version=2");
  assert.throws(() => unopened.migrate(), code("unsupported_registry_schema"));
  f.registryRaw.exec("UPDATE hab_registry_meta SET version=1");
  const unrelatedPath = join(f.dir, "unrelated.sqlite"),
    unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec("CREATE TABLE user_data(id INTEGER)");
  unrelated.close();
  chmodSync(unrelatedPath, 0o600);
  const other = new SQLiteHabRegistry(unrelatedPath, options);
  assert.throws(() => other.migrate(), code("unknown_registry_schema"));
  other.close();
  const link = join(f.dir, "symlink.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new SQLiteHabRegistry(link, options));
  chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), code("insecure_registry_file"));
  chmodSync(f.path, 0o600);
});

test("unsafe or implicit policy is refused before opening a registry", () => {
  for (const patch of [
    { max_agents: Infinity },
    { max_requests: 0 },
    { busy_timeout_ms: 1001 },
    { max_context_ms: 300001 },
    { allowed_kinds: [] },
    { allowed_kinds: ["question", "question"] },
    { fingerprint_key: new Uint8Array(1) },
  ])
    assert.throws(
      () => new SQLiteHabRegistry(":memory:", { ...options, ...patch }),
      code("invalid_registry_options"),
    );
});

test("binding reservations keep consuming quota after revocation, while explicit unblock frees a block slot", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    c = f.enroll("c");
  const capped = f.open({ max_bindings: 3, max_blocks: 1 });
  capped.migrate();
  const revoked = capped.revoke(f.admin, {
    request_id: "revoke-cap",
    binding_id: f.bindings.get("c").binding_id,
    expected_epoch: c.epoch,
  });
  assert.throws(
    () =>
      capped.bind(f.admin, {
        request_id: "rotate-cap",
        agent_id: c.agent_id,
        expected_epoch: revoked.agent_epoch,
        principal: principal("c", { connection_id: "rotated-c" }),
      }),
    code("registry_capacity_exceeded"),
  );
  capped.setBlock(f.admin, {
    request_id: "block-one",
    sender_id: a.agent_id,
    recipient_id: b.agent_id,
    sender_epoch: a.epoch,
    recipient_epoch: b.epoch,
    blocked: true,
  });
  let currentA = capped.inspect(f.admin, a.agent_id),
    currentB = capped.inspect(f.admin, b.agent_id),
    currentC = capped.inspect(f.admin, c.agent_id);
  assert.throws(
    () =>
      capped.setBlock(f.admin, {
        request_id: "block-overflow",
        sender_id: a.agent_id,
        recipient_id: c.agent_id,
        sender_epoch: currentA.epoch,
        recipient_epoch: currentC.epoch,
        blocked: true,
      }),
    code("registry_capacity_exceeded"),
  );
  capped.setBlock(f.admin, {
    request_id: "free-block",
    sender_id: a.agent_id,
    recipient_id: b.agent_id,
    sender_epoch: currentA.epoch,
    recipient_epoch: currentB.epoch,
    blocked: false,
  });
  currentA = capped.inspect(f.admin, a.agent_id);
  currentC = capped.inspect(f.admin, c.agent_id);
  assert.equal(
    capped.setBlock(f.admin, {
      request_id: "use-block",
      sender_id: a.agent_id,
      recipient_id: c.agent_id,
      sender_epoch: currentA.epoch,
      recipient_epoch: currentC.epoch,
      blocked: true,
    }).blocked,
    true,
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_blocks").get().n,
    1,
  );
});

test(
  "simultaneous enrollment from separate workers reserves one individual and recovers shared request",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    const run = (requestId) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(
          `
      const { parentPort,workerData }=require('node:worker_threads');
      (async()=>{ const {SQLiteHabRegistry}=await import(workerData.module);
      const r=new SQLiteHabRegistry(workerData.path,workerData.options,{administrator:()=>({actor_id:'administrator'})});
      try{r.migrate();parentPort.postMessage({result:r.enroll(null,workerData.input)});}catch(e){parentPort.postMessage({error:e.code});}finally{r.close();}})().catch(e=>{throw e});`,
          {
            eval: true,
            workerData: {
              module: new URL("../src/hab/sqlite-registry.ts", import.meta.url)
                .href,
              path: f.path,
              options: { ...options, busy_timeout_ms: 1000 },
              input: {
                request_id: requestId,
                product_id: f.product.product_id,
                bot_name: "concurrent",
              },
            },
          },
        );
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    const replies = await Promise.all([run("concurrent"), run("concurrent")]);
    assert.ok(replies.every((r) => r.result));
    assert.deepEqual(replies[0].result, replies[1].result);
    assert.equal(
      f.registryRaw.prepare("SELECT count(*) n FROM hab_agents").get().n,
      1,
    );
  },
);
