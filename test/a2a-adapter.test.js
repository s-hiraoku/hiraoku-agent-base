import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskState, ListTasksRequest } from "@a2a-js/sdk";
import { fixture, request, worker, RESPONSE } from "./a2a-fixtures.js";

const taskOf = (result) => {
  assert.ok("id" in result);
  return result;
};

test("A2A official client discovers AgentCard and observes real execution through completion", async (t) => {
  const f = await fixture(t);
  assert.equal(f.card.supportedInterfaces[0].protocolVersion, "1.0");
  assert.equal(f.card.capabilities.streaming, false);
  assert.equal(f.card.capabilities.pushNotifications, false);
  assert.deepEqual(
    f.card.skills.map((s) => s.id),
    ["connectivity_check"],
  );
  const submitted = taskOf(await f.client.sendMessage(request(), f.options));
  assert.equal(submitted.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.deepEqual(submitted.artifacts, []);
  assert.equal(f.count(), 1);
  const claimed = await f.hub.claim(worker);
  const running = await f.client.getTask({ id: submitted.id }, f.options);
  assert.equal(running.status.state, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(running.artifacts, []);
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const completed = await f.client.getTask({ id: submitted.id }, f.options);
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content.value, RESPONSE);
  await f.restart();
  const durable = await f.client.getTask({ id: submitted.id }, f.options);
  assert.equal(durable.id, submitted.id);
  assert.equal(durable.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(durable.artifacts[0].parts[0].content.value, RESPONSE);
});

test("A2A retries survive a lost engine response and a store reopen without duplicate work", async (t) => {
  const f = await fixture(t);
  f.state.failAfterSubmit = true;
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  assert.equal(first.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(f.count(), 1);
  await f.restart();
  const retry = taskOf(await f.client.sendMessage(request(), f.options));
  assert.equal(retry.id, first.id);
  assert.equal(f.count(), 1);
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.client.sendMessage(request("parallel"), f.options),
    ),
  );
  assert.equal(new Set(parallel.map((v) => taskOf(v).id)).size, 1);
  assert.equal(f.count(), 2);
});

test("A2A identity scope and independently verified execution permission both apply", async (t) => {
  const f = await fixture(t);
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  const other = {
    serviceParameters: { Authorization: "Bearer synthetic-other" },
  };
  await assert.rejects(() => f.client.getTask({ id: first.id }, other));
  const second = taskOf(await f.client.sendMessage(request(), other));
  assert.notEqual(second.id, first.id);
  assert.equal(f.count(), 2);
  f.state.forbidden = true;
  await assert.rejects(() => f.client.getTask({ id: first.id }, f.options));
  assert.equal(f.count(), 2);
  const denied = await f.raw(
    "SendMessage",
    {},
    { Authorization: "Bearer forged" },
  );
  assert.equal(denied.status, 401);
});

test("A2A refuses unsupported input, deadlines, cancellation and alternate protocol versions before execution", async (t) => {
  const f = await fixture(t);
  const good = {
    message: {
      messageId: "reject",
      role: "ROLE_USER",
      parts: [{ text: "connectivity_check" }],
    },
    configuration: { returnImmediately: true },
  };
  const bad = [
    { ...good, message: { ...good.message, parts: [{ text: "run a shell" }] } },
    { ...good, message: { ...good.message, taskId: "some-task" } },
    { ...good, metadata: { deadline: "tomorrow" } },
    {
      ...good,
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: { url: "https://invalid.example/" },
      },
    },
    { ...good, tenant: "someone-else" },
  ];
  for (const params of bad)
    assert.equal((await f.raw("SendMessage", params)).status, 400);
  assert.equal((await f.raw("CancelTask", { id: "anything" })).status, 400);
  assert.equal((await f.raw("SendStreamingMessage", good)).status, 400);
  assert.equal(
    (await f.raw("SendMessage", good, { "A2A-Version": "0.3" })).status,
    400,
  );
  assert.equal(
    (await f.raw("SendMessage", good, { Origin: "http://invalid.example" }))
      .status,
    403,
  );
  assert.equal(f.count(), 0);
});

test("A2A failed execution produces no success artifact and remains failed after restart", async (t) => {
  const f = await fixture(t);
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  const claimed = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "failed",
    result: "connectivity_check_failed",
  });
  await f.restart();
  const failed = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(failed.status.state, TaskState.TASK_STATE_FAILED);
  assert.deepEqual(failed.artifacts, []);
});

test("A2A private Card and ListTasks preserve owner isolation and confirmed artifacts", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await globalThis.fetch(`${f.base}/.well-known/agent-card.json`)).status,
    401,
  );
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  assert.notEqual(first.id, first.contextId);
  const claimed = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.restart();
  const page = await f.client.listTasks(
    ListTasksRequest.fromJSON({ includeArtifacts: true, historyLength: 0 }),
    f.options,
  );
  assert.equal(page.totalSize, 1);
  assert.equal(page.tasks[0].id, first.id);
  assert.equal(page.tasks[0].status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(page.tasks[0].artifacts[0].parts[0].content.value, RESPONSE);
  assert.deepEqual(page.tasks[0].history, []);
  const full = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(full.history.length, first.history.length);
  const other = await f.client.listTasks(ListTasksRequest.fromJSON({}), {
    serviceParameters: { Authorization: "Bearer synthetic-other" },
  });
  assert.equal(other.totalSize, 0);
  f.state.forbidden = true;
  await assert.rejects(() =>
    f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      f.options,
    ),
  );
});

test("A2A blocking default waits for confirmed completion while cancellation stays unsupported", async (t) => {
  const f = await fixture(t);
  const input = request("blocking");
  input.configuration = undefined;
  const pending = f.client.sendMessage(input, f.options);
  let claimed;
  for (let i = 0; i < 100 && !claimed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    claimed = await f.hub.claim(worker);
  }
  assert.ok(claimed);
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const completed = taskOf(await pending);
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  const cancelled = await f.raw("CancelTask", { id: completed.id });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).error.code, -32002);
});

test("A2A body limit returns a deliverable refusal without submitting work", async (t) => {
  const f = await fixture(t);
  const oversized = await f.raw("SendMessage", { junk: "x".repeat(17000) });
  assert.equal(oversized.status, 413);
  assert.equal(f.count(), 0);
});

test("A2A wait timeout leaves one queryable task and never reports execution failure", async (t) => {
  const f = await fixture(t);
  const input = request("timeout");
  input.configuration = undefined;
  await assert.rejects(() => f.client.sendMessage(input, f.options));
  const retry = taskOf(
    await f.client.sendMessage(request("timeout"), f.options),
  );
  assert.equal(retry.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.deepEqual(retry.artifacts, []);
  assert.equal(f.count(), 1);
});

test("A2A does not report stopped execution for a cancelled engine task whose execution remains open", async (t) => {
  const f = await fixture(t);
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  const claimed = await f.hub.claim(worker);
  const principal = {
    subject: "fixture-owner",
    destination: "hermes",
    operations: ["cancel"],
  };
  await f.hub.cancel(principal, { id: claimed.id });
  const current = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(current.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(current.artifacts, []);
});

test("A2A definite rejection never becomes a resumable execution intent", async (t) => {
  const f = await fixture(t);
  f.state.forbidden = true;
  const rejected = taskOf(await f.client.sendMessage(request(), f.options));
  assert.equal(rejected.status.state, TaskState.TASK_STATE_REJECTED);
  assert.equal(f.count(), 0);
  f.state.forbidden = false;
  await f.restart();
  const read = await f.client.getTask({ id: rejected.id }, f.options);
  assert.equal(read.status.state, TaskState.TASK_STATE_REJECTED);
  const listed = await f.client.listTasks(
    ListTasksRequest.fromJSON({}),
    f.options,
  );
  assert.equal(listed.tasks[0].status.state, TaskState.TASK_STATE_REJECTED);
  const replay = taskOf(await f.client.sendMessage(request(), f.options));
  assert.equal(replay.status.state, TaskState.TASK_STATE_REJECTED);
  assert.equal(f.count(), 0);
});

test("A2A stale engine evidence cannot erase a terminal Task or Artifact", async (t) => {
  const f = await fixture(t);
  const first = taskOf(await f.client.sendMessage(request(), f.options));
  const queued = await f.hub.get(
    { subject: "fixture-owner", operations: ["get"] },
    { id: first.metadata.hab.engine_task_id },
  );
  const running = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const done = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
  await f.legacyRecord(first.id);
  f.state.observed = queued;
  await assert.rejects(() => f.client.getTask({ id: first.id }, f.options));
  f.state.observed = undefined;
  await f.restart();
  const preserved = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(preserved.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(preserved.artifacts[0].parts[0].content.value, RESPONSE);
});
