import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskState } from "@a2a-js/sdk";
import {
  createA2aRelayFixture,
  a2aRequest,
  worker,
  RESPONSE,
} from "./a2a-relay-fixtures.js";

async function storeAndAck(f, mailbox, delivery) {
  const store = f.inboxStore(mailbox);
  store.save(delivery);
  const request = store.claimAck();
  const receipt = await f.transport(mailbox).ack(request);
  store.confirmAck(request, receipt);
  return { request, receipt };
}
async function runAndReply(f, task, accepted = true) {
  const source = f.sourceOf(task);
  f.recipient.accept(f.operator, source);
  await f.recipient.submitOnce(f.operator, source);
  if (accepted) {
    f.recipient.replyOnce(f.operator, source, "execution_accepted");
    await f.sendReply();
    await f.receiveResult();
  }
  const running = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.recipient.observeOnce(f.operator, source);
  f.recipient.replyOnce(f.operator, source, "execution_result");
  await f.sendReply();
}

test("A2A rename compatibility preserves a leased recipient ID and source envelope after explicit host refresh", async (t) => {
  const f = await createA2aRelayFixture(t, { enableRename: true });
  const task = await f.client.sendMessage(
    a2aRequest("recipient_rename"),
    f.options,
  );
  const envelope = structuredClone(task.metadata.hab_relay.source),
    old = f.destination;
  const route = f.routeSnapshot();
  const lease = await f.transport("b").poll();
  assert.equal(lease.message.recipient_id, old.agent_id);
  const originalReceipt = await f.receipt(task);
  const renamed = f.rename("b", "recipient-new");
  assert.equal(renamed.agent_id, old.agent_id);
  assert.throws(() => route.assertCurrent());
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  assert.throws(() => f.claimName(old.bot_name));
  f.refreshAddress("b");
  const ack = await storeAndAck(f, "b", lease);
  assert.equal(ack.receipt.recipient_id, old.agent_id);
  assert.deepEqual(await f.transport("b").ack(ack.request), ack.receipt);
  assert.equal(ack.request.generation, lease.generation);
  assert.equal(ack.request.lease_token, lease.lease_token);
  assert.equal(ack.request.message_id, lease.message.message_id);
  const savedReceipt = await f.receipt(task);
  assert.equal(savedReceipt.state, "acked");
  assert.equal(savedReceipt.receipt_id, originalReceipt.receipt_id);
  assert.equal(savedReceipt.expires_at, originalReceipt.expires_at);
  assert.throws(() =>
    f.routeSnapshot({ ...f.destination, agent_id: f.origin.agent_id }),
  );
  assert.equal(f.count(), 0);
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  await runAndReply(f, task);
  await f.receiveResult();
  const completed = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content.value, RESPONSE);
  assert.deepEqual(completed.metadata.hab_relay.source, envelope);
  assert.equal(completed.id, task.id);
  assert.equal(completed.contextId, task.contextId);
  assert.equal(f.count(), 1);
  f.revokeGroup();
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  await assert.rejects(() =>
    f.client.sendMessage(a2aRequest("recipient_rename"), f.options),
  );
  assert.equal(f.count(), 1);
  f.restoreGroup();
  await f.restart();
  const durable = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(durable.id, task.id);
  assert.equal(durable.metadata.hab_relay.source.recipient_id, old.agent_id);
  assert.equal(durable.artifacts[0].parts[0].content.value, RESPONSE);
});

test("A2A origin rename keeps the original result lease and requires a refreshed authenticated address", async (t) => {
  const f = await createA2aRelayFixture(t, { enableRename: true });
  const task = await f.client.sendMessage(
    a2aRequest("origin_rename"),
    f.options,
  );
  const envelope = structuredClone(task.metadata.hab_relay.source),
    old = f.origin;
  await f.recipient.receiveOnce();
  await runAndReply(f, task);
  const before = await f.client.getTask({ id: task.id }, f.options);
  assert.notEqual(before.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(before.artifacts, []);
  const lease = await f.transport("a").poll();
  assert.equal(lease.message.recipient_id, old.agent_id);
  const staleClient = f.transport("a"),
    route = f.routeSnapshot();
  const renamed = f.rename("a", "origin-new");
  assert.equal(renamed.agent_id, old.agent_id);
  assert.throws(() => route.assertCurrent());
  const store = f.inboxStore("a");
  store.save(lease);
  const request = store.claimAck();
  await assert.rejects(() => staleClient.ack(request));
  assert.equal(
    f
      .originEntries()
      .find((v) => v.message.message_id === lease.message.message_id)
      .receipt_confirmed,
    false,
  );
  f.refreshAddress("a");
  assert.equal(request.generation, lease.generation);
  assert.equal(request.lease_token, lease.lease_token);
  const ack = await f.transport("a").ack(request);
  assert.equal(ack.request_id, request.request_id);
  assert.equal(ack.message_id, lease.message.message_id);
  assert.equal(ack.recipient_id, old.agent_id);
  store.confirmAck(request, ack);
  const completed = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content.value, RESPONSE);
  assert.deepEqual(completed.metadata.hab_relay.source, envelope);
  assert.equal(f.count(), 1);
  assert.throws(() => f.claimName(old.bot_name));
  const replay = await f.client.sendMessage(
    a2aRequest("origin_rename"),
    f.options,
  );
  assert.equal(replay.id, task.id);
  assert.deepEqual(replay.metadata.hab_relay.source, envelope);
});

test("A2A native ingress retains downstream foreign mailbox, status and ACK refusal", async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("foreign_scope"),
    f.options,
  );
  assert.equal((await f.receipt(task)).state, "pending");
  assert.equal(await f.transport("c").poll(), null);
  assert.equal((await f.receipt(task)).state, "pending");
  const lease = await f.transport("b").poll();
  assert.ok(lease);
  assert.equal(lease.message.message_id, f.sourceOf(task).message_id);
  assert.equal(lease.message.recipient_id, f.destination.agent_id);
  await assert.rejects(() =>
    f.transport("c").status(f.sourceOf(task).message_id),
  );
  const request = {
    sender_id: f.origin.agent_id,
    message_id: lease.message.message_id,
    generation: lease.generation,
    lease_token: lease.lease_token,
    request_id: "foreign-ack",
  };
  await assert.rejects(() => f.transport("c").ack(request));
  assert.equal((await f.receipt(task)).state, "leased");
  assert.equal(f.count(), 0);
  await storeAndAck(f, "b", lease);
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  assert.equal(f.count(), 0);
});
