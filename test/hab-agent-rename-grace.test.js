import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fixture, code } from "./hab-registry-fixtures.js";
import { groupFixture } from "./hab-group-fixtures.js";
import { message } from "./mcp-http-fixtures.js";
import { provisionHostA2aIdentity } from "../src/host/a2a.ts";

const renamed = (f, agent, bot_name = "renamed", request_id = "rename") =>
  f.registry.renameAgent(f.admin, {
    request_id,
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
    expected_address: agent.address,
    bot_name,
  });
const DAY = 86400000;

test("during the grace period a previous name resolves to the same ID and echoes the requested address", async (t) => {
  const f = await fixture(t, { agent_rename: true });
  const a = f.enroll("a");
  f.enroll("b");
  const current = renamed(f, a);
  assert.deepEqual(f.hab.resolve(f.contexts.b, a.address), {
    recipient_id: a.agent_id,
    address: a.address,
    normalization_version: 1,
  });
  assert.equal(
    f.hab.resolve(f.contexts.b, current.address).recipient_id,
    a.agent_id,
  );
  // The previous name stays reserved even while it resolves.
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: f.product.product_id,
      bot_name: "a",
    }).available,
    false,
  );
  const [previous] = f.registry.previousNames(f.admin);
  assert.equal(previous.address, a.address);
  assert.equal(previous.agent_id, a.agent_id);
  assert.equal(previous.current_address, current.address);
  assert.equal(previous.resolves, true);
  assert.equal(
    Date.parse(previous.grace_until) - Date.parse(previous.renamed_at),
    30 * DAY,
  );
  // Only the category of use is kept: which caller, how often, when.
  assert.equal(previous.callers.length, 1);
  assert.equal(previous.callers[0].uses, 1);
  f.hab.resolve(f.contexts.b, a.address);
  assert.equal(f.registry.previousNames(f.admin)[0].callers[0].uses, 2);
});

test("a previous name never reaches a stopped agent or another ID", async (t) => {
  const f = await fixture(t, { agent_rename: true });
  const a = f.enroll("a"),
    b = f.enroll("b");
  const current = renamed(f, a);
  const stopped = f.registry.setAccess(f.admin, {
    request_id: "stop-a",
    agent_id: a.agent_id,
    expected_epoch: current.epoch,
    state: "stopped",
    operations: [],
  });
  assert.throws(
    () => f.hab.resolve(f.contexts.b, a.address),
    code("unknown_address"),
  );
  f.registry.setAccess(f.admin, {
    request_id: "restart-a",
    agent_id: a.agent_id,
    expected_epoch: stopped.epoch,
    state: "active",
    operations: current.operations,
  });
  assert.equal(f.hab.resolve(f.contexts.b, a.address).recipient_id, a.agent_id);
  // Renaming b cannot take a's previous name; reservations are per ID forever.
  assert.throws(
    () => renamed(f, b, "a", "steal"),
    code("registry_name_reserved"),
  );
});

test("renaming back makes the old name current again and the intermediate name previous", async (t) => {
  const f = await fixture(t, { agent_rename: true });
  const a = f.enroll("a");
  f.enroll("b");
  const middle = renamed(f, a, "middle", "to-middle");
  const back = renamed(f, middle, "a", "back");
  assert.equal(back.address, a.address);
  assert.deepEqual(
    f.registry.previousNames(f.admin).map((entry) => entry.address),
    [middle.address],
  );
  assert.equal(
    f.hab.resolve(f.contexts.b, middle.address).recipient_id,
    a.agent_id,
  );
  assert.deepEqual(f.hab.resolve(f.contexts.b, a.address), {
    recipient_id: a.agent_id,
    address: a.address,
    normalization_version: 1,
  });
});

test("zero grace refuses a previous name at once and status reports that it no longer resolves", async (t) => {
  const f = await fixture(t, { agent_rename: true, rename_grace_days: 0 });
  const a = f.enroll("a");
  f.enroll("b");
  renamed(f, a);
  assert.throws(
    () => f.hab.resolve(f.contexts.b, a.address),
    code("unknown_address"),
  );
  const [previous] = f.registry.previousNames(f.admin);
  assert.equal(previous.resolves, false);
  assert.equal(previous.grace_until, previous.renamed_at);
  assert.deepEqual(previous.callers, []);
});

test("a frozen as_address keeps working for the same group member during the grace period only", async (t) => {
  const f = await groupFixture(t, {
    agent_rename: true,
    discovery: { availability_namespaces: ["grok-bot"] },
  });
  const frozen = f.registry.selectAddress(
    f.contexts.a,
    f.first.address,
    f.first.agent_id,
  );
  const current = renamed(f, f.registry.inspect(f.admin, f.first.agent_id));
  const outbound = {
    ...message("4".repeat(32)),
    recipient_id: f.external.agent_id,
  };
  assert.equal(f.hab.submit(frozen, outbound).sender_id, f.first.agent_id);
  const wrong = f.registry.selectAddress(
    f.contexts.a,
    f.first.address,
    f.second.agent_id,
  );
  assert.throws(() => f.hab.poll(wrong), code("forbidden"));
  // Another group's credential cannot select the previous name.
  const foreign = f.registry.selectAddress(f.contexts.b, f.first.address);
  assert.throws(() => f.hab.poll(foreign), code("forbidden"));
  const who = f.registry.discover(f.contexts.a, {
    action: "whoami",
    as_address: f.first.address,
    expected_agent_id: f.first.agent_id,
  });
  assert.equal(who.selected_identity.address, current.address);
  const [previous] = f.registry.previousNames(f.admin);
  assert.deepEqual(
    previous.callers.map((caller) => caller.caller_id),
    [f.first.agent_id],
  );
});

test("the A2A host identity keeps its agent under a previous name and is refused after the grace period", async (t) => {
  for (const [grace, expected] of [
    [30, "same"],
    [0, "a2a_identity_renamed"],
  ]) {
    const f = await fixture(t, {
      agent_rename: true,
      rename_grace_days: grace,
    });
    f.enroll("b");
    const host = provisionHostA2aIdentity(
      f.registry,
      f.admin,
      "a2a-host@grok-bot.hab",
    );
    const current = renamed(f, f.registry.inspect(f.admin, host.agent_id));
    if (expected === "same") {
      const again = provisionHostA2aIdentity(
        f.registry,
        f.admin,
        "a2a-host@grok-bot.hab",
      );
      assert.equal(again.agent_id, host.agent_id);
      assert.equal(again.address, current.address);
    } else
      assert.throws(
        () =>
          provisionHostA2aIdentity(
            f.registry,
            f.admin,
            "a2a-host@grok-bot.hab",
          ),
        new RegExp(expected),
      );
  }
});

test("an existing v3 name schema gains the use table on the next start, not before", async (t) => {
  const f = await fixture(t, { agent_rename: true });
  const a = f.enroll("a");
  f.enroll("b");
  renamed(f, a);
  // Simulate a registry written by the first v3 build (name schema version 1).
  f.registryRaw.exec(
    "DROP TABLE hab_previous_name_uses; UPDATE hab_agent_name_meta SET version=1",
  );
  const next = f.open();
  next.migrate();
  const raw = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(
      raw.prepare("SELECT version FROM hab_agent_name_meta").get().version,
      2,
    );
  } finally {
    raw.close();
  }
  assert.equal(
    f.habFor(next).resolve(f.contexts.b, a.address).recipient_id,
    a.agent_id,
  );
  f.registryRaw.exec("UPDATE hab_agent_name_meta SET version=9");
  assert.throws(
    () => f.open().migrate(),
    code("unsupported_registry_name_schema"),
  );
});
