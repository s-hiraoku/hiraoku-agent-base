import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  operations,
  principal,
  code,
} from "./hab-registry-fixtures.js";
import { message } from "./relay-http-fixtures.js";
import { groupFixture as shared } from "./hab-group-fixtures.js";

test("one verified group uses two addresses; another group cannot select them", (t) => {
  const f = shared(t);
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

test("shared receiver ACKs only the selected mailbox, with fixed retries", (t) => {
  const f = shared(t),
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

test("address stop affects one name; group stop affects both and incoming resolution", (t) => {
  const f = shared(t),
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
  assert.equal(f.hab.poll(f.select(f.second)), null);
  assert.throws(() => f.hab.poll(saved), code("forbidden"));
});

test("group and address operation permissions intersect", (t) => {
  const f = shared(t);
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

test("membership and group binding survive reopen; refreshed credential retains group", (t) => {
  const f = shared(t);
  f.close(f.registry);
  const reopened = f.open();
  reopened.migrate();
  assert.equal(
    reopened.withRelay(
      reopened.selectAddress(f.contexts.a, f.second.address),
      "poll",
      (_auth, id) => id,
    ),
    f.second.agent_id,
  );
  f.mutable.expires_at = new Date(Date.now() + 15000).toISOString();
  assert.equal(
    reopened.withRelay(
      reopened.selectAddress(f.contexts.a, f.first.address),
      "poll",
      (_auth, id) => id,
    ),
    f.first.agent_id,
  );
  f.mutable.individual = false;
  assert.throws(
    () =>
      reopened.withRelay(
        reopened.selectAddress(f.contexts.a, f.first.address),
        "poll",
        () => true,
      ),
    code("forbidden"),
  );
});

test("ordinary clients cannot enroll groups, attach names or change permissions", (t) => {
  const f = shared(t);
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

test("legacy credential and membership cannot silently be rebound to another group", (t) => {
  const f = shared(t),
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
      f.registry.bind(f.admin, {
        request_id: f.request(),
        agent_id: fresh.agent_id,
        expected_epoch: fresh.epoch,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
});

test("group authorization records distinguish authenticated group from selected name", (t) => {
  const f = shared(t);
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

test("legacy-only registry remains opt-out and accepts its original single mailbox", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  assert.throws(
    () => f.registry.createGroup(f.admin, { request_id: "not-enabled" }),
    code("registry_groups_disabled"),
  );
  assert.equal(
    f.hab.poll(f.registry.selectAddress(f.contexts.a, a.address)),
    null,
  );
  assert.throws(
    () => f.hab.poll(f.registry.selectAddress(f.contexts.a, b.address)),
    code("forbidden"),
  );
});

test("explicit schema upgrade preserves legacy bindings and prevents an old runtime from opening version 2", (t) => {
  const f = fixture(t),
    original = f.enroll("a");
  assert.equal(
    f.registryRaw.prepare("SELECT version FROM hab_registry_meta").get()
      .version,
    1,
  );
  const upgraded = f.open({ authentication_groups: true });
  upgraded.migrate();
  assert.throws(
    () => f.registry.withRelay(f.contexts.a, "poll", () => true),
    code("registry_schema_changed"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT version FROM hab_registry_meta").get()
      .version,
    2,
  );
  assert.equal(
    upgraded.withRelay(f.contexts.a, "poll", (_auth, id) => id),
    original.agent_id,
  );
  assert.deepEqual(upgraded.inspect(f.admin, original.agent_id), original);
  f.registryRaw.exec("UPDATE hab_auth_group_meta SET version=99");
  assert.throws(
    () => upgraded.migrate(),
    code("unsupported_registry_group_schema"),
  );
  assert.throws(
    () => upgraded.withRelay(f.contexts.a, "poll", () => true),
    code("registry_not_migrated"),
  );
});

test("a group with one registered address needs no selector; extra members require an explicit selection", (t) => {
  const f = fixture(t, { authentication_groups: true });
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

test("disabling groups after migration refuses shared members without releasing reservations", (t) => {
  const f = shared(t),
    off = f.open({ authentication_groups: false });
  off.migrate();
  assert.throws(
    () =>
      off.withRelay(
        off.selectAddress(f.contexts.a, f.first.address),
        "poll",
        () => true,
      ),
    code("forbidden"),
  );
  assert.throws(
    () => off.resolve(f.contexts.b, f.second.address),
    code("forbidden"),
  );
  const fresh = f.enroll("after-disable", false);
  assert.throws(
    () =>
      off.bind(f.admin, {
        request_id: "try-rebind",
        agent_id: fresh.agent_id,
        expected_epoch: fresh.epoch,
        principal: principal("a"),
      }),
    code("registry_binding_reserved"),
  );
});

test("group changes are idempotent and reject stale epochs and changed requests", (t) => {
  const f = fixture(t, { authentication_groups: true });
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

test("group binding requires a fresh verified connection matching the management checkpoint", (t) => {
  const f = fixture(t, { authentication_groups: true });
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

test("group binding quotas include legacy reservations and never store raw connection claims", (t) => {
  const f = fixture(t, { authentication_groups: true, max_bindings: 1 });
  const group = f.registry.createGroup(f.admin, { request_id: "quota-group" });
  f.registry.bindGroup(f.admin, {
    request_id: "quota-group-bind",
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  });
  const legacy = f.enroll("legacy-after-group", false);
  assert.throws(
    () =>
      f.registry.bind(f.admin, {
        request_id: "quota-legacy",
        agent_id: legacy.agent_id,
        expected_epoch: legacy.epoch,
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

test("group retirement is terminal and cannot move a reserved address to a new group", (t) => {
  const f = shared(t),
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

test("last group binding revocation stops retained contexts and preserves credentials as tombstones", (t) => {
  const f = shared(t),
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

test("overlapping verified credential rotation preserves the group and member identity", (t) => {
  const f = shared(t);
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

test("authorization audit storage failure denies delivery and leaves no receipt", (t) => {
  const f = shared(t),
    input = { ...message(), recipient_id: f.external.agent_id };
  f.registryRaw.exec(
    "CREATE TRIGGER reject_group_audit BEFORE INSERT ON hab_auth_group_authorizations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
  );
  assert.throws(
    () => f.hab.submit(f.select(f.first), input),
    code("registry_unavailable"),
  );
  assert.equal(f.hab.poll(f.contexts.b), null);
  f.registryRaw.exec("DROP TRIGGER reject_group_audit;");
  assert.equal(
    f.hab.submit(f.select(f.first), input).sender_id,
    f.first.agent_id,
  );
});

test("scoped group authorization cannot escape, change address or permit a concurrent registry change", (t) => {
  const f = shared(t),
    selected = f.select(f.first),
    other = f.select(f.second),
    concurrent = f.open();
  concurrent.migrate();
  const currentEpoch = f.registry.inspectGroup(f.admin, f.group.group_id).epoch;
  let saved;
  f.registry.withRelay(selected, "poll", (authorization) => {
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

test("group authorization records keep the newest entries instead of exhausting delivery", (t) => {
  const f = shared(t, { max_audit_records: 30 });
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
