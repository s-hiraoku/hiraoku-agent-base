import { test } from "node:test";
import assert from "node:assert/strict";
import { ListTasksRequest, TaskState } from "@a2a-js/sdk";
import {
  createA2aRelayFixture,
  a2aRequest,
  worker,
  RESPONSE,
} from "./a2a-relay-fixtures.js";

const submitted = TaskState.TASK_STATE_SUBMITTED,
  completed = TaskState.TASK_STATE_COMPLETED;
async function deliverAndAccept(f, task) {
  await f.recipient.receiveOnce();
  const source = f.sourceOf(task);
  f.recipient.accept(f.operator, source);
  await f.recipient.submitOnce(f.operator, source);
  return source;
}
async function reply(f, source, kind) {
  f.recipient.replyOnce(f.operator, source, kind);
  await f.sendReply();
  await f.receiveResult();
}
async function finish(f, source) {
  const running = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.recipient.observeOnce(f.operator, source);
}

test("A2A real HAB Relay route separates delivery ACK, explicit acceptance and confirmed result", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  const source = f.sourceOf(first);
  assert.equal(first.status.state, submitted);
  assert.equal(f.count(), 0);
  await f.recipient.receiveOnce();
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal((await f.receipt(first)).state, "acked");
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    submitted,
  );
  assert.equal(f.count(), 0);
  f.recipient.accept(f.operator, source);
  assert.equal(f.count(), 0);
  await f.recipient.submitOnce(f.operator, source);
  await f.recipient.submitOnce(f.operator, source);
  assert.equal(f.count(), 1);
  await reply(f, source, "execution_accepted");
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    submitted,
  );
  const claimed = await f.hub.claim(worker);
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    TaskState.TASK_STATE_WORKING,
  );
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const notDelivered = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(notDelivered.status.state, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(notDelivered.artifacts, []);
  assert.equal(JSON.stringify(notDelivered).includes(RESPONSE), false);
  const beforeReplySend = await f.client.sendMessage(a2aRequest(), f.options);
  assert.equal(JSON.stringify(beforeReplySend).includes(RESPONSE), false);
  const beforeReplyList = await f.client.listTasks(
    ListTasksRequest.fromJSON({ includeArtifacts: true }),
    f.options,
  );
  assert.equal(JSON.stringify(beforeReplyList).includes(RESPONSE), false);
  await f.recipient.observeOnce(f.operator, source);
  await reply(f, source, "execution_result");
  const done = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(done.status.state, completed);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  assert.notEqual(done.id, done.contextId);
  const envelope = done.metadata.hab_relay.source;
  assert.match(envelope.message_id, /^rm1\./);
  assert.notEqual(envelope.thread_id, done.contextId);
  assert.equal(
    Date.parse(envelope.expires_at) - Date.parse(envelope.first_sent_at),
    3600000,
  );
  await f.restart();
  const durable = await f.client.getTask({ id: done.id }, f.options);
  assert.equal(durable.status.state, completed);
  assert.equal(durable.artifacts[0].parts[0].content.value, RESPONSE);
  assert.deepEqual(durable.metadata.hab_relay.source, envelope);
  assert.equal(f.count(), 1);
  const replay = await f.client.sendMessage(a2aRequest(), f.options);
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.metadata.hab_relay.source, envelope);
  assert.equal(f.count(), 1);
});

test("A2A HAB group and immutable-name authorization protect Card, Get, List and Artifact", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  const third = { serviceParameters: { Authorization: "Bearer fixture-c" } };
  assert.notEqual(
    (
      await globalThis.fetch(`${f.base}/.well-known/agent-card.json`, {
        headers: { Authorization: "Bearer fixture-c" },
      })
    ).status,
    200,
  );
  await assert.rejects(() => f.client.getTask({ id: first.id }, third));
  await assert.rejects(() =>
    f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      third,
    ),
  );
  f.revokeGroup();
  assert.notEqual(
    (
      await globalThis.fetch(`${f.base}/.well-known/agent-card.json`, {
        headers: { Authorization: "Bearer fixture-a" },
      })
    ).status,
    200,
  );
  await assert.rejects(() => f.client.getTask({ id: first.id }, f.options));
  await assert.rejects(() =>
    f.client.listTasks(ListTasksRequest.fromJSON({}), f.options),
  );
  assert.equal(f.count(), 0);
  f.restoreGroup();
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    submitted,
  );
});

test("A2A Relay replay conflicts and unsupported cancellation do not create more work", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  await assert.rejects(() =>
    f.client.sendMessage(
      a2aRequest("relay_check", "different request"),
      f.options,
    ),
  );
  const cancelled = await f.raw("CancelTask", { id: first.id });
  assert.equal((await cancelled.json()).error.code, -32002);
  const replay = await f.client.sendMessage(a2aRequest(), f.options);
  assert.equal(replay.id, first.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    first.metadata.hab_relay.source,
  );
  assert.equal(f.count(), 0);
});

test("A2A lost Relay response and full store reopen recover one original receipt and envelope", async (t) => {
  const f = await createA2aRelayFixture(t);
  f.state.failSubmitReply = true;
  await assert.rejects(() => f.client.sendMessage(a2aRequest(), f.options));
  assert.equal(f.requestCount(), 1);
  const accepted = f.relayRows()[0];
  await f.restart();
  f.faults.outboxRetryDue();
  const replay = await f.client.sendMessage(a2aRequest(), f.options);
  const receipt = await f.receipt(replay);
  assert.equal(receipt.message_id, f.sourceOf(replay).message_id);
  assert.equal(receipt.receipt_id, accepted.receipt_id);
  assert.equal(receipt.message_id, accepted.message_id);
  assert.equal(Date.parse(receipt.expires_at), accepted.expires_at);
  assert.equal(replay.metadata.hab_relay.source.thread_id, accepted.thread_id);
  assert.equal(f.relayRows().length, 1);
  await f.recipient.receiveOnce();
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
});

test("A2A recipient ACK response loss is recovered before explicit execution", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  f.state.failAckReply = true;
  await assert.rejects(() => f.recipient.receiveOnce());
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, false);
  assert.throws(() => f.recipient.accept(f.operator, f.sourceOf(first)));
  await f.restart();
  f.faults.ackRetryDue();
  await f.recipient.receiveOnce();
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
  f.recipient.accept(f.operator, f.sourceOf(first));
  await f.recipient.submitOnce(f.operator, f.sourceOf(first));
  assert.equal(f.count(), 1);
});

test("A2A explicit recipient acceptance and submission both enforce the original deadline", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  await f.recipient.receiveOnce();
  const source = f.sourceOf(first),
    expires = Date.parse(first.metadata.hab_relay.source.expires_at);
  f.state.clock = expires;
  assert.throws(() => f.recipient.accept(f.operator, source));
  f.state.clock = expires - 1;
  f.recipient.accept(f.operator, source);
  f.state.clock = expires;
  await assert.rejects(() => f.recipient.submitOnce(f.operator, source));
  assert.equal(f.count(), 0);
});

test("A2A result persistence failure cannot release a completed Task without its Artifact", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  const source = await deliverAndAccept(f, first);
  await finish(f, source);
  await reply(f, source, "execution_result");
  f.state.failCompletionSave = true;
  await assert.rejects(() => f.client.getTask({ id: first.id }, f.options));
  f.state.failCompletionSave = false;
  await f.restart();
  const done = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(done.status.state, completed);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.count(), 1);
});

test("A2A late acceptance and stale execution evidence cannot erase a delivered result", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  const source = await deliverAndAccept(f, first);
  const queued = f.journal.get(source).task;
  await finish(f, source);
  await reply(f, source, "execution_result");
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    completed,
  );
  await reply(f, source, "execution_accepted");
  const afterLate = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(afterLate.status.state, completed);
  assert.equal(afterLate.artifacts[0].parts[0].content.value, RESPONSE);
  f.state.observed = queued;
  await assert.rejects(() => f.client.getTask({ id: first.id }, f.options));
  f.state.observed = undefined;
  await f.restart();
  const durable = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(durable.status.state, completed);
  assert.equal(durable.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.count(), 1);
});

test("A2A confirms an execution RPC started before expiry even when its response crosses the deadline", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  await f.recipient.receiveOnce();
  const source = f.sourceOf(first);
  f.recipient.accept(f.operator, source);
  const originalSubmit = f.hub.submit.bind(f.hub);
  f.hub.submit = async (...args) => {
    const result = await originalSubmit(...args);
    f.state.clock = Date.parse(first.metadata.hab_relay.source.expires_at);
    return result;
  };
  const linked = await f.recipient.submitOnce(f.operator, source);
  assert.equal(linked.state, "linked");
  assert.ok(linked.task);
  assert.equal(f.count(), 1);
  assert.equal(
    (await f.recipient.submitOnce(f.operator, source)).state,
    "linked",
  );
  assert.equal(f.count(), 1);
});

test("A2A ordinary legacy replies cannot block a valid execution result in the same inbox", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  const source = await deliverAndAccept(f, first);
  await finish(f, source);
  await reply(f, source, "execution_result");
  await f.ordinaryReply(first, "answer");
  await f.ordinaryReply(first, "notice");
  const done = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(done.status.state, completed);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.originEntries().length, 3);
  assert.equal(f.count(), 1);
});

test("A2A known success outlives both delivery deadline and bridge lease without another engine RPC", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  await f.recipient.receiveOnce();
  const source = f.sourceOf(first);
  f.recipient.accept(f.operator, source);
  let calls = 0;
  const submit = f.hub.submit.bind(f.hub);
  f.hub.submit = async (...args) => {
    calls++;
    const task = await submit(...args);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    f.state.clock = Date.parse(first.metadata.hab_relay.source.expires_at);
    return task;
  };
  const linked = await f.recipient.submitOnce(f.operator, source);
  assert.equal(linked.state, "linked");
  assert.ok(linked.task);
  assert.equal(calls, 1);
  assert.equal(f.count(), 1);
  await f.restart();
  f.hub.submit = async () => {
    calls++;
    throw Error("engine RPC must not be repeated");
  };
  const again = await f.recipient.submitOnce(f.operator, source, true);
  assert.equal(again.state, "linked");
  assert.equal(again.task.id, linked.task.id);
  assert.equal(calls, 1);
  assert.equal(f.count(), 1);
});

test("A2A checks original expiry again after durable receipt reservation and before the engine RPC", async (t) => {
  const f = await createA2aRelayFixture(t);
  const first = await f.client.sendMessage(a2aRequest(), f.options);
  await f.recipient.receiveOnce();
  const source = f.sourceOf(first);
  f.recipient.accept(f.operator, source);
  const prepare = f.submissionReceipts.prepare.bind(f.submissionReceipts);
  f.submissionReceipts.prepare = (...args) => {
    prepare(...args);
    f.state.clock = Date.parse(first.metadata.hab_relay.source.expires_at);
  };
  const result = await f.recipient.submitOnce(f.operator, source);
  assert.equal(result.state, "uncertain");
  assert.equal(f.count(), 0);
  await assert.rejects(() => f.recipient.submitOnce(f.operator, source, true));
  assert.equal(f.count(), 0);
});
