import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  fixture,
  limits,
  worker,
  RESPONSE,
  code,
} from "./task-bridge-fixtures.js";
import { SQLiteReplyBudget } from "../src/adapter-policy/sqlite-reply-budget.ts";
import { InboxAnswers } from "../src/adapter-policy/inbox-answers.ts";
import { TaskReplies } from "../src/task-bridge/replies.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { DurableSender } from "../src/relay/sender.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
const context = Symbol("reply-operator");
function setup(t, patch = {}) {
  const f = fixture(t),
    path = join(f.dir, "reply-budget.sqlite");
  const options = {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(31),
    limits,
    max_records: 30,
    max_thread_replies: 8,
    max_per_window: 10,
    window_ms: 60000,
    max_clock_skew_ms: 1000,
    ...patch,
  };
  const stores = new Set();
  const open = (extra = {}, file = path) => {
    const budget = new SQLiteReplyBudget(file, { ...options, ...extra });
    stores.add(budget);
    return budget;
  };
  const budget = open();
  budget.migrate();
  const raw = new DatabaseSync(path);
  const outbox = new SQLiteOutbox(join(f.dir, "answer-outbox.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(62),
    limits,
    max_records: 100,
    max_body_bytes: 1000000,
    max_clock_skew_ms: 1000,
    lease_ms: 1000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  });
  outbox.migrate();
  const outboxRaw = new DatabaseSync(join(f.dir, "answer-outbox.sqlite"));
  const state = { enabled: true };
  const authorize = (ctx) =>
    ctx === context && state.enabled
      ? { agent_id: "b", actor_id: "synthetic-operator" }
      : undefined;
  const answers = new InboxAnswers(budget, f.inbox, outbox, limits, authorize);
  t.after(() => {
    outboxRaw.close();
    outbox.close();
    raw.close();
    for (const b of stores) b.close();
  });
  const key = (kind = "question", thread = "thread-ab", confirmed = true) =>
    f.receive(
      {
        kind,
        thread_id: thread,
        body: { parts: [{ type: "text", text: "synthetic question" }] },
      },
      confirmed,
    );
  const source = (key, kind = "question", thread = "thread-ab") => ({
    sender_id: key.sender_id,
    message_id: key.message_id,
    recipient_id: "b",
    thread_id: thread,
    kind,
  });
  const message = (key, patch = {}) => {
    const first = new Date(Date.now() - 100).toISOString();
    return {
      version: 1,
      message_id: makeReplayBoundMessageId(
        first,
        randomUUID().replaceAll("-", ""),
      ),
      recipient_id: key.sender_id,
      kind: "answer",
      thread_id: "thread-ab",
      in_reply_to: key,
      first_sent_at: first,
      expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
      body: { parts: [{ type: "text", text: "synthetic answer" }] },
      ...patch,
    };
  };
  return {
    ...f,
    taskContext: f.context,
    taskAuthorize: f.authorize,
    budget,
    path,
    options,
    open,
    outbox,
    outboxRaw,
    context,
    state,
    answers,
    authorize,
    budgetRaw: raw,
    key,
    source,
    message,
    closeBudget: (b) => {
      b.close();
      stores.delete(b);
    },
    records: () => raw.prepare("SELECT * FROM reply_budget_reservations").all(),
    sent: () => outboxRaw.prepare("SELECT * FROM relay_outbox").all(),
  };
}
function clock(at, action) {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
      return { get: () => ({ at }) };
    return original.call(this, sql);
  };
  try {
    return action();
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
}
test("Reply budget: explicit confirmed inbox answer consumes exactly one reservation", (t) => {
  const f = setup(t),
    key = f.key(),
    message = f.message(key);
  assert.equal(f.answers.enqueueOnce(context, key, message).state, "queued");
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
  assert.equal(f.count(), 0);
});
test("Reply budget: ACK alone neither answers nor consumes a reservation", (t) => {
  const f = setup(t);
  f.key();
  assert.equal(f.records().length, 0);
  assert.equal(f.sent().length, 0);
});
test("Reply budget: unconfirmed source, source mismatch and absent source cannot answer", (t) => {
  const f = setup(t),
    key = f.key("question", "thread-ab", false);
  assert.throws(
    () => f.answers.enqueueOnce(context, key, f.message(key)),
    code("invalid_reply_source"),
  );
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        context,
        { ...key, message_id: "missing" },
        f.message(key),
      ),
    code("not_found"),
  );
  assert.equal(f.records().length, 0);
});
test("Reply budget: answering answers, failures, notices or execution requests is forbidden", (t) => {
  const f = setup(t);
  for (const kind of [
    "answer",
    "delivery_failure",
    "notice",
    "execution_accepted",
    "execution_result",
    "execution_request",
  ]) {
    const key = f.key(kind);
    assert.throws(
      () => f.answers.enqueueOnce(context, key, f.message(key)),
      code("automatic_reply_forbidden"),
    );
  }
  assert.equal(f.records().length, 0);
  assert.equal(f.sent().length, 0);
});
test("Reply budget: known source identity cannot authorize another caller", (t) => {
  const f = setup(t),
    key = f.key(),
    message = f.message(key);
  const denied = new InboxAnswers(f.budget, f.inbox, f.outbox, limits);
  assert.throws(
    () => denied.enqueueOnce(context, key, message),
    code("reply_forbidden"),
  );
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        { agent_id: "b", actor_id: "operator" },
        key,
        message,
      ),
    code("reply_forbidden"),
  );
  assert.equal(f.records().length, 0);
});
test("Reply budget: async and decorated promise authorization is denied", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  for (const auth of [
    async () => ({ agent_id: "b", actor_id: "x" }),
    () => Object.assign(Promise.resolve(), { agent_id: "b", actor_id: "x" }),
  ]) {
    const answers = new InboxAnswers(f.budget, f.inbox, f.outbox, limits, auth);
    assert.throws(
      () => answers.enqueueOnce(context, key, m),
      code("reply_forbidden"),
    );
  }
  assert.equal(f.records().length, 0);
});
test("Reply budget: exact retries at capacity preserve one reply and one charge", (t) => {
  const f = setup(t, {
      max_records: 1,
      max_thread_replies: 1,
      max_per_window: 1,
    }),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  for (let i = 0; i < 3; i++) f.answers.enqueueOnce(context, key, m);
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
});
test("Reply budget: a second answer ID or changed content for the same request is a conflict", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  for (const next of [
    f.message(key),
    { ...m, body: { parts: [{ type: "text", text: "changed" }] } },
  ])
    assert.throws(
      () => f.answers.enqueueOnce(context, key, next),
      code("reply_budget_conflict"),
    );
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
});
test("Reply budget: new source messages cannot bypass the thread cap", (t) => {
  const f = setup(t, { max_thread_replies: 2 });
  for (let i = 0; i < 2; i++) {
    const key = f.key();
    f.answers.enqueueOnce(context, key, f.message(key));
  }
  const key = f.key();
  assert.throws(
    () => f.answers.enqueueOnce(context, key, f.message(key)),
    code("reply_thread_exhausted"),
  );
  assert.equal(f.records().length, 2);
  assert.equal(f.sent().length, 2);
});
test("Reply budget: new threads cannot bypass the agent-wide rate window", (t) => {
  const f = setup(t, { max_per_window: 2 });
  for (let i = 0; i < 2; i++) {
    const thread = "thread-" + i,
      key = f.key("question", thread);
    f.answers.enqueueOnce(context, key, f.message(key, { thread_id: thread }));
  }
  const key = f.key("question", "new-thread");
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        context,
        key,
        f.message(key, { thread_id: "new-thread" }),
      ),
    code("reply_rate_exhausted"),
  );
  assert.equal(f.records().length, 2);
});
test("Reply budget: sliding window recovery preserves permanent source and thread charges", (t) => {
  const f = setup(t, { max_per_window: 1, max_thread_replies: 2 }),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  const next = f.key();
  assert.throws(
    () => f.answers.enqueueOnce(context, next, f.message(next)),
    code("reply_rate_exhausted"),
  );
  const at = Date.now() + 60001,
    first = new Date(at).toISOString();
  const later = f.message(next, {
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
    message_id: makeReplayBoundMessageId(first, "a".repeat(32)),
  });
  clock(at, () => f.answers.enqueueOnce(context, next, later));
  assert.equal(f.records().length, 2);
  clock(at, () =>
    assert.throws(
      () => f.answers.enqueueOnce(context, key, f.message(key)),
      code("reply_budget_conflict"),
    ),
  );
});
test("Reply budget: reopen does not reset source, thread or rate limits", (t) => {
  const f = setup(t, { max_per_window: 1 }),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  f.closeBudget(f.budget);
  const b = f.open();
  b.migrate();
  const answers = new InboxAnswers(b, f.inbox, f.outbox, limits, f.authorize);
  answers.enqueueOnce(context, key, m);
  const next = f.key();
  assert.throws(
    () => answers.enqueueOnce(context, next, f.message(next)),
    code("reply_rate_exhausted"),
  );
  assert.equal(f.records().length, 1);
});
test("Reply budget: lost outbox response consumes the slot and only exact retry recovers", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  const answers = new InboxAnswers(
    f.budget,
    f.inbox,
    {
      agentId: "b",
      enqueueGuarded(message, guard) {
        f.outbox.enqueueGuarded(message, guard);
        throw Error("lost");
      },
    },
    limits,
    f.authorize,
  );
  assert.throws(() => answers.enqueueOnce(context, key, m));
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
  f.answers.enqueueOnce(context, key, m);
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
});
test("Reply budget: failure before outbox commit retains the conservative charge", (t) => {
  const f = setup(t, { max_per_window: 1 }),
    key = f.key(),
    m = f.message(key);
  const answers = new InboxAnswers(
    f.budget,
    f.inbox,
    {
      agentId: "b",
      enqueueGuarded() {
        throw Error("down");
      },
    },
    limits,
    f.authorize,
  );
  assert.throws(() => answers.enqueueOnce(context, key, m));
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 0);
  const next = f.key();
  assert.throws(
    () => f.answers.enqueueOnce(context, next, f.message(next)),
    code("reply_rate_exhausted"),
  );
  f.answers.enqueueOnce(context, key, m);
  assert.equal(f.sent().length, 1);
});
test("Reply budget: source body release does not prevent an already admitted exact retry", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  f.inbox.releaseBody(key.sender_id, key.message_id);
  f.answers.enqueueOnce(context, key, m);
  assert.equal(f.records().length, 1);
  assert.throws(
    () => f.answers.enqueueOnce(context, key, f.message(key)),
    code("reply_budget_conflict"),
  );
});
test("Reply budget: destination, thread and reply reference cannot be redirected", (t) => {
  const f = setup(t),
    key = f.key();
  for (const patch of [
    { recipient_id: "c" },
    { thread_id: "other" },
    { in_reply_to: null },
    { in_reply_to: { ...key, sender_id: "c" } },
    { in_reply_to: { ...key, message_id: "other" } },
  ])
    assert.throws(
      () => f.answers.enqueueOnce(context, key, f.message(key, patch)),
      code("invalid_automatic_reply"),
    );
  assert.equal(f.records().length, 0);
});
test("Reply budget: opaque IDs, expired intent and future timestamps are rejected", (t) => {
  const f = setup(t),
    key = f.key();
  const expired = Date.now() - 3600001,
    first = new Date(expired).toISOString();
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        context,
        key,
        f.message(key, { message_id: "opaque" }),
      ),
    code("invalid_automatic_reply"),
  );
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        context,
        key,
        f.message(key, {
          message_id: makeReplayBoundMessageId(first, "b".repeat(32)),
          first_sent_at: first,
          expires_at: new Date(expired + 3600000).toISOString(),
        }),
      ),
    code("reply_budget_invalid_time"),
  );
  const future = Date.now() + 60000,
    futureFirst = new Date(future).toISOString();
  assert.throws(
    () =>
      f.answers.enqueueOnce(
        context,
        key,
        f.message(key, {
          message_id: makeReplayBoundMessageId(futureFirst, "c".repeat(32)),
          first_sent_at: futureFirst,
          expires_at: new Date(future + 3600000).toISOString(),
        }),
      ),
    code("reply_budget_invalid_time"),
  );
  assert.equal(f.records().length, 0);
});
test("Reply budget: capacity exhaustion never evicts an admitted source", (t) => {
  const f = setup(t, { max_records: 1 }),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  const next = f.key();
  assert.throws(
    () => f.answers.enqueueOnce(context, next, f.message(next)),
    code("reply_budget_capacity_exceeded"),
  );
  assert.equal(f.budget.lookup(key, "answer").reply_id, m.message_id);
});
test("Reply budget: source and reply bodies are absent from the reservation ledger", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  const data = f.records()[0].data;
  assert.equal(data.includes("synthetic question"), false);
  assert.equal(data.includes("synthetic answer"), false);
  assert.equal(data.includes("body"), false);
  assert.match(JSON.parse(data).reply_fingerprint, /^[a-f0-9]{64}$/);
});
test("Reply budget: authority revoked before reservation commit leaves no charge", (t) => {
  const f = setup(t),
    key = f.key();
  let n = 0;
  const answers = new InboxAnswers(f.budget, f.inbox, f.outbox, limits, () =>
    ++n < 3 ? { agent_id: "b", actor_id: "op" } : undefined,
  );
  assert.throws(
    () => answers.enqueueOnce(context, key, f.message(key)),
    code("reply_forbidden"),
  );
  assert.equal(f.records().length, 0);
  assert.equal(f.sent().length, 0);
});
test("Reply budget: authority revoked at outbox commit retains charge but rolls back the message", (t) => {
  const f = setup(t),
    key = f.key();
  let n = 0;
  const answers = new InboxAnswers(f.budget, f.inbox, f.outbox, limits, () =>
    ++n < 5 ? { agent_id: "b", actor_id: "op" } : undefined,
  );
  assert.throws(
    () => answers.enqueueOnce(context, key, f.message(key)),
    code("reply_forbidden"),
  );
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 0);
});
test("Reply budget: async guards and actions do not claim successful admission", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  assert.throws(
    () =>
      f.budget.withReply(
        f.source(key),
        m,
        async () => {},
        () => {},
      ),
    code("reply_forbidden"),
  );
  assert.equal(f.records().length, 0);
  assert.throws(
    () =>
      f.budget.withReply(
        f.source(key),
        m,
        () => {},
        async () => {},
      ),
    code("invalid_reply_action"),
  );
  assert.equal(f.records().length, 1);
});
test("Reply budget: failed reservation insert rolls back counters before outbox", (t) => {
  const f = setup(t),
    key = f.key();
  f.budgetRaw.exec(
    "CREATE TRIGGER fail_budget BEFORE INSERT ON reply_budget_reservations BEGIN SELECT RAISE(ABORT,'synthetic');END",
  );
  assert.throws(
    () => f.answers.enqueueOnce(context, key, f.message(key)),
    code("reply_budget_unavailable"),
  );
  assert.equal(f.records().length, 0);
  assert.equal(f.sent().length, 0);
  assert.equal(
    f.budgetRaw.prepare("SELECT record_count FROM reply_budget_meta").get()
      .record_count,
    0,
  );
});
test("Reply budget: tampered reservation, sealed clock and missing rows fail closed", (t) => {
  for (const kind of ["row", "clock", "delete"]) {
    const f = setup(t),
      key = f.key(),
      m = f.message(key);
    f.answers.enqueueOnce(context, key, m);
    if (kind === "row") {
      f.budgetRaw.exec(
        "DROP TRIGGER reply_budget_no_update; UPDATE reply_budget_reservations SET data='{}'",
      );
    } else if (kind === "clock")
      f.budgetRaw.exec("UPDATE reply_budget_meta SET last_at=0");
    else
      f.budgetRaw.exec(
        "DROP TRIGGER reply_budget_no_delete; DELETE FROM reply_budget_reservations",
      );
    assert.throws(
      () => f.answers.enqueueOnce(context, key, m),
      code("reply_budget_integrity_failed"),
    );
    assert.equal(f.sent().length, 1);
  }
});
test("Reply budget: backward clock fails closed instead of replenishing rate", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  const at = f.budgetRaw
    .prepare("SELECT last_at FROM reply_budget_meta")
    .get().last_at;
  clock(at - 1, () =>
    assert.throws(
      () => f.answers.enqueueOnce(context, key, m),
      code("reply_budget_clock_regressed"),
    ),
  );
  assert.equal(f.records().length, 1);
});
test("Reply budget: bindings include agent, key and finite policy across restart", (t) => {
  const f = setup(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(8) },
    { max_thread_replies: 9 },
    { window_ms: 61000 },
  ]) {
    const b = f.open(patch);
    assert.throws(() => b.migrate(), code("reply_budget_binding_mismatch"));
  }
  const link = join(f.dir, "budget-link");
  symlinkSync(f.path, link);
  assert.throws(() => f.open({}, link), code("reply_budget_unavailable"));
  chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), code("reply_budget_unavailable"));
  chmodSync(f.path, 0o600);
});
test("Reply budget: unknown schema and missing immutable triggers are not auto repaired", (t) => {
  const f = setup(t);
  f.budgetRaw.exec("DROP TRIGGER reply_budget_no_delete");
  const b = f.open();
  assert.throws(() => b.migrate(), code("unsupported_reply_budget_schema"));
  const path = join(f.dir, "unknown.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE other(id)");
  raw.close();
  chmodSync(path, 0o600);
  const unknown = f.open({}, path);
  assert.throws(() => unknown.migrate(), code("unknown_reply_budget_schema"));
});
test("Reply budget: options require explicit finite positive limits and composition identity", (t) => {
  const f = setup(t);
  for (const patch of [
    { max_thread_replies: 0 },
    { max_per_window: Infinity },
    { window_ms: 0 },
    { max_records: 10001 },
    { max_clock_skew_ms: -1 },
  ])
    assert.throws(
      () => f.open(patch, ":memory:"),
      code("invalid_reply_budget_options"),
    );
  assert.throws(
    () =>
      new InboxAnswers(
        f.budget,
        f.inbox,
        { agentId: "c", enqueueGuarded() {} },
        limits,
      ),
    code("invalid_reply_composition"),
  );
  assert.throws(
    () =>
      new TaskReplies(f.journal, f.outbox, f.authorize, {
        agentId: "c",
        withReply() {},
      }),
    code("invalid_bridge_composition"),
  );
});
test("Reply budget: Task accepted and result share the same persistent thread cap", async (t) => {
  const f = setup(t, { max_thread_replies: 1 }),
    key = f.receive();
  f.bridge.accept(f.taskContext, key);
  await f.bridge.submitOnce(f.taskContext, key);
  const replies = new TaskReplies(
    f.journal,
    f.outbox,
    f.taskAuthorize,
    f.budget,
  );
  replies.prepare(f.taskContext, key, "execution_accepted");
  replies.enqueueOnce(f.taskContext, key, "execution_accepted");
  const task = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: task.id,
    fence: task.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.bridge.observeOnce(f.taskContext, key);
  replies.prepare(f.taskContext, key, "execution_result");
  assert.throws(
    () => replies.enqueueOnce(f.taskContext, key, "execution_result"),
    code("reply_thread_exhausted"),
  );
  assert.equal(f.journal.getReply(key, "execution_result").state, "prepared");
  assert.equal(f.count(), 1);
  assert.equal(f.records().length, 1);
  assert.equal(f.calls.filter((c) => c.op === "submit").length, 1);
});
test("Reply budget: normal Task replies use two independent slots without automatic re-execution", async (t) => {
  const f = setup(t),
    key = f.receive();
  f.bridge.accept(f.taskContext, key);
  await f.bridge.submitOnce(f.taskContext, key);
  const replies = new TaskReplies(
    f.journal,
    f.outbox,
    f.taskAuthorize,
    f.budget,
  );
  replies.prepare(f.taskContext, key, "execution_accepted");
  replies.enqueueOnce(f.taskContext, key, "execution_accepted");
  const task = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: task.id,
    fence: task.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.bridge.observeOnce(f.taskContext, key);
  replies.prepare(f.taskContext, key, "execution_result");
  replies.enqueueOnce(f.taskContext, key, "execution_result");
  replies.enqueueOnce(f.taskContext, key, "execution_result");
  assert.equal(f.count(), 1);
  assert.equal(f.records().length, 2);
  assert.equal(f.sent().length, 2);
});
test("Reply budget: real Relay question-answer roundtrip ACKs without starting another conversation", async (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  const sender = new DurableSender(f.outbox, {
    submit: async (message) => f.service.submit(f.contexts.b, message),
    status: async (id) => f.service.status(f.contexts.b, id),
  });
  await sender.sendOnce();
  const delivery = f.service.poll(f.contexts.a);
  assert.equal(delivery.message.kind, "answer");
  assert.deepEqual(delivery.message.in_reply_to, key);
  f.service.ack(f.contexts.a, {
    sender_id: "b",
    message_id: m.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "answer-ack",
  });
  assert.equal(f.service.status(f.contexts.b, m.message_id).state, "acked");
  f.answers.enqueueOnce(context, key, m);
  await sender.sendOnce();
  assert.equal(f.service.poll(f.contexts.a), null);
  assert.equal(f.records().length, 1);
  assert.equal(f.count(), 0);
});
test("Reply budget: competing native writers cannot exceed a one-reply rate budget", async (t) => {
  const f = setup(t, { max_per_window: 1 });
  const requests = [
    f.key("question", "thread-1"),
    f.key("question", "thread-2"),
  ].map((key, i) => ({
    source: f.source(key, "question", "thread-" + (i + 1)),
    message: f.message(key, { thread_id: "thread-" + (i + 1) }),
  }));
  const moduleUrl = new URL(
    "../src/adapter-policy/sqlite-reply-budget.ts",
    import.meta.url,
  ).href;
  const source = `
    const { parentPort, workerData: d } = require("node:worker_threads");
    (async () => {
      const { SQLiteReplyBudget } = await import(d.moduleUrl);
      const b = new SQLiteReplyBudget(d.path, d.options);
      try {
        b.migrate();
        try { b.withReply(d.request.source, d.request.message, () => {}, () => {});
          parentPort.postMessage("admitted"); }
        catch(e) { parentPort.postMessage(e.code); }
      } finally { b.close(); }
    })().catch(e => { throw e; });
  `;
  const outcomes = await Promise.all(
    requests.map(
      (request) =>
        new Promise((resolve, reject) => {
          const w = new Worker(source, {
            eval: true,
            workerData: {
              moduleUrl,
              path: f.path,
              options: f.options,
              request,
            },
          });
          let result;
          w.once("message", (value) => {
            result = value;
          });
          w.once("error", reject);
          w.once("exit", (status) =>
            status === 0 && result
              ? resolve(result)
              : reject(Error("worker exit")),
          );
        }),
    ),
  );
  assert.deepEqual(outcomes.sort(), ["admitted", "reply_rate_exhausted"]);
  assert.equal(f.records().length, 1);
});

test("Reply budget: automatic answers and Task replies share one individual thread budget", async (t) => {
  const f = setup(t, { max_thread_replies: 1 }),
    question = f.key();
  f.answers.enqueueOnce(context, question, f.message(question));
  const key = f.receive();
  f.bridge.accept(f.taskContext, key);
  await f.bridge.submitOnce(f.taskContext, key);
  const replies = new TaskReplies(
    f.journal,
    f.outbox,
    f.taskAuthorize,
    f.budget,
  );
  replies.prepare(f.taskContext, key, "execution_accepted");
  assert.throws(
    () => replies.enqueueOnce(f.taskContext, key, "execution_accepted"),
    code("reply_thread_exhausted"),
  );
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
  assert.equal(f.count(), 1);
});

test("Reply budget: lost Task reply journal commit recovers without another reservation", async (t) => {
  const f = setup(t, { max_records: 1, max_per_window: 1 }),
    key = f.receive();
  f.bridge.accept(f.taskContext, key);
  await f.bridge.submitOnce(f.taskContext, key);
  const replies = new TaskReplies(
    f.journal,
    f.outbox,
    f.taskAuthorize,
    f.budget,
  );
  const prepared = replies.prepare(f.taskContext, key, "execution_accepted");
  f.raw.exec(
    "CREATE TRIGGER fail_task_reply BEFORE UPDATE ON task_bridge_replies BEGIN SELECT RAISE(ABORT,'synthetic');END",
  );
  assert.throws(
    () => replies.enqueueOnce(f.taskContext, key, "execution_accepted"),
    code("bridge_store_unavailable"),
  );
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
  assert.equal(f.journal.getReply(key, "execution_accepted").state, "prepared");
  f.raw.exec("DROP TRIGGER fail_task_reply");
  replies.enqueueOnce(f.taskContext, key, "execution_accepted");
  assert.equal(
    f.journal.getReply(key, "execution_accepted").message.message_id,
    prepared.message.message_id,
  );
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 1);
  assert.equal(f.calls.filter((c) => c.op === "submit").length, 1);
});

test("Reply budget: expired exact replay cannot recreate a missing outbox record or a fresh ID", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.answers.enqueueOnce(context, key, m);
  f.outboxRaw
    .prepare("DELETE FROM relay_outbox WHERE message_id=?")
    .run(m.message_id);
  clock(Date.parse(m.expires_at) + 1, () => {
    assert.throws(
      () => f.answers.enqueueOnce(context, key, m),
      code("expired_before_enqueue"),
    );
    assert.throws(
      () => f.answers.enqueueOnce(context, key, f.message(key)),
      code("reply_budget_conflict"),
    );
  });
  assert.equal(f.records().length, 1);
  assert.equal(f.sent().length, 0);
});

test("Reply budget: transaction-level rollback stops the store until explicit migration", (t) => {
  const f = setup(t),
    key = f.key(),
    m = f.message(key);
  f.budgetRaw.exec(
    "CREATE TRIGGER force_rollback BEFORE INSERT ON reply_budget_reservations BEGIN SELECT RAISE(ROLLBACK,'synthetic');END",
  );
  assert.throws(
    () => f.answers.enqueueOnce(context, key, m),
    code("reply_budget_unavailable"),
  );
  assert.throws(
    () => f.budget.lookup(key, "answer"),
    code("reply_budget_not_migrated"),
  );
  assert.equal(f.records().length, 0);
  f.budgetRaw.exec("DROP TRIGGER force_rollback");
  f.budget.migrate();
  f.answers.enqueueOnce(context, key, m);
  assert.equal(f.records().length, 1);
});
