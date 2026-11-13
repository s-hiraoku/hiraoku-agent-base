import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  fixture,
  operations,
  options,
  principal,
  code,
} from "./hab-registry-fixtures.js";
import { message } from "./relay-http-fixtures.js";
import { groupFixture as shared } from "./hab-group-fixtures.js";

test("one verified group uses two addresses; another group cannot select them", async (t) => {
  const f = await shared(t);
  for (const agent of [f.first, f.second]) {
    const selected = f.select(agent);
    const sent = f.hab.submit(selected, {
      ...message(agent === f.first ? "1".repeat(32) : "2".repeat(32)),
      recipient_id: f.external.agent_id,
    });
    assert.equal(sent.sender_id, agent.agent_id);
    assert.throws(
      () => f.hab.poll(f.registry.selectAddress(f.contexts.b, agent.address)),
      code("forbidden"),
    );
  }
  assert.throws(() => f.hab.poll(f.contexts.a), code("forbidden"));
  assert.throws(
    () =>
      f.hab.poll(f.registry.selectAddress(f.contexts.a, f.external.address)),
    code("forbidden"),
  );
});

test("shared receiver ACKs only the selected mailbox, with fixed retries", async (t) => {
  const f = await shared(t),
    input = { ...message(), recipient_id: f.first.agent_id };
  f.hab.submit(f.contexts.b, input);
  const delivery = f.hab.poll(f.select(f.first));
  assert.equal(delivery.message.recipient_id, f.first.agent_id);
  const ack = {
    sender_id: f.external.agent_id,
    message_id: input.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "fixed-ack",
  };
  assert.throws(() => f.hab.ack(f.select(f.second), ack));
  const receipt = f.hab.ack(f.select(f.first), ack);
  assert.deepEqual(f.hab.ack(f.select(f.first), ack), receipt);
});

test("address stop affects one name; group stop affects both and incoming resolution", async (t) => {
  const f = await shared(t),
    saved = f.select(f.first);
  f.registry.setAccess(f.admin, {
    request_id: f.request(),
    agent_id: f.first.agent_id,
    expected_epoch: f.first.epoch,
    state: "stopped",
    operations: [],
  });
  assert.throws(() => f.hab.poll(saved), code("forbidden"));
  assert.equal(f.hab.poll(f.select(f.second)), null);
  f.access("stopped");
  assert.throws(() => f.hab.poll(f.select(f.second)), code("forbidden"));
  assert.throws(
    () => f.hab.resolve(f.contexts.b, f.second.address),
    code("forbidden"),
  );
  f.access("active", operations);
  // The group stop stopped its members; reactivating the group re-grants no address.
  assert.throws(() => f.hab.poll(f.select(f.second)), code("forbidden"));
  f.registry.setAccess(f.admin, {
    request_id: f.request(),
    agent_id: f.second.agent_id,
    expected_epoch: f.registry.inspect(f.admin, f.second.agent_id).epoch,
    state: "active",
    operations,
  });
  assert.equal(f.hab.poll(f.select(f.second)), null);
  assert.throws(() => f.hab.poll(saved), code("forbidden"));
});

test("group and address operation permissions intersect", async (t) => {
  const f = await shared(t);
  f.access("active", ["poll"]);
  assert.equal(f.hab.poll(f.select(f.first)), null);
  assert.throws(
    () => f.hab.resolve(f.select(f.first), f.external.address),
    code("forbidden"),
  );
  assert.throws(
    () =>
      f.hab.submit(f.select(f.first), {
        ...message(),
        recipient_id: f.external.agent_id,
      }),
    code("forbidden"),
  );
});

test("membership and group binding survive reopen; refreshed credential retains group", async (t) => {
  const f = await shared(t);
  f.close(f.registry);
  const reopened = f.open();
  reopened.migrate();
  assert.equal(
    reopened.withAuthorization(
      reopened.selectAddress(f.contexts.a, f.second.address),
      "poll",
      (_auth, id) => id,
    ),
    f.second.agent_id,
  );
  f.mutable.expires_at = new Date(Date.now() + 15000).toISOString();
  assert.equal(
    reopened.withAuthorization(
      reopened.selectAddress(f.contexts.a, f.first.address),
      "poll",
      (_auth, id) => id,
    ),
    f.first.agent_id,
  );
  f.mutable.individual = false;
  assert.throws(
    () =>
      reopened.withAuthorization(
        reopened.selectAddress(f.contexts.a, f.first.address),
        "poll",
        () => true,
      ),
    code("forbidden"),
  );
});

test("ordinary clients cannot enroll groups, attach names or change permissions", async (t) => {
  const f = await shared(t);
  assert.throws(
    () => f.registry.createGroup(f.contexts.a, { request_id: f.request() }),
    code("registry_forbidden"),
  );
  f.mutable.denied.add("group_member");
  const agent = f.enroll("extra", false);
  assert.throws(
    () =>
      f.registry.addGroupMember(f.admin, {
        request_id: f.request(),
        group_id: f.group.group_id,
        expected_group_epoch: f.registry.inspectGroup(f.admin, f.group.group_id)
          .epoch,
        agent_id: agent.agent_id,
        expected_epoch: agent.epoch,
      }),
    code("registry_forbidden"),
  );
});

test("a credential and membership cannot silently be rebound to another group", async (t) => {
  const f = await shared(t),
    other = f.registry.createGroup(f.admin, { request_id: f.request() });
  assert.throws(
    () =>
      f.registry.bindGroup(f.admin, {
        request_id: f.request(),
        group_id: other.group_id,
        expected_epoch: other.epoch,
        principal: principal("b"),
      }),
    code("registry_binding_reserved"),
  );
  assert.throws(
    () =>
      f.registry.addGroupMember(f.admin, {
        request_id: f.request(),
        group_id: other.group_id,
        expected_group_epoch: other.epoch,
        agent_id: f.first.agent_id,
        expected_epoch: f.registry.inspect(f.admin, f.first.agent_id).epoch,
      }),
    code("registry_binding_reserved"),
  );
  const fresh = f.enroll("fresh", false);
  assert.throws(
    () =>
      f.registry.createBoundGroup(f.admin, {
        request_id: f.request(),
        agent_id: fresh.agent_id,
        expected_epoch: fresh.epoch,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
});

test("group authorization records distinguish authenticated group from selected name", async (t) => {
  const f = await shared(t);
  f.hab.poll(f.select(f.first));
  f.hab.poll(f.select(f.second));
  const rows = f.registry.groupAuthorizations(f.admin, {
    group_id: f.group.group_id,
    after_id: 0,
    limit: 10,
  });
  assert.deepEqual(
    rows.map((r) => [r.group_id, r.agent_id, r.operation]),
    [
      [f.group.group_id, f.first.agent_id, "poll"],
      [f.group.group_id, f.second.agent_id, "poll"],
    ],
  );
  assert.ok(!JSON.stringify(rows).includes("shared-owner"));
  assert.throws(
    () =>
      f.registry.groupAuthorizations(f.contexts.a, {
        group_id: f.group.group_id,
        after_id: 0,
        limit: 10,
      }),
    code("registry_forbidden"),
  );
});

test("an address bound on its own is the only member of its group and reaches only its own mailbox", async (t) => {
  const f = await fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  const view = f.registry.overview(f.admin);
  const group = view.groups.find(
    (g) =>
      g.group_id ===
      view.agents.find((x) => x.agent_id === a.agent_id).group_id,
  );
  assert.deepEqual(group.member_ids, [a.agent_id]);
  assert.equal(group.active_binding_ids.length, 1);
  assert.equal(f.hab.poll(f.contexts.a), null);
  assert.equal(
    f.hab.poll(f.registry.selectAddress(f.contexts.a, a.address)),
    null,
  );
  assert.throws(
    () => f.hab.poll(f.registry.selectAddress(f.contexts.a, b.address)),
    code("forbidden"),
  );
});
/** Turns the fixture's registry back into an earlier build's v1 file with direct bindings. */
function legacyV1(f, names) {
  const raw = f.registryRaw;
  const agents = Object.fromEntries(
    names.map((name) => [name, f.enroll(name, false)]),
  );
  for (const table of [
    "hab_auth_group_authorizations",
    "hab_auth_group_members",
    "hab_auth_group_bindings",
    "hab_auth_groups",
    "hab_auth_group_meta",
  ])
    raw.exec(`DROP TABLE ${table}`);
  raw.exec("UPDATE hab_registry_meta SET version=1");
  for (const [name, agent] of Object.entries(agents)) {
    raw
      .prepare("INSERT INTO hab_bindings VALUES(?,?,?,'active',?,NULL)")
      .run(
        `legacy-${name}`,
        agent.agent_id,
        fingerprint(principal(name)),
        new Date().toISOString(),
      );
    raw
      .prepare(
        "UPDATE hab_agents SET state='active',operations=? WHERE agent_id=?",
      )
      .run(JSON.stringify([...operations].sort()), agent.agent_id);
  }
  return agents;
}
function fingerprint(value) {
  const canonical = (v) =>
    !v || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
            .join(",")}}`;
  return createHmac("sha256", options.fingerprint_key)
    .update(canonical(["principal-v1", value]))
    .digest("hex");
}

test("migrate moves an earlier build's direct bindings into single-member groups with the same IDs", async (t) => {
  const f = await fixture(t);
  const { a, b } = legacyV1(f, ["a", "b"]);
  const upgraded = f.open();
  upgraded.migrate();
  assert.equal(
    f.registryRaw.prepare("SELECT version FROM hab_registry_meta").get()
      .version,
    2,
  );
  const view = upgraded.overview(f.admin);
  for (const [name, agent] of Object.entries({ a, b })) {
    const current = view.agents.find((x) => x.agent_id === agent.agent_id);
    assert.equal(current.state, "active");
    const group = view.groups.find((g) => g.group_id === current.group_id);
    assert.equal(group.state, "active");
    assert.deepEqual(group.member_ids, [agent.agent_id]);
    assert.deepEqual(group.active_binding_ids, [`legacy-${name}`]);
  }
  assert.deepEqual(
    f.registryRaw
      .prepare("SELECT DISTINCT state FROM hab_bindings")
      .all()
      .map((r) => r.state),
    ["revoked"],
  );
  assert.equal(
    upgraded.withAuthorization(f.contexts.a, "poll", (_auth, id) => id),
    a.agent_id,
  );
  const hab = f.habFor(upgraded);
  assert.equal(
    hab.submit(f.contexts.a, { ...message(), recipient_id: b.agent_id })
      .sender_id,
    a.agent_id,
  );
  // A second migrate converts nothing twice.
  upgraded.migrate();
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_auth_groups").get().n,
    2,
  );
  f.registryRaw.exec("UPDATE hab_auth_group_meta SET version=99");
  assert.throws(
    () => upgraded.migrate(),
    code("unsupported_registry_group_schema"),
  );
  assert.throws(
    () => upgraded.withAuthorization(f.contexts.a, "poll", () => true),
    code("registry_not_migrated"),
  );
});

test("migrate keeps a revoked direct binding as a revoked group binding and refuses its reuse", async (t) => {
  const f = await fixture(t);
  const { a } = legacyV1(f, ["a"]);
  f.registryRaw.exec(
    "UPDATE hab_bindings SET state='revoked',revoked_at='2026-01-01T00:00:00.000Z'",
  );
  f.registryRaw
    .prepare(
      "UPDATE hab_agents SET state='stopped',operations='[]' WHERE agent_id=?",
    )
    .run(a.agent_id);
  const upgraded = f.open();
  upgraded.migrate();
  const view = upgraded.overview(f.admin);
  const group = view.groups.find(
    (g) =>
      g.group_id ===
      view.agents.find((x) => x.agent_id === a.agent_id).group_id,
  );
  assert.equal(group.state, "stopped");
  assert.deepEqual(group.active_binding_ids, []);
  assert.deepEqual(upgraded.findPrincipal(f.admin, principal("a")), {
    binding_id: "legacy-a",
    group_id: group.group_id,
    state: "revoked",
  });
  assert.throws(
    () =>
      upgraded.bindGroup(f.admin, {
        request_id: "rebind-revoked",
        group_id: group.group_id,
        expected_epoch: group.epoch,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
});
test("a group with one registered address needs no selector; extra members require an explicit selection", async (t) => {
  const f = await fixture(t);
  const group = f.registry.createGroup(f.admin, { request_id: "single-group" });
  const binding = f.registry.bindGroup(f.admin, {
    request_id: "single-bind",
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  });
  const agent = f.enroll("single", false);
  const member = f.registry.addGroupMember(f.admin, {
    request_id: "single-member",
    group_id: group.group_id,
    expected_group_epoch: binding.group_epoch,
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
  });
  f.registry.setAccess(f.admin, {
    request_id: "single-address-active",
    agent_id: agent.agent_id,
    expected_epoch: member.agent_epoch,
    state: "active",
    operations,
  });
  f.registry.setGroupAccess(f.admin, {
    request_id: "single-group-active",
    group_id: group.group_id,
    expected_epoch: member.group_epoch,
    state: "active",
    operations,
  });
  assert.equal(f.hab.poll(f.contexts.a), null);
});

test("a config that still turns authentication groups off is ignored", async (t) => {
  const f = await shared(t),
    off = f.open({ authentication_groups: false });
  off.migrate();
  assert.equal(
    off.withAuthorization(
      off.selectAddress(f.contexts.a, f.first.address),
      "poll",
      (_auth, id) => id,
    ),
    f.first.agent_id,
  );
  assert.equal(
    off.resolve(f.contexts.b, f.second.address).recipient_id,
    f.second.agent_id,
  );
});
test("group changes are idempotent and reject stale epochs and changed requests", async (t) => {
  const f = await fixture(t);
  const group = f.registry.createGroup(f.admin, { request_id: "same-create" });
  assert.deepEqual(
    f.registry.createGroup(f.admin, { request_id: "same-create" }),
    group,
  );
  const input = {
    request_id: "same-bind",
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  };
  const binding = f.registry.bindGroup(f.admin, input);
  assert.deepEqual(f.registry.bindGroup(f.admin, input), binding);
  assert.throws(
    () =>
      f.registry.bindGroup(f.admin, { ...input, principal: principal("b") }),
    code("registry_idempotency_conflict"),
  );
  assert.throws(
    () =>
      f.registry.setGroupAccess(f.admin, {
        request_id: "stale",
        group_id: group.group_id,
        expected_epoch: group.epoch,
        state: "active",
        operations,
      }),
    code("registry_stale_epoch"),
  );
});

test("group binding requires a fresh verified connection matching the management checkpoint", async (t) => {
  const f = await fixture(t);
  const group = f.registry.createGroup(f.admin, {
    request_id: "verified-group",
  });
  const checkpoint = f.registry.inspectConnection(f.admin, f.contexts.a);
  const input = {
    request_id: "verified-group-bind",
    group_id: group.group_id,
    expected_epoch: group.epoch,
    ...checkpoint,
  };
  assert.throws(
    () => f.registry.bindGroupVerified(f.admin, input, f.contexts.b),
    code("registry_connection_changed"),
  );
  f.mutable.individual = false;
  assert.throws(
    () => f.registry.bindGroupVerified(f.admin, input, f.contexts.a),
    code("registry_forbidden"),
  );
  f.mutable.individual = true;
  const result = f.registry.bindGroupVerified(f.admin, input, f.contexts.a);
  assert.equal(result.group_id, group.group_id);
  assert.deepEqual(
    f.registry.bindGroupVerified(f.admin, input, f.contexts.a),
    result,
  );
});

test("group binding quotas count every binding and never store raw connection claims", async (t) => {
  const f = await fixture(t, { max_bindings: 1 });
  const group = f.registry.createGroup(f.admin, { request_id: "quota-group" });
  f.registry.bindGroup(f.admin, {
    request_id: "quota-group-bind",
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  });
  const other = f.enroll("after-group", false);
  assert.throws(
    () =>
      f.registry.createBoundGroup(f.admin, {
        request_id: "quota-other",
        agent_id: other.agent_id,
        expected_epoch: other.epoch,
        principal: principal("b"),
      }),
    code("registry_capacity_exceeded"),
  );
  const saved = JSON.stringify([
    f.registryRaw.prepare("SELECT * FROM hab_auth_group_bindings").all(),
    f.registryRaw.prepare("SELECT * FROM hab_admin_requests").all(),
    f.registryRaw.prepare("SELECT * FROM hab_registry_audit").all(),
  ]);
  for (const value of [
    "shared-owner",
    "shared-client",
    "verified-a",
    "https://issuer.example/",
  ])
    assert.ok(!saved.includes(value));
});

test("group retirement is terminal and cannot move a reserved address to a new group", async (t) => {
  const f = await shared(t),
    retired = f.access("retired");
  assert.throws(
    () =>
      f.registry.setGroupAccess(f.admin, {
        request_id: f.request(),
        group_id: f.group.group_id,
        expected_epoch: retired.epoch,
        state: "active",
        operations,
      }),
    code("registry_retired"),
  );
  assert.throws(() => f.hab.poll(f.select(f.first)), code("forbidden"));
  assert.throws(() =>
    f.registryRaw
      .prepare("UPDATE hab_auth_group_members SET group_id=? WHERE agent_id=?")
      .run("other", f.first.agent_id),
  );
  assert.throws(() =>
    f.registryRaw
      .prepare("DELETE FROM hab_auth_groups WHERE group_id=?")
      .run(f.group.group_id),
  );
});

test("last group binding revocation stops retained contexts and preserves credentials as tombstones", async (t) => {
  const f = await shared(t),
    selected = f.select(f.first);
  const binding = f.registryRaw
    .prepare("SELECT binding_id FROM hab_auth_group_bindings WHERE group_id=?")
    .get(f.group.group_id);
  f.registry.revokeGroupBinding(f.admin, {
    request_id: f.request(),
    binding_id: binding.binding_id,
    expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id).epoch,
  });
  assert.throws(() => f.hab.poll(selected), code("forbidden"));
  assert.throws(
    () => f.hab.resolve(f.contexts.b, f.first.address),
    code("forbidden"),
  );
  assert.equal(
    f.registry.inspectGroup(f.admin, f.group.group_id).state,
    "stopped",
  );
  assert.throws(
    () =>
      f.registry.bindGroup(f.admin, {
        request_id: f.request(),
        group_id: f.group.group_id,
        expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id)
          .epoch,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
});

test("stopping a group stops every member; a new binding re-grants only the address it names", async (t) => {
  for (const stop of ["revoke", "access"]) {
    const f = await shared(t);
    if (stop === "revoke") {
      const binding = f.registryRaw
        .prepare(
          "SELECT binding_id FROM hab_auth_group_bindings WHERE group_id=?",
        )
        .get(f.group.group_id);
      f.registry.revokeGroupBinding(f.admin, {
        request_id: f.request(),
        binding_id: binding.binding_id,
        expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id)
          .epoch,
      });
    } else f.access("stopped");
    for (const agent of [f.first, f.second]) {
      const member = f.registry.inspect(f.admin, agent.agent_id);
      assert.deepEqual([member.state, member.operations], ["stopped", []]);
      assert.ok(member.epoch > agent.epoch, `${stop}: member epoch advances`);
    }
    f.registry.bindGroup(f.admin, {
      request_id: f.request(),
      group_id: f.group.group_id,
      expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id).epoch,
      principal: principal("c"),
    });
    f.access("active", operations);
    assert.throws(
      () => f.hab.poll(f.registry.selectAddress(f.contexts.c, f.first.address)),
      code("forbidden"),
    );
    f.registry.setAccess(f.admin, {
      request_id: f.request(),
      agent_id: f.first.agent_id,
      expected_epoch: f.registry.inspect(f.admin, f.first.agent_id).epoch,
      state: "active",
      operations,
    });
    assert.equal(
      f.hab.poll(f.registry.selectAddress(f.contexts.c, f.first.address)),
      null,
    );
    assert.throws(
      () =>
        f.hab.poll(f.registry.selectAddress(f.contexts.c, f.second.address)),
      code("forbidden"),
    );
    assert.equal(f.hab.poll(f.contexts.c), null, `${stop}: one active member`);
  }
});

test("overlapping verified credential rotation preserves the group and member identity", async (t) => {
  const f = await shared(t);
  const old = f.registryRaw
    .prepare("SELECT binding_id FROM hab_auth_group_bindings WHERE group_id=?")
    .get(f.group.group_id);
  f.registry.bindGroup(f.admin, {
    request_id: f.request(),
    group_id: f.group.group_id,
    expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id).epoch,
    principal: principal("c"),
  });
  f.registry.revokeGroupBinding(f.admin, {
    request_id: f.request(),
    binding_id: old.binding_id,
    expected_epoch: f.registry.inspectGroup(f.admin, f.group.group_id).epoch,
  });
  assert.equal(
    f.registry.inspectGroup(f.admin, f.group.group_id).state,
    "active",
  );
  assert.throws(() => f.hab.poll(f.select(f.first)), code("forbidden"));
  assert.equal(
    f.hab.poll(f.registry.selectAddress(f.contexts.c, f.first.address)),
    null,
  );
});

test("authorization audit storage failure denies delivery and leaves no receipt", async (t) => {
  const f = await shared(t),
    input = { ...message(), recipient_id: f.external.agent_id };
  f.registryRaw.exec(
    "CREATE TRIGGER reject_group_audit BEFORE INSERT ON hab_auth_group_authorizations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
  );
  assert.throws(
    () => f.hab.submit(f.select(f.first), input),
    code("registry_unavailable"),
  );
  f.registryRaw.exec("DROP TRIGGER reject_group_audit;");
  assert.equal(f.hab.poll(f.contexts.b), null);
  assert.equal(
    f.hab.submit(f.select(f.first), input).sender_id,
    f.first.agent_id,
  );
});

test("scoped group authorization cannot escape, change address or permit a concurrent registry change", async (t) => {
  const f = await shared(t),
    selected = f.select(f.first),
    other = f.select(f.second),
    concurrent = f.open();
  concurrent.migrate();
  const currentEpoch = f.registry.inspectGroup(f.admin, f.group.group_id).epoch;
  let saved;
  f.registry.withAuthorization(selected, "poll", (authorization) => {
    saved = authorization;
    assert.equal(
      authorization.authorize(selected, "poll").agent_id,
      f.first.agent_id,
    );
    assert.equal(authorization.authorize(other, "poll"), undefined);
    assert.throws(() =>
      concurrent.setGroupAccess(f.admin, {
        request_id: f.request(),
        group_id: f.group.group_id,
        expected_epoch: currentEpoch,
        state: "stopped",
        operations: [],
      }),
    );
  });
  assert.equal(saved.authorize(selected, "poll"), undefined);
});

test("group authorization records keep the newest entries instead of exhausting delivery", async (t) => {
  const f = await shared(t, { max_audit_records: 30 });
  for (let i = 0; i < 45; i++)
    assert.equal(f.hab.poll(f.select(f.first)), null);
  const rows = f.registry.groupAuthorizations(f.admin, {
    group_id: f.group.group_id,
    after_id: 0,
    limit: 100,
  });
  assert.equal(rows.length, 30);
  assert.equal(rows.at(-1).id, 45);
  assert.equal(rows[0].id, 16);
});

test("createBoundGroup needs group_bind and group_member as well as group_create, and a refusal leaves nothing", async (t) => {
  const f = await fixture(t);
  const agent = f.enroll("research", false);
  const count = (table) =>
    f.registryRaw.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const state = () => ({
    groups: count("hab_auth_groups"),
    bindings: count("hab_auth_group_bindings"),
    members: count("hab_auth_group_members"),
    epoch: f.registryRaw.prepare("SELECT epoch FROM hab_registry_meta").get()
      .epoch,
  });
  const before = state();
  const input = (request_id) => ({
    request_id,
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
    principal: principal("a"),
  });
  for (const denied of [
    ["group_bind", "group_member"],
    ["group_bind"],
    ["group_member"],
  ]) {
    f.mutable.denied = new Set(denied);
    assert.throws(
      () => f.registry.createBoundGroup(f.admin, input(denied.join("-"))),
      code("registry_forbidden"),
      `refused without ${denied}`,
    );
    assert.deepEqual(state(), before, `refused without ${denied}: no state`);
  }
  f.mutable.denied = new Set();
  const created = f.registry.createBoundGroup(f.admin, input("bound-all"));
  assert.equal(created.agent_id, agent.agent_id);
});
