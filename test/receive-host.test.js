import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hostFixture } from "./adapter-host-fixtures.js";
import { code } from "./task-bridge-fixtures.js";
import { ReceiveHost } from "../src/agent-sdk/receive-host.ts";
import { ReceiveSupervisor } from "../src/agent-sdk/receive-supervisor.ts";
import { SQLiteHostOwner } from "../src/agent-sdk/sqlite-host-owner.ts";

/** The receive-only host takes only control, inbox, transport and authorization. */
function receiveOptions(f, extra = {}) {
  const { control, inbox, transport, network, authorization } = f.hostOptions();
  return { control, inbox, transport, network, authorization, ...extra };
}

test("Receive host: no outbox, budget or Task bridge is needed to save and ACK", async (t) => {
  const f = await hostFixture(t);
  const host = new ReceiveHost(receiveOptions(f));
  assert.equal(host.status(f.context).paused, true);
  await assert.rejects(
    host.stepOnce(f.context, { op: "receive" }),
    code("host_paused"),
  );
  f.resume(host);
  const { key } = f.submit();
  const result = await host.stepOnce(f.context, { op: "receive" });
  assert.deepEqual(result, {
    op: "receive",
    state: "done",
    reason: null,
    value: null,
  });
  const [entry] = f.inbox.inbox();
  assert.equal(entry.sender_id, key.sender_id);
  assert.equal(entry.message.message_id, key.message_id);
  assert.equal(entry.receipt_confirmed, true);
  assert.deepEqual(
    f.state.tools.filter((tool) => tool !== "relay_poll"),
    ["relay_ack"],
  );
  // A second step finds nothing new and does not reprocess the saved message.
  assert.equal(
    (await host.stepOnce(f.context, { op: "receive" })).state,
    "done",
  );
  assert.equal(f.inbox.inbox().length, 1);
});

test("Receive host: only the receive command is accepted", async (t) => {
  const f = await hostFixture(t);
  const host = new ReceiveHost(receiveOptions(f));
  f.resume(host);
  for (const op of ["send", "inbox", "message_enqueue", "task_accept"])
    await assert.rejects(
      host.stepOnce(f.context, { op }),
      code("invalid_host_command"),
    );
  await assert.rejects(
    host.stepOnce(f.context, { op: "receive", extra: true }),
    code("invalid_host_command"),
  );
  assert.deepEqual(f.state.tools, []);
});

test("Receive host: composition and authorization fail closed", async (t) => {
  const f = await hostFixture(t);
  for (const extra of [
    { inbox: undefined },
    { control: undefined },
    { transport: undefined },
    { managedTransport: () => ({}) },
    { authorization: "allow" },
  ])
    assert.throws(
      () => new ReceiveHost(receiveOptions(f, extra)),
      code("invalid_host_composition"),
    );
  const denied = new ReceiveHost(
    receiveOptions(f, { authorization: undefined }),
  );
  assert.throws(() => denied.status(f.context), code("host_forbidden"));
  const host = new ReceiveHost(receiveOptions(f));
  f.resume(host);
  f.state.denied.add("receive");
  await assert.rejects(
    host.stepOnce(f.context, { op: "receive" }),
    code("host_forbidden"),
  );
  assert.deepEqual(f.state.tools, []);
});

test("Receive host: a stop after remote ACK keeps the saved message and retries the same ACK", async (t) => {
  const f = await hostFixture(t);
  const host = new ReceiveHost(receiveOptions(f));
  f.resume(host);
  const { key } = f.submit();
  f.state.afterNetwork = async (tool) => {
    if (tool === "relay_ack") f.pause(host);
  };
  const stopped = await host.stepOnce(f.context, { op: "receive" });
  assert.equal(stopped.state, "incomplete");
  assert.equal(stopped.reason, "host_epoch_changed");
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
  const request = f.inboxRaw
    .prepare("SELECT request_id FROM relay_receiver_acks")
    .get().request_id;
  f.state.afterNetwork = null;
  f.resume(host);
  f.inboxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  assert.equal(
    (await host.stepOnce(f.context, { op: "receive" })).state,
    "done",
  );
  assert.equal(f.inbox.inbox().length, 1);
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  assert.equal(
    f.inboxRaw.prepare("SELECT request_id FROM relay_receiver_acks").get()
      .request_id,
    request,
  );
});

test("Receive host: the receive supervisor runs it with a process owner", async (t) => {
  const f = await hostFixture(t);
  const owner = new SQLiteHostOwner(join(f.dir, "receive-host-owner.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(92),
  });
  owner.migrate();
  owner.acquire(() => {});
  t.after(() => owner.close());
  const host = new ReceiveHost(receiveOptions(f, { owner }));
  assert.equal(host.status(f.context).owner, "held");
  f.resume(host);
  f.submit();
  const stop = new AbortController();
  const run = new ReceiveSupervisor(
    { version: 1, host, context: f.context },
    {
      interval_ms: 30000,
      retry_base_ms: 1000,
      retry_cap_ms: 4000,
      drain_timeout_ms: 3000,
    },
    { wait: async () => stop.abort() },
  );
  const result = await run.run(stop.signal);
  assert.equal(result.reason, "stopped");
  assert.equal(result.receive_steps, 1);
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  f.pause(host);
  host.releaseOwner(f.context);
  assert.equal(host.status(f.context).owner, "lost");
});
