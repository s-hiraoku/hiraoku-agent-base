import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskState, GetTaskRequest, ListTasksRequest } from "@a2a-js/sdk";
import {
  fixture,
  request,
  context,
  RESPONSE,
} from "./a2a-hab-unit-fixtures.js";
import { createHabA2aGateway } from "../src/a2a/hab-http.ts";
import { habRelayAgentCard } from "../src/a2a/hab-adapter.ts";

const get = (id, patch = {}) => GetTaskRequest.fromJSON({ id, ...patch });
test("HAB A2A retains one original Relay intent and delivery ACK cannot create execution evidence", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  const source = first.metadata.hab_relay.source;
  assert.notEqual(first.id, first.contextId);
  assert.notEqual(source.thread_id, first.id);
  assert.equal(
    Date.parse(source.expires_at) - Date.parse(source.first_sent_at),
    3600000,
  );
  assert.match(source.message_id, /^rm1\.[0-9]+\.[a-f0-9]{32}$/);
  const record = f.state.records.get(source.message_id);
  record.state = "accepted";
  record.receipt = {
    sender_id: "sender-a",
    message_id: source.message_id,
    recipient_id: "recipient-b",
    receipt_id: "receipt",
    accepted_at: source.first_sent_at,
    expires_at: source.expires_at,
    state: "acked",
  };
  const observed = await f.handler.getTask(get(first.id), context());
  assert.equal(observed.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.deepEqual(observed.artifacts, []);
  assert.equal(f.state.verifyCalls, 0);
  const again = await f.handler.sendMessage(request(), context());
  assert.equal(again.id, first.id);
  assert.equal(
    JSON.stringify(again.metadata.hab_relay.source),
    JSON.stringify(source),
  );
  assert.equal(f.state.records.size, 1);
  await assert.rejects(
    () => f.handler.sendMessage(request("first", "different"), context()),
    /message_id_conflict/,
  );
  await assert.rejects(
    () => f.handler.sendMessage(request("unknown", "different"), context()),
    /Unsupported HAB skill/,
  );
});

test("HAB A2A only completes after matching durable reply plus independently verified closed execution", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  const accepted = f.reply(first);
  accepted.receipt_confirmed = false;
  assert.equal(
    (await f.handler.getTask(get(first.id), context())).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  assert.equal(f.state.verifyCalls, 0);
  accepted.receipt_confirmed = true;
  await f.handler.getTask(get(first.id), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "running",
    fence: 1,
    execution_open: 1,
  };
  assert.equal(
    (await f.handler.getTask(get(first.id), context())).status.state,
    TaskState.TASK_STATE_WORKING,
  );
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    execution_open: 0,
    result: RESPONSE,
  };
  const beforeResult = await f.handler.getTask(get(first.id), context());
  assert.equal(beforeResult.status.state, TaskState.TASK_STATE_WORKING);
  assert.deepEqual(beforeResult.artifacts, []);
  assert.equal(JSON.stringify(beforeResult).includes(RESPONSE), false);
  const replay = await f.handler.sendMessage(request(), context());
  assert.equal(JSON.stringify(replay).includes(RESPONSE), false);
  const privatePage = await f.handler.listTasks(
    ListTasksRequest.fromJSON({ includeArtifacts: true }),
    context(),
  );
  assert.equal(JSON.stringify(privatePage).includes(RESPONSE), false);
  f.reply(first, "execution_result");
  const completed = await f.handler.getTask(get(first.id), context());
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content.value, RESPONSE);
  f.state.entries = [accepted];
  const lateAccepted = await f.handler.getTask(get(first.id), context());
  assert.equal(lateAccepted.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(lateAccepted.artifacts.length, 1);
});

test("HAB A2A refuses stale or conflicting execution evidence without erasing terminal Artifacts", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 2,
    result: RESPONSE,
  };
  f.reply(first, "execution_result");
  await f.handler.getTask(get(first.id), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "queued",
    fence: 0,
    result: null,
  };
  await assert.rejects(
    () => f.handler.getTask(get(first.id), context()),
    /regressed/,
  );
  const saved = await f.store.load(first.id, context());
  assert.equal(saved.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(saved.artifacts.length, 1);
});

test("HAB A2A validates reply identity, reference, thread and schema before verifier or completion", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 1,
    result: RESPONSE,
  };
  const forged = f.reply(first, "execution_result");
  forged.sender_id = "other-recipient";
  assert.equal(
    (await f.handler.getTask(get(first.id), context())).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  forged.sender_id = "recipient-b";
  forged.message.thread_id = "wrong-thread";
  await assert.rejects(
    () => f.handler.getTask(get(first.id), context()),
    /correlation/,
  );
  assert.equal(f.state.verifyCalls, 0);
  forged.message.thread_id = first.metadata.hab_relay.source.thread_id;
  forged.message.body.parts[0].schema_id = "unrelated";
  await assert.rejects(
    () => f.handler.getTask(get(first.id), context()),
    /schema/,
  );
  assert.equal((await f.store.load(first.id, context())).artifacts.length, 0);
});

test("HAB A2A Get and List preserve full history, owner isolation, and perform no delivery writes", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  const enqueues = f.state.enqueueCalls;
  const flushes = f.state.flushCalls;
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 1,
    result: RESPONSE,
  };
  f.reply(first, "execution_result");
  const page = await f.handler.listTasks(
    ListTasksRequest.fromJSON({ historyLength: 0, includeArtifacts: true }),
    context(),
  );
  assert.equal(page.tasks[0].artifacts.length, 1);
  assert.deepEqual(page.tasks[0].history, []);
  assert.equal(
    (await f.handler.getTask(get(first.id), context())).history.length,
    1,
  );
  await assert.rejects(() =>
    f.handler.getTask(get(first.id), context("another-owner")),
  );
  assert.equal(
    (
      await f.handler.listTasks(
        ListTasksRequest.fromJSON({}),
        context("another-owner"),
      )
    ).tasks.length,
    0,
  );
  assert.equal(f.state.enqueueCalls, enqueues);
  assert.equal(f.state.flushCalls, flushes);
});

test("HAB A2A expired unknown delivery keeps original identity without creating execution", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  const source = first.metadata.hab_relay.source;
  const now = Date.now;
  Date.now = () => now() + 3600001;
  try {
    const expired = await f.handler.getTask(get(first.id), context());
    assert.equal(expired.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    const replay = await f.handler.sendMessage(request(), context());
    assert.equal(
      JSON.stringify(replay.metadata.hab_relay.source),
      JSON.stringify(source),
    );
    assert.equal(f.state.enqueueCalls, 1);
    assert.equal(f.state.flushCalls, 1);
    assert.equal(f.state.verifyCalls, 0);
  } finally {
    Date.now = now;
  }
});

test("a reply saved before the window but still unconfirmed cannot postpone failure or revive a failed Task", async (t) => {
  const f = fixture();
  delete f.route.evidence;
  f.route.replyWindowMs = 86400000;
  const first = await f.handler.sendMessage(request(), context());
  f.reply(first);
  await f.handler.apply(first.id, context(), f.route);
  f.state.evidence.state = "succeeded";
  f.state.evidence.result = RESPONSE;
  const result = f.reply(first, "execution_result");
  result.receipt_confirmed = false;
  assert.equal(
    (await f.handler.apply(first.id, context(), f.route)).status.state,
    TaskState.TASK_STATE_WORKING,
  );
  const deadline =
    Date.parse(first.metadata.hab_relay.source.expires_at) +
    f.route.replyWindowMs;
  assert.ok(Date.parse(result.received_at) < deadline);
  t.mock.method(Date, "now", () => deadline);
  const failed = await f.handler.apply(first.id, context(), f.route);
  assert.equal(failed.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(failed.metadata.hab_relay.failure, "result_window_expired");
  assert.deepEqual(failed.artifacts, []);
  result.receipt_confirmed = true;
  const later = await f.handler.apply(first.id, context(), f.route);
  assert.equal(
    JSON.stringify(later),
    JSON.stringify(failed),
    "ACK confirmation after failure cannot revive the Task",
  );
  assert.equal(
    JSON.stringify(later.metadata.hab_relay.source),
    JSON.stringify(first.metadata.hab_relay.source),
  );
  assert.equal(f.state.enqueueCalls, 1);
  assert.equal(f.state.flushCalls, 1);
});

test("HAB A2A flush uncertainty preserves one intent and Get never retries submission", async () => {
  const f = fixture();
  f.state.flushError = Error("response lost");
  await assert.rejects(
    () => f.handler.sendMessage(request(), context()),
    /response lost/,
  );
  const records = await f.store.list(ListTasksRequest.fromJSON({}), context());
  const first = records.tasks[0];
  const enqueues = f.state.enqueueCalls;
  const flushes = f.state.flushCalls;
  assert.equal(
    (await f.handler.getTask(get(first.id), context())).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  assert.equal(f.state.enqueueCalls, enqueues);
  assert.equal(f.state.flushCalls, flushes);
  f.state.flushError = undefined;
  const retry = await f.handler.sendMessage(request(), context());
  assert.equal(retry.id, first.id);
  assert.equal(f.state.records.size, 1);
});

test("HAB gateway keeps Card private and denies unsupported input before Relay enqueue", async () => {
  const f = fixture();
  const endpoint = "http://127.0.0.1:12345/a2a";
  const gateway = createHabA2aGateway({
    endpoint,
    card: habRelayAgentCard(endpoint),
    store: f.store,
    authorize: (req) =>
      req.headers.get("authorization") === "Bearer synthetic"
        ? f.route
        : undefined,
  });
  assert.equal(
    (
      await gateway(
        new Request("http://127.0.0.1:12345/.well-known/agent-card.json"),
      )
    ).status,
    401,
  );
  const raw = (method, params, patch = {}) =>
    gateway(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic",
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
          ...patch,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const input = {
    message: {
      messageId: "wire",
      role: "ROLE_USER",
      parts: [{ text: "connectivity_check" }],
    },
    configuration: { returnImmediately: true },
  };
  for (const extra of [
    { tenant: "forged" },
    { metadata: { deadline: "tomorrow" } },
  ])
    assert.equal(
      (await raw("SendMessage", { ...input, ...extra })).status,
      400,
    );
  assert.equal((await raw("SendStreamingMessage", input)).status, 400);
  assert.equal(
    (await raw("SendMessage", input, { "A2A-Version": "0.3" })).status,
    400,
  );
  assert.equal(f.state.enqueueCalls, 0);
  const response = await raw("SendMessage", input);
  assert.equal(response.status, 200);
  const task = (await response.json()).result.task;
  const deniedCancel = await raw("CancelTask", { id: task.id });
  assert.equal((await deniedCancel.json()).error.code, -32002);
  f.state.allowed = false;
  assert.equal((await raw("GetTask", { id: task.id })).status, 403);
});

test("HAB A2A rechecks policy after asynchronous Task storage and never resumes work from Get", async () => {
  const f = fixture();
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => {
    await save(...args);
    f.state.allowed = false;
  };
  await assert.rejects(
    () => f.handler.sendMessage(request(), context()),
    /forbidden/,
  );
  assert.equal(f.state.enqueueCalls, 0);
  f.store.save = save;
  f.state.allowed = true;
  const page = await f.store.list(ListTasksRequest.fromJSON({}), context());
  const observed = await f.handler.getTask(get(page.tasks[0].id), context());
  assert.equal(observed.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(f.state.enqueueCalls, 0);
  assert.equal(f.state.flushCalls, 0);
});

test("HAB A2A rechecks policy after evidence observation before saving or returning results", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 1,
    result: RESPONSE,
  };
  f.reply(first, "execution_result");
  const verify = f.route.evidence.verify;
  f.route.evidence.verify = async (...args) => {
    const result = await verify(...args);
    f.state.allowed = false;
    return result;
  };
  await assert.rejects(
    () => f.handler.getTask(get(first.id), context()),
    /forbidden/,
  );
  assert.deepEqual((await f.store.load(first.id, context())).artifacts, []);
});

test("HAB A2A default blocking waits for a real result observation and exposes no unsupported cancellation", async () => {
  const f = fixture();
  const input = request();
  input.configuration = undefined;
  const pending = f.handler.sendMessage(input, context());
  await new Promise((resolve) => setTimeout(resolve, 1));
  const saved = (await f.store.list(ListTasksRequest.fromJSON({}), context()))
    .tasks[0];
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 1,
    result: RESPONSE,
  };
  f.reply(saved, "execution_result");
  const completed = await pending;
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].parts[0].content.value, RESPONSE);
  await assert.rejects(
    () => f.handler.cancelTask(),
    /Cancellation is unsupported/,
  );
});

test("HAB gateway separates recipient routes in SDK storage for the same authenticated owner", async () => {
  const f = fixture();
  const firstEndpoint = "http://127.0.0.1:12345/a2a";
  const secondEndpoint = "http://127.0.0.1:12346/a2a";
  const first = createHabA2aGateway({
    endpoint: firstEndpoint,
    card: habRelayAgentCard(firstEndpoint),
    store: f.store,
    authorize: () => f.route,
  });
  const second = createHabA2aGateway({
    endpoint: secondEndpoint,
    card: habRelayAgentCard(secondEndpoint),
    store: f.store,
    authorize: () => ({ ...f.route, recipientId: "recipient-c" }),
  });
  const raw = (gateway, endpoint, method, params) =>
    gateway(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const input = {
    message: {
      messageId: "same-id",
      role: "ROLE_USER",
      parts: [{ text: "connectivity_check" }],
    },
    configuration: { returnImmediately: true },
  };
  const one = (
    await (await raw(first, firstEndpoint, "SendMessage", input)).json()
  ).result.task;
  const two = (
    await (await raw(second, secondEndpoint, "SendMessage", input)).json()
  ).result.task;
  assert.notEqual(one.id, two.id);
  const page = (await (await raw(first, firstEndpoint, "ListTasks", {})).json())
    .result;
  assert.deepEqual(
    page.tasks.map((task) => task.id),
    [one.id],
  );
  const wrongRoute = await (
    await raw(first, firstEndpoint, "GetTask", { id: two.id })
  ).json();
  assert.equal(wrongRoute.error.code, -32001);
});

test("HAB A2A ignores ordinary legacy replies beside a valid execution result", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  f.state.evidence = {
    ...f.state.evidence,
    state: "succeeded",
    fence: 1,
    result: RESPONSE,
  };
  f.reply(first, "execution_result");
  f.reply(first, "answer", {
    body: { parts: [{ type: "text", text: "ordinary reply" }] },
  });
  f.reply(first, "notice", {
    body: { parts: [{ type: "text", text: "ordinary notice" }] },
  });
  const done = await f.handler.getTask(get(first.id), context());
  assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
});

test("HAB A2A supplies the exact source hint and still filters an unscoped reply provider", async () => {
  const f = fixture();
  const first = await f.handler.sendMessage(request(), context());
  const other = await f.handler.sendMessage(request("other"), context());
  f.reply(other);
  f.reply(first);
  const hints = [];
  f.route.replies = (source) => {
    hints.push(source);
    return f.state.entries;
  };
  const observed = await f.handler.getTask(get(first.id), context());
  assert.deepEqual(hints, [
    {
      sender_id: first.metadata.hab_relay.sender_id,
      message_id: first.metadata.hab_relay.source.message_id,
    },
  ]);
  assert.equal(f.state.verifyCalls, 1);
  assert.equal(observed.status.state, TaskState.TASK_STATE_SUBMITTED);
  // A hint is not the canonical correlation key, even if an implementation mutates it.
  f.route.replies = (source) => {
    source.message_id = other.metadata.hab_relay.source.message_id;
    return f.state.entries;
  };
  await f.handler.getTask(get(first.id), context());
  assert.equal(f.state.verifyCalls, 2);
});
