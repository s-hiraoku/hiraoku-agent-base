import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { ReplyBudgetError } from "../src/adapter-policy/contract.ts";
import { hostFixture, limits } from "./adapter-host-fixtures.js";
import { code } from "./task-bridge-fixtures.js";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { AnswerIntents } from "../src/answer-intents/answers.ts";
import { DELIVERY_TTL_MS, RECORD_RETENTION_MS } from "../src/relay/contract.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
const body = () => ({
  parts: [{ type: "text", text: "synthetic durable answer" }],
});
const yes = () => {};
function fixture(t, patch = {}, timing = {}) {
  const f = hostFixture(t, {}, timing),
    path = join(f.dir, "answer-intents.sqlite"),
    stores = new Set();
  const options = {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(65),
    limits,
    max_records: 20,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    ...patch,
  };
  const open = (extra = {}, file = path) => {
    const s = new SQLiteAnswerJournal(file, { ...options, ...extra });
    stores.add(s);
    return s;
  };
  const journal = open();
  journal.migrate();
  const raw = new DatabaseSync(path);
  const host = f.makeHost({ answer_intents: journal });
  const authorize = (ctx, op) => f.authorize(ctx, "answer_" + op);
  const make = (
    j = journal,
    outbox = f.outbox,
    auth = authorize,
    inbox = f.inbox,
    budget = f.budget,
  ) => new AnswerIntents(j, inbox, outbox, budget, limits, auth);
  const answers = make();
  const receive = (kind = "question", confirmed = true) => {
    const source = f.submit(kind),
      delivery = f.service.poll(f.contexts.b);
    f.inbox.save(delivery);
    if (confirmed) {
      const req = f.inbox.claimAck();
      f.inbox.confirmAck(req, f.service.ack(f.contexts.b, req));
    }
    return source;
  };
  const rows = () => raw.prepare("SELECT * FROM answer_intents").all();
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  return {
    ...f,
    host,
    journal,
    raw,
    options,
    open,
    answers,
    make,
    receive,
    rows,
    path,
    closeJournal: (s) => {
      s.close();
      stores.delete(s);
    },
    step: (c) => host.stepOnce(f.context, c),
    prepare: (key) => answers.prepare(f.context, key, body()),
    enqueue: (key) => answers.enqueueOnce(f.context, key),
    inspect: (key) => answers.inspect(f.context, key),
    pending: (n = 20, after = null) => answers.pending(f.context, n, after),
    maintain: (n = 20) => answers.maintain(f.context, n),
  };
}
function at(now, action) {
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (sql === "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) at")
      return { get: () => ({ at: now }) };
    return original.call(this, sql, ...rest);
  };
  try {
    return action();
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
}
test("Answer intents: durable preparation precedes all budget, outbox, Task and network work", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  const v = f.prepare(key);
  assert.equal(v.state, "prepared");
  assert.equal(f.queued().length, 0);
  assert.equal(f.budget.lookup(key, "answer"), null);
  assert.equal(f.count(), 0);
  assert.equal(f.state.tools.length, 0);
  assert.match(v.reply_id, /^rm1\./);
  assert.equal(
    Date.parse(v.expires_at) - Date.parse(v.first_sent_at),
    DELIVERY_TTL_MS,
  );
  assert.ok(f.rows()[0].message.includes("synthetic durable answer"));
  assert.equal(JSON.stringify(v).includes("synthetic"), false);
  assert.equal(JSON.stringify(v).includes("fingerprint"), false);
});
test("Answer intents: exact repeat keeps ID and saved copy; changed text conflicts before handoff", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    input = body();
  const first = f.answers.prepare(f.context, key, input);
  input.parts[0].text = "mutated caller data";
  assert.deepEqual(f.prepare(key), first);
  assert.throws(
    () => f.answers.prepare(f.context, key, input),
    code("answer_intent_conflict"),
  );
  assert.equal(f.rows().length, 1);
  assert.equal(
    JSON.parse(f.rows()[0].message).body.parts[0].text,
    body().parts[0].text,
  );
});
test("Answer intents: canonical data key order replays but part order and values are exact", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  const parts = [
    {
      type: "data",
      schema_id: "synthetic",
      schema_version: 1,
      value: { b: 2, a: 1 },
    },
    { type: "text", text: "x" },
  ];
  const a = f.answers.prepare(f.context, key, { parts });
  assert.deepEqual(
    f.answers.prepare(f.context, key, {
      parts: [{ ...parts[0], value: { a: 1, b: 2 } }, parts[1]],
    }),
    a,
  );
  assert.throws(
    () => f.answers.prepare(f.context, key, { parts: [parts[1], parts[0]] }),
    code("answer_intent_conflict"),
  );
});
test("Answer intents: restart discovers redacted pending intents and resumes after inbox body release", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    first = f.prepare(key);
  f.inbox.releaseBody(key.sender_id, key.message_id);
  f.closeJournal(f.journal);
  const reopened = f.open();
  reopened.migrate();
  const answers = f.make(reopened);
  const page = answers.pending(f.context, 1);
  assert.deepEqual(page, { items: [first], next_after: null });
  assert.equal(answers.enqueueOnce(f.context, key).state, "enqueued");
  assert.equal(f.queued().length, 1);
  assert.equal(f.rows()[0].message, null);
  assert.equal(
    answers.prepare(f.context, key, body()).reply_id,
    first.reply_id,
  );
  assert.equal(answers.inspect(f.context, key).outbox_state, "queued");
});
test("Answer intents: lost outbox response reuses the same envelope and budget reservation", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    first = f.prepare(key),
    seen = [];
  const broken = f.make(f.journal, {
    agentId: "b",
    get: f.outbox.get.bind(f.outbox),
    enqueueGuarded: (m, g) => {
      seen.push(structuredClone(m));
      f.outbox.enqueueGuarded(m, g);
      throw Error("private diagnostic");
    },
  });
  assert.throws(
    () => broken.enqueueOnce(f.context, key),
    code("answer_intent_unavailable"),
  );
  assert.equal(f.rows()[0].state, "prepared");
  assert.equal(f.queued().length, 1);
  const reservation = f.budget.lookup(key, "answer");
  assert.equal(f.enqueue(key).state, "enqueued");
  assert.deepEqual(f.budget.lookup(key, "answer"), reservation);
  assert.equal(f.queued()[0].message_id, first.reply_id);
  assert.deepEqual(JSON.parse(f.queued()[0].body), seen[0]);
});
test("Answer intents: journal confirmation failure after outbox commit is restart-reconcilable", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    first = f.prepare(key);
  f.raw.exec(
    "CREATE TRIGGER synthetic BEFORE UPDATE ON answer_intents BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  assert.throws(() => f.enqueue(key), code("answer_intent_unavailable"));
  assert.equal(f.queued().length, 1);
  assert.equal(f.rows()[0].state, "prepared");
  f.raw.exec("DROP TRIGGER synthetic");
  f.closeJournal(f.journal);
  const s = f.open();
  s.migrate();
  assert.equal(f.make(s).enqueueOnce(f.context, key).reply_id, first.reply_id);
  assert.equal(f.rows()[0].message, null);
});
test("Answer intents: confirmed handoff never recreates an independently missing outbox", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.prepare(key);
  f.enqueue(key);
  f.outboxRaw.prepare("DELETE FROM relay_outbox").run();
  assert.equal(f.inspect(key).outbox_state, "missing");
  assert.equal(f.enqueue(key).state, "enqueued");
  assert.equal(f.queued().length, 0);
  assert.equal(f.rows()[0].message, null);
});
test("Answer intents: expiry erases producer body without renewing ID, time or budget", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    first = f.prepare(key),
    expiry = Date.parse(first.expires_at);
  const v = at(expiry, () => f.enqueue(key));
  assert.equal(v.state, "expired");
  assert.equal(v.reply_id, first.reply_id);
  assert.equal(f.rows()[0].message, null);
  assert.equal(f.queued().length, 0);
  assert.equal(f.budget.lookup(key, "answer"), null);
  at(expiry, () => assert.equal(f.prepare(key).expires_at, first.expires_at));
  assert.throws(
    () =>
      at(expiry, () =>
        f.answers.prepare(f.context, key, {
          parts: [{ type: "text", text: "new" }],
        }),
      ),
    code("answer_intent_conflict"),
  );
});
test("Answer intents: bounded maintenance expires bodies then retains metadata for 30 days", (t) => {
  const f = fixture(t),
    a = f.receive(),
    b = f.receive(),
    aa = f.prepare(a.key),
    bb = f.prepare(b.key);
  const now = Math.max(Date.parse(aa.expires_at), Date.parse(bb.expires_at));
  assert.equal(at(now, () => f.maintain(1)).expired, 1);
  assert.equal(f.rows().filter((r) => r.message !== null).length, 1);
  assert.equal(at(now, () => f.maintain(1)).expired, 1);
  assert.equal(at(now + RECORD_RETENTION_MS - 1, () => f.maintain()).purged, 0);
  assert.equal(at(now + RECORD_RETENTION_MS, () => f.maintain(1)).purged, 1);
  assert.equal(at(now + RECORD_RETENTION_MS, () => f.maintain(1)).purged, 1);
});
test("Answer intents: GC cannot mint a new ID from an old replay-bound source and clock rollback fails", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    first = f.prepare(key),
    expiry = Date.parse(first.expires_at);
  at(expiry, () => f.maintain());
  const horizon = expiry + RECORD_RETENTION_MS;
  at(horizon, () => assert.equal(f.maintain().purged, 1));
  assert.throws(
    () => at(horizon, () => f.prepare(key)),
    code("answer_intent_source_horizon_closed"),
  );
  assert.throws(
    () => at(horizon - 1, () => f.prepare(key)),
    code("answer_intent_clock_regressed"),
  );
});
test("Answer intents: source delivery deadline is not a one-hour answer decision deadline", (t) => {
  const f = fixture(t),
    { key, message } = f.receive();
  const first = at(Date.parse(message.expires_at) + 1000, () => f.prepare(key));
  assert.equal(first.state, "prepared");
  assert.equal(
    Date.parse(first.first_sent_at),
    Date.parse(message.expires_at) + 1000,
  );
});
test("Answer intents: old opaque source tombstones are safety-held instead of unsafe GC", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  // Independent trusted journal proof exercises legacy source IDs; no wire identity is inferred.
  const legacy = { sender_id: "a", message_id: "legacy-source" },
    now = Date.now();
  const proof = {
    source: {
      ...legacy,
      recipient_id: "b",
      kind: "question",
      thread_id: "legacy-thread",
    },
    expires_at: new Date(now + DELIVERY_TTL_MS).toISOString(),
    fingerprint_material: "synthetic legacy source",
  };
  const v = f.journal.prepare(legacy, body(), "operator", proof, yes);
  assert.ok(key.message_id.startsWith("rm1."));
  const expiry = Date.parse(v.expires_at);
  at(expiry, () => f.journal.maintain(20, yes));
  const result = at(
    Math.max(expiry, Date.parse(proof.expires_at)) + RECORD_RETENTION_MS,
    () => f.journal.maintain(20, yes),
  );
  assert.equal(result.purged, 0);
  assert.equal(result.safety_held, 1);
  assert.equal(f.rows().length, 1);
});
test("Answer intents: redacted startup pagination is bounded and requires current authority", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.prepare(f.receive().key);
  const a = f.pending(1),
    b = f.pending(1, a.next_after),
    c = f.pending(1, b.next_after);
  assert.equal(
    new Set([...a.items, ...b.items, ...c.items].map((r) => r.reply_id)).size,
    3,
  );
  assert.equal(c.next_after, null);
  assert.equal(JSON.stringify(a).includes("synthetic"), false);
  for (const n of [0, -1, 1001, 1.5])
    assert.throws(() => f.pending(n), code("invalid_answer_intent_page"));
  assert.throws(
    () => f.pending(1, "bad cursor"),
    code("invalid_answer_intent_page"),
  );
  f.state.denied.add("answer_pending");
  assert.throws(() => f.pending(), code("answer_intent_forbidden"));
});
test("Answer intents: default-deny and wrong-agent composition reject all producer work", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  const boundary = new AnswerIntents(
    f.journal,
    f.inbox,
    f.outbox,
    f.budget,
    limits,
  );
  assert.throws(
    () => boundary.prepare(f.context, key, body()),
    code("answer_intent_forbidden"),
  );
  assert.throws(
    () => boundary.pending(f.context, 1),
    code("answer_intent_forbidden"),
  );
  assert.throws(
    () => f.make(f.journal, { ...f.outbox, agentId: "c" }),
    code("invalid_answer_intent_composition"),
  );
  assert.equal(f.rows().length, 0);
});
for (const kind of ["notice", "answer", "execution_request"]) {
  test(
    "Answer intents: " + kind + " does not trigger an answer or Task",
    (t) => {
      const f = fixture(t),
        { key } = f.receive(kind);
      assert.throws(() => f.prepare(key), code("invalid_reply_source"));
      assert.equal(f.rows().length, 0);
      assert.equal(f.count(), 0);
    },
  );
}
test("Answer intents: unconfirmed, mismatched or forged inbox sources are rejected", (t) => {
  const f = fixture(t),
    { key } = f.receive("question", false);
  assert.throws(() => f.prepare(key), code("invalid_reply_source"));
  const entry = f.inbox.inbox()[0];
  for (const patch of [
    { sender_id: "c" },
    { message: { ...entry.message, recipient_id: "c" } },
    { message: { ...entry.message, message_id: "wrong" } },
  ]) {
    const a = f.make(f.journal, f.outbox, undefined, {
      withEntry: (_s, _m, action) =>
        action({ ...entry, receipt_confirmed: true, ...patch }),
    });
    assert.throws(
      () => a.prepare(f.context, key, body()),
      code("invalid_reply_source"),
    );
  }
  assert.equal(f.rows().length, 0);
});
test("Answer intents: mid-step authority revocation cannot commit an intent", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  let calls = 0;
  const a = f.make(f.journal, f.outbox, () =>
    ++calls < 4 ? { agent_id: "b", actor_id: "operator" } : undefined,
  );
  assert.throws(
    () => a.prepare(f.context, key, body()),
    code("answer_intent_forbidden"),
  );
  assert.equal(f.rows().length, 0);
});
test("Answer intents: actor changes and asynchronous authority fail closed", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  let n = 0;
  const a = f.make(f.journal, f.outbox, () => ({
    agent_id: "b",
    actor_id: "actor-" + ++n,
  }));
  assert.throws(
    () => a.prepare(f.context, key, body()),
    code("answer_intent_forbidden"),
  );
  const b = f.make(f.journal, f.outbox, async () => ({
    agent_id: "b",
    actor_id: "actor",
  }));
  assert.throws(
    () => b.prepare(f.context, key, body()),
    code("answer_intent_forbidden"),
  );
  assert.equal(f.rows().length, 0);
});
test("Answer intents: record and byte caps preserve existing exact retries", (t) => {
  const f = fixture(t, { max_records: 1 }),
    a = f.receive(),
    b = f.receive(),
    first = f.prepare(a.key);
  assert.throws(
    () => f.prepare(b.key),
    code("answer_intent_capacity_exceeded"),
  );
  assert.deepEqual(f.prepare(a.key), first);
  assert.equal(f.rows().length, 1);
});
test("Answer intents: body byte cap rejects the whole intent transaction", (t) => {
  const f = fixture(t, { max_body_bytes: 1 }),
    { key } = f.receive();
  assert.throws(() => f.prepare(key), code("answer_intent_capacity_exceeded"));
  assert.equal(f.rows().length, 0);
});
test("Answer intents: exhausted shared budget preserves prepared ID and payload for reconciliation", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  const first = f.prepare(key);
  const budget = {
    agentId: "b",
    withReply: () => {
      throw new ReplyBudgetError("reply_rate_exhausted");
    },
  };
  assert.throws(
    () =>
      f
        .make(f.journal, f.outbox, undefined, f.inbox, budget)
        .enqueueOnce(f.context, key),
    code("reply_rate_exhausted"),
  );
  assert.equal(f.pending().items[0].reply_id, first.reply_id);
  assert.equal(f.rows()[0].state, "prepared");
  assert.equal(f.queued().length, 0);
});
test("Answer intents: host legacy answer path is fenced when producer journal is configured", async (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.resume(f.host);
  assert.equal(
    (await f.step({ op: "answer", source: key, message: f.answer(key) }))
      .reason,
    "host_answer_intents_required",
  );
  assert.equal(
    (await f.step({ op: "answer_prepare", source: key, body: body() })).state,
    "done",
  );
  const h = f.makeHost();
  assert.equal(
    (await h.stepOnce(f.context, { op: "answer_enqueue", source: key })).reason,
    "host_answer_intents_unconfigured",
  );
  assert.equal(f.queued().length, 0);
});
test("Answer intents: host pause, command permission and binding gate local producer actions", async (t) => {
  const f = fixture(t),
    { key } = f.receive();
  await assert.rejects(
    f.step({ op: "answer_prepare", source: key, body: body() }),
    code("host_paused"),
  );
  f.resume(f.host);
  f.state.denied.add("answer_prepare");
  await assert.rejects(
    f.step({ op: "answer_prepare", source: key, body: body() }),
    code("host_forbidden"),
  );
  assert.throws(
    () => f.makeHost({ answer_intents: { agentId: "c" } }),
    code("invalid_host_composition"),
  );
  assert.equal(f.rows().length, 0);
});
test("Answer intents: host startup inventory, inspect and explicit handoff keep state meanings separate", async (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.resume(f.host);
  const prepared = await f.step({
    op: "answer_prepare",
    source: key,
    body: body(),
  });
  assert.equal(prepared.state, "done");
  assert.equal(prepared.value.state, "prepared");
  const restarted = f.makeHost({ answer_intents: f.journal });
  const pending = await restarted.stepOnce(f.context, {
    op: "answer_pending",
    limit: 1,
  });
  assert.equal(pending.value.items[0].reply_id, prepared.value.reply_id);
  assert.equal(
    (await f.step({ op: "answer_inspect", source: key })).value.outbox_state,
    "missing",
  );
  assert.equal(
    (await f.step({ op: "answer_enqueue", source: key })).value.state,
    "enqueued",
  );
  assert.equal(
    (await f.step({ op: "answer_inspect", source: key })).value.outbox_state,
    "queued",
  );
  assert.deepEqual((await f.step({ op: "answer_maintain", limit: 1 })).value, {
    expired: 0,
    purged: 0,
    safety_held: 0,
  });
});
for (const sql of [
  "UPDATE answer_intents SET message='{}'",
  "UPDATE answer_intents SET state='enqueued'",
  "UPDATE answer_intents SET reply_id='changed'",
  "UPDATE answer_intents SET data=json_set(data,'$.source.thread_id','changed')",
  "DELETE FROM answer_intents",
  "UPDATE answer_intent_meta SET last_at=0",
  "UPDATE answer_intent_meta SET body_bytes=0",
])
  test("Answer intents: integrity rejects " + sql, (t) => {
    const f = fixture(t);
    f.prepare(f.receive().key);
    f.raw.exec(sql);
    assert.throws(() => f.pending(), code("answer_intent_integrity_failed"));
  });
test("Answer intents: private mode, symlinks, options and database binding are checked", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.prepare(key);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(1) },
    { max_records: 21 },
  ]) {
    const s = f.open(patch);
    assert.throws(() => s.migrate(), code("answer_intent_binding_mismatch"));
  }
  for (const patch of [
    { max_records: 0 },
    { max_records: 10001 },
    { max_body_bytes: 0 },
    { max_body_bytes: 67108865 },
    { max_clock_skew_ms: -1 },
    { fingerprint_key: new Uint8Array(31) },
  ])
    assert.throws(() => f.open(patch), code("invalid_answer_intent_options"));
  const link = join(f.dir, "intent-link");
  symlinkSync(f.path, link);
  assert.throws(() => f.open({}, link), code("answer_intent_unavailable"));
  chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), code("answer_intent_unavailable"));
  chmodSync(f.path, 0o600);
});
test("Answer intents: unknown schema and explicit migration gate fail closed", (t) => {
  const f = fixture(t),
    p = join(f.dir, "unknown.sqlite"),
    raw = new DatabaseSync(p);
  raw.exec("CREATE TABLE unrelated(id INTEGER)");
  raw.close();
  chmodSync(p, 0o600);
  const a = f.open({}, p);
  assert.throws(() => a.migrate(), code("unknown_answer_intent_schema"));
  const b = f.open({}, join(f.dir, "unmigrated.sqlite"));
  assert.throws(
    () => b.pending(1, null, yes),
    code("answer_intent_not_migrated"),
  );
  f.raw.exec("UPDATE answer_intent_meta SET version=99");
  assert.throws(
    () => f.journal.migrate(),
    code("unsupported_answer_intent_schema"),
  );
});
test("Answer intents: rollback failure latches instance until explicit migration", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.raw.exec(
    "CREATE TRIGGER synthetic BEFORE INSERT ON answer_intents BEGIN SELECT RAISE(ROLLBACK,'synthetic'); END",
  );
  assert.throws(() => f.prepare(key), code("answer_intent_unavailable"));
  assert.throws(() => f.pending(), code("answer_intent_not_migrated"));
  f.raw.exec("DROP TRIGGER synthetic");
  f.journal.migrate();
  assert.equal(f.prepare(key).state, "prepared");
});
test("Answer intents: two SQLite connections converge on one ID and one outbox message", (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    other = f.open();
  other.migrate();
  const b = f.make(other);
  const first = f.prepare(key);
  assert.deepEqual(b.prepare(f.context, key, body()), first);
  b.enqueueOnce(f.context, key);
  f.enqueue(key);
  assert.equal(f.rows().length, 1);
  assert.equal(f.queued().length, 1);
});
test("Answer intents: real loopback HTTP MCP receive-restart-answer-send-ACK uses the saved ID", async (t) => {
  // This success-path test includes real HTTP; retain the short defaults for fault/expiry tests.
  const f = fixture(t, {}, { outboxLeaseMs: 5000 });
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/mcp";
  server.on(
    "request",
    createRelayNodeHandler(f.gateway({ resource_url: url })),
  );
  try {
    f.state.resource_url = url;
    const host = f.makeHost({
      answer_intents: f.journal,
      network: globalThis.fetch,
    });
    f.resume(host);
    const { key } = f.submit();
    const run = (c) => host.stepOnce(f.context, c);
    assert.equal((await run({ op: "receive" })).state, "done");
    const prepared = (
      await run({ op: "answer_prepare", source: key, body: body() })
    ).value;
    f.inbox.releaseBody(key.sender_id, key.message_id);
    f.closeJournal(f.journal);
    const s = f.open();
    s.migrate();
    const restarted = f.makeHost({
      answer_intents: s,
      network: globalThis.fetch,
    });
    const step = (c) => restarted.stepOnce(f.context, c);
    assert.equal(
      (await step({ op: "answer_pending", limit: 1 })).value.items[0].reply_id,
      prepared.reply_id,
    );
    assert.equal(
      (await step({ op: "answer_enqueue", source: key })).value.state,
      "enqueued",
    );
    assert.equal((await step({ op: "send" })).state, "done");
    const delivery = f.service.poll(f.contexts.a);
    assert.equal(delivery.message.message_id, prepared.reply_id);
    assert.deepEqual(delivery.message.body, body());
    f.service.ack(f.contexts.a, {
      sender_id: "b",
      message_id: prepared.reply_id,
      generation: delivery.generation,
      lease_token: delivery.lease_token,
      request_id: "answer-intent-ack",
    });
    assert.equal(
      f.service.status(f.contexts.b, prepared.reply_id).state,
      "acked",
    );
    assert.equal(
      (await step({ op: "answer_inspect", source: key })).value.state,
      "enqueued",
    );
    assert.equal(f.count(), 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("Answer intents: native simultaneous producers commit one stable ID", async (t) => {
  const f = fixture(t),
    { key, message } = f.receive();
  const proof = {
    source: {
      ...key,
      recipient_id: "b",
      kind: "question",
      thread_id: message.thread_id,
    },
    expires_at: message.expires_at,
    fingerprint_material: "synthetic confirmed source",
  };
  const moduleUrl = new URL(
    "../src/answer-intents/sqlite-journal.ts",
    import.meta.url,
  ).href;
  const start = new SharedArrayBuffer(4),
    barrier = new Int32Array(start);
  const source = `
    const {parentPort,workerData}=require("node:worker_threads");
    (async()=>{
      const {SQLiteAnswerJournal}=await import(workerData.moduleUrl);
      const s=new SQLiteAnswerJournal(workerData.path,workerData.options); s.migrate();
      const barrier=new Int32Array(workerData.start);
      Atomics.add(barrier,0,1);
      while(Atomics.load(barrier,0)<2) Atomics.wait(barrier,0,1,10);
      try { parentPort.postMessage(s.prepare(workerData.key,workerData.body,"operator",workerData.proof,()=>{})); }
      finally {s.close();}
    })().catch(e=>{throw e});
  `;
  const outcomes = await Promise.all(
    [0, 1].map(
      () =>
        new Promise((resolve, reject) => {
          const w = new Worker(source, {
            eval: true,
            workerData: {
              moduleUrl,
              path: f.path,
              options: f.options,
              key,
              proof,
              body: body(),
              start,
            },
          });
          let result;
          w.once("message", (v) => {
            result = v;
          });
          w.once("error", reject);
          w.once("exit", (n) =>
            n === 0 && result ? resolve(result) : reject(Error("worker exit")),
          );
        }),
    ),
  );
  assert.equal(Atomics.load(barrier, 0), 2);
  assert.equal(outcomes[0].reply_id, outcomes[1].reply_id);
  assert.equal(f.rows().length, 1);
});

test("Answer intents: host revocation after outbox commit leaves a recoverable prepared intent", async (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.resume(f.host);
  const first = f.prepare(key);
  const original = f.outbox.enqueueGuarded.bind(f.outbox);
  f.outbox.enqueueGuarded = (m, g) => {
    const record = original(m, g);
    f.state.enabled = false;
    return record;
  };
  const failed = await f.step({ op: "answer_enqueue", source: key });
  assert.equal(failed.reason, "host_forbidden");
  assert.equal(f.rows()[0].state, "prepared");
  assert.equal(f.queued().length, 1);
  f.state.enabled = true;
  f.outbox.enqueueGuarded = original;
  assert.equal(
    (await f.step({ op: "answer_enqueue", source: key })).value.reply_id,
    first.reply_id,
  );
  assert.equal(f.queued().length, 1);
});

test("Answer intents: asynchronous budget cannot falsely confirm handoff or enqueue after return", async (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.prepare(key);
  let delayed, failure;
  const budget = {
    agentId: "b",
    withReply: (_s, _m, _g, action) => {
      delayed = Promise.resolve()
        .then(() => action())
        .catch((e) => {
          failure = e.code;
        });
      return delayed;
    },
  };
  assert.throws(
    () =>
      f
        .make(f.journal, f.outbox, undefined, f.inbox, budget)
        .enqueueOnce(f.context, key),
    code("invalid_reply_action"),
  );
  await delayed;
  assert.equal(failure, "answer_intent_forbidden");
  assert.equal(f.rows()[0].state, "prepared");
  assert.equal(f.queued().length, 0);
});
test("Answer intents: asynchronous outbox result never confirms producer handoff", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  f.prepare(key);
  const outbox = {
    agentId: "b",
    get: f.outbox.get.bind(f.outbox),
    enqueueGuarded: () => Promise.resolve({ state: "queued" }),
  };
  assert.throws(
    () => f.make(f.journal, outbox).enqueueOnce(f.context, key),
    code("invalid_reply_outbox_record"),
  );
  assert.equal(f.rows()[0].state, "prepared");
  assert.equal(f.queued().length, 0);
});

test("Answer intents: asynchronous inbox callback cannot persist a producer intent after return", async (t) => {
  const f = fixture(t),
    { key } = f.receive(),
    entry = f.inbox.inbox()[0];
  let pending, failure;
  const inbox = {
    withEntry: (_s, _m, action) => {
      pending = Promise.resolve()
        .then(() => action(entry))
        .catch((e) => {
          failure = e.code;
        });
      return pending;
    },
  };
  assert.throws(
    () =>
      f
        .make(f.journal, f.outbox, undefined, inbox)
        .prepare(f.context, key, body()),
    code("invalid_answer_intent_action"),
  );
  await pending;
  assert.equal(failure, "answer_intent_forbidden");
  assert.equal(f.rows().length, 0);
});

test("Answer intents: budget that skips the handoff action cannot discard the saved reply", (t) => {
  const f = fixture(t),
    { key } = f.receive();
  const first = f.prepare(key);
  const budget = { agentId: "b", withReply: () => undefined };
  assert.throws(
    () =>
      f
        .make(f.journal, f.outbox, undefined, f.inbox, budget)
        .enqueueOnce(f.context, key),
    code("invalid_reply_action"),
  );
  assert.equal(f.rows()[0].state, "prepared");
  assert.ok(f.rows()[0].message);
  assert.equal(f.queued().length, 0);
  assert.equal(f.enqueue(key).reply_id, first.reply_id);
});
