import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  fixture,
  code,
  worker,
  owner,
  RESPONSE,
  limits,
} from "./task-bridge-fixtures.js";
import { TaskReplies } from "../src/task-bridge/replies.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { DurableSender } from "../src/relay/sender.ts";

const accepted = "execution_accepted",
  result = "execution_result";
function setup(t, patch = {}, outboxPatch = {}) {
  const f = fixture(t, patch);
  const path = join(f.dir, "reply-outbox.sqlite");
  const options = {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(61),
    limits,
    max_records: 20,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 1000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
    ...outboxPatch,
  };
  const outbox = new SQLiteOutbox(path, options);
  outbox.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    outbox.close();
  });
  const replies = new TaskReplies(f.journal, outbox, f.authorize);
  return {
    ...f,
    outbox,
    outboxRaw: raw,
    outboxPath: path,
    outboxOptions: options,
    replies,
    rows: () => raw.prepare("SELECT * FROM relay_outbox").all(),
    replyRows: () => f.raw.prepare("SELECT * FROM task_bridge_replies").all(),
  };
}
async function linked(f) {
  const key = f.receive();
  f.bridge.accept(f.context, key);
  await f.bridge.submitOnce(f.context, key);
  return key;
}
async function finish(f, key, state = "succeeded") {
  const task = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: task.id,
    fence: task.fence,
    state,
    result: state === "succeeded" ? RESPONSE : "connectivity_check_failed",
  });
  return f.bridge.observeOnce(f.context, key);
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

test("Task replies: acceptance is separate from ACK, local approval and unconfirmed Task submission", async (t) => {
  const f = setup(t),
    key = f.receive();
  assert.throws(
    () => f.replies.prepare(f.context, key, accepted),
    code("bridge_not_found"),
  );
  f.bridge.accept(f.context, key);
  assert.throws(
    () => f.replies.prepare(f.context, key, accepted),
    code("bridge_not_linked"),
  );
  const b = f.makeBridge({
    submit: async () => {
      throw Error("unknown");
    },
  });
  await b.submitOnce(f.context, key);
  assert.throws(
    () => f.replies.prepare(f.context, key, accepted),
    code("bridge_not_linked"),
  );
  assert.equal(f.rows().length, 0);
  assert.equal(f.replyRows().length, 0);
});

test("Task replies: fixed accepted contract derives destination, thread and source reference", async (t) => {
  const f = setup(t),
    key = await linked(f),
    count = f.calls.length;
  const r = f.replies.prepare(f.context, key, accepted);
  assert.equal(r.state, "prepared");
  assert.equal(r.message.recipient_id, key.sender_id);
  assert.deepEqual(r.message.in_reply_to, key);
  assert.equal(r.message.thread_id, "thread-ab");
  assert.deepEqual(JSON.parse(JSON.stringify(r.message.body.parts)), [
    {
      type: "data",
      schema_id: "task.execution_accepted",
      schema_version: 1,
      value: { task_type: "connectivity_check", task_id: r.task.id },
    },
  ]);
  assert.equal(
    Date.parse(r.message.expires_at) - Date.parse(r.message.first_sent_at),
    3600000,
  );
  assert.match(r.message.message_id, /^rm1\.[0-9]+\.[a-f0-9]{32}$/);
  assert.equal(f.calls.length, count);
  assert.equal(f.rows().length, 0);
});

test("Task replies: prepare, handoff and exact retries keep one message and never resubmit a Task", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const r = f.replies.prepare(f.context, key, accepted);
  assert.deepEqual(f.replies.prepare(f.context, key, accepted), r);
  assert.equal(
    f.replies.enqueueOnce(f.context, key, accepted).state,
    "enqueued",
  );
  for (let n = 0; n < 3; n++) f.replies.enqueueOnce(f.context, key, accepted);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].message_id, r.message.message_id);
  assert.equal(f.count(), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.audit().filter((e) => e === accepted + "_prepared").length, 1);
  assert.equal(f.audit().filter((e) => e === accepted + "_enqueued").length, 1);
});

test("Task replies: default denial, fake context and separate reply permission", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const denied = new TaskReplies(f.journal, f.outbox);
  assert.throws(
    () => denied.prepare(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.throws(
    () =>
      f.replies.prepare(
        { receiver_id: "b", actor_id: "operator" },
        key,
        accepted,
      ),
    code("bridge_forbidden"),
  );
  f.state.denied.add("reply");
  assert.throws(
    () => f.replies.prepare(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.replyRows().length, 0);
});

test("Task replies: wrong outbox identity and async authority fail closed", async (t) => {
  const f = setup(t),
    key = await linked(f);
  assert.throws(
    () =>
      new TaskReplies(
        f.journal,
        { agentId: "a", enqueueGuarded() {} },
        f.authorize,
      ),
    code("invalid_bridge_composition"),
  );
  const replies = new TaskReplies(f.journal, f.outbox, async () => ({
    receiver_id: "b",
    actor_id: "operator",
  }));
  assert.throws(
    () => replies.prepare(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.replyRows().length, 0);
});

test("Task replies: closed succeeded and failed evidence produces the fixed result contract", async (t) => {
  for (const state of ["succeeded", "failed"]) {
    const f = setup(t),
      key = await linked(f);
    const done = await finish(f, key, state);
    const reply = f.replies.prepare(f.context, key, result);
    assert.deepEqual(JSON.parse(JSON.stringify(reply.message.body.parts)), [
      {
        type: "data",
        schema_id: "task.execution_result",
        schema_version: 1,
        value: {
          task_type: "connectivity_check",
          task_id: done.task.id,
          state,
          result: done.task.result,
        },
      },
    ]);
    f.replies.enqueueOnce(f.context, key, result);
    assert.equal(f.rows().length, 1);
    assert.equal(f.count(), 1);
  }
});

test("Task replies: queued, running, waiting approval and cancelled-open are not completion", async (t) => {
  const f = setup(t),
    key = await linked(f);
  assert.throws(
    () => f.replies.prepare(f.context, key, result),
    code("bridge_task_not_closed"),
  );
  const task = await f.hub.claim(worker, {});
  await f.bridge.observeOnce(f.context, key);
  assert.throws(
    () => f.replies.prepare(f.context, key, result),
    code("bridge_task_not_closed"),
  );
  // Waiting approval is an unresolved execution snapshot, never a result.
  const old = f.journal.get(key).task;
  f.journal.observe(key, { ...old, state: "waiting_approval" }, () => {});
  assert.throws(
    () => f.replies.prepare(f.context, key, result),
    code("bridge_task_not_closed"),
  );
  await f.hub.cancel(owner, { id: task.id });
  await f.bridge.observeOnce(f.context, key);
  assert.throws(
    () => f.replies.prepare(f.context, key, result),
    code("bridge_task_not_closed"),
  );
  assert.equal(f.replyRows().length, 0);
});

test("Task replies: cancelled-closed evidence is a result without claiming success", async (t) => {
  const f = setup(t),
    key = await linked(f),
    task = f.journal.get(key).task;
  await f.hub.cancel(owner, { id: task.id });
  await f.bridge.observeOnce(f.context, key);
  const r = f.replies.prepare(f.context, key, result);
  assert.equal(r.task.execution_open, 0);
  assert.equal(r.message.body.parts[0].value.state, "cancelled");
  assert.equal(r.message.body.parts[0].value.result, null);
});

test("Task replies: terminal result requires observation, not merely an Engine-side completion", async (t) => {
  const f = setup(t),
    key = await linked(f),
    task = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: task.id,
    fence: task.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  assert.throws(
    () => f.replies.prepare(f.context, key, result),
    code("bridge_task_not_closed"),
  );
  await f.bridge.observeOnce(f.context, key);
  f.replies.prepare(f.context, key, result);
});

test("Task replies: lost enqueue response recovers the same durable message after reopen", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const r = f.replies.prepare(f.context, key, accepted);
  const replies = new TaskReplies(
    f.journal,
    {
      agentId: "b",
      enqueueGuarded(m, guard) {
        f.outbox.enqueueGuarded(m, guard);
        throw Error("lost synthetic response");
      },
    },
    f.authorize,
  );
  assert.throws(() => replies.enqueueOnce(f.context, key, accepted));
  assert.equal(f.rows().length, 1);
  assert.equal(f.journal.getReply(key, accepted).state, "prepared");
  f.close(f.journal);
  const reopened = f.open();
  reopened.migrate();
  const restarted = new TaskReplies(reopened, f.outbox, f.authorize);
  assert.deepEqual(
    restarted.prepare(f.context, key, accepted).message,
    r.message,
  );
  assert.equal(
    restarted.enqueueOnce(f.context, key, accepted).state,
    "enqueued",
  );
  assert.equal(f.rows().length, 1);
  assert.equal(f.calls.length, 1);
});

test("Task replies: journal commit failure after durable enqueue replays without another message", async (t) => {
  const f = setup(t),
    key = await linked(f);
  f.replies.prepare(f.context, key, accepted);
  f.raw.exec(
    "CREATE TRIGGER fail_reply BEFORE UPDATE ON task_bridge_replies BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  assert.throws(
    () => f.replies.enqueueOnce(f.context, key, accepted),
    code("bridge_store_unavailable"),
  );
  assert.equal(f.rows().length, 1);
  assert.equal(f.journal.getReply(key, accepted).state, "prepared");
  f.raw.exec("DROP TRIGGER fail_reply");
  f.replies.enqueueOnce(f.context, key, accepted);
  assert.equal(f.rows().length, 1);
  assert.equal(f.audit().filter((e) => e === accepted + "_enqueued").length, 1);
});

test("Task replies: accepted outbox receipt can recover handoff after its body is erased", async (t) => {
  const f = setup(t),
    key = await linked(f),
    r = f.replies.prepare(f.context, key, accepted);
  const replies = new TaskReplies(
    f.journal,
    {
      agentId: "b",
      enqueueGuarded(m, guard) {
        f.outbox.enqueueGuarded(m, guard);
        throw Error("lost");
      },
    },
    f.authorize,
  );
  assert.throws(() => replies.enqueueOnce(f.context, key, accepted));
  const sender = new DurableSender(f.outbox, {
    submit: async (m) => f.service.submit(f.contexts.b, m),
    status: async (id) => f.service.status(f.contexts.b, id),
  });
  await sender.sendOnce();
  assert.equal(f.rows()[0].body, null);
  assert.equal(f.rows()[0].state, "accepted");
  const replay = f.replies.enqueueOnce(f.context, key, accepted);
  assert.equal(replay.message.message_id, r.message.message_id);
  assert.equal(f.rows().length, 1);
});

test("Task replies: full outbox preserves prepared ID without Task IO", async (t) => {
  const f = setup(t, {}, { max_records: 1 }),
    key = await linked(f);
  const a = f.replies.prepare(f.context, key, accepted);
  f.replies.enqueueOnce(f.context, key, accepted);
  await finish(f, key);
  const r = f.replies.prepare(f.context, key, result);
  assert.throws(
    () => f.replies.enqueueOnce(f.context, key, result),
    code("bridge_outbox_capacity_exceeded"),
  );
  assert.deepEqual(f.journal.getReply(key, result), r);
  assert.equal(f.rows()[0].message_id, a.message.message_id);
  assert.equal(f.calls.filter((c) => c.op === "submit").length, 1);
});

test("Task replies: finite audit capacity is reserved before writing outbox", async (t) => {
  const f = setup(t, { max_audit_records: 4 }),
    key = await linked(f);
  f.replies.prepare(f.context, key, accepted); // accepted, attempted, linked, prepared
  assert.throws(
    () => f.replies.enqueueOnce(f.context, key, accepted),
    code("bridge_capacity_exceeded"),
  );
  assert.equal(f.rows().length, 0);
  assert.equal(f.journal.getReply(key, accepted).state, "prepared");
});

test("Task replies: authorization revoked at outbox commit rolls back the durable enqueue", async (t) => {
  const f = setup(t),
    key = await linked(f);
  f.replies.prepare(f.context, key, accepted);
  let checks = 0;
  const auth = () =>
    ++checks < 3 ? { receiver_id: "b", actor_id: "operator" } : undefined;
  const replies = new TaskReplies(f.journal, f.outbox, auth);
  assert.throws(
    () => replies.enqueueOnce(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.rows().length, 0);
  assert.equal(f.journal.getReply(key, accepted).state, "prepared");
});

test("Task replies: authority revoked after outbox commit leaves a recoverable prepared handoff", async (t) => {
  const f = setup(t),
    key = await linked(f);
  f.replies.prepare(f.context, key, accepted);
  const replies = new TaskReplies(
    f.journal,
    {
      agentId: "b",
      enqueueGuarded(m, guard) {
        const r = f.outbox.enqueueGuarded(m, guard);
        f.state.enabled = false;
        return r;
      },
    },
    f.authorize,
  );
  assert.throws(
    () => replies.enqueueOnce(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.rows().length, 1);
  assert.equal(f.journal.getReply(key, accepted).state, "prepared");
  assert.throws(
    () => f.replies.enqueueOnce(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  f.state.enabled = true;
  f.replies.enqueueOnce(f.context, key, accepted);
  assert.equal(f.rows().length, 1);
});

test("Task replies: expired preparation never renews ID or lifetime, even if handoff was uncertain", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const original = f.replies.prepare(f.context, key, accepted);
  const view = clock(Date.parse(original.message.expires_at), () =>
    f.replies.enqueueOnce(f.context, key, accepted),
  );
  assert.equal(view.state, "expired");
  assert.deepEqual(view.message, original.message);
  assert.equal(f.replies.prepare(f.context, key, accepted).state, "expired");
  assert.equal(
    f.replies.enqueueOnce(f.context, key, accepted).state,
    "expired",
  );
  assert.equal(f.rows().length, 0);
  await finish(f, key);
  const later = clock(Date.parse(original.message.expires_at) + 1000, () =>
    f.replies.prepare(f.context, key, result),
  );
  assert.notEqual(later.message.message_id, original.message.message_id);
  assert.equal(
    Date.parse(later.message.expires_at) -
      Date.parse(later.message.first_sent_at),
    3600000,
  );
});

test("Task replies: outbox GC cannot cause a completed handoff to enqueue again", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const r = f.replies.prepare(f.context, key, accepted);
  f.replies.enqueueOnce(f.context, key, accepted);
  // Fault injection models a separately restored/removed outbox; no automatic resend.
  f.outboxRaw
    .prepare("DELETE FROM relay_outbox WHERE message_id=?")
    .run(r.message.message_id);
  assert.equal(
    f.replies.enqueueOnce(f.context, key, accepted).state,
    "enqueued",
  );
  assert.equal(f.rows().length, 0);
  assert.equal(f.count(), 1);
});

test("Task replies: source release, terminal observation and restart do not alter the accepted reply", async (t) => {
  const f = setup(t),
    key = await linked(f),
    r = f.replies.prepare(f.context, key, accepted);
  f.inbox.releaseBody(key.sender_id, key.message_id);
  await finish(f, key);
  f.close(f.journal);
  const j = f.open();
  j.migrate();
  const replies = new TaskReplies(j, f.outbox, f.authorize);
  assert.deepEqual(replies.prepare(f.context, key, accepted), r);
  assert.equal(replies.prepare(f.context, key, result).task.state, "succeeded");
});

test("Task replies: tampered reply payload, indexed ID and state fail integrity before outbox", async (t) => {
  for (const field of ["data", "reply_id", "state"]) {
    const f = setup(t),
      key = await linked(f);
    f.replies.prepare(f.context, key, accepted);
    if (field === "reply_id")
      f.raw.exec("DROP TRIGGER task_bridge_reply_identity");
    f.raw
      .prepare("UPDATE task_bridge_replies SET " + field + "=?")
      .run(
        field === "data" ? "{}" : field === "state" ? "enqueued" : "other-id",
      );
    assert.throws(
      () => f.replies.enqueueOnce(f.context, key, accepted),
      code("bridge_integrity_failed"),
    );
    assert.equal(f.rows().length, 0);
  }
});

test("Task replies: explicit schema1 upgrade preserves existing link and stable Task key", async (t) => {
  const f = setup(t),
    key = await linked(f),
    before = f.journal.get(key);
  f.close(f.journal);
  f.raw.exec(
    "DROP TRIGGER task_bridge_reply_identity; DROP TABLE task_bridge_replies; UPDATE task_bridge_meta SET version=1",
  );
  const j = f.open();
  j.migrate();
  assert.deepEqual(j.get(key), before);
  assert.equal(
    f.raw.prepare("SELECT version FROM task_bridge_meta").get().version,
    2,
  );
  new TaskReplies(j, f.outbox, f.authorize).prepare(f.context, key, accepted);
  assert.equal(f.count(), 1);
});

test("Task replies: missing schema2 objects fail closed without auto repair", async (t) => {
  const f = setup(t);
  f.raw.exec("DROP TRIGGER task_bridge_reply_identity");
  const j = f.open();
  assert.throws(() => j.migrate(), code("unsupported_bridge_schema"));
  assert.equal(
    f.raw
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='task_bridge_reply_identity'",
      )
      .get(),
    undefined,
  );
});

test("Task replies: captured outbox port cannot be replaced after composition", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const port = {
    agentId: "b",
    enqueueGuarded: f.outbox.enqueueGuarded.bind(f.outbox),
  };
  const replies = new TaskReplies(f.journal, port, f.authorize);
  port.agentId = "a";
  port.enqueueGuarded = () => {
    throw Error("replaced");
  };
  replies.prepare(f.context, key, accepted);
  replies.enqueueOnce(f.context, key, accepted);
  assert.equal(f.rows().length, 1);
});

test("Task replies: invalid outbox responses cannot claim durable handoff", async (t) => {
  for (const value of [
    undefined,
    { message_id: "other" },
    Promise.resolve({}),
  ]) {
    const f = setup(t),
      key = await linked(f);
    f.replies.prepare(f.context, key, accepted);
    const replies = new TaskReplies(
      f.journal,
      { agentId: "b", enqueueGuarded: () => value },
      f.authorize,
    );
    assert.throws(
      () => replies.enqueueOnce(f.context, key, accepted),
      code("bridge_invalid_outbox_record"),
    );
    assert.equal(f.journal.getReply(key, accepted).state, "prepared");
  }
});

test("Task replies: real Relay accepted/result delivery and ACK do not generate another Task", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const sender = new DurableSender(f.outbox, {
    submit: async (m) => f.service.submit(f.contexts.b, m),
    status: async (id) => f.service.status(f.contexts.b, id),
  });
  for (const kind of [accepted, result]) {
    if (kind === result) await finish(f, key);
    const r = f.replies.prepare(f.context, key, kind);
    f.replies.enqueueOnce(f.context, key, kind);
    await sender.sendOnce();
    const delivery = f.service.poll(f.contexts.a);
    assert.equal(delivery.message.kind, kind);
    assert.deepEqual(delivery.message.in_reply_to, key);
    f.service.ack(f.contexts.a, {
      sender_id: "b",
      message_id: r.message.message_id,
      generation: delivery.generation,
      lease_token: delivery.lease_token,
      request_id: "ack-" + kind,
    });
    assert.equal(
      f.service.status(f.contexts.b, r.message.message_id).state,
      "acked",
    );
  }
  assert.equal(f.rows().length, 2);
  await sender.sendOnce();
  assert.equal(f.outbox.claim(), null);
  assert.equal(f.calls.filter((c) => c.op === "submit").length, 1);
  assert.equal(f.count(), 1);
});

test("Task replies: native competing writers converge on one prepared reply and one outbox row", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const journalUrl = new URL(
    "../src/task-bridge/sqlite-journal.ts",
    import.meta.url,
  ).href;
  const outboxUrl = new URL("../src/relay/sqlite-outbox.ts", import.meta.url)
    .href;
  const repliesUrl = new URL("../src/task-bridge/replies.ts", import.meta.url)
    .href;
  const source = `
    const { parentPort, workerData: d } = require("node:worker_threads");
    (async () => {
      const { SQLiteTaskBridgeJournal } = await import(d.journalUrl);
      const { SQLiteOutbox } = await import(d.outboxUrl);
      const { TaskReplies } = await import(d.repliesUrl);
      const j = new SQLiteTaskBridgeJournal(d.path, d.options);
      const o = new SQLiteOutbox(d.outboxPath, d.outboxOptions);
      try {
        j.migrate(); o.migrate();
        const r = new TaskReplies(j, o, () => ({ receiver_id: "b", actor_id: "operator" }));
        const reply = r.prepare(null, d.key, "execution_accepted");
        r.enqueueOnce(null, d.key, "execution_accepted");
        parentPort.postMessage(reply.message.message_id);
      } finally { o.close(); j.close(); }
    })().catch(e => { throw e; });
  `;
  const ids = await Promise.all(
    [1, 2].map(
      () =>
        new Promise((resolve, reject) => {
          const w = new Worker(source, {
            eval: true,
            workerData: {
              path: f.path,
              options: f.options,
              outboxPath: f.outboxPath,
              outboxOptions: f.outboxOptions,
              key,
              journalUrl,
              outboxUrl,
              repliesUrl,
            },
          });
          let id;
          w.once("message", (value) => {
            id = value;
          });
          w.once("error", reject);
          w.once("exit", (status) =>
            status === 0 && id ? resolve(id) : reject(Error("worker exit")),
          );
        }),
    ),
  );
  assert.equal(ids[0], ids[1]);
  assert.equal(f.rows().length, 1);
  assert.equal(f.replyRows().length, 1);
  assert.equal(f.calls.length, 1);
});

test("Outbox guarded enqueue: failed or async commit guard rolls back fresh and exact enqueue", async (t) => {
  const f = setup(t),
    key = await linked(f),
    r = f.replies.prepare(f.context, key, accepted);
  assert.throws(() =>
    f.outbox.enqueueGuarded(r.message, () => {
      throw Error("revoked");
    }),
  );
  assert.equal(f.rows().length, 0);
  assert.throws(
    () => f.outbox.enqueueGuarded(r.message, async () => {}),
    code("invalid_outbox_admission"),
  );
  assert.equal(f.rows().length, 0);
  f.outbox.enqueue(r.message);
  assert.throws(() =>
    f.outbox.enqueueGuarded(r.message, () => {
      throw Error("revoked");
    }),
  );
  assert.equal(f.rows().length, 1);
});

test("Task replies: expired uncertain handoff preserves the existing outbox row without renewing a message", async (t) => {
  const f = setup(t),
    key = await linked(f),
    r = f.replies.prepare(f.context, key, accepted);
  const replies = new TaskReplies(
    f.journal,
    {
      agentId: "b",
      enqueueGuarded(m, guard) {
        f.outbox.enqueueGuarded(m, guard);
        throw Error("lost");
      },
    },
    f.authorize,
  );
  assert.throws(() => replies.enqueueOnce(f.context, key, accepted));
  const expired = clock(Date.parse(r.message.expires_at) + 1, () =>
    f.replies.enqueueOnce(f.context, key, accepted),
  );
  assert.equal(expired.state, "expired");
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].message_id, r.message.message_id);
  assert.equal(
    f.replies.prepare(f.context, key, accepted).message.message_id,
    r.message.message_id,
  );
  assert.equal(f.count(), 1);
});

test("Task replies: lost Relay acceptance response retries through sender with the same message", async (t) => {
  const f = setup(t),
    key = await linked(f),
    r = f.replies.prepare(f.context, key, accepted);
  f.replies.enqueueOnce(f.context, key, accepted);
  const ids = [];
  const sender = new DurableSender(f.outbox, {
    submit: async (m) => {
      ids.push(m.message_id);
      const receipt = f.service.submit(f.contexts.b, m);
      if (ids.length === 1) throw Error("lost after server commit");
      return receipt;
    },
    status: async (id) => f.service.status(f.contexts.b, id),
  });
  await assert.rejects(sender.sendOnce(), code("sender_transport_failed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sender.sendOnce();
  assert.deepEqual(ids, [r.message.message_id, r.message.message_id]);
  assert.equal(f.outbox.get(r.message.message_id).state, "accepted");
  assert.equal(
    f.service.poll(f.contexts.a).message.message_id,
    r.message.message_id,
  );
  assert.equal(f.service.poll(f.contexts.a), null);
  assert.equal(f.count(), 1);
  assert.equal(f.calls.length, 1);
});

test("Task replies: authority changed during preparation leaves no saved reply or audit", async (t) => {
  const f = setup(t),
    key = await linked(f),
    before = f.audit();
  let n = 0;
  const replies = new TaskReplies(f.journal, f.outbox, () => ({
    receiver_id: "b",
    actor_id: ++n === 1 ? "operator-1" : "operator-2",
  }));
  assert.throws(
    () => replies.prepare(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.replyRows().length, 0);
  assert.deepEqual(f.audit(), before);
});

test("Task replies: decorated promises cannot impersonate synchronous authorization", async (t) => {
  const f = setup(t),
    key = await linked(f);
  const promise = Object.assign(Promise.resolve(), {
    receiver_id: "b",
    actor_id: "operator",
  });
  const replies = new TaskReplies(f.journal, f.outbox, () => promise);
  assert.throws(
    () => replies.prepare(f.context, key, accepted),
    code("bridge_forbidden"),
  );
  assert.equal(f.replyRows().length, 0);
});

test("Task replies: an outbox port cannot mutate the saved reply through its input reference", async (t) => {
  const f = setup(t),
    key = await linked(f),
    prepared = f.replies.prepare(f.context, key, accepted);
  const replies = new TaskReplies(
    f.journal,
    {
      agentId: "b",
      enqueueGuarded(m, guard) {
        const record = f.outbox.enqueueGuarded(m, guard);
        m.body.parts[0].value.task_type = "mutated-by-port";
        return record;
      },
    },
    f.authorize,
  );
  const enqueued = replies.enqueueOnce(f.context, key, accepted);
  assert.deepEqual(enqueued.message, prepared.message);
  assert.deepEqual(f.journal.getReply(key, accepted).message, prepared.message);
});
