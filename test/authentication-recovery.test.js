import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  AuthenticationRecoveryError,
  AuthenticationRecoveryGate,
  authenticationRecoveryReason,
  authenticationRecoveryReasons,
} from "../src/agent-sdk/authentication-recovery.ts";
import { ReceiveSupervisor } from "../src/agent-sdk/receive-supervisor.ts";
import { SQLiteHostOwner } from "../src/agent-sdk/sqlite-host-owner.ts";
import { DurableReceiver } from "../src/agent-sdk/receiver.ts";
import { DurableSender } from "../src/agent-sdk/sender.ts";
import { DeliveryMcpClient } from "../src/agent-sdk/mcp-client.ts";
import { hostFixture, deferred, limits } from "./adapter-host-fixtures.js";

const identity = Object.freeze({
  issuer: "https://issuer.example/",
  resource: "https://hab.example/mcp",
  subject: "fixture|b",
  client_id: "fixture-client",
  connection_id: "fixture-connection",
  agent_id: "b",
});
const policy = {
  interval_ms: 30000,
  retry_base_ms: 1000,
  retry_cap_ms: 4000,
  drain_timeout_ms: 3000,
};
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
function ready(gate) {
  assert.equal(gate.confirmVerified(gate.beginVerification(), identity), true);
}
function port() {
  const state = { owner: "held", paused: false, running: false, draining: 0 };
  let calls = 0;
  return {
    state,
    calls: () => calls,
    version: 1,
    context: {},
    host: {
      status: () => ({ ...state }),
      stepOnce: async () => {
        calls++;
        return { op: "receive", state: "done", reason: null, value: null };
      },
    },
  };
}
async function durableFixture(t) {
  const f = await hostFixture(t);
  const owner = new SQLiteHostOwner(join(f.dir, "recovery-owner.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(92),
  });
  owner.migrate();
  owner.acquire(() => {});
  t.after(() => owner.close());
  const ackRequests = [],
    network = f.hostOptions().network;
  const host = f.makeHost({
    owner,
    network: async (input, init) => {
      if (new Request(input, init).headers.get("Mcp-Name") === "hab_ack")
        ackRequests.push(JSON.parse(init.body).params.arguments);
      return network(input, init);
    },
  });
  f.resume(host);
  return {
    ...f,
    host,
    ackRequests,
    port: { version: 1, host, context: f.context },
  };
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
  const gate = new AuthenticationRecoveryGate(identity),
    other = new AuthenticationRecoveryGate(identity);
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
test("receiver preserves recovery but not an error code string", async () => {
  for (const error of [
    recovery(),
    Object.assign(new Error("synthetic-private"), {
      code: "reauthentication_required",
    }),
  ]) {
    const receiver = new DurableReceiver(
      { claimAck: () => null },
      {
        poll: async () => {
          throw error;
        },
      },
    );
    await assert.rejects(
      receiver.receiveOnce(),
      error instanceof AuthenticationRecoveryError
        ? isRecovery
        : { code: "poll_transport_failed" },
    );
  }
});
for (const operation of ["submit", "status"]) {
  test(`sender durably defers ${operation} before reporting recovery, without quarantine`, async () => {
    const job = {
      operation,
      message_id: "synthetic-message",
      fence: 1,
      message: {},
    };
    const events = [];
    const sender = new DurableSender(
      {
        claim: () => job,
        defer: (value) => {
          assert.equal(value, job);
          events.push("defer");
        },
        quarantine: () => events.push("quarantine"),
      },
      {
        [operation]: async () => {
          throw recovery();
        },
      },
    );
    await assert.rejects(sender.sendOnce(), isRecovery);
    assert.deepEqual(events, ["defer"]);
  });
}
test("host reports local recovery, but a current pause wins and no credential reaches the network", async (t) => {
  const f = await durableFixture(t);
  f.state.credential = () => {
    throw recovery();
  };
  const first = await f.host.stepOnce(f.context, { op: "receive" });
  assert.equal(first.reason, "reauthentication_required");
  f.state.credential = () => {
    f.pause(f.host);
    throw recovery();
  };
  const second = await f.host.stepOnce(f.context, { op: "receive" });
  assert.equal(second.reason, "host_epoch_changed");
  assert.deepEqual(f.state.tools, []);
});
test("durable ACK identity and full body survive recovery and same-identity resume", async (t) => {
  const f = await durableFixture(t),
    gate = new AuthenticationRecoveryGate(identity),
    stop = new AbortController();
  ready(gate);
  const { key, message } = f.submit();
  let credentials = 0,
    savedAck;
  f.state.credential = () => {
    if (++credentials === 2) throw recovery();
    return "Bearer fixture-b";
  };
  const events = [];
  const result = await new ReceiveSupervisor(
    {
      ...f.port,
      authentication: gate,
      authenticationChanged: (status) => {
        events.push(status.reason);
      },
    },
    policy,
    {
      wait: async (ms) => {
        assert.equal(ms, policy.interval_ms);
        if (gate.status().state === "blocked") {
          assert.equal(gate.status().reason, "reauthentication_required");
          assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
          assert.deepEqual(f.inbox.inbox()[0].message, message);
          savedAck = f.inboxRaw
            .prepare("SELECT * FROM receiver_acks")
            .get();
          f.inboxRaw.exec("UPDATE receiver_acks SET next_retry_at=0");
          ready(gate);
        } else stop.abort();
      },
    },
  ).run(stop.signal);
  assert.deepEqual(result, {
    reason: "stopped",
    receive_steps: 2,
    retries: 0,
    drained: true,
  });
  assert.deepEqual(events, [null, "reauthentication_required", null]);
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  const confirmed = f.inboxRaw
    .prepare("SELECT * FROM receiver_acks")
    .get();
  assert.deepEqual(f.ackRequests, [JSON.parse(savedAck.request)]);
  for (const field of ["request_id", "message_id", "fingerprint"])
    assert.equal(confirmed[field], savedAck[field]);
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
  assert.deepEqual(f.state.tools, ["hab_poll", "hab_ack", "hab_poll"]);
  assert.equal(f.queued().length, 0);
});
test("supervisor without a gate stops at a typed recovery reason instead of retrying forever", async () => {
  const p = port();
  p.host.stepOnce = async () => ({
    op: "receive",
    state: "incomplete",
    reason: "reauthentication_required",
    value: null,
  });
  const result = await new ReceiveSupervisor(p, policy).run(
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    reason: "reauthentication_required",
    receive_steps: 1,
    retries: 0,
    drained: true,
  });
});
test("blocked supervisor performs only bounded local waits and emits each state once", async () => {
  const p = port(),
    gate = new AuthenticationRecoveryGate(identity),
    stop = new AbortController(),
    events = [];
  let waits = 0;
  const result = await new ReceiveSupervisor(
    {
      ...p,
      authentication: gate,
      authenticationChanged: (status) => {
        events.push(status);
      },
    },
    policy,
    {
      wait: async (ms, signal) => {
        assert.equal(ms, policy.interval_ms);
        assert.equal(signal, stop.signal);
        assert.equal(p.calls(), 0);
        if (++waits === 3) stop.abort();
      },
    },
  ).run(stop.signal);
  assert.equal(result.receive_steps, 0);
  assert.equal(result.retries, 0);
  assert.equal(events.length, 1);
});
for (const kind of ["paused", "owner", "draining"]) {
  test(`authentication recovery never overrides ${kind}`, async () => {
    const p = port(),
      gate = new AuthenticationRecoveryGate(identity);
    let now = 0;
    const result = await new ReceiveSupervisor(
      { ...p, authentication: gate },
      policy,
      {
        now: () => now,
        wait: async () => {
          now += 1000;
          ready(gate);
          if (kind === "owner") p.state.owner = "lost";
          else if (kind === "draining") p.state.draining = 1;
          else p.state.paused = true;
        },
      },
    ).run(new AbortController().signal);
    assert.equal(p.calls(), 0);
    assert.equal(
      result.reason,
      {
        paused: "paused",
        owner: "owner_unavailable",
        draining: "drain_timeout",
      }[kind],
    );
  });
}
for (const change of ["pause", "block"]) {
  test(`ready observer ${change} is rechecked before receive admission`, async () => {
    const p = port(),
      gate = new AuthenticationRecoveryGate(identity),
      stop = new AbortController();
    ready(gate);
    const result = await new ReceiveSupervisor(
      {
        ...p,
        authentication: gate,
        authenticationChanged: (status) => {
          if (status.state === "ready") {
            if (change === "pause") p.state.paused = true;
            else gate.block("identity_mismatch");
          }
        },
      },
      policy,
      { wait: async () => stop.abort() },
    ).run(stop.signal);
    assert.equal(p.calls(), 0);
    assert.equal(result.reason, change === "pause" ? "paused" : "stopped");
  });
}
test("observer exceptions and asynchronous callbacks fail closed without exposing their text", async () => {
  for (const callback of [
    () => {
      throw Error("synthetic-private");
    },
    async () => {
      throw Error("synthetic-private");
    },
  ]) {
    const p = port(),
      gate = new AuthenticationRecoveryGate(identity);
    ready(gate);
    const result = await new ReceiveSupervisor(
      { ...p, authentication: gate, authenticationChanged: callback },
      policy,
    ).run(new AbortController().signal);
    assert.equal(result.reason, "host_unavailable");
    assert.equal(p.calls(), 0);
  }
});
test("stop signal interrupts a blocked wait without receiving or unpausing", async () => {
  const p = port(),
    gate = new AuthenticationRecoveryGate(identity),
    stop = new AbortController(),
    observed = deferred();
  const run = new ReceiveSupervisor(
    {
      ...p,
      authentication: gate,
      authenticationChanged: () => {
        observed.resolve();
      },
    },
    policy,
  ).run(stop.signal);
  await observed.promise;
  stop.abort();
  assert.deepEqual(await run, {
    reason: "stopped",
    receive_steps: 0,
    retries: 0,
    drained: true,
  });
  assert.equal(gate.status().state, "blocked");
});
