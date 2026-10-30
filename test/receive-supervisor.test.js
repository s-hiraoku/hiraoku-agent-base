import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ReceiveSupervisor } from "../src/adapter-host/receive-supervisor.ts";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { hostFixture, deferred, limits } from "./adapter-host-fixtures.js";

const policy = {
  interval_ms: 30000,
  retry_base_ms: 1000,
  retry_cap_ms: 4000,
  drain_timeout_ms: 3000,
};
function fixture(t) {
  const f = hostFixture(t);
  const owner = new SQLiteHostOwner(join(f.dir, "supervisor-owner.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(91),
  });
  owner.migrate();
  owner.acquire(() => {});
  const host = f.makeHost({ owner });
  t.after(() => owner.close());
  return { ...f, host, port: { version: 1, host, context: f.context } };
}
test("Receive supervisor: durable host stores and ACKs once, restart does not reprocess or execute", async (t) => {
  const f = fixture(t),
    stop = new AbortController();
  f.resume(f.host);
  const { key } = f.submit();
  let ticks = 0;
  const run = new ReceiveSupervisor(f.port, policy, {
    wait: async (ms) => {
      assert.equal(ms, policy.interval_ms);
      assert.equal(f.inbox.inbox().length, 1);
      assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
      if (++ticks === 2) stop.abort();
    },
  });
  assert.deepEqual(await run.run(stop.signal), {
    reason: "stopped",
    receive_steps: 2,
    retries: 0,
    drained: true,
  });
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
  const reopened = f.open();
  reopened.migrate();
  const restarted = f.makeHost({ control: reopened });
  // Owner composition is mandatory even when the previous durable state is active.
  assert.equal(
    (
      await new ReceiveSupervisor({ ...f.port, host: restarted }, policy).run(
        new AbortController().signal,
      )
    ).reason,
    "owner_unavailable",
  );
  f.pause(f.host);
  f.host.releaseOwner(f.context);
  const nextOwner = new SQLiteHostOwner(
    join(f.dir, "supervisor-owner.sqlite"),
    {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(91),
    },
  );
  nextOwner.migrate();
  nextOwner.acquire(() => {});
  const nextInbox = new SQLiteInbox(join(f.dir, "bridge-inbox.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(44),
    limits,
    max_records: 20,
    max_body_bytes: 100000,
    max_ack_records: 40,
    ack_retry_ms: 86400000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_attempts: 3,
  });
  nextInbox.migrate();
  t.after(() => {
    nextOwner.close();
    nextInbox.close();
  });
  const nextHost = f.makeHost({
    control: reopened,
    inbox: nextInbox,
    owner: nextOwner,
  });
  f.resume(nextHost);
  const nextStop = new AbortController();
  const afterRestart = await new ReceiveSupervisor(
    { ...f.port, host: nextHost },
    policy,
    {
      wait: async () => nextStop.abort(),
    },
  ).run(nextStop.signal);
  assert.equal(afterRestart.receive_steps, 1);
  assert.equal(afterRestart.drained, true);
  assert.equal(nextInbox.inbox().length, 1);
  assert.equal(nextInbox.inbox()[0].receipt_confirmed, true);
  assert.deepEqual(f.state.tools, [
    "relay_poll",
    "relay_ack",
    "relay_poll",
    "relay_poll",
  ]);
  assert.equal(f.inbox.inbox().length, 1);
  assert.equal(f.count(), 0);
  assert.equal(f.queued().length, 0);
});
test("Receive supervisor: lost ACK response is reconciled before polling another message", async (t) => {
  const f = fixture(t),
    stop = new AbortController(),
    waits = [];
  f.resume(f.host);
  f.submit();
  let lost = false;
  f.state.afterNetwork = async (tool) => {
    if (tool === "relay_ack" && !lost) {
      lost = true;
      throw new Error("private endpoint detail");
    }
  };
  const run = new ReceiveSupervisor(f.port, policy, {
    wait: async (ms) => {
      waits.push(ms);
      if (waits.length === 1) {
        assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
        // Advance the existing ACK retry eligibility, not the envelope or receipt identity.
        f.inboxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
      } else stop.abort();
    },
  });
  const result = await run.run(stop.signal);
  assert.equal(result.retries, 1);
  assert.deepEqual(waits, [1000, 30000]);
  assert.deepEqual(f.state.tools, [
    "relay_poll",
    "relay_ack",
    "relay_ack",
    "relay_poll",
  ]);
  assert.equal(f.inbox.inbox().length, 1);
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
});
test("Receive supervisor: pause, revocation and missing owner never start network work", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await new ReceiveSupervisor(f.port, policy).run(
        new AbortController().signal,
      )
    ).reason,
    "paused",
  );
  f.resume(f.host);
  f.state.enabled = false;
  const r = await new ReceiveSupervisor(f.port, policy).run(
    new AbortController().signal,
  );
  assert.deepEqual(r, {
    reason: "host_unavailable",
    receive_steps: 0,
    retries: 0,
    drained: false,
  });
  assert.deepEqual(f.state.tools, []);
});
test("Receive supervisor: stop waits for the current receive and prevents overlap", async (t) => {
  const f = fixture(t),
    stop = new AbortController(),
    started = deferred(),
    finish = deferred();
  f.resume(f.host);
  f.state.afterNetwork = async () => {
    started.resolve();
    await finish.promise;
  };
  const run = new ReceiveSupervisor(f.port, policy);
  const pending = run.run(stop.signal);
  await started.promise;
  await assert.rejects(run.run(stop.signal), /receive_supervisor_busy/);
  stop.abort();
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finish.resolve();
  assert.deepEqual(await pending, {
    reason: "stopped",
    receive_steps: 1,
    retries: 0,
    drained: true,
  });
  assert.deepEqual(f.state.tools, ["relay_poll"]);
});
test("Receive supervisor: transport failures back off to a cap and success resets the delay", async () => {
  const stop = new AbortController(),
    delays = [],
    commands = [];
  let n = 0;
  const host = {
    status: () => ({
      owner: "held",
      paused: false,
      running: false,
      draining: 0,
    }),
    stepOnce: async (_ctx, command) => {
      commands.push(command);
      n++;
      return n === 5
        ? { op: "receive", state: "done", reason: null, value: null }
        : {
            op: "receive",
            state: "incomplete",
            reason: "poll_transport_failed",
            value: null,
          };
    },
  };
  const result = await new ReceiveSupervisor(
    { version: 1, host, context: {} },
    policy,
    {
      wait: async (ms) => {
        delays.push(ms);
        if (delays.length === 6) stop.abort();
      },
    },
  ).run(stop.signal);
  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 30000, 1000]);
  assert.equal(result.retries, 5);
  assert.ok(commands.every((c) => JSON.stringify(c) === '{"op":"receive"}'));
});
test("Receive supervisor: unknown/unsafe results fail closed without logging private error text", async () => {
  const state = { owner: "held", paused: false, running: false, draining: 0 };
  for (const stepOnce of [
    async () => {
      throw new Error("SECRET");
    },
    async () => ({
      op: "receive",
      state: "incomplete",
      reason: "host_step_unavailable",
      value: "SECRET",
    }),
    async () => ({ op: "send", state: "done", reason: null, value: "SECRET" }),
  ]) {
    const result = await new ReceiveSupervisor(
      { version: 1, context: {}, host: { status: () => state, stepOnce } },
      policy,
    ).run(new AbortController().signal);
    assert.equal(result.reason, "host_unavailable");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
});
test("Receive supervisor: unresolved transport is drained with a bound, never replaced or released", async () => {
  let clock = 0,
    calls = 0;
  const state = { owner: "held", paused: false, running: false, draining: 1 };
  const result = await new ReceiveSupervisor(
    {
      version: 1,
      context: {},
      host: {
        status: () => state,
        stepOnce: async () => {
          calls++;
        },
      },
    },
    policy,
    {
      now: () => clock,
      wait: async (ms, signal) => {
        assert.equal(signal, undefined);
        clock += ms;
      },
    },
  ).run(new AbortController().signal);
  assert.deepEqual(result, {
    reason: "drain_timeout",
    receive_steps: 0,
    retries: 0,
    drained: false,
  });
  assert.equal(clock, 3000);
  assert.equal(calls, 0);
});
test("Receive supervisor: aborted idle wait exits, malformed state and policy are rejected", async () => {
  const signal = new AbortController();
  const host = {
    status: () => ({
      owner: "held",
      paused: false,
      running: false,
      draining: 0,
    }),
    stepOnce: async () => {
      signal.abort();
      return { op: "receive", state: "done", reason: null, value: null };
    },
  };
  assert.equal(
    (
      await new ReceiveSupervisor(
        { version: 1, host, context: null },
        policy,
      ).run(signal.signal)
    ).reason,
    "stopped",
  );
  for (const patch of [
    { interval_ms: 0 },
    { retry_cap_ms: 1 },
    { drain_timeout_ms: 60001 },
    { extra: true },
  ])
    assert.throws(
      () =>
        new ReceiveSupervisor(
          { version: 1, host, context: null },
          { ...policy, ...patch },
        ),
    );
  assert.throws(
    () => new ReceiveSupervisor({ version: 2, host, context: null }, policy),
  );
  host.status = () => ({
    owner: "held",
    paused: false,
    running: false,
    draining: -1,
  });
  const result = await new ReceiveSupervisor(
    { version: 1, host, context: null },
    policy,
  ).run(new AbortController().signal);
  assert.equal(result.reason, "host_unavailable");
  assert.equal(result.drained, false);
});
