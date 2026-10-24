import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  hostFixture as baseHostFixture,
  deferred,
} from "./adapter-host-fixtures.js";
import { message } from "./relay-http-fixtures.js";
import { code } from "./task-bridge-fixtures.js";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
// Healthy send coverage must not expire a deliberately short fault-test lease under suite load.
const hostFixture = (t) => baseHostFixture(t, {}, { outboxLeaseMs: 5000 });
const initial = (patch = {}) => ({ ...message(), recipient_id: "a", ...patch });
const enqueue = (value) => ({ op: "message_enqueue", message: value });

test("initial message: paused/default-denied/fake-context calls cannot populate outbox", async (t) => {
  const f = hostFixture(t),
    value = initial();
  await assert.rejects(f.step(enqueue(value)), code("host_paused"));
  f.resume();
  await assert.rejects(
    f.host.stepOnce({ agent_id: "b", actor_id: "synthetic" }, enqueue(value)),
    code("host_forbidden"),
  );
  const denied = f.makeHost({ authorization: undefined });
  await assert.rejects(
    denied.stepOnce(f.context, enqueue(value)),
    code("host_forbidden"),
  );
  assert.equal(f.queued().length, 0);
  assert.equal(f.state.tools.length, 0);
});

test("initial message: enqueue needs its own operation permission and strict command fields", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.state.denied.add("message_enqueue");
  await assert.rejects(f.step(enqueue(initial())), code("host_forbidden"));
  f.state.denied.delete("message_enqueue");
  await assert.rejects(
    f.step({ ...enqueue(initial()), agent_id: "b" }),
    code("invalid_host_command"),
  );
  assert.equal(f.queued().length, 0);
});

test("initial message: persist before network, stable duplicate receipt, and changed body never overwrites", async (t) => {
  const f = hostFixture(t),
    value = initial();
  f.resume();
  const first = await f.step(enqueue(value));
  assert.equal(first.state, "done");
  assert.equal(first.value.state, "queued");
  assert.equal(first.value.message_id, value.message_id);
  assert.equal(first.value.submit_attempts, 0);
  assert.equal("body" in first.value, false);
  assert.equal(f.state.tools.length, 0);
  assert.equal(f.count(), 0);
  assert.deepEqual((await f.step(enqueue(value))).value, first.value);
  const conflict = await f.step(
    enqueue({ ...value, body: { parts: [{ type: "text", text: "changed" }] } }),
  );
  assert.equal(conflict.state, "incomplete");
  assert.equal(f.queued().length, 1);
  assert.deepEqual((await f.step(enqueue(value))).value, first.value);
});

test("initial message: explicit send performs the only submit using the host-bound sender", async (t) => {
  const f = hostFixture(t),
    value = initial();
  f.resume();
  await f.step(enqueue(value));
  assert.equal((await f.step({ op: "send" })).state, "done");
  assert.deepEqual(f.state.tools, ["relay_submit"]);
  const delivery = f.service.poll(f.contexts.a);
  assert.equal(delivery.message.sender_id, "b");
  assert.equal(delivery.message.message_id, value.message_id);
  assert.equal(f.count(), 0);
});

test("initial message: replies cannot bypass source-bound intents and reply budgets", async (t) => {
  const f = hostFixture(t);
  f.resume();
  for (const kind of ["answer", "execution_accepted", "execution_result"]) {
    const result = await f.step(enqueue(initial({ kind })));
    assert.equal(result.reason, "host_initial_message_required");
  }
  const value = initial();
  const result = await f.step(
    enqueue({
      ...value,
      in_reply_to: { sender_id: "a", message_id: value.message_id },
    }),
  );
  assert.equal(result.reason, "host_initial_message_required");
  assert.equal(f.queued().length, 0);
  assert.equal(f.state.tools.length, 0);
});

test("initial message: malformed sender/URL/attachment input cannot enqueue or trigger IO", async (t) => {
  const f = hostFixture(t);
  f.resume();
  for (const patch of [
    { sender_id: "a" },
    { recipient_id: "https://example.invalid/forward" },
    {
      body: {
        parts: [{ type: "attachment", url: "https://example.invalid/file" }],
      },
    },
  ]) {
    assert.equal((await f.step(enqueue(initial(patch)))).state, "incomplete");
  }
  assert.equal(f.queued().length, 0);
  assert.equal(f.state.tools.length, 0);
  assert.equal(f.count(), 0);
});

test("initial message: current authority is rechecked at the durable outbox boundary", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const original = f.outbox.enqueueGuarded.bind(f.outbox);
  f.outbox.enqueueGuarded = (value, guard) => {
    f.state.enabled = false;
    return original(value, guard);
  };
  const result = await f.step(enqueue(initial()));
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "host_forbidden");
  assert.equal(f.queued().length, 0);
  assert.equal(f.state.tools.length, 0);
});

test("initial message: lost confirmation keeps one stable intent and reveals no exception text", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const value = initial();
  const original = f.outbox.enqueueGuarded.bind(f.outbox);
  f.outbox.enqueueGuarded = (v, guard) => {
    original(v, guard);
    throw Error("synthetic-private-error-do-not-return");
  };
  const result = await f.step(enqueue(value));
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "host_step_unavailable");
  assert.equal(
    JSON.stringify(result).includes("synthetic-private-error"),
    false,
  );
  assert.equal(f.queued().length, 1);
  f.outbox.enqueueGuarded = original;
  const replay = await f.step(enqueue(value));
  assert.equal(replay.state, "done");
  assert.equal(replay.value.expires_at, value.expires_at);
  assert.equal(f.queued().length, 1);
  assert.equal(f.state.tools.length, 0);
});

test("initial message: inert execution request never creates a Task at enqueue or send", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const value = initial({
    kind: "execution_request",
    body: {
      parts: [
        {
          type: "data",
          schema_id: "task.execution_request",
          schema_version: 1,
          value: { task_type: "connectivity_check" },
        },
      ],
    },
  });
  assert.equal((await f.step(enqueue(value))).state, "done");
  assert.equal(f.count(), 0);
  assert.equal((await f.step({ op: "send" })).state, "done");
  assert.equal(f.count(), 0);
  assert.equal(f.calls.length, 0);
});

test("initial message: released process owner cannot enqueue through an old host", async (t) => {
  const f = hostFixture(t),
    owner = new SQLiteHostOwner(join(f.dir, "message-owner.sqlite"), {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(82),
    });
  t.after(() => owner.close());
  owner.migrate();
  owner.acquire(() => {});
  const host = f.makeHost({ owner });
  f.resume(host);
  f.pause(host);
  host.releaseOwner(f.context);
  await assert.rejects(host.stepOnce(f.context, enqueue(initial())));
  assert.equal(f.queued().length, 0);
  assert.equal(f.state.tools.length, 0);
});

test("initial message: an in-flight host RPC blocks concurrent enqueue", async (t) => {
  const f = hostFixture(t),
    wait = deferred();
  f.resume();
  f.state.credential = () => wait.promise;
  const work = f.step({ op: "receive" });
  await assert.rejects(f.step(enqueue(initial())), code("host_busy"));
  wait.resolve("Bearer fixture-b");
  await work;
  assert.equal(f.queued().length, 0);
});
