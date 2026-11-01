import assert from "node:assert/strict";
import { test } from "node:test";
import { HabRelayService } from "../../../src/hab/relay.ts";
import { HabHttpGateway } from "../../../src/hab/http.ts";
import { DurableReceiver } from "../../../src/relay/receiver.ts";
import { policy, call } from "../../../test/relay-http-fixtures.js";
import { habFixture } from "./hab-fixture.js";
import { ackRequest, gatePubAck } from "./fixture.js";
import { JetStreamRelay } from "../src/backend.ts";

test("real group Registry keeps all public operations synchronous while the broker pump does IO", async (t) => {
  const f = await habFixture(t);
  const message = f.message();
  const receipt = f.service.submit(f.selected("a"), message);
  assert.equal(receipt instanceof Promise, false);
  assert.equal(receipt.sender_id, f.agents.a.agent_id);
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.equal(f.service.poll(f.selected("b")), null);
  await f.backend.pumpOnce();
  const delivery = f.service.poll(f.selected("b"));
  assert.ok(delivery);
  assert.equal(delivery instanceof Promise, false);
  const saved = f.service.ack(f.selected("b"), ackRequest(delivery));
  assert.equal(saved instanceof Promise, false);
  await f.backend.pumpOnce();
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.equal(
    f.service.status(f.selected("a"), message.message_id).state,
    "acked",
  );
});

test("two names in one real group stay distinct and another group cannot select or ACK them", async (t) => {
  const f = await habFixture(t);
  const first = f.service.submit(f.selected("a"), f.message());
  const second = f.service.submit(f.selected("a2"), f.message());
  assert.equal(first.sender_id, f.agents.a.agent_id);
  assert.equal(second.sender_id, f.agents.a2.agent_id);
  assert.throws(() => f.service.poll(f.contexts.a), { code: "forbidden" });
  assert.throws(() => f.service.poll(f.selected("a", "c")), {
    code: "forbidden",
  });
  await f.backend.pumpOnce();
  const delivery = f.service.poll(f.selected("b"));
  assert.throws(() => f.service.ack(f.selected("c"), ackRequest(delivery)), {
    code: "invalid_ack",
  });
  f.service.ack(f.selected("b"), ackRequest(delivery));
});

test("stopped address, stopped group, expired credential and emergency stop fence cached delivery commits", async (t) => {
  const f = await habFixture(t);
  f.service.submit(f.selected("a"), f.message());
  await f.backend.pumpOnce();
  f.access("a", "stopped");
  assert.equal(f.service.poll(f.selected("b")), null);
  f.access("a", "active", ["submit", "status", "poll", "ack", "resolve"]);
  f.groupAccess("b", "stopped");
  assert.throws(() => f.service.poll(f.selected("b")), { code: "forbidden" });
  f.groupAccess("b", "active", ["submit", "status", "poll", "ack", "resolve"]);
  f.mutable.expires_at.set("b", new Date(Date.now() - 1000).toISOString());
  assert.throws(() => f.service.poll(f.selected("b")), { code: "forbidden" });
  f.mutable.expires_at.delete("b");
  const raw = f.journal();
  assert.equal(
    raw.prepare("SELECT max(generation) n FROM nats_messages").get().n,
    0,
  );
  raw.close();
  f.registry.emergencyStop(f.admin);
  assert.throws(() => f.service.poll(f.selected("b")), { code: "forbidden" });
});

test("old SQLite receipts and new NATS receipts keep their owner across route rollback", async (t) => {
  const f = await habFixture(t);
  const old = new HabRelayService(f.registry, f.legacy, f.options.limits);
  const legacyMessage = f.message();
  const legacyReceipt = old.submit(f.selected("a"), legacyMessage);
  assert.deepEqual(
    f.service.submit(f.selected("a"), legacyMessage),
    legacyReceipt,
  );
  assert.equal(
    f.backend.lookupReceipt(f.agents.a.agent_id, legacyMessage.message_id),
    null,
  );
  const natsMessage = f.message();
  const natsReceipt = f.service.submit(f.selected("a"), natsMessage);
  const rollbackBackend = f.track(
    await JetStreamRelay.open({ ...f.options, route_epoch: 2 }),
  );
  const rollback = f.createService(
    { ...f.routing, epoch: 2, enabled: false },
    rollbackBackend,
  );
  assert.deepEqual(rollback.submit(f.selected("a"), natsMessage), natsReceipt);
  const future = f.message();
  rollback.submit(f.selected("a"), future);
  assert.equal(
    f.backend.lookupReceipt(f.agents.a.agent_id, future.message_id),
    null,
  );
  assert.throws(
    () => f.service.submit(f.selected("a"), f.message()),
    /routing|epoch/i,
  );
  assert.equal(
    rollback.status(f.selected("a"), natsMessage.message_id).receipt_id,
    natsReceipt.receipt_id,
  );
});

test("mixed old and new queues share one live lease and alternate after a saved ACK", async (t) => {
  const f = await habFixture(t);
  const old = new HabRelayService(f.registry, f.legacy, f.options.limits);
  const legacyMessage = f.message();
  old.submit(f.selected("a"), legacyMessage);
  const natsMessage = f.message();
  f.service.submit(f.selected("a"), natsMessage);
  await f.backend.pumpOnce();
  const first = f.service.poll(f.selected("b"));
  assert.equal(first.message.message_id, legacyMessage.message_id);
  assert.equal(f.service.poll(f.selected("b")), null);
  f.service.ack(f.selected("b"), ackRequest(first, "legacy-saved"));
  const second = f.service.poll(f.selected("b"));
  assert.equal(second.message.message_id, natsMessage.message_id);
  assert.equal(f.service.poll(f.selected("b")), null);
  f.service.ack(f.selected("b"), ackRequest(second, "nats-saved"));
});

test("real MCP five-tool gateway accepts the synchronous façade and preserves group name selection", async (t) => {
  const f = await habFixture(t);
  const gateway = new HabHttpGateway(
    f.service,
    policy,
    { record() {} },
    () => f.contexts.a,
  );
  const message = f.message();
  const response = await call(gateway, "relay_submit", {
    ...message,
    as_address: f.agents.a.address,
    expected_agent_id: f.agents.a.agent_id,
  });
  assert.equal(response.body.result.isError, undefined);
  assert.equal(
    response.body.result.structuredContent.sender_id,
    f.agents.a.agent_id,
  );
  const poller = new HabHttpGateway(
    f.service,
    policy,
    { record() {} },
    () => f.contexts.b,
  );
  await f.backend.pumpOnce();
  const received = await call(poller, "relay_poll", {
    as_address: f.agents.b.address,
    expected_agent_id: f.agents.b.agent_id,
  });
  assert.equal(
    received.body.result.structuredContent.delivery.message.message_id,
    message.message_id,
  );
});

test("receiver persistence failure does not ACK either store through the real group façade", async (t) => {
  const f = await habFixture(t);
  const message = f.message();
  f.service.submit(f.selected("a"), message);
  await f.backend.pumpOnce();
  let calls = 0;
  const receiver = new DurableReceiver(
    {
      save() {
        throw Error("synthetic storage failure");
      },
      claimAck: () => null,
    },
    {
      poll: () => Promise.resolve(f.service.poll(f.selected("b"))),
      ack: (request) => {
        calls++;
        return Promise.resolve(f.service.ack(f.selected("b"), request));
      },
    },
  );
  await assert.rejects(receiver.receiveOnce(), /synthetic storage failure/);
  assert.equal(calls, 0);
  assert.equal(
    f.service.status(f.selected("a"), message.message_id).state,
    "leased",
  );
});

test("revocation while PubAck is held cannot create a HAB lease from a prefetched broker message", async (t) => {
  const f = await habFixture(t);
  const proxy = await gatePubAck(t, f.options.server);
  const backend = f.track(
    await JetStreamRelay.open({ ...f.options, server: proxy.server }),
  );
  const service = f.createService(f.routing, backend);
  const message = f.message();
  const accepted = service.submit(f.selected("a"), message);
  const pumping = backend.pumpOnce();
  await proxy.gated;
  f.access("a", "stopped");
  proxy.release();
  await pumping;
  assert.equal(service.poll(f.selected("b")), null);
  const raw = f.journal();
  assert.equal(
    raw
      .prepare("SELECT generation FROM nats_messages WHERE message_id=?")
      .get(message.message_id).generation,
    0,
  );
  raw.close();
  assert.equal(accepted.state, "pending");
});

test("replies follow the parent's persisted owner during rollout and rollback", async (t) => {
  const f = await habFixture(t);
  const old = new HabRelayService(f.registry, f.legacy, f.options.limits);
  const legacyParent = f.message();
  old.submit(f.selected("a"), legacyParent);
  const legacyReply = f.message("a", {
    kind: "answer",
    in_reply_to: {
      sender_id: f.agents.a.agent_id,
      message_id: legacyParent.message_id,
    },
  });
  f.service.submit(f.selected("b"), legacyReply);
  assert.equal(
    f.backend.lookupReceipt(f.agents.b.agent_id, legacyReply.message_id),
    null,
  );
  const natsParent = f.message();
  f.service.submit(f.selected("a"), natsParent);
  const backend = f.track(
    await JetStreamRelay.open({ ...f.options, route_epoch: 2 }),
  );
  const rollback = f.createService(
    { ...f.routing, epoch: 2, enabled: false },
    backend,
  );
  const natsReply = f.message("a", {
    kind: "answer",
    in_reply_to: {
      sender_id: f.agents.a.agent_id,
      message_id: natsParent.message_id,
    },
  });
  rollback.submit(f.selected("b"), natsReply);
  assert.ok(backend.lookupReceipt(f.agents.b.agent_id, natsReply.message_id));
});

test("service-wide sender capacity cannot be doubled across selected and legacy routes", async (t) => {
  const f = await habFixture(t, {
    agent_capacity: {
      max_pending_per_sender: 1,
      max_body_bytes_per_sender: 50000,
      max_records_per_sender: 2,
      max_body_bytes_per_recipient: 100000,
      max_records_per_recipient: 100,
      reservations: [],
    },
  });
  const first = f.message();
  const accepted = f.service.submit(f.selected("a"), first);
  assert.throws(() => f.service.submit(f.selected("a"), f.message("c")), {
    code: "capacity_exceeded",
  });
  assert.deepEqual(f.service.submit(f.selected("a"), first), accepted);
  assert.ok(f.service.submit(f.selected("c"), f.message("a")));
});

test("broker backpressure still drains accepted cached delivery and frees space for staged publication", async (t) => {
  const f = await habFixture(t, { broker_max_bytes: 1600 });
  const first = f.message("b", {
    body: { parts: [{ type: "text", text: "x".repeat(100) }] },
  });
  f.service.submit(f.selected("a"), first);
  await f.backend.pumpOnce();
  const used = (await f.manager.streams.info("HAB")).state.bytes;
  await f.manager.streams.update("HAB", { max_bytes: used + 1 });
  const second = f.message("b", {
    body: { parts: [{ type: "text", text: "y".repeat(100) }] },
  });
  f.service.submit(f.selected("a"), second);
  await assert.rejects(f.backend.pumpOnce(), { code: "capacity_exceeded" });
  const delivery = f.service.poll(f.selected("b"));
  assert.equal(delivery.message.message_id, first.message_id);
  f.service.ack(f.selected("b"), ackRequest(delivery, "space-release"));
  await f.backend.pumpOnce();
  assert.equal(
    f.service.poll(f.selected("b")).message.message_id,
    second.message_id,
  );
});

test("retained record budget stays shared after saved ACKs on different owners", async (t) => {
  const f = await habFixture(t, {
    agent_capacity: {
      max_pending_per_sender: 2,
      max_body_bytes_per_sender: 50000,
      max_records_per_sender: 2,
      max_body_bytes_per_recipient: 100000,
      max_records_per_recipient: 100,
      reservations: [],
    },
  });
  const first = f.message();
  f.service.submit(f.selected("a"), first);
  await f.backend.pumpOnce();
  f.service.ack(
    f.selected("b"),
    ackRequest(f.service.poll(f.selected("b")), "nats-record"),
  );
  f.service.submit(f.selected("a"), f.message("c"));
  f.service.ack(
    f.selected("c"),
    ackRequest(f.service.poll(f.selected("c")), "sqlite-record"),
  );
  assert.throws(() => f.service.submit(f.selected("a"), f.message()), {
    code: "capacity_exceeded",
  });
  assert.equal(f.service.submit(f.selected("a"), first).state, "acked");
});

test("shared reservations retain one sender's admission across both queues", async (t) => {
  const f = await habFixture(t, {
    max_pending: 4,
    max_pending_per_recipient: 4,
    prefetch_per_recipient: 4,
  });
  f.options.agent_capacity = {
    max_pending_per_sender: 3,
    max_body_bytes_per_sender: 100000,
    max_records_per_sender: 100,
    max_body_bytes_per_recipient: 100000,
    max_records_per_recipient: 100,
    reservations: [
      {
        sender_id: f.agents.c.agent_id,
        pending: 1,
        body_bytes: 500,
        records: 1,
      },
    ],
  };
  const service = f.createService();
  service.submit(f.selected("a"), f.message());
  service.submit(f.selected("a"), f.message("c"));
  service.submit(f.selected("a"), f.message("c"));
  assert.throws(() => service.submit(f.selected("b"), f.message("a")), {
    code: "capacity_exceeded",
  });
  assert.ok(service.submit(f.selected("c"), f.message()));
});

test("fair poll scan cursor survives restart and bypasses stopped sender with a one-row scan", async (t) => {
  const f = await habFixture(t, { fair_poll: true, poll_scan_limit: 1 });
  const blocked = f.message(),
    allowed = f.message();
  const [blockedName, allowedName] = ["a", "c"].sort((a, b) =>
    f.agents[a].agent_id < f.agents[b].agent_id ? -1 : 1,
  );
  f.service.submit(f.selected(blockedName), blocked);
  f.service.submit(f.selected(allowedName), allowed);
  await f.backend.pumpOnce();
  f.access(blockedName, "stopped");
  assert.equal(f.service.poll(f.selected("b")), null);
  await f.restart();
  const delivery = f.service.poll(f.selected("b"));
  assert.equal(delivery.message.message_id, allowed.message_id);
  f.service.ack(f.selected("b"), ackRequest(delivery, "fair-allowed"));
  assert.equal(
    f.service.status(f.selected(allowedName), allowed.message_id).state,
    "acked",
  );
  assert.equal(
    f.backend.lookupReceipt(f.agents[blockedName].agent_id, blocked.message_id)
      .state,
    "pending",
  );
  f.access(blockedName, "active", [
    "submit",
    "status",
    "poll",
    "ack",
    "resolve",
  ]);
  assert.equal(
    f.service.poll(f.selected("b")).message.message_id,
    blocked.message_id,
  );
});

test("HAB rejects partial prefetch profiles that could indefinitely hide an authorized sender", async (t) => {
  await assert.rejects(habFixture(t, { prefetch_per_recipient: 1 }), {
    code: "insufficient_prefetch_window",
  });
});

test("ACK request IDs remain recipient-wide across both owners and preserve exact retries", async (t) => {
  for (const firstOwner of ["sqlite", "jetstream"]) {
    const f = await habFixture(t);
    const old = new HabRelayService(f.registry, f.legacy, f.options.limits);
    const messages = { sqlite: f.message(), jetstream: f.message() };
    const services = { sqlite: old, jetstream: f.service };
    services[firstOwner].submit(f.selected("a"), messages[firstOwner]);
    await f.backend.pumpOnce();
    const first = f.service.poll(f.selected("b"));
    const request = ackRequest(first, "recipient-wide");
    const receipt = f.service.ack(f.selected("b"), request);
    assert.deepEqual(f.service.ack(f.selected("b"), request), receipt);
    const other = firstOwner === "sqlite" ? "jetstream" : "sqlite";
    services[other].submit(f.selected("a"), messages[other]);
    await f.backend.pumpOnce();
    const second = f.service.poll(f.selected("b"));
    assert.equal(second.message.message_id, messages[other].message_id);
    assert.throws(
      () =>
        f.service.ack(f.selected("b"), ackRequest(second, "recipient-wide")),
      { code: "ack_idempotency_conflict" },
    );
    f.service.ack(f.selected("b"), ackRequest(second, "recipient-wide-other"));
  }
});

test("small pump budget makes uncached progress despite repeatedly expired broker ACK waits", async (t) => {
  const f = await habFixture(t, {
    max_pending: 2,
    max_pending_per_recipient: 2,
    prefetch_per_recipient: 2,
    lease_ms: 50,
    fair_poll: true,
    poll_scan_limit: 1,
  });
  const blocked = f.message(),
    allowed = f.message();
  f.service.submit(f.selected("a"), blocked);
  f.service.submit(f.selected("c"), allowed);
  await f.backend.pumpOnce(1);
  f.access("a", "stopped");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await f.backend.pumpOnce(1);
  let delivery = f.service.poll(f.selected("b"));
  if (!delivery) delivery = f.service.poll(f.selected("b"));
  assert.equal(delivery.message.message_id, allowed.message_id);
  assert.equal(
    f.backend.lookupReceipt(f.agents.a.agent_id, blocked.message_id).state,
    "pending",
  );
});
