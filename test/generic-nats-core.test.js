import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hub } from "../src/sqlite.ts";
import { TextNatsJournal } from "../src/generic-nats/journal.ts";
import { createTextTaskGate } from "../src/generic-nats/task-gate.ts";
import {
  TEXT_NATS_CONTRACT,
  defineRoute,
  executePacket,
  inspectPacket,
  evidencePacket,
  packetMessage,
  packetFrom,
  safeRun,
  assertWitness,
  sameWitness,
} from "../src/generic-nats/protocol.ts";
import { identities } from "./generic-async/fixtures.js";

const acceptedAt = 1_000;
const hour = 3_600_000;
const retentionMs = 7_200_000;
function routeFor(identity = identities()) {
  return defineRoute({
    id: "paper-route",
    coordinator: "coordinator",
    recipient: "paper-peer",
    ownerSubject: identity.sender.subject,
    ownerClient: identity.sender.clientId,
    workerSubject: identity.worker.subject,
    workerClient: identity.worker.clientId,
    binding: identity.worker.textBinding,
    boundaryId: identity.worker.runnerScope,
    runtimeBoundaryId: "private-runtime",
    retentionMs,
  });
}
function inputFor(task, route) {
  const stored = task.text_request;
  return {
    idempotencyKey: `hub-${task.id}`,
    content: {
      origin: "external_agent",
      text: stored.input.text,
      messageId: stored.input.messageId,
      contextId: stored.input.contextId,
      senderAgent: stored.binding.senderAgent,
      recipientAgent: stored.binding.recipientAgent,
    },
    tools: [],
    replay: {
      deadline: Math.min(
        stored.acceptedAt + route.retentionMs,
        stored.input.workDeadline,
      ),
      retentionMs: route.retentionMs,
      contract: TEXT_NATS_CONTRACT,
    },
  };
}
async function taskFixture(
  t,
  { workDeadline = acceptedAt + hour + 10_000 } = {},
) {
  let clock = acceptedAt;
  const hub = new Hub(":memory:", () => clock, 2 * hour);
  t.after(() => hub.close());
  const identity = identities();
  const route = routeFor(identity);
  await hub.submitText(identity.sender, {
    messageId: "message-core",
    contextId: "context-core",
    text: "external text",
    workDeadline,
  });
  const task = await hub.claim(
    identity.worker,
    {},
    { textRetentionMs: retentionMs },
  );
  assert.ok(task);
  const packet = executePacket(
    route,
    inputFor(task, route),
    task.text_request.acceptedAt,
  );
  const gate = createTextTaskGate(
    hub,
    () => identity.worker,
    () => clock,
  );
  return {
    hub,
    identity,
    route,
    task,
    packet,
    gate,
    clock: (value) => {
      clock = value;
    },
    attach: () =>
      hub.heartbeat(identity.worker, {
        id: task.id,
        fence: task.fence,
        run_id: packet.handle,
      }),
  };
}
function received(packet, route, firstAt = acceptedAt) {
  return {
    sender_id: packet.type === "evidence" ? route.recipient : route.coordinator,
    message: packetMessage(packet, route, firstAt),
    received_at: new Date(firstAt + 1).toISOString(),
    receipt_confirmed: true,
  };
}
function journalFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-nats-core-"));
  const path = join(dir, "journal.sqlite");
  const options = {
    binding: "synthetic-client",
    fingerprintKey: new Uint8Array(32).fill(9),
    maxRecords: 100,
    maxBytes: 1_000_000,
    ...overrides,
  };
  const resources = [];
  t.after(() => {
    for (const resource of resources.reverse()) resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    options,
    open: (file = path, config = options) => {
      const journal = new TextNatsJournal(file, config);
      resources.push(journal);
      return journal;
    },
  };
}

test("NATS execution retries preserve accepted time, scope, fingerprint and envelope", async (t) => {
  const f = await taskFixture(t);
  const original = received(f.packet, f.route);
  f.clock(acceptedAt + 10_000);
  const task = await f.hub.get(f.identity.worker, f.task);
  const retried = executePacket(
    f.route,
    inputFor(task, f.route),
    task.text_request.acceptedAt,
  );
  assert.deepEqual(received(retried, f.route), original);
  assert.equal(original.message.first_sent_at, "1970-01-01T00:00:01.000Z");
  assert.equal(original.message.expires_at, "1970-01-01T01:00:01.000Z");
  assert.ok(Object.isFrozen(f.route) && Object.isFrozen(f.route.binding));
  const { scope, ...routeInput } = f.route;
  const changed = defineRoute({ ...routeInput, ownerClient: "another-client" });
  assert.equal(scope, f.route.scope);
  assert.notEqual(changed.scope, f.route.scope);
});

test("NATS wire parser rejects forged peers, route, immutable content and reply correlation", async (t) => {
  const f = await taskFixture(t);
  const good = received(f.packet, f.route);
  assert.deepEqual(packetFrom(good, f.route, "request"), f.packet);
  for (const mutate of [
    (e) => {
      e.sender_id = "untrusted-peer";
    },
    (e) => {
      e.message.recipient_id = "another-recipient";
    },
    (e) => {
      e.message.thread_id = "other-thread";
    },
    (e) => {
      e.message.kind = "other-kind";
    },
    (e) => {
      e.message.body.parts[0].schema_version = 2;
    },
    (e) => {
      e.message.body.parts[0].value.unrecognized = true;
    },
    (e) => {
      e.message.body.parts[0].value.input.content.text = "tampered";
    },
    (e) => {
      e.message.body.parts[0].value.fingerprint = "0".repeat(64);
    },
    (e) => {
      e.message.first_sent_at = new Date(acceptedAt + 1).toISOString();
    },
    (e) => {
      e.message.body.parts[0].value.input.idempotencyKey =
        "hub-11111111-1111-1111-1111-111111111111";
    },
  ]) {
    const entry = structuredClone(good);
    mutate(entry);
    assert.throws(() => packetFrom(entry, f.route, "request"));
  }
  const query = inspectPacket(f.packet, 1);
  assert.notEqual(query.requestId, inspectPacket(f.packet, 2).requestId);
  const reply = evidencePacket(query, "inspection", {
    id: "actual-run",
    state: "succeeded",
    text: "answer",
  });
  const entry = received(reply, f.route, acceptedAt + hour);
  assert.equal(packetFrom(entry, f.route, "evidence").replyTo, query.requestId);
  entry.message.in_reply_to.message_id = f.packet.requestId;
  assert.throws(() => packetFrom(entry, f.route, "evidence"));
  const contradictory = received(reply, f.route);
  contradictory.message.body.parts[0].value.outcome = "unknown";
  assert.throws(() => packetFrom(contradictory, f.route, "evidence"));
});

test("NATS accepts maximum escaped text and rejects oversized, non-Unicode and tool-bearing input", async (t) => {
  const f = await taskFixture(t);
  for (const text of ["\u0001".repeat(32768), "😀".repeat(8192)]) {
    const input = inputFor(f.task, f.route);
    input.content.text = text;
    const packet = executePacket(f.route, input, acceptedAt);
    assert.equal(
      packetFrom(received(packet, f.route), f.route, "request").input.content
        .text,
      text,
    );
    const evidence = evidencePacket(packet, "outcome", {
      id: "actual-run",
      state: "succeeded",
      text,
    });
    assert.equal(
      packetFrom(received(evidence, f.route), f.route, "evidence").run.text,
      text,
    );
  }
  for (const text of ["a".repeat(32769), "\u0000", "\ud800", "\udc00"]) {
    const input = inputFor(f.task, f.route);
    input.content.text = text;
    assert.throws(() => executePacket(f.route, input, acceptedAt));
  }
  const unsafe = inputFor(f.task, f.route);
  unsafe.tools = ["shell"];
  assert.throws(() => executePacket(f.route, unsafe, acceptedAt));
  assert.deepEqual(
    safeRun({
      id: "actual-run",
      state: "failed",
      text: "private runtime error",
    }),
    { id: "actual-run", state: "failed" },
  );
  assert.throws(() => safeRun({ id: "actual-run", state: "succeeded" }));
});

test("Task witness requires exact binding and durable handle attachment before publication", async (t) => {
  const f = await taskFixture(t);
  const unattached = await f.gate.inspect(f.route, f.packet.key);
  assert.doesNotThrow(() =>
    assertWitness(f.route, f.packet, unattached, "prepare"),
  );
  assert.throws(
    () => assertWitness(f.route, f.packet, unattached, "publish"),
    /text_handle_not_attached/,
  );
  await f.attach();
  const attached = await f.gate.inspect(f.route, f.packet.key);
  assert.doesNotThrow(() =>
    assertWitness(f.route, f.packet, attached, "publish"),
  );
  assert.throws(
    () => sameWitness(unattached, attached),
    /text_authorization_changed/,
  );
  for (const mutate of [
    (w) => {
      w.task.owner = "other-owner";
    },
    (w) => {
      w.task.text_request.ownerClient = "other-client";
    },
    (w) => {
      w.task.text_request.binding.conversationBinding = "other-conversation";
    },
    (w) => {
      w.task.destination = "other-agent";
    },
    (w) => {
      w.task.runner_scope = "other-runtime";
    },
    (w) => {
      w.task.text_request.acceptedAt++;
    },
    (w) => {
      w.task.run_id = "different-run";
    },
  ]) {
    const witness = structuredClone(attached);
    mutate(witness);
    assert.throws(() => assertWitness(f.route, f.packet, witness, "publish"));
  }
  const conflict = structuredClone(attached);
  conflict.task.run_id = "different-run";
  assert.throws(
    () => assertWitness(f.route, f.packet, conflict, "prepare"),
    /text_run_identity_conflict/,
  );
});

test("Task witness denies admission at exact TTL, work and lease boundaries but permits observation", async (t) => {
  const f = await taskFixture(t);
  await f.attach();
  const w = await f.gate.inspect(f.route, f.packet.key);
  assert.doesNotThrow(() =>
    assertWitness(
      f.route,
      f.packet,
      { ...w, now: acceptedAt + hour - 1 },
      "execute",
    ),
  );
  assert.throws(
    () =>
      assertWitness(
        f.route,
        f.packet,
        { ...w, now: acceptedAt + hour },
        "execute",
      ),
    /text_admission_denied/,
  );
  assert.throws(
    () =>
      assertWitness(f.route, f.packet, { ...w, now: w.task.lease }, "execute"),
    /text_admission_denied/,
  );
  const late = {
    ...w,
    now: acceptedAt + retentionMs + 1,
    admissionAllowed: false,
  };
  assert.doesNotThrow(() => assertWitness(f.route, f.packet, late, "observe"));
  const early = await taskFixture(t, { workDeadline: acceptedAt + 100 });
  await early.attach();
  const ew = await early.gate.inspect(early.route, early.packet.key);
  assert.doesNotThrow(() =>
    assertWitness(
      early.route,
      early.packet,
      { ...ew, now: acceptedAt + 99 },
      "execute",
    ),
  );
  assert.throws(
    () =>
      assertWitness(
        early.route,
        early.packet,
        { ...ew, now: acceptedAt + 100 },
        "execute",
      ),
    /text_admission_denied/,
  );
});

test("journal requires a private regular owned database and refuses foreign database tables", (t) => {
  const f = journalFixture(t);
  const privateJournal = f.open();
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(f.path).uid, statSync(f.dir).uid);
  assert.equal(statSync(`${f.path}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(`${f.path}-shm`).mode & 0o777, 0o600);
  privateJournal.insert("requests", "one", { text: "durable" });
  chmodSync(f.path, 0o644);
  assert.throws(
    () => new TextNatsJournal(f.path, f.options),
    /private_text_journal_required/,
  );
  chmodSync(f.path, 0o600);
  const link = join(f.dir, "link.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new TextNatsJournal(link, f.options));
  const foreign = join(f.dir, "foreign.sqlite");
  const raw = new DatabaseSync(foreign);
  raw.exec(
    "CREATE TABLE unrelated(secret TEXT); INSERT INTO unrelated VALUES('synthetic')",
  );
  raw.close();
  chmodSync(foreign, 0o600);
  assert.throws(
    () => new TextNatsJournal(foreign, f.options),
    /foreign_text_journal_database/,
  );
  const unchanged = new DatabaseSync(foreign);
  assert.equal(
    unchanged.prepare("SELECT secret FROM unrelated").get().secret,
    "synthetic",
  );
  assert.equal(
    unchanged
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='generic_nats_records'",
      )
      .get().n,
    0,
  );
  unchanged.close();
});

test("journal reopening preserves records and rejects wrong scope or key without replacing data", (t) => {
  const f = journalFixture(t);
  const journal = f.open();
  journal.insert("requests", "one", { handle: "durable-handle" });
  f.options.fingerprintKey.fill(7);
  journal.insert("requests", "two", { handle: "still-original-key" });
  const correct = { ...f.options, fingerprintKey: new Uint8Array(32).fill(9) };
  assert.deepEqual(f.open(f.path, correct).entry("requests", "two").data, {
    handle: "still-original-key",
  });
  assert.throws(
    () => new TextNatsJournal(f.path, f.options),
    /text_journal_binding_mismatch/,
  );
  assert.throws(
    () =>
      new TextNatsJournal(f.path, { ...correct, binding: "other-recipient" }),
    /text_journal_binding_mismatch/,
  );
  assert.deepEqual(f.open(f.path, correct).entry("requests", "one").data, {
    handle: "durable-handle",
  });
});

test("journal detects payload, version and record-key corruption instead of adopting forged evidence", (t) => {
  const f = journalFixture(t);
  const journal = f.open();
  journal.insert("requests", "one", { state: "running" });
  const raw = new DatabaseSync(f.path);
  try {
    const original = raw.prepare("SELECT * FROM generic_nats_records").get();
    const otherPath = join(f.dir, "other-binding.sqlite");
    const other = f.open(otherPath, {
      ...f.options,
      binding: "synthetic-recipient",
    });
    const otherRaw = new DatabaseSync(otherPath);
    try {
      otherRaw
        .prepare("INSERT INTO generic_nats_records VALUES(?,?,?,?,?)")
        .run(
          original.bucket,
          original.id,
          original.version,
          original.data,
          original.mac,
        );
      assert.throws(
        () => other.entry("requests", "one"),
        /text_journal_corrupt/,
      );
    } finally {
      otherRaw.close();
    }
    raw
      .prepare("UPDATE generic_nats_records SET data=?")
      .run('{"state":"succeeded"}');
    assert.throws(
      () => journal.entry("requests", "one"),
      /text_journal_corrupt/,
    );
    raw
      .prepare("UPDATE generic_nats_records SET data=?,version=2")
      .run(original.data);
    assert.throws(
      () => journal.entry("requests", "one"),
      /text_journal_corrupt/,
    );
    raw.prepare("UPDATE generic_nats_records SET version=1,id='two'").run();
    assert.throws(
      () => journal.entry("requests", "two"),
      /text_journal_corrupt/,
    );
    raw
      .prepare("UPDATE generic_nats_records SET id='one',bucket='evidence'")
      .run();
    assert.throws(() => journal.list("evidence"), /text_journal_corrupt/);
    raw
      .prepare(
        "UPDATE generic_nats_records SET bucket='requests',mac='not-a-mac'",
      )
      .run();
    assert.throws(
      () => journal.entry("requests", "one"),
      /text_journal_corrupt/,
    );
  } finally {
    raw.close();
  }
});

test("journal immutable insertion is idempotent, isolated from caller aliases and bounded on scans", (t) => {
  const journal = journalFixture(t).open();
  const data = { state: "running", content: { text: "immutable" } };
  journal.insert("requests", "one", data);
  data.content.text = "changed outside";
  journal.insert("requests", "one", {
    content: { text: "immutable" },
    state: "running",
  });
  assert.equal(journal.entry("requests", "one").version, 1);
  assert.equal(journal.entry("requests", "one").data.content.text, "immutable");
  assert.throws(
    () => journal.insert("requests", "one", data),
    /text_record_conflict/,
  );
  journal.insert("requests", "two", { state: "pending" });
  assert.deepEqual(
    journal.list("requests", 1).map((entry) => entry.id),
    ["one"],
  );
  for (const limit of [0, -1, 129, 1.5])
    assert.throws(() => journal.list("requests", limit));
  for (const [bucket, id] of [
    ["bad-bucket", "one"],
    ["requests", ""],
    ["requests", "a".repeat(201)],
  ]) {
    assert.throws(() => journal.insert(bucket, id, {}));
  }
});

test("journal count and UTF-8 capacity failures roll back inserts, updates and complete transactions", (t) => {
  const byCount = journalFixture(t, { maxRecords: 1 }).open();
  byCount.insert("requests", "one", { state: "pending" });
  assert.throws(
    () => byCount.insert("requests", "two", {}),
    /text_journal_capacity/,
  );
  assert.equal(byCount.entry("requests", "two"), null);
  assert.equal(byCount.entry("requests", "one").version, 1);
  const byBytes = journalFixture(t, { maxBytes: 30 }).open();
  byBytes.insert("requests", "one", { text: "a" });
  assert.throws(
    () => byBytes.set("requests", "one", { text: "界".repeat(10) }, 1),
    /text_journal_capacity/,
  );
  assert.deepEqual(byBytes.entry("requests", "one"), {
    id: "one",
    version: 1,
    data: { text: "a" },
  });
  assert.throws(
    () =>
      byBytes.transaction(() => {
        byBytes.set("requests", "one", { text: "b" }, 1);
        byBytes.insert("evidence", "two", { text: "界".repeat(10) });
      }),
    /text_journal_capacity/,
  );
  assert.equal(byBytes.entry("requests", "one").data.text, "a");
  assert.equal(byBytes.entry("evidence", "two"), null);
});

test("journal CAS coordinates independent connections and rejects asynchronous nested transactions", (t) => {
  const f = journalFixture(t);
  const first = f.open(),
    second = f.open();
  first.insert("requests", "one", { state: "ready" });
  const version = second.entry("requests", "one").version;
  assert.equal(
    first.set("requests", "one", { state: "prepared" }, version),
    true,
  );
  assert.equal(
    second.set("requests", "one", { state: "ready" }, version),
    false,
  );
  assert.equal(second.entry("requests", "one").data.state, "prepared");
  assert.throws(
    () =>
      first.transaction(() => {
        first.insert("evidence", "one", { state: "succeeded" });
        first.insert("outbox", "one", { reply: "answer" });
        throw Error("synthetic disk write failed");
      }),
    /synthetic disk write failed/,
  );
  assert.equal(second.entry("evidence", "one"), null);
  assert.equal(second.entry("outbox", "one"), null);
  assert.throws(
    () =>
      first.transaction(() => {
        first.insert("outbox", "async", {});
        return Promise.resolve();
      }),
    /async_text_journal_transaction/,
  );
  assert.equal(second.entry("outbox", "async"), null);
  assert.throws(
    () =>
      first.transaction(() => {
        first.transaction(async () => {
          first.insert("outbox", "nested-async", {});
        });
      }),
    /async_text_journal_transaction/,
  );
  assert.equal(second.entry("outbox", "nested-async"), null);
  assert.throws(() =>
    first.transaction(() => {
      first.insert("outbox", "before-caught-error", {});
      assert.throws(
        () =>
          first.transaction(() => {
            throw Error("nested storage failure");
          }),
        /nested storage failure/,
      );
    }),
  );
  assert.equal(second.entry("outbox", "before-caught-error"), null);
});

test("Task gate refreshes durable authorization and denies revoked owner subjects and clients", async (t) => {
  const f = await taskFixture(t);
  const captured = await f.hub.authorization.bind(f.identity.worker);
  await f.hub.authorization.setStopped(
    { kind: "client", id: "unrelated-client" },
    true,
    await f.hub.authorization.epoch(),
    "synthetic-operator",
  );
  await assert.rejects(
    createTextTaskGate(f.hub, () => captured).inspect(f.route, f.packet.key),
  );
  const fresh = await f.gate.inspect(f.route, f.packet.key);
  assert.equal(fresh.epoch, await f.hub.authorization.epoch());
  for (const target of [
    { kind: "subject", id: f.identity.sender.subject },
    { kind: "client", id: f.identity.sender.clientId },
  ]) {
    await f.hub.authorization.setStopped(
      target,
      true,
      await f.hub.authorization.epoch(),
      "synthetic-operator",
    );
    await assert.rejects(f.gate.inspect(f.route, f.packet.key));
    await f.hub.authorization.setStopped(
      target,
      false,
      await f.hub.authorization.epoch(),
      "synthetic-operator",
    );
  }
  assert.equal(
    (await f.gate.inspect(f.route, f.packet.key)).admissionAllowed,
    true,
  );
});

test("Task gate snapshots mutable principals and rejects partial or foreign identity bindings", async (t) => {
  const f = await taskFixture(t);
  for (const changed of [
    { subject: "other-worker" },
    { clientId: "other-client" },
    { runnerScope: "other-boundary" },
    ...Object.keys(f.identity.worker.textBinding).map((field) => ({
      textBinding: {
        ...f.identity.worker.textBinding,
        [field]: "foreign-binding",
      },
    })),
  ]) {
    await assert.rejects(
      createTextTaskGate(f.hub, () => ({
        ...f.identity.worker,
        ...changed,
      })).inspect(f.route, f.packet.key),
    );
  }
  let resolutions = 0;
  const mutable = structuredClone(f.identity.worker);
  const gate = createTextTaskGate(f.hub, () => {
    if (++resolutions === 2)
      mutable.operations.splice(mutable.operations.indexOf("complete"), 1);
    return mutable;
  });
  await assert.rejects(
    gate.inspect(f.route, f.packet.key),
    /text_authorization_changed/,
  );
  const { scope: _scope, ...routeInput } = f.route;
  void _scope;
  await assert.rejects(
    f.gate.inspect(
      defineRoute({ ...routeInput, ownerClient: "foreign-origin-client" }),
      f.packet.key,
    ),
  );
});

test("read-only Task witnesses permit known-result observation without execution privileges", async (t) => {
  const f = await taskFixture(t);
  await f.attach();
  const gate = createTextTaskGate(
    f.hub,
    () => ({ ...f.identity.worker, operations: ["get"] }),
    () => acceptedAt + retentionMs,
  );
  const witness = await gate.inspect(f.route, f.packet.key);
  assert.equal(witness.admissionAllowed, false);
  assert.doesNotThrow(() =>
    assertWitness(f.route, f.packet, witness, "observe"),
  );
  assert.throws(
    () => assertWitness(f.route, f.packet, witness, "execute"),
    /text_admission_denied/,
  );
});

test("Task gate cannot return an admissible stale snapshot after a delayed principal refresh", async (t) => {
  for (const mutation of ["cancel", "global-epoch"]) {
    const f = await taskFixture(t);
    await f.attach();
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    let resolutions = 0;
    const gate = createTextTaskGate(
      f.hub,
      async () => {
        if (++resolutions === 2) {
          enter();
          await released;
        }
        return f.identity.worker;
      },
      () => acceptedAt,
    );
    const pending = gate.inspect(f.route, f.packet.key).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered;
    if (mutation === "cancel") await f.hub.cancel(f.identity.sender, f.task);
    else
      await f.hub.authorization.setStopped(
        { kind: "global", id: "*" },
        true,
        await f.hub.authorization.epoch(),
        "synthetic-operator",
      );
    release();
    const result = await pending;
    if (result.error) assert.ok(result.error instanceof Error);
    else
      assert.throws(
        () => assertWitness(f.route, f.packet, result.value, "execute"),
        /text_admission_denied/,
      );
  }
});
