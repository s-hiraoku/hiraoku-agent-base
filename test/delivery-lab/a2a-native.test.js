import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ListTasksRequest, TaskState } from "@a2a-js/sdk";
import {
  createA2aRelayFixture,
  a2aRequest,
  worker,
  RESPONSE,
} from "../a2a-relay-fixtures.js";
import { request, decode } from "../relay-http-fixtures.js";
import { nativeCases } from "./a2a-acceptance.js";

const submitted = TaskState.TASK_STATE_SUBMITTED;
const completed = TaskState.TASK_STATE_COMPLETED;
function readDatabase(f, name, action) {
  const db = new DatabaseSync(join(f.dir, name), { readOnly: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}
function expireFixtureLease(f, source) {
  const db = new DatabaseSync(join(f.dir, "relay.sqlite"));
  try {
    assert.equal(
      db
        .prepare(
          "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0 WHERE sender_id=? AND message_id=? AND state='leased'",
        )
        .run(source.sender_id, source.message_id).changes,
      1,
    );
  } finally {
    db.close();
  }
}
function observeAcks(t, f, intercept = (_args, forward) => forward()) {
  const original = globalThis.fetch;
  const captured = [],
    responses = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new globalThis.Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (
      url !== f.relayUrl ||
      headers.get("mcp-name") !== "relay_ack" ||
      headers.get("authorization") !== "Bearer fixture-b"
    )
      return original(input, init);
    const req = new Request(
      input instanceof Request ? input.clone() : input,
      init,
    );
    const args = (await req.json()).params.arguments;
    assert.equal(args.sender_id, f.origin.agent_id);
    captured.push(structuredClone(args));
    const response = await intercept(args, () => original(input, init));
    responses.push((await decode(response.clone())).result);
    return response;
  });
  return { captured, responses };
}
async function deliverAccept(f, task) {
  await f.recipient.receiveOnce();
  const source = f.sourceOf(task);
  f.recipient.accept(f.operator, source);
  return source;
}
async function reply(f, source, kind) {
  f.recipient.replyOnce(f.operator, source, kind);
  await f.sendReply();
  await f.receiveResult();
}
async function completeEngine(f, source) {
  const running = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.recipient.observeOnce(f.operator, source);
}

test(nativeCases[0], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_ingress"),
    f.options,
  );
  assert.equal(task.status.state, submitted);
  assert.equal(f.relayRows().length, 1);
  const body = JSON.parse(f.relayRows()[0].body);
  assert.equal(body.kind, "execution_request");
  assert.equal(body.recipient_id, f.destination.agent_id);
  assert.equal(f.count(), 0);
  await f.recipient.receiveOnce();
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).status.state,
    submitted,
  );
  assert.equal(f.count(), 0);
});

test(nativeCases[1], async (t) => {
  const f = await createA2aRelayFixture(t);
  f.state.failSubmitReply = true;
  await assert.rejects(() =>
    f.client.sendMessage(a2aRequest("independent_replay"), f.options),
  );
  const original = { ...f.relayRows()[0] };
  assert.equal(f.requestCount(), 1);
  await f.restart();
  f.faults.outboxRetryDue();
  const task = await f.client.sendMessage(
    a2aRequest("independent_replay"),
    f.options,
  );
  const replay = await f.client.sendMessage(
    a2aRequest("independent_replay"),
    f.options,
  );
  assert.equal(replay.id, task.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.deepEqual({ ...f.relayRows()[0] }, original);
  assert.equal((await f.receipt(task)).receipt_id, original.receipt_id);
  assert.equal(
    Date.parse(task.metadata.hab_relay.source.expires_at),
    original.expires_at,
  );
  await assert.rejects(
    () =>
      f.client.sendMessage(
        a2aRequest("independent_replay", "different"),
        f.options,
      ),
    /message_id_conflict/,
  );
  assert.equal(f.relayRows().length, 1);
  assert.equal(f.count(), 0);
});

test(nativeCases[2], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_durability"),
    f.options,
  );
  let observed = 0;
  observeAcks(t, f, (args, forward) => {
    readDatabase(f, "inbox-b.sqlite", (db) => {
      const row = db
        .prepare(
          "SELECT body,receipt_confirmed FROM relay_inbox WHERE sender_id=? AND message_id=?",
        )
        .get(args.sender_id, args.message_id);
      assert.ok(row);
      assert.deepEqual(JSON.parse(row.body), JSON.parse(f.relayRows()[0].body));
      assert.equal(row.receipt_confirmed, 0);
      const ack = db
        .prepare("SELECT request FROM relay_receiver_acks WHERE request_id=?")
        .get(args.request_id);
      assert.deepEqual(JSON.parse(ack.request), args);
    });
    observed++;
    return forward();
  });
  const unrelated = new Request(`${f.base}/a2a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      Authorization: "Bearer fixture-a",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "unrelated-request",
      method: "GetTask",
      params: { id: task.id },
    }),
  });
  const unrelatedResponse = await globalThis.fetch(unrelated);
  assert.equal(unrelatedResponse.status, 200);
  assert.equal((await unrelatedResponse.json()).result.id, task.id);
  await f.recipient.receiveOnce();
  assert.equal(observed, 1);
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
});

test(nativeCases[3], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_ack_committed"),
    f.options,
  );
  const observation = observeAcks(t, f);
  f.state.failAckReply = true;
  await assert.rejects(() => f.recipient.receiveOnce());
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.recipientEntries()[0].receipt_confirmed, false);
  assert.throws(() => f.recipient.accept(f.operator, f.sourceOf(task)));
  await f.restart();
  f.faults.ackRetryDue();
  await f.recipient.receiveOnce();
  assert.equal(observation.captured.length, 2);
  assert.deepEqual(observation.captured[1], observation.captured[0]);
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
});

test(nativeCases[4], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_ack_uncommitted"),
    f.options,
  );
  let drop = true;
  const observation = observeAcks(t, f, (_args, forward) => {
    if (drop) {
      drop = false;
      throw Error("synthetic ACK dropped before HTTP");
    }
    return forward();
  });
  await assert.rejects(() => f.recipient.receiveOnce());
  assert.equal((await f.receipt(task)).state, "leased");
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, false);
  expireFixtureLease(f, f.sourceOf(task));
  await f.restart();
  f.faults.ackRetryDue();
  await f.recipient.receiveOnce();
  assert.equal(observation.captured.length, 3);
  assert.deepEqual(observation.captured[1], observation.captured[0]);
  assert.equal(observation.responses[0].structuredContent.error, "invalid_ack");
  assert.equal(
    observation.captured[2].generation,
    observation.captured[0].generation + 1,
  );
  assert.notEqual(
    observation.captured[2].lease_token,
    observation.captured[0].lease_token,
  );
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
});

test(nativeCases[5], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_consumers"),
    f.options,
  );
  const poll = async () => {
    const response = await globalThis.fetch(
      request(
        "tools/call",
        { name: "relay_poll", arguments: {} },
        { url: f.relayUrl, headers: { Authorization: "Bearer fixture-b" } },
      ),
    );
    assert.equal(response.status, 200);
    const rpc = await decode(response);
    assert.notEqual(rpc.result.isError, true);
    return rpc.result.structuredContent.delivery;
  };
  const deliveries = await Promise.all([poll(), poll()]);
  assert.equal(deliveries.filter(Boolean).length, 1);
  assert.equal(
    deliveries.find(Boolean).message.message_id,
    f.sourceOf(task).message_id,
  );
  assert.equal(f.recipientEntries().length, 0);
  expireFixtureLease(f, f.sourceOf(task));
  await f.recipient.receiveOnce();
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.recipientEntries().length, 1);
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
});

test(nativeCases[6], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_acceptance"),
    f.options,
  );
  await f.recipient.receiveOnce();
  const source = f.sourceOf(task);
  assert.throws(() => f.recipient.accept(Symbol("wrong-operator"), source));
  await f.client.getTask({ id: task.id }, f.options);
  await f.client.listTasks(
    ListTasksRequest.fromJSON({ includeArtifacts: true }),
    f.options,
  );
  assert.equal(f.count(), 0);
  f.recipient.accept(f.operator, source);
  assert.equal(f.count(), 0);
  const linked = await f.recipient.submitOnce(f.operator, source);
  assert.equal(linked.state, "linked");
  assert.equal(f.count(), 1);
  await f.restart();
  const replay = await f.recipient.submitOnce(f.operator, source);
  assert.equal(replay.task.id, linked.task.id);
  await f.client.getTask({ id: task.id }, f.options);
  await f.client.listTasks(ListTasksRequest.fromJSON({}), f.options);
  assert.equal(f.count(), 1);
});

test(nativeCases[7], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_artifact"),
    f.options,
  );
  const source = await deliverAccept(f, task);
  await f.recipient.submitOnce(f.operator, source);
  const queued = f.journal.get(source).task;
  await reply(f, source, "execution_accepted");
  await completeEngine(f, source);
  for (const view of [
    await f.client.getTask({ id: task.id }, f.options),
    await f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      f.options,
    ),
    await f.client.sendMessage(a2aRequest("independent_artifact"), f.options),
  ])
    assert.equal(JSON.stringify(view).includes(RESPONSE), false);
  f.recipient.replyOnce(f.operator, source, "execution_result");
  await f.sendReply();
  assert.equal(
    JSON.stringify(await f.client.getTask({ id: task.id }, f.options)).includes(
      RESPONSE,
    ),
    false,
  );
  await f.receiveResult();
  f.state.failEvidence = true;
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  f.state.failEvidence = false;
  const done = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(done.status.state, completed);
  assert.equal(done.artifacts.length, 1);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  await reply(f, source, "execution_accepted");
  f.state.observed = queued;
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  f.state.observed = undefined;
  await f.restart();
  const durable = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(durable.status.state, completed);
  assert.deepEqual(durable.artifacts, done.artifacts);
  assert.equal(f.count(), 1);
});

test(nativeCases[8], async (t) => {
  const f = await createA2aRelayFixture(t);
  const task = await f.client.sendMessage(
    a2aRequest("independent_privacy"),
    f.options,
  );
  const source = await deliverAccept(f, task);
  await f.recipient.submitOnce(f.operator, source);
  await completeEngine(f, source);
  await reply(f, source, "execution_result");
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).artifacts[0].parts[0]
      .content.value,
    RESPONSE,
  );
  const third = { serviceParameters: { Authorization: "Bearer fixture-c" } };
  for (const token of ["fixture-c", "missing-token"]) {
    const card = await globalThis.fetch(
      `${f.base}/.well-known/agent-card.json`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.notEqual(card.status, 200);
    assert.equal((await card.text()).includes(RESPONSE), false);
  }
  await assert.rejects(() => f.client.getTask({ id: task.id }, third));
  await assert.rejects(() =>
    f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      third,
    ),
  );
  f.revokeGroup();
  const card = await globalThis.fetch(`${f.base}/.well-known/agent-card.json`, {
    headers: { Authorization: "Bearer fixture-a" },
  });
  assert.notEqual(card.status, 200);
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  await assert.rejects(() =>
    f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      f.options,
    ),
  );
  f.restoreGroup();
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).artifacts.length,
    1,
  );
  assert.equal(f.count(), 1);
});

test(nativeCases[9], async (t) => {
  const unknown = await createA2aRelayFixture(t);
  const first = await unknown.client.sendMessage(
    a2aRequest("independent_expiry"),
    unknown.options,
  );
  await unknown.recipient.receiveOnce();
  const source = unknown.sourceOf(first),
    expires = Date.parse(first.metadata.hab_relay.source.expires_at);
  unknown.state.clock = expires;
  assert.throws(() => unknown.recipient.accept(unknown.operator, source));
  unknown.state.clock = expires - 1;
  unknown.recipient.accept(unknown.operator, source);
  unknown.state.clock = expires;
  await assert.rejects(() =>
    unknown.recipient.submitOnce(unknown.operator, source),
  );
  assert.equal(unknown.count(), 0);
  await unknown.restart();
  const replay = await unknown.client.sendMessage(
    a2aRequest("independent_expiry"),
    unknown.options,
  );
  assert.equal(replay.id, first.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    first.metadata.hab_relay.source,
  );
  assert.equal(unknown.count(), 0);
  const known = await createA2aRelayFixture(t);
  const task = await known.client.sendMessage(
    a2aRequest("independent_known_receipt"),
    known.options,
  );
  const knownSource = await deliverAccept(known, task);
  let calls = 0;
  const original = known.hub.submit.bind(known.hub);
  known.hub.submit = async (...args) => {
    calls++;
    const value = await original(...args);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    known.state.clock = Date.parse(task.metadata.hab_relay.source.expires_at);
    return value;
  };
  const linked = await known.recipient.submitOnce(known.operator, knownSource);
  assert.equal(linked.state, "linked");
  assert.equal(calls, 1);
  await known.restart();
  known.hub.submit = async () => {
    calls++;
    throw Error("engine RPC repeated");
  };
  const recovered = await known.recipient.submitOnce(
    known.operator,
    knownSource,
    true,
  );
  assert.equal(recovered.state, "linked");
  assert.equal(recovered.task.id, linked.task.id);
  assert.equal(calls, 1);
  assert.equal(known.count(), 1);
});
