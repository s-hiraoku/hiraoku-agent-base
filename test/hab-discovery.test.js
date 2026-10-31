import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HabHttpGateway } from "../src/hab/http.ts";
import { createHabMcpServer } from "../src/hab/mcp.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { groupFixture } from "./hab-group-fixtures.js";
import {
  fixture,
  code,
  operations,
  principal,
} from "./hab-registry-fixtures.js";
import { limits, policy, request, decode } from "./relay-http-fixtures.js";
import { WriterAdmission } from "../src/relay/writer-admission.ts";

const discovery = { availability_namespaces: ["grok-bot"] };
function group(t, patch = {}) {
  return groupFixture(t, { discovery, ...patch });
}
function gateway(f, admission) {
  return new HabHttpGateway(f.hab, policy, f.audit, f.verifier, admission);
}
async function call(g, input, headers = {}) {
  const response = await g.fetch(
    request(
      "tools/call",
      { name: "hab_discover", arguments: input },
      { headers },
    ),
  );
  return {
    status: response.status,
    body: response.status === 200 ? await decode(response) : null,
  };
}
const value = (result) => {
  assert.equal(result.status, 200);
  assert.ok(!result.body.result.isError, JSON.stringify(result));
  return result.body.result.structuredContent;
};
const discover = (f, input) => f.registry.discover(f.contexts.a, input);
function state(f) {
  const snapshot = (db) =>
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]);
  return JSON.stringify([snapshot(f.registryRaw), snapshot(f.raw)]);
}
function hosted(f, identity) {
  const registry = f.open({}, { ...f.authority, hostIdentity: () => identity });
  registry.migrate();
  return { registry, hab: new HabRelayService(registry, f.store, limits) };
}
function attestation(agent, patch = {}) {
  return {
    agent_id: agent.agent_id,
    address: agent.address,
    owner_kind: "session",
    owner_reference: "opaque-owner-123",
    binding_generation: 1,
    observed_at: new Date(Date.now() - 100).toISOString(),
    expires_at: new Date(Date.now() + 10000).toISOString(),
    ...patch,
  };
}

test("discovery is opt-in; HTTP and SDK catalogs expose a bounded read-only tool", async (t) => {
  const plain = fixture(t);
  plain.enroll("a");
  const g = gateway(plain);
  assert.equal((await decode(await g.fetch(request()))).result.tools.length, 5);
  const disabled = await call(g, { action: "whoami" });
  assert.ok(disabled.body.error || disabled.body.result?.isError);
  assert.throws(
    () => plain.registry.discover(plain.contexts.a, { action: "whoami" }),
    code("forbidden"),
  );
  const f = group(t),
    enabled = gateway(f);
  const tools = (await decode(await enabled.fetch(request()))).result.tools;
  assert.equal(tools.length, 6);
  const tool = tools.find((x) => x.name === "hab_discover");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  for (const branch of tool.inputSchema.oneOf ?? tool.inputSchema.anyOf)
    assert.equal(branch.additionalProperties, false);
  const handler = createMcpHandler(() =>
    createHabMcpServer(f.hab, () => f.contexts.a),
  );
  t.after(() => handler.close());
  const result = await decode(
    await handler.fetch(
      request("tools/call", {
        name: "hab_discover",
        arguments: { action: "directory" },
      }),
    ),
  );
  assert.equal(result.result.structuredContent.agents.length, 2);
});

test("group whoami distinguishes a selected alias from the actual host owner; profile names are irrelevant", (t) => {
  const f = group(t),
    before = state(f);
  const self = discover(f, { action: "whoami" });
  assert.equal(self.connection.kind, "authentication_group");
  assert.equal(self.connection.id, f.group.group_id);
  assert.equal(typeof self.connection.binding_id, "string");
  assert.equal(self.selected_identity, null);
  assert.equal(self.host_identity.state, "unknown");
  const selected = discover(f, {
    action: "whoami",
    as_address: f.first.address,
    expected_agent_id: f.first.agent_id,
  });
  assert.equal(selected.selected_identity.agent_id, f.first.agent_id);
  assert.equal(selected.selection_basis, "requested_group_name");
  assert.equal(selected.host_identity.state, "unknown");
  const host = hosted(f, attestation(f.second, { owner_kind: "bot" }));
  const result = host.registry.discover(f.contexts.a, {
    action: "whoami",
    as_address: f.first.address,
  });
  assert.equal(result.selected_identity.agent_id, f.first.agent_id);
  assert.equal(result.host_identity.agent_id, f.second.agent_id);
  assert.equal(result.host_identity.owner_kind, "bot");
  assert.equal(result.identity_verification, "mismatch");
  assert.equal(
    host.registry.discover(f.contexts.a, {
      action: "whoami",
      as_address: f.second.address,
    }).identity_verification,
    "matched",
  );
  assert.equal(result.host_identity.owner_reference, "opaque-owner-123");
  assert.equal(result.selected_identity.host_assignment.state, "unknown");
  const directory = host.registry.discover(f.contexts.a, {
    action: "directory",
  });
  assert.equal(
    directory.agents.find((a) => a.agent_id === f.second.agent_id)
      .host_assignment.state,
    "attested",
  );
  assert.equal(state(f), before);
});

test("legacy individual binding only sees its own identity, not the product or another group", (t) => {
  const f = group(t);
  const result = f.registry.discover(f.contexts.b, { action: "whoami" });
  assert.equal(result.connection.kind, "individual_connection");
  assert.equal(result.selected_identity.agent_id, f.external.agent_id);
  assert.equal(result.host_identity.state, "unknown");
  const directory = f.registry.discover(f.contexts.b, { action: "directory" });
  assert.deepEqual(
    directory.agents.map((x) => x.agent_id),
    [f.external.agent_id],
  );
  assert.throws(
    () =>
      f.registry.discover(f.contexts.b, {
        action: "whoami",
        as_address: f.first.address,
      }),
    code("forbidden"),
  );
});

test("directory is group-scoped, keyset paged, filtered and secret-free; cursors cannot cross principals/filters/snapshots", (t) => {
  const f = group(t);
  const pending = f.enroll("pending", false);
  const g = f.registry.inspectGroup(f.admin, f.group.group_id);
  f.registry.addGroupMember(f.admin, {
    request_id: "pending-member",
    group_id: g.group_id,
    expected_group_epoch: g.epoch,
    agent_id: pending.agent_id,
    expected_epoch: pending.epoch,
  });
  const all = discover(f, { action: "directory" });
  assert.equal(all.agents.length, 3);
  assert.ok(all.agents.every((x) => x.agent_id !== f.external.agent_id));
  const waiting = discover(f, {
    action: "directory",
    state: "waiting_connection",
    address_prefix: "pending@",
  });
  assert.equal(waiting.agents.length, 1);
  assert.equal(waiting.agents[0].registration_state, "waiting_connection");
  assert.equal(
    waiting.agents[0].authentication_assignment.kind,
    "authentication_group",
  );
  assert.equal(waiting.agents[0].host_assignment.state, "unknown");
  assert.deepEqual(waiting.agents[0].presence, {
    state: "unknown",
    reason: "not_observed",
    observed_at: null,
  });
  assert.deepEqual(waiting.agents[0].authorized_operations, []);
  const seen = [];
  let cursor;
  do {
    const page = discover(f, {
      action: "directory",
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.agents.map((a) => a.agent_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(
    seen,
    all.agents.map((x) => x.agent_id),
  );
  const first = discover(f, { action: "directory", limit: 1 });
  for (const change of [
    { cursor: first.next_cursor + "x" },
    { address_prefix: "a" },
    { limit: 2 },
    { state: "active" },
  ])
    assert.throws(
      () =>
        discover(f, {
          action: "directory",
          limit: 1,
          cursor: first.next_cursor,
          ...change,
        }),
      code("invalid_reference"),
    );
  assert.throws(
    () =>
      f.registry.discover(f.contexts.b, {
        action: "directory",
        limit: 1,
        cursor: first.next_cursor,
      }),
    code("invalid_reference"),
  );
  const text = JSON.stringify(all);
  for (const secret of [
    "verified-a",
    "shared-owner",
    "shared-client",
    "https://issuer.example/",
    "fingerprint",
    "token",
    f.external.agent_id,
    f.external.address,
  ])
    assert.ok(!text.includes(secret), secret);
  f.enrollMember("newcomer");
  assert.throws(
    () =>
      discover(f, { action: "directory", limit: 1, cursor: first.next_cursor }),
    code("invalid_reference"),
  );
});

test("availability is exact and explicitly namespace-scoped, leaks no foreign record and never reserves", (t) => {
  const f = group(t),
    before = state(f);
  const own = discover(f, {
    action: "check_address",
    address: f.first.address,
  });
  assert.equal(own.availability, "unavailable");
  const foreign = discover(f, {
    action: "check_address",
    address: f.external.address,
  });
  assert.equal(foreign.availability, "unavailable");
  assert.ok(!JSON.stringify(foreign).includes(f.external.agent_id));
  const available = discover(f, {
    action: "check_address",
    address: "free@grok-bot.hab",
  });
  assert.equal(available.availability, "available");
  assert.equal(available.reservation_created, false);
  assert.equal(available.registration_permission, "not_evaluated");
  assert.equal(available.registration_capacity, "not_evaluated");
  assert.equal(
    discover(f, { action: "check_address", address: "x@private.hab" })
      .availability,
    "unknown",
  );
  assert.equal(state(f), before);
  const restricted = f.open({ discovery: { availability_namespaces: [] } });
  restricted.migrate();
  assert.equal(
    restricted.discover(f.contexts.a, {
      action: "check_address",
      address: f.external.address,
    }).availability,
    "unknown",
  );
  assert.equal(
    restricted.discover(f.contexts.a, {
      action: "check_address",
      address: "missing@grok-bot.hab",
    }).availability,
    "unknown",
  );
  assert.equal(
    restricted.discover(f.contexts.a, {
      action: "check_address",
      address: f.first.address,
    }).availability,
    "unavailable",
  );
});

test("availability races converge at atomic enrollment; stopped and retired addresses stay reserved", (t) => {
  const f = group(t),
    peer = f.open();
  peer.migrate();
  const address = "race@grok-bot.hab";
  assert.equal(
    discover(f, { action: "check_address", address }).availability,
    "available",
  );
  assert.equal(
    peer.discover(f.contexts.a, { action: "check_address", address })
      .availability,
    "available",
  );
  const enrolled = f.registry.enroll(f.admin, {
    request_id: "winner",
    product_id: f.product.product_id,
    bot_name: "race",
  });
  assert.throws(
    () =>
      peer.enroll(f.admin, {
        request_id: "loser",
        product_id: f.product.product_id,
        bot_name: "race",
      }),
    code("registry_name_reserved"),
  );
  let current = enrolled;
  for (const status of ["stopped", "retired"]) {
    current = f.registry.setAccess(f.admin, {
      request_id: status,
      agent_id: current.agent_id,
      expected_epoch: current.epoch,
      state: status,
      operations: [],
    });
    assert.equal(
      discover(f, { action: "check_address", address }).availability,
      "unavailable",
    );
  }
});

test("forged selections, host identities, group IDs, credentials and malformed inputs cannot grant or change identity", async (t) => {
  const f = group(t),
    g = gateway(f),
    before = state(f);
  for (const input of [
    { action: "whoami", group_id: f.group.group_id },
    { action: "whoami", agent_id: f.first.agent_id },
    { action: "whoami", host_identity: attestation(f.first) },
    { action: "whoami", confirmed: true },
    { action: "whoami", expected_agent_id: f.first.agent_id },
    { action: "whoami", as_address: f.external.address },
    {
      action: "whoami",
      as_address: f.first.address,
      expected_agent_id: f.second.agent_id,
    },
    { action: "directory", limit: 101 },
    { action: "directory", cursor: "bad" },
    { action: "directory", limit: 0 },
    { action: "directory", address_prefix: "%" },
    { action: "check_address", address: "Free@grok-bot.hab" },
    { action: "check_address", address: "a@grok-bot.hab\n" },
  ]) {
    const result = await call(g, input);
    assert.ok(
      result.status !== 200 || result.body.error || result.body.result?.isError,
    );
  }
  for (const ctx of [
    null,
    "a",
    { agent_id: f.first.agent_id },
    { ...principal("a") },
  ])
    assert.throws(
      () => f.registry.discover(ctx, { action: "whoami" }),
      code("forbidden"),
    );
  for (const identity of [
    attestation(f.external),
    attestation(f.first, { address: f.second.address }),
    attestation(f.first, { secret: "synthetic" }),
    attestation(f.first, {
      observed_at: new Date(Date.now() + 1000).toISOString(),
    }),
  ]) {
    const host = hosted(f, identity);
    assert.throws(
      () => host.registry.discover(f.contexts.a, { action: "whoami" }),
      code("forbidden"),
    );
  }
  const stale = hosted(
    f,
    attestation(f.first, {
      observed_at: new Date(Date.now() - 2000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }),
  );
  assert.equal(
    stale.registry.discover(f.contexts.a, { action: "whoami" }).host_identity
      .reason,
    "stale_attestation",
  );
  const selected = f.registry.selectAddress(
    f.contexts.a,
    f.first.address,
    f.second.agent_id,
  );
  assert.throws(
    () => f.registry.discover(selected, { action: "whoami" }),
    code("forbidden"),
  );
  assert.equal(state(f), before);
});

test("discovery rechecks expiry, revoked bindings, rights and emergency stop", (t) => {
  const f = group(t);
  f.mutable.expires_at = new Date(Date.now() - 1).toISOString();
  assert.throws(() => discover(f, { action: "directory" }), code("forbidden"));
  f.mutable.expires_at = null;
  f.access("active", ["submit"]);
  assert.throws(() => discover(f, { action: "directory" }), code("forbidden"));
  f.access("active", operations);
  f.access("stopped", []);
  assert.throws(() => discover(f, { action: "whoami" }), code("forbidden"));
  f.access("active", operations);
  f.registry.emergencyStop(f.admin);
  assert.throws(
    () =>
      discover(f, { action: "check_address", address: "free@grok-bot.hab" }),
    code("forbidden"),
  );
});

test("a revoked binding denies retained contexts and another group's mutation does not change a scope snapshot", (t) => {
  const f = group(t);
  const before = discover(f, { action: "directory", limit: 1 });
  f.registry.setAccess(f.admin, {
    request_id: "foreign-stop",
    agent_id: f.external.agent_id,
    expected_epoch: f.external.epoch,
    state: "stopped",
    operations: [],
  });
  const after = discover(f, {
    action: "directory",
    limit: 1,
    cursor: before.next_cursor,
  });
  assert.equal(after.snapshot, before.snapshot);
  const binding = f.registry
    .overview(f.admin)
    .groups.find((g) => g.group_id === f.group.group_id).active_binding_ids[0];
  const current = f.registry.inspectGroup(f.admin, f.group.group_id);
  f.registry.revokeGroupBinding(f.admin, {
    request_id: "revoke-discovery",
    binding_id: binding,
    expected_epoch: current.epoch,
  });
  assert.throws(() => discover(f, { action: "whoami" }), code("forbidden"));
});

test("HTTP authentication, audit, bounds and writer-admission compatibility apply to discovery", async (t) => {
  const f = group(t),
    before = state(f);
  const admission = new WriterAdmission(
    {
      max_individuals: 3,
      max_waiting_per_individual: 2,
      requests_per_window: 10,
      window_ms: 1000,
      max_wait_ms: 1000,
    },
    () => {
      throw Error(
        "group discovery must not select a sender for the writer queue",
      );
    },
  );
  t.after(() => admission.close());
  const g = gateway(f, admission);
  assert.equal(
    value(await call(g, { action: "directory", limit: 1 })).agents.length,
    1,
  );
  assert.equal(
    value(await call(g, { action: "whoami" })).host_identity.state,
    "unknown",
  );
  assert.ok(f.events.some((e) => e.category === "tool_succeeded"));
  assert.equal(
    (await call(g, { action: "whoami" }, { Authorization: "Bearer bad" }))
      .status,
    401,
  );
  assert.equal(state(f), before);
});
