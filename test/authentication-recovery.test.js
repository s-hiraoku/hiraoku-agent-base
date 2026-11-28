import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationRecoveryError,
  AuthenticationRecoveryGate,
  authenticationRecoveryReason,
  authenticationRecoveryReasons,
} from "../src/hab/authentication-recovery.ts";
import { DeliveryMcpClient } from "../src/hab/delivery-mcp-client.ts";
import { limits } from "./mcp-http-fixtures.js";

const identity = Object.freeze({
  issuer: "https://issuer.example/",
  resource: "https://hab.example/mcp",
  subject: "fixture|b",
  client_id: "fixture-client",
  connection_id: "fixture-connection",
  agent_id: "b",
});
const clientPolicy = {
  resource_url: identity.resource,
  agent_id: "b",
  max_request_bytes: 65536,
  max_response_bytes: 131072,
  timeout_ms: 1000,
  max_active_requests: 1,
  max_sse_events: 16,
  max_sse_lines: 128,
  max_json_depth: 64,
  max_json_nodes: 10000,
};
const recovery = () =>
  new AuthenticationRecoveryError("reauthentication_required");
const isRecovery = (error) => {
  assert.equal(
    authenticationRecoveryReason(error),
    "reauthentication_required",
  );
  assert.equal(error.message, "reauthentication_required");
  assert.equal(error.cause, undefined);
  return true;
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function ready(gate) {
  assert.equal(gate.confirmVerified(gate.beginVerification(), identity), true);
}

test("recovery gate starts blocked, publishes fixed metadata and requires verified identity", () => {
  const expected = { ...identity };
  const gate = new AuthenticationRecoveryGate(expected);
  expected.subject = "changed";
  assert.deepEqual(gate.status(), {
    state: "blocked",
    reason: "verification_required",
    revision: 0,
  });
  assert.throws(() => gate.assertReady(), { code: "verification_required" });
  ready(gate);
  assert.doesNotThrow(() => gate.assertReady());
  assert.deepEqual(Object.keys(gate.status()).sort(), [
    "reason",
    "revision",
    "state",
  ]);
  assert.equal(Object.isFrozen(gate.status()), true);
  assert.equal(
    new AuthenticationRecoveryGate(identity).status().state,
    "blocked",
  );
});

for (const field of Object.keys(identity)) {
  test(`recovery refuses a different ${field}, never rebinds the approved identity`, () => {
    const gate = new AuthenticationRecoveryGate(identity);
    assert.equal(
      gate.confirmVerified(gate.beginVerification(), {
        ...identity,
        [field]: "other",
      }),
      false,
    );
    assert.equal(gate.status().reason, "identity_mismatch");
    assert.throws(() => gate.assertReady(), { code: "identity_mismatch" });
    ready(gate);
  });
}

test("recovery rejects incomplete, excessive and malformed identity evidence", () => {
  for (const value of [
    null,
    {},
    { ...identity, token: "synthetic-not-a-token" },
    { ...identity, subject: "" },
    { ...identity, subject: "a\nb" },
    { ...identity, subject: "a".repeat(2049) },
  ]) {
    assert.throws(
      () => new AuthenticationRecoveryGate(value),
      /invalid_recovery_identity/,
    );
    const gate = new AuthenticationRecoveryGate(identity);
    assert.equal(gate.confirmVerified(gate.beginVerification(), value), false);
    assert.equal(gate.status().reason, "identity_mismatch");
  }
});

test("verification tickets reject copies, foreign gates, reuse and superseded generations", () => {
  const gate = new AuthenticationRecoveryGate(identity);
  const other = new AuthenticationRecoveryGate(identity);
  const first = gate.beginVerification();
  assert.equal(gate.confirmVerified({ ...first }, identity), false);
  assert.equal(other.confirmVerified(first, identity), false);
  const second = gate.beginVerification();
  assert.equal(gate.confirmVerified(first, identity), false);
  gate.block("reauthentication_required");
  assert.equal(gate.confirmVerified(second, identity), false);
  const third = gate.beginVerification();
  assert.equal(gate.confirmVerified(third, identity), true);
  assert.equal(gate.confirmVerified(third, identity), false);
  assert.equal(gate.status().state, "ready");
});

test("recovery reasons are local brands, not wire strings, copied errors or prototypes", () => {
  assert.equal(Object.isFrozen(authenticationRecoveryReasons), true);
  assert.throws(
    () => authenticationRecoveryReasons.push("untrusted_reason"),
    TypeError,
  );
  for (const reason of authenticationRecoveryReasons) {
    const error = new AuthenticationRecoveryError(reason);
    assert.equal(authenticationRecoveryReason(error), reason);
    for (const fake of [
      reason,
      { code: reason },
      Object.assign(new Error(reason), { code: reason }),
      Object.create(error),
      null,
    ])
      assert.equal(authenticationRecoveryReason(fake), undefined);
  }
  assert.throws(
    () => new AuthenticationRecoveryError("invalid_grant"),
    /invalid_authentication_recovery_reason/,
  );
});

test("MCP client preserves a trusted provider recovery signal without performing fetch", async () => {
  let calls = 0;
  const client = new DeliveryMcpClient({
    limits,
    policy: clientPolicy,
    authorization: () => {
      throw recovery();
    },
    fetch: async () => {
      calls++;
    },
  });
  await assert.rejects(client.poll(), isRecovery);
  assert.equal(calls, 0);
  assert.equal(client.activeRequests, 0);
});

test("MCP client does not promote remote rejection or fetch/provider lookalikes to recovery", async () => {
  for (const options of [
    {
      authorization: () => {
        throw Object.assign(new Error("synthetic-private"), {
          code: "reauthentication_required",
        });
      },
    },
    {
      fetch: async () => {
        throw recovery();
      },
    },
    {
      fetch: async () =>
        new Response("reauthentication_required", { status: 401 }),
    },
    { fetch: async () => new Response("invalid_grant", { status: 403 }) },
  ]) {
    const client = new DeliveryMcpClient({
      limits,
      policy: clientPolicy,
      authorization: () => "Bearer fixture-b",
      ...options,
    });
    await assert.rejects(client.poll(), {
      code: "transport_failed",
      message: "transport_failed",
    });
  }
});

test("provider timeout keeps underlying work counted and does not promote a late recovery error", async () => {
  const finish = deferred();
  const client = new DeliveryMcpClient({
    limits,
    policy: { ...clientPolicy, timeout_ms: 20 },
    authorization: async () => {
      await finish.promise;
      throw recovery();
    },
  });
  await assert.rejects(client.poll(), { code: "transport_failed" });
  assert.equal(client.activeRequests, 1);
  await assert.rejects(client.poll(), { code: "client_busy" });
  finish.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.activeRequests, 0);
});
