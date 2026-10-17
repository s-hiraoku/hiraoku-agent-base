import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  readFileSync,
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";
import { fixture, options, principal, code } from "./hab-registry-fixtures.js";
import {
  runHabEnrollment,
  parseEnrollmentCheckpoint,
} from "../src/hab/enrollment.ts";
import { SQLiteEnrollmentJournal } from "../src/hab/sqlite-enrollment-journal.ts";
import { enrollmentTerminalUI } from "../src/hab/enrollment-terminal.ts";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";

function setup(t, patch = {}, registryOptions = {}) {
  const f = fixture(t, registryOptions);
  const path = join(f.dir, "enrollment.sqlite");
  const journals = new Set();
  const open = () => {
    const store = new SQLiteEnrollmentJournal(path, {
      max_sessions: 10,
      busy_timeout_ms: 100,
    });
    store.migrate();
    journals.add(store);
    return store;
  };
  const close = (store) => {
    store.close();
    journals.delete(store);
  };
  t.after(() => {
    for (const journal of journals) journal.close();
  });
  const events = [];
  const host = {
    registry: f.registry,
    journal: open(),
    managementContext: () => f.admin,
    connection: async (expected) => {
      events.push(["connection", expected]);
      return { context: f.contexts.a, label: "Synthetic bot A" };
    },
    ui: {
      product: async () => {
        events.push(["product"]);
        return f.product.product_id;
      },
      botName: async () => {
        events.push(["name"]);
        return "research";
      },
      confirm: async (p) => {
        events.push(["confirm", p.kind]);
        return true;
      },
      operations: async () => {
        events.push(["operations"]);
        return ["submit", "status", "poll", "ack", "resolve"];
      },
      ...patch,
    },
  };
  const count = (table) =>
    Number(f.registryRaw.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  return {
    ...f,
    pathJournal: path,
    host,
    events,
    openJournal: open,
    closeJournal: close,
    count,
  };
}
test("enrollment: human choices reserve, bind and explicitly activate one immutable address", async (t) => {
  const f = setup(t);
  const result = await runHabEnrollment(f.host, "flow-1");
  assert.equal(result.status, "complete");
  assert.equal(result.agent.address, "research@grok-bot.hab");
  assert.equal(result.agent.state, "active");
  assert.equal(result.agent.epoch, 3);
  assert.deepEqual(
    f.events.filter((e) => e[0] === "confirm"),
    [
      ["confirm", "reserve"],
      ["confirm", "bind"],
      ["confirm", "activate"],
    ],
  );
  assert.deepEqual(f.host.journal.load("flow-1").checkpoint.operations, [
    "ack",
    "poll",
    "resolve",
    "status",
    "submit",
  ]);
  assert.equal(f.count("hab_agents"), 1);
  assert.equal(f.count("hab_bindings"), 1);
  const before = f.count("hab_admin_requests");
  f.events.length = 0;
  assert.deepEqual(await runHabEnrollment(f.host, "flow-1"), result);
  assert.equal(f.count("hab_admin_requests"), before);
  assert.deepEqual(f.events, []);
});
for (const kind of ["reserve", "bind", "activate"]) {
  test(`enrollment: refusal at ${kind} pauses without granting subsequent rights`, async (t) => {
    const f = setup(t, { confirm: async (p) => p.kind !== kind });
    const result = await runHabEnrollment(f.host, "pause");
    assert.equal(result.status, "paused");
    assert.equal(
      result.stage,
      { reserve: "unconfirmed", bind: "enrolled", activate: "bound" }[kind],
    );
    assert.equal(f.count("hab_agents"), kind === "reserve" ? 0 : 1);
    assert.equal(f.count("hab_bindings"), kind === "activate" ? 1 : 0);
    if (kind !== "reserve") {
      const saved = f.host.journal.load("pause").checkpoint;
      assert.equal(
        f.registry.inspect(f.admin, saved.agent_id).state,
        "waiting_connection",
      );
      assert.deepEqual(
        f.registry.inspect(f.admin, saved.agent_id).operations,
        [],
      );
      assert.equal(
        f.registry.preview(f.admin, {
          product_id: f.product.product_id,
          bot_name: "research",
        }).available,
        false,
      );
      f.host.ui.confirm = async () => true;
      const completed = await runHabEnrollment(f.host, "pause");
      assert.equal(completed.agent.agent_id, saved.agent_id);
    }
  });
}
for (const stage of ["enrolled", "bound", "complete"]) {
  test(`enrollment: restart recovers a committed operation before ${stage} checkpoint response`, async (t) => {
    const f = setup(t);
    const journal = f.host.journal;
    f.host.journal = {
      load: (id) => journal.load(id),
      save(id, revision, value) {
        if (value.stage === stage) throw Error("private journal failure");
        return journal.save(id, revision, value);
      },
    };
    await assert.rejects(
      runHabEnrollment(f.host, "restart"),
      code("enrollment_failed"),
    );
    assert.equal(f.count("hab_agents"), 1);
    const agentId = f.registryRaw
      .prepare("SELECT agent_id FROM hab_agents")
      .get().agent_id;
    f.closeJournal(journal);
    f.close(f.registry);
    f.host.journal = f.openJournal();
    f.host.registry = f.open();
    f.host.registry.migrate();
    f.events.length = 0;
    const result = await runHabEnrollment(f.host, "restart");
    assert.equal(result.agent.agent_id, agentId);
    assert.equal(result.agent.epoch, 3);
    assert.equal(f.count("hab_agents"), 1);
    assert.equal(f.count("hab_bindings"), 1);
    assert.equal(f.count("hab_admin_requests"), 4); // product + three human-confirmed mutations
    assert.equal(
      f.events.some((v) => v[0] === "product" || v[0] === "name"),
      false,
    );
    if (stage !== "enrolled")
      assert.equal(
        f.events.some((v) => v[0] === "confirm" && v[1] === "bind"),
        false,
      );
    if (stage === "complete") assert.deepEqual(f.events, []);
  });
}
for (const stage of ["enroll_pending", "bind_pending", "activation_pending"]) {
  test(`enrollment: journal refusal before ${stage} prevents that registry mutation`, async (t) => {
    const f = setup(t);
    const journal = f.host.journal;
    f.host.journal = {
      load: (id) => journal.load(id),
      save(id, rev, value) {
        if (value.stage === stage) throw Error("disk full");
        return journal.save(id, rev, value);
      },
    };
    await assert.rejects(
      runHabEnrollment(f.host, "before"),
      code("enrollment_failed"),
    );
    assert.equal(f.count("hab_agents"), stage === "enroll_pending" ? 0 : 1);
    assert.equal(
      f.count("hab_bindings"),
      stage === "activation_pending" ? 1 : 0,
    );
    assert.equal(
      f.registryRaw
        .prepare("SELECT count(*) n FROM hab_agents WHERE state='active'")
        .get().n,
      0,
    );
  });
}
test("enrollment: lost activation response followed by stop is not silently replayed as active", async (t) => {
  const f = setup(t);
  const journal = f.host.journal;
  f.host.journal = {
    load: (id) => journal.load(id),
    save(id, rev, cp) {
      if (cp.stage === "complete") throw Error();
      return journal.save(id, rev, cp);
    },
  };
  await assert.rejects(runHabEnrollment(f.host, "stopped"));
  const cp = journal.load("stopped").checkpoint;
  const active = f.registry.inspect(f.admin, cp.agent_id);
  f.registry.setAccess(f.admin, {
    request_id: "operator-stop",
    agent_id: active.agent_id,
    expected_epoch: active.epoch,
    state: "stopped",
    operations: [],
  });
  f.host.journal = journal;
  await assert.rejects(
    runHabEnrollment(f.host, "stopped"),
    code("enrollment_review_required"),
  );
  assert.equal(f.registry.inspect(f.admin, active.agent_id).state, "stopped");
});
test("enrollment: a changed or revoked binding after pause requires review", async (t) => {
  const f = setup(t, { confirm: async (p) => p.kind !== "activate" });
  await runHabEnrollment(f.host, "revoke");
  const cp = f.host.journal.load("revoke").checkpoint;
  f.registry.revoke(f.admin, {
    request_id: "operator-revoke",
    binding_id: cp.binding_id,
    expected_epoch: cp.expected_epoch,
  });
  f.host.ui.confirm = async () => true;
  await assert.rejects(
    runHabEnrollment(f.host, "revoke"),
    code("enrollment_review_required"),
  );
  assert.equal(f.registry.inspect(f.admin, cp.agent_id).state, "stopped");
});
test("enrollment: current management rights are rechecked after human confirmation and on restart", async (t) => {
  const f = setup(t, {
    confirm: async (p) => {
      if (p.kind === "reserve") f.mutable.denied.add("enroll");
      return true;
    },
  });
  await assert.rejects(
    runHabEnrollment(f.host, "revoked-admin"),
    code("registry_forbidden"),
  );
  assert.equal(f.count("hab_agents"), 0);
  assert.equal(
    f.host.journal.load("revoked-admin").checkpoint.stage,
    "enroll_pending",
  );
  f.mutable.admin = false;
  await assert.rejects(
    runHabEnrollment(f.host, "revoked-admin"),
    code("registry_forbidden"),
  );
  assert.deepEqual(
    f.events.filter((e) => e[0] === "connection"),
    [],
  );
});
test("enrollment: same proposed address won by a concurrent administrator does not retarget", async (t) => {
  const f = setup(t, {
    confirm: async (p) => {
      if (p.kind === "reserve") f.enroll("research", false);
      return true;
    },
  });
  await assert.rejects(
    runHabEnrollment(f.host, "collision"),
    code("registry_name_reserved"),
  );
  assert.equal(f.count("hab_agents"), 1);
  assert.equal(f.count("hab_bindings"), 0);
});
test("enrollment: confirmed connection cannot change even before its first bind commits", async (t) => {
  const f = setup(t, {
    confirm: async (p) => {
      if (p.kind === "bind") f.mutable.individual = false;
      return true;
    },
  });
  await assert.rejects(
    runHabEnrollment(f.host, "connection"),
    code("registry_forbidden"),
  );
  const cp = f.host.journal.load("connection").checkpoint;
  assert.equal(cp.stage, "bind_pending");
  f.mutable.individual = true;
  f.host.connection = async () => ({
    context: f.contexts.b,
    label: "Other bot",
  });
  await assert.rejects(
    runHabEnrollment(f.host, "connection"),
    code("registry_connection_changed"),
  );
  assert.equal(f.count("hab_bindings"), 0);
  f.host.connection = async () => ({
    context: f.contexts.a,
    label: "Original bot",
  });
  assert.equal(
    (await runHabEnrollment(f.host, "connection")).status,
    "complete",
  );
});
test("enrollment: stale activation confirmation cannot overwrite a later management action", async (t) => {
  const f = setup(t, {
    confirm: async (p) => {
      if (p.kind === "activate") {
        const cp = f.host.journal.load("race").checkpoint;
        f.registry.setAccess(f.admin, {
          request_id: "stop-between",
          agent_id: cp.agent_id,
          expected_epoch: cp.expected_epoch,
          state: "stopped",
          operations: [],
        });
      }
      return true;
    },
  });
  await assert.rejects(
    runHabEnrollment(f.host, "race"),
    code("registry_stale_epoch"),
  );
  const cp = f.host.journal.load("race").checkpoint;
  assert.equal(f.registry.inspect(f.admin, cp.agent_id).state, "stopped");
});
test("enrollment: select only approved product IDs, canonical bot names and explicit grants", async (t) => {
  const f = setup(t);
  f.host.ui.product = async () => "self-declared-product";
  await assert.rejects(
    runHabEnrollment(f.host, "invalid1"),
    code("invalid_enrollment_choice"),
  );
  f.host.ui.product = async () => f.product.product_id;
  f.host.ui.botName = async () => "Research";
  await assert.rejects(
    runHabEnrollment(f.host, "invalid2"),
    code("invalid_registry_request"),
  );
  f.host.ui.botName = async () => "research";
  f.host.ui.operations = async () => ["shell"];
  await assert.rejects(
    runHabEnrollment(f.host, "invalid3"),
    code("invalid_enrollment_choice"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT state FROM hab_agents").get().state,
    "waiting_connection",
  );
});
test("enrollment: checkpoint rejects embedded contexts, credentials, unknown fields and address changes", (t) => {
  const f = setup(t);
  const valid = {
    version: 1,
    flow_id: "one",
    product_id: f.product.product_id,
    agent_name: "grok-bot",
    bot_name: "one",
    address: "one@grok-bot.hab",
    stage: "enroll_pending",
  };
  for (const patch of [
    { token: "synthetic-private" },
    { principal: principal("a") },
    { context: {} },
    { address: "other@grok-bot.hab" },
    { version: 2 },
    { stage: "complete" },
  ]) {
    assert.throws(
      () => parseEnrollmentCheckpoint({ ...valid, ...patch }),
      code("invalid_enrollment_checkpoint"),
    );
  }
  assert.throws(
    () => f.host.journal.save("different", 0, valid),
    code("invalid_enrollment_checkpoint"),
  );
});
test("enrollment: stored checkpoints/audit have no raw individual claims, labels or authentication material", async (t) => {
  const f = setup(t, { confirm: async (p) => p.kind !== "bind" });
  await runHabEnrollment(f.host, "privacy");
  // Save the pending-binding checkpoint, then fail its actual verification.
  f.host.ui.confirm = async (p) => {
    if (p.kind === "bind") f.mutable.individual = false;
    return true;
  };
  await assert.rejects(runHabEnrollment(f.host, "privacy"));
  const cp = f.host.journal.load("privacy").checkpoint;
  assert.match(cp.connection_fingerprint, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(f.pathJournal).toString("latin1");
  for (const value of Object.values(principal("a")))
    assert.equal(bytes.includes(value), false);
  assert.equal(bytes.includes("Synthetic bot A"), false);
  const audit = JSON.stringify(
    f.registryRaw.prepare("SELECT * FROM hab_registry_audit").all(),
  );
  for (const value of Object.values(principal("a")))
    assert.equal(audit.includes(value), false);
});
test("enrollment: unexpected UI/connection failures are redacted", async (t) => {
  const f = setup(t);
  f.host.connection = async () => {
    throw Error("synthetic-private-provider-details");
  };
  await assert.rejects(runHabEnrollment(f.host, "redact"), (e) => {
    assert.equal(e.code, "enrollment_failed");
    assert.equal(e.cause, undefined);
    assert.equal(e.stack.includes("synthetic-private-provider-details"), false);
    return true;
  });
});
test("enrollment: journal CAS refuses concurrent/old writers and its capacity never evicts reservations", (t) => {
  const f = setup(t);
  const second = f.openJournal();
  const cp = {
    version: 1,
    flow_id: "one",
    product_id: f.product.product_id,
    agent_name: "grok-bot",
    bot_name: "one",
    address: "one@grok-bot.hab",
    stage: "enroll_pending",
  };
  assert.equal(f.host.journal.save("one", 0, cp), 1);
  assert.throws(
    () => second.save("one", 0, cp),
    code("enrollment_journal_conflict"),
  );
  assert.equal(second.save("one", 1, cp), 2);
  assert.throws(
    () => f.host.journal.save("one", 1, cp),
    code("enrollment_journal_conflict"),
  );
  const tiny = new SQLiteEnrollmentJournal(join(f.dir, "tiny.sqlite"), {
    max_sessions: 1,
    busy_timeout_ms: 1,
  });
  t.after(() => tiny.close());
  tiny.migrate();
  tiny.save("one", 0, cp);
  assert.throws(
    () => tiny.save("two", 0, { ...cp, flow_id: "two" }),
    code("enrollment_journal_capacity_exceeded"),
  );
  assert.equal(tiny.load("one").revision, 1);
  assert.equal(tiny.save("one", 1, cp), 2);
});
test("enrollment: journal refuses loose/symlink/unknown/corrupt storage and requires explicit migration", (t) => {
  const f = setup(t);
  assert.equal(statSync(f.pathJournal).mode & 0o777, 0o600);
  const link = join(f.dir, "linked.sqlite");
  symlinkSync(f.pathJournal, link);
  const config = { max_sessions: 10, busy_timeout_ms: 1 };
  assert.throws(
    () => new SQLiteEnrollmentJournal(link, config),
    code("enrollment_journal_unavailable"),
  );
  const loose = join(f.dir, "loose.sqlite");
  writeFileSync(loose, "");
  chmodSync(loose, 0o644);
  assert.throws(
    () => new SQLiteEnrollmentJournal(loose, config),
    code("enrollment_journal_unavailable"),
  );
  const unknown = new SQLiteEnrollmentJournal(":memory:", config);
  t.after(() => unknown.close());
  assert.throws(
    () => unknown.load("one"),
    code("enrollment_journal_not_migrated"),
  );
  const alienPath = join(f.dir, "alien.sqlite");
  const raw = new DatabaseSync(alienPath);
  raw.exec("CREATE TABLE unrelated(id INTEGER)");
  raw.close();
  chmodSync(alienPath, 0o600);
  const alien = new SQLiteEnrollmentJournal(alienPath, config);
  t.after(() => alien.close());
  assert.throws(
    () => alien.migrate(),
    code("unknown_enrollment_journal_schema"),
  );
  const rawJournal = new DatabaseSync(f.pathJournal);
  rawJournal
    .prepare("INSERT INTO hab_enrollment_sessions VALUES(?,1,?)")
    .run("bad", JSON.stringify({ token: "synthetic" }));
  rawJournal.close();
  assert.throws(
    () => f.host.journal.load("bad"),
    code("invalid_enrollment_checkpoint"),
  );
});
test("management catalog: bounded authorized pagination contains approved products only", (t) => {
  const f = setup(t);
  for (const name of ["dot", "hermes"])
    f.registry.registerProduct(f.admin, {
      request_id: `product-${name}`,
      agent_name: name,
    });
  let after;
  const ids = [];
  do {
    const page = f.registry.catalog(f.admin, {
      limit: 1,
      ...(after ? { after } : {}),
    });
    assert.equal(page.products.length, 1);
    assert.deepEqual(Object.keys(page.products[0]).sort(), [
      "agent_name",
      "created_at",
      "product_id",
    ]);
    ids.push(page.products[0].product_id);
    after = page.next;
  } while (after);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, [...ids].sort());
  for (const input of [
    { limit: 101 },
    { limit: 0 },
    { limit: 1, agent_name: "self" },
    { limit: 1, after: "bad\n" },
  ])
    assert.throws(
      () => f.registry.catalog(f.admin, input),
      code("invalid_registry_request"),
    );
  assert.throws(
    () => f.registry.catalog(f.contexts.a, { limit: 1 }),
    code("registry_forbidden"),
  );
});
test("verified binding: fresh exclusive host claims required even for an exact committed retry", (t) => {
  const f = setup(t);
  const agent = f.enroll("waiting", false);
  const digest = f.registry.inspectConnection(
    f.admin,
    f.contexts.a,
  ).connection_fingerprint;
  const input = {
    request_id: "verified-bind",
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
    connection_fingerprint: digest,
  };
  const binding = f.registry.bindVerified(f.admin, input, f.contexts.a);
  assert.deepEqual(
    f.registry.bindVerified(f.admin, input, f.contexts.a),
    binding,
  );
  assert.throws(
    () => f.registry.bindVerified(f.contexts.a, input, f.contexts.a),
    code("registry_forbidden"),
  );
  assert.throws(
    () =>
      f.registry.bindVerified(
        f.admin,
        { ...input, principal: principal("a") },
        f.contexts.a,
      ),
    code("invalid_registry_request"),
  );
  assert.throws(
    () =>
      f.registry.bindVerified(f.admin, input, { principal: principal("a") }),
    code("registry_forbidden"),
  );
  f.mutable.expires_at = new Date(Date.now() - 1).toISOString();
  assert.throws(
    () => f.registry.bindVerified(f.admin, input, f.contexts.a),
    code("registry_forbidden"),
  );
  f.mutable.expires_at = new Date(
    Date.now() + options.max_context_ms + 5000,
  ).toISOString();
  assert.throws(
    () => f.registry.bindVerified(f.admin, input, f.contexts.a),
    code("registry_forbidden"),
  );
  assert.equal(
    f.registry.inspect(f.admin, agent.agent_id).state,
    "waiting_connection",
  );
  assert.equal(
    f.registry.inspectBinding(f.admin, binding.binding_id).state,
    "active",
  );
  assert.throws(
    () => f.registry.inspectBinding(f.contexts.a, binding.binding_id),
    code("registry_forbidden"),
  );
});
test("verified binding: disconnected, throwing and asynchronous identity ports fail closed", async (t) => {
  const f = setup(t);
  for (const individual of [
    undefined,
    () => {
      throw Error("private");
    },
    async () => {
      throw Error("private");
    },
  ]) {
    const registry = new SQLiteHabRegistry(":memory:", options, {
      ...f.authority,
      individual,
    });
    registry.migrate();
    assert.throws(
      () => registry.inspectConnection(f.admin, {}),
      code("registry_forbidden"),
    );
    registry.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 1)); // consume denied async rejection
});
test("terminal enrollment: exact address confirmation and explicit operation selection", async (t) => {
  const f = setup(t);
  const answers = [
    "1",
    "research",
    "research@grok-bot.hab",
    "research@grok-bot.hab",
    "1,2,3,4,5",
    "research@grok-bot.hab",
  ];
  const output = [];
  f.host.ui = enrollmentTerminalUI({
    write: (line) => output.push(line),
    question: async () => answers.shift() ?? null,
  });
  assert.equal((await runHabEnrollment(f.host, "terminal")).status, "complete");
  assert.equal(answers.length, 0);
  assert.equal(output.join("").includes("変更・再割当てできません"), true);
  assert.equal(output.join("").includes("Synthetic bot A"), true);
});
test("terminal enrollment: generic yes, EOF and terminal control input never confirm or execute", async () => {
  for (const answer of ["yes", "y", null, "wrong@grok-bot.hab"]) {
    const ui = enrollmentTerminalUI({
      write() {},
      question: async () => answer,
    });
    assert.equal(
      await ui.confirm({
        kind: "reserve",
        address: "one@grok-bot.hab",
        agent_name: "grok-bot",
      }),
      false,
    );
  }
  for (const answer of ["\x1b[31m", "x".repeat(257)]) {
    const ui = enrollmentTerminalUI({
      write() {},
      question: async () => answer,
    });
    await assert.rejects(
      ui.botName({ agent_name: "grok-bot" }),
      code("invalid_enrollment_choice"),
    );
  }
});
test("enrollment: concurrent runners cannot independently advance one flow", async (t) => {
  const f = setup(t);
  const results = await Promise.allSettled([
    runHabEnrollment(f.host, "concurrent"),
    runHabEnrollment(f.host, "concurrent"),
  ]);
  assert.equal(
    results.filter(
      (r) => r.status === "fulfilled" && r.value.status === "complete",
    ).length,
    1,
  );
  assert.equal(
    results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason.code === "enrollment_journal_conflict",
    ).length,
    1,
  );
  assert.equal(f.count("hab_agents"), 1);
  assert.equal(f.count("hab_bindings"), 1);
});
test("enrollment: a durable checkpoint with a lost save response is recovered without another reservation confirmation", async (t) => {
  const f = setup(t);
  const journal = f.host.journal;
  f.host.journal = {
    load: (id) => journal.load(id),
    save(id, revision, cp) {
      journal.save(id, revision, cp);
      throw Error("save committed, response lost");
    },
  };
  await assert.rejects(
    runHabEnrollment(f.host, "lost-save"),
    code("enrollment_failed"),
  );
  assert.equal(journal.load("lost-save").checkpoint.stage, "enroll_pending");
  assert.equal(f.count("hab_agents"), 0);
  f.host.journal = journal;
  f.events.length = 0;
  assert.equal(
    (await runHabEnrollment(f.host, "lost-save")).status,
    "complete",
  );
  assert.equal(
    f.events.some((e) => e[0] === "confirm" && e[1] === "reserve"),
    false,
  );
});
test("enrollment: product selection can explicitly advance a bounded catalog page", async (t) => {
  const f = setup(t, {}, { max_products: 60 });
  for (let i = 0; i < 50; i++)
    f.registry.registerProduct(f.admin, {
      request_id: `more-${i}`,
      agent_name: `product-${i}`,
    });
  let pages = 0;
  let selected;
  f.host.ui.product = async (page) => {
    pages++;
    assert.ok(page.products.length <= 50);
    if (page.next) return "next";
    selected = page.products[0];
    return selected.product_id;
  };
  const result = await runHabEnrollment(f.host, "pagination");
  assert.equal(pages, 2);
  assert.equal(result.agent.product_id, selected.product_id);
  assert.equal(result.agent.address, `research@${selected.agent_name}.hab`);
});
test("management: rejected asynchronous administrator results are denied and consumed", async (t) => {
  const f = setup(t);
  const registry = f.open(
    {},
    {
      ...f.authority,
      administrator: async () => {
        throw Error("private");
      },
    },
  );
  registry.migrate();
  assert.throws(
    () => registry.catalog(f.admin, { limit: 1 }),
    code("registry_forbidden"),
  );
  await new Promise((resolve) => setTimeout(resolve, 1));
});
test("enrollment: foreign error codes from injected ports are not exposed", async (t) => {
  const f = setup(t);
  f.host.ui.product = async () => {
    const error = new Error("synthetic-private-error");
    error.code = "synthetic-private-error";
    throw error;
  };
  await assert.rejects(
    runHabEnrollment(f.host, "foreign"),
    code("enrollment_failed"),
  );
});
test("enrollment demo: explicit synthetic mode reproduces pause/reopen/activation without real connections", () => {
  const output = execFileSync(
    execPath,
    ["scripts/hab-enrollment-demo.mjs", "--simulate"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /模擬登録完了: research@grok-bot\.hab \/ active/);
  assert.match(output, /DBを閉じて再開/);
  assert.doesNotMatch(output, /\/Users\/|\/home\//);
  assert.throws(
    () =>
      execFileSync(execPath, ["scripts/hab-enrollment-demo.mjs"], {
        stdio: "pipe",
      }),
    { status: 1 },
  );
  assert.throws(
    () =>
      execFileSync(
        execPath,
        ["scripts/hab-enrollment-demo.mjs", "--interactive"],
        { stdio: "pipe" },
      ),
    { status: 1 },
  );
});
