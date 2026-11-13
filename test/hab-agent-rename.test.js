import test from "node:test";
import assert from "node:assert/strict";
import { fixture, code } from "./hab-registry-fixtures.js";
import { groupFixture } from "./hab-group-fixtures.js";
import { message } from "./relay-http-fixtures.js";
import { backup } from "node:sqlite";
import { join } from "node:path";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { options } from "./hab-registry-fixtures.js";
import { chmodSync } from "node:fs";

const renamed = (f, agent, bot_name = "renamed", request_id = "rename") =>
  f.registry.renameAgent(f.admin, {
    request_id,
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
    expected_address: agent.address,
    bot_name,
  });

// These cases set rename_grace_days: 0, so a previous name is refused at once; the
// grace period itself is covered in hab-agent-rename-grace.test.js.
test("opt-in rename preserves the birth identity and reserves the old name without forwarding", async (t) => {
  const f = await fixture(t, {
    agent_rename: true,
    rename_grace_days: 0,
  });
  const a = f.enroll("a"),
    b = f.enroll("b");
  const input = {
    request_id: "rename-a",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    expected_address: a.address,
    bot_name: "renamed",
  };
  const current = f.registry.renameAgent(f.admin, input);
  assert.equal(current.agent_id, a.agent_id);
  assert.equal(current.address, "renamed@grok-bot.hab");
  assert.equal(current.epoch, a.epoch + 1);
  assert.deepEqual(f.registry.renameAgent(f.admin, input), current);
  assert.equal(
    f.registryRaw
      .prepare("SELECT address FROM hab_agents WHERE agent_id=?")
      .get(a.agent_id).address,
    a.address,
  );
  assert.equal(
    f.hab.resolve(f.contexts.b, current.address).recipient_id,
    a.agent_id,
  );
  assert.throws(
    () => f.hab.resolve(f.contexts.b, a.address),
    code("forbidden"),
  );
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: f.product.product_id,
      bot_name: "a",
    }).available,
    false,
  );
  assert.equal(f.registry.inspect(f.admin, b.agent_id).address, b.address);
});

test("the v2→v3 upgrade is explicit, invalidates old handles, and preserves credentials", async (t) => {
  {
    const f = await fixture(t);
    const a = f.enroll("a"),
      b = f.enroll("b");
    assert.equal(
      f.registryRaw.prepare("SELECT version FROM hab_registry_meta").get()
        .version,
      2,
    );
    const next = f.open({ agent_rename: true });
    next.migrate();
    assert.equal(
      f.registryRaw.prepare("SELECT version FROM hab_registry_meta").get()
        .version,
      3,
    );
    assert.throws(
      () => f.registry.inspect(f.admin, a.agent_id),
      code("registry_schema_changed"),
    );
    const current = next.renameAgent(f.admin, {
      request_id: "rename",
      agent_id: a.agent_id,
      expected_epoch: a.epoch,
      expected_address: a.address,
      bot_name: "renamed",
    });
    const hab = f.habFor(next);
    assert.equal(
      hab.submit(f.contexts.a, { ...message(), recipient_id: b.agent_id })
        .sender_id,
      a.agent_id,
    );
    const readOnlyFeature = f.open({
      agent_rename: false,
    });
    readOnlyFeature.migrate();
    assert.equal(
      readOnlyFeature.inspect(f.admin, a.agent_id).address,
      current.address,
    );
    assert.throws(
      () =>
        readOnlyFeature.renameAgent(f.admin, {
          request_id: "off",
          agent_id: a.agent_id,
          expected_epoch: current.epoch,
          expected_address: current.address,
          bot_name: "other",
        }),
      code("registry_rename_disabled"),
    );
  }
});

test("admin permission, CAS, retired state, immutable birth row and request conflict are enforced", async (t) => {
  const f = await fixture(t, {
    agent_rename: true,
  });
  const a = f.enroll("a");
  const input = {
    request_id: "rename",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    expected_address: a.address,
    bot_name: "new",
  };
  assert.throws(
    () => f.registry.renameAgent(f.contexts.a, input),
    code("registry_forbidden"),
  );
  f.mutable.denied.add("rename");
  assert.throws(
    () => f.registry.renameAgent(f.admin, input),
    code("registry_forbidden"),
  );
  f.mutable.denied.clear();
  assert.throws(
    () =>
      f.registry.renameAgent(f.admin, {
        ...input,
        expected_address: "wrong@grok-bot.hab",
      }),
    code("registry_stale_address"),
  );
  assert.throws(
    () =>
      f.registry.renameAgent(f.admin, { ...input, bot_name: "Not Canonical" }),
    code("invalid_registry_request"),
  );
  const current = f.registry.renameAgent(f.admin, input);
  assert.throws(
    () => f.registry.renameAgent(f.admin, { ...input, bot_name: "other" }),
    code("registry_idempotency_conflict"),
  );
  assert.throws(
    () => f.registry.renameAgent(f.admin, { ...input, request_id: "stale" }),
    code("registry_stale_epoch"),
  );
  assert.throws(
    () =>
      f.registryRaw
        .prepare("UPDATE hab_agents SET address=? WHERE agent_id=?")
        .run("hack@grok-bot.hab", a.agent_id),
    /immutable/,
  );
  const retired = f.registry.setAccess(f.admin, {
    request_id: "retire",
    agent_id: a.agent_id,
    expected_epoch: current.epoch,
    state: "retired",
    operations: [],
  });
  assert.throws(
    () => renamed(f, retired, "third", "retired-rename"),
    code("registry_retired"),
  );
});

test("permanent reservations prevent cross-agent reuse and permit an explicit same-ID rollback", async (t) => {
  const f = await fixture(t, {
    agent_rename: true,
    rename_grace_days: 0,
  });
  const a = f.enroll("a"),
    b = f.enroll("b");
  const current = renamed(f, a);
  assert.throws(
    () => renamed(f, b, "renamed", "steal-current"),
    code("registry_name_reserved"),
  );
  assert.throws(
    () => renamed(f, b, "a", "steal-old"),
    code("registry_name_reserved"),
  );
  assert.throws(
    () =>
      f.registry.enroll(f.admin, {
        request_id: "new-reserved",
        product_id: f.product.product_id,
        bot_name: "renamed",
      }),
    code("registry_name_reserved"),
  );
  const restored = renamed(f, current, "a", "rollback");
  assert.equal(restored.address, a.address);
  assert.equal(restored.agent_id, a.agent_id);
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: a.product_id,
      bot_name: "renamed",
    }).available,
    false,
  );
  assert.throws(
    () => f.hab.resolve(f.contexts.b, current.address),
    code("forbidden"),
  );
  assert.throws(
    () => f.registryRaw.exec("DELETE FROM hab_address_reservations"),
    /reserved/,
  );
  assert.throws(
    () => f.registryRaw.exec("UPDATE hab_agent_name_events SET at='other'"),
    /immutable/,
  );
});

test("leased delivery ACK, saved sender status, duplicate submit and reply IDs survive rename", async (t) => {
  const f = await groupFixture(t, { agent_rename: true, rename_grace_days: 0 });
  const before = f.select(f.first);
  const inbound = { ...message(), recipient_id: f.first.agent_id };
  f.hab.submit(f.contexts.b, inbound);
  const lease = f.hab.poll(before);
  const outbound = {
    ...message("2".repeat(32)),
    recipient_id: f.external.agent_id,
  };
  const receipt = f.hab.submit(before, outbound);
  const current = renamed(f, f.registry.inspect(f.admin, f.first.agent_id));
  const selected = f.registry.selectAddress(
    f.contexts.a,
    current.address,
    current.agent_id,
  );
  assert.throws(() => f.hab.poll(before), code("forbidden"));
  assert.deepEqual(f.hab.status(selected, outbound.message_id), receipt);
  assert.deepEqual(f.hab.submit(selected, outbound), receipt);
  f.hab.ack(selected, {
    sender_id: lease.message.sender_id,
    message_id: lease.message.message_id,
    generation: lease.generation,
    lease_token: lease.lease_token,
    request_id: "saved-ack",
  });
  assert.equal(f.hab.status(f.contexts.b, inbound.message_id).state, "acked");
  const reply = {
    ...message("3".repeat(32)),
    kind: "answer",
    recipient_id: f.external.agent_id,
    in_reply_to: {
      sender_id: f.external.agent_id,
      message_id: inbound.message_id,
    },
  };
  assert.equal(f.hab.submit(selected, reply).sender_id, f.first.agent_id);
});

test("group discovery reflects the current name, invalidates cursors, and marks old host attestations unknown", async (t) => {
  const f = await groupFixture(t, {
    agent_rename: true,
    discovery: { availability_namespaces: ["grok-bot"] },
  });
  const page = f.registry.discover(f.contexts.a, {
    action: "directory",
    limit: 1,
  });
  assert.ok(page.next_cursor);
  const old = f.first;
  const now = new Date();
  const attested = f.open(
    {},
    {
      ...f.authority,
      hostIdentity: () => ({
        agent_id: old.agent_id,
        address: old.address,
        owner_kind: "bot",
        owner_reference: "stable-host-owner",
        binding_generation: 1,
        observed_at: now.toISOString(),
        expires_at: new Date(+now + 30000).toISOString(),
      }),
    },
  );
  attested.migrate();
  const current = renamed(f, f.registry.inspect(f.admin, old.agent_id));
  assert.throws(
    () =>
      f.registry.discover(f.contexts.a, {
        action: "directory",
        limit: 1,
        cursor: page.next_cursor,
      }),
    code("invalid_reference"),
  );
  const who = attested.discover(f.contexts.a, {
    action: "whoami",
    as_address: current.address,
    expected_agent_id: current.agent_id,
  });
  assert.equal(who.selected_identity.address, current.address);
  assert.equal(who.host_identity.state, "unknown");
  assert.equal(who.host_identity.reason, "stale_address_attestation");
  assert.equal(
    f.registry.discover(f.contexts.a, {
      action: "check_address",
      address: old.address,
    }).availability,
    "unavailable",
  );
  const filtered = f.registry.discover(f.contexts.a, {
    action: "directory",
    address_prefix: "renamed@",
  });
  assert.deepEqual(
    filtered.agents.map((x) => x.agent_id),
    [current.agent_id],
  );
  assert.throws(
    () =>
      f.registry.discover(f.contexts.b, {
        action: "whoami",
        as_address: current.address,
      }),
    code("forbidden"),
  );
});

test("exhausted group epoch rolls back all name and authority changes", async (t) => {
  const f = await groupFixture(t, { agent_rename: true });
  const a = f.registry.inspect(f.admin, f.first.agent_id);
  f.registryRaw
    .prepare("UPDATE hab_auth_groups SET epoch=? WHERE group_id=?")
    .run(Number.MAX_SAFE_INTEGER, f.group.group_id);
  assert.throws(() => renamed(f, a), code("registry_unavailable"));
  assert.equal(f.registry.inspect(f.admin, a.agent_id).address, a.address);
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_agent_name_events").get()
      .n,
    0,
  );
});

test("v3 registry backup/reopen retains names, reservations, ID and existing binding without token rotation", async (t) => {
  const f = await fixture(t, {
    agent_rename: true,
  });
  const a = f.enroll("a"),
    b = f.enroll("b"),
    current = renamed(f, a);
  const path = join(f.dir, "renamed-backup.sqlite");
  await backup(f.registryRaw, path);
  chmodSync(path, 0o600);
  const restored = new SQLiteHabRegistry(path, { ...options }, f.authority);
  t.after(() => restored.close());
  restored.migrate();
  assert.equal(restored.inspect(f.admin, a.agent_id).address, current.address);
  const hab = f.habFor(restored);
  assert.equal(
    hab.submit(f.contexts.a, { ...message(), recipient_id: b.agent_id })
      .sender_id,
    a.agent_id,
  );
  assert.equal(
    restored.preview(f.admin, { product_id: a.product_id, bot_name: "a" })
      .available,
    false,
  );
});

test("permanent event capacity fails closed without reserving a new address", async (t) => {
  const f = await fixture(t, {
    agent_rename: true,
  });
  const a = f.enroll("a");
  renamed(f, a);
  let previous = "renamed@grok-bot.hab";
  for (let i = 1; i < options.max_requests; i++) {
    const address = previous === a.address ? "renamed@grok-bot.hab" : a.address;
    f.registryRaw
      .prepare(
        "INSERT INTO hab_agent_name_events(agent_id,address,previous_address,at) VALUES(?,?,?,?)",
      )
      .run(a.agent_id, address, previous, new Date().toISOString());
    previous = address;
  }
  const before = f.registry.inspect(f.admin, a.agent_id);
  assert.throws(
    () => renamed(f, before, "overflow", "overflow"),
    code("registry_capacity_exceeded"),
  );
  assert.deepEqual(f.registry.inspect(f.admin, a.agent_id), before);
  assert.equal(
    f.registry.preview(f.admin, {
      product_id: a.product_id,
      bot_name: "overflow",
    }).available,
    true,
  );
});

test("retired member groups and foreign host address attestations cannot be bypassed by rename", async (t) => {
  const f = await groupFixture(t, {
    agent_rename: true,
    discovery: { availability_namespaces: ["grok-bot"] },
  });
  const current = renamed(f, f.registry.inspect(f.admin, f.first.agent_id));
  const now = new Date();
  const forged = f.open(
    {},
    {
      ...f.authority,
      hostIdentity: () => ({
        agent_id: current.agent_id,
        address: f.external.address,
        owner_kind: "bot",
        owner_reference: "foreign-name",
        binding_generation: 1,
        observed_at: now.toISOString(),
        expires_at: new Date(+now + 30000).toISOString(),
      }),
    },
  );
  forged.migrate();
  assert.throws(
    () =>
      forged.discover(f.contexts.a, {
        action: "whoami",
        as_address: current.address,
      }),
    code("forbidden"),
  );
  f.access("retired");
  assert.throws(
    () =>
      renamed(
        f,
        f.registry.inspect(f.admin, current.agent_id),
        "later",
        "after-retire",
      ),
    code("registry_retired"),
  );
  assert.equal(
    f.registry.inspect(f.admin, current.agent_id).address,
    current.address,
  );
});
