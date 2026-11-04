import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { NatsTextRecipient } from "../src/generic-nats/recipient.ts";
import { TextNatsJournal } from "../src/generic-nats/journal.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import {
  defineRoute,
  executePacket,
  inspectPacket,
  packetMessage,
  TEXT_NATS_CONTRACT,
  textNatsLimits,
} from "../src/generic-nats/protocol.ts";

function fixture(
  t,
  { runtime: patch = {}, maxRecords = 100, timeout = 1000 } = {},
) {
  const root = join(process.cwd(), ".runtime/recipient-audit");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "unit-"));
  const route = defineRoute({
    id: "unit-route",
    coordinator: "unit-coordinator",
    recipient: "unit-recipient",
    ownerSubject: "unit-owner",
    ownerClient: "unit-owner-client",
    workerSubject: "unit-worker",
    workerClient: "unit-worker-client",
    boundaryId: "unit-proxy-boundary",
    runtimeBoundaryId: "unit-real-boundary",
    retentionMs: 86400000,
    binding: {
      ownerScope: "unit-scope",
      senderAgent: "unit-sender",
      recipientAgent: "unit-destination",
      recipientOwner: "unit-recipient-owner",
      conversationBinding: "unit-conversation",
    },
  });
  const id = randomUUID(),
    key = `hub-${id}`;
  let clock = Date.now(),
    epoch = 1,
    allowed = true;
  const acceptedAt = clock;
  const input = {
    idempotencyKey: key,
    content: {
      origin: "external_agent",
      text: "unit external text",
      messageId: "unit-source-message",
      contextId: "unit-context",
      senderAgent: route.binding.senderAgent,
      recipientAgent: route.binding.recipientAgent,
    },
    tools: [],
    replay: {
      contract: TEXT_NATS_CONTRACT,
      deadline: clock + 3600000,
      retentionMs: route.retentionMs,
    },
  };
  const execute = executePacket(route, input, acceptedAt);
  const task = {
    id,
    fence: 1,
    task_type: "generic_text",
    owner: route.ownerSubject,
    destination: route.binding.recipientAgent,
    request_key: "unit-request",
    state: "running",
    lease: clock + 3600000,
    run_id: execute.handle,
    runner_scope: route.boundaryId,
    runner_subject: route.workerSubject,
    result: null,
    execution_open: 1,
    at: acceptedAt,
    text_request: {
      owner: route.ownerSubject,
      ownerClient: route.ownerClient,
      binding: route.binding,
      acceptedAt,
      input: {
        messageId: input.content.messageId,
        contextId: input.content.contextId,
        text: input.content.text,
        workDeadline: input.replay.deadline,
      },
    },
  };
  const gate = {
    async inspect() {
      if (!allowed) throw Error("unit_authority_revoked");
      return structuredClone({
        task,
        epoch,
        now: clock,
        admissionAllowed: true,
      });
    },
  };
  const pending = [],
    submits = [],
    calls = { create: 0, lookup: 0, get: 0, ack: 0 },
    ledger = new Map();
  const runtime = {
    supportedTaskTypes: ["generic_text"],
    boundaryId: route.runtimeBoundaryId,
    admissionContract: "unit-inner-contract",
    textBoundary: {
      version: 1,
      inputAuthority: "external_agent",
      effects: "none",
      automaticReply: false,
    },
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: route.retentionMs,
    async create() {
      throw Error("unit_fixed_forbidden");
    },
    async createText(value) {
      calls.create++;
      assert.equal(value.idempotencyKey, key);
      assert.deepEqual(value.content, input.content);
      assert.deepEqual(value.tools, []);
      assert.deepEqual(value.replay, {
        ...input.replay,
        contract: runtime.admissionContract,
      });
      const run = {
        id: "unit-actual-run",
        state: "succeeded",
        text: "unit answer",
      };
      ledger.set(key, run);
      return run;
    },
    async lookupText(value) {
      calls.lookup++;
      return ledger.get(value) ?? null;
    },
    async get(value) {
      calls.get++;
      return [...ledger.values()].find((run) => run.id === value) ?? null;
    },
    ...patch,
  };
  let ackFailure = false,
    submitFailure = false;
  const transport = {
    agentId: route.recipient,
    async poll() {
      return pending.shift() ?? null;
    },
    async ack(request) {
      calls.ack++;
      if (ackFailure) throw Error("unit_lost_ack_response");
      return {
        ...request,
        recipient_id: route.recipient,
        receipt_id: "unit-ack-receipt",
        acked_at: new Date().toISOString(),
        state: "acked",
      };
    },
    async submit(message) {
      submits.push(structuredClone(message));
      if (submitFailure) throw Error("unit_lost_submit_response");
      return { message_id: message.message_id, state: "pending" };
    },
    async status() {
      throw Error("unit_status_unused");
    },
  };
  const inbox = new SQLiteInbox(join(dir, "inbox.sqlite"), {
    agent_id: route.recipient,
    fingerprint_key: new Uint8Array(32).fill(17),
    limits: textNatsLimits,
    max_records: 500,
    max_body_bytes: 5000000,
    max_ack_records: 500,
    ack_retry_ms: 3600000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_attempts: 100,
  });
  inbox.migrate();
  const journalOptions = {
    binding: route.scope,
    fingerprintKey: new Uint8Array(32).fill(18),
    maxRecords,
    maxBytes: 5000000,
  };
  const journals = [];
  const openJournal = (options = {}) => {
    const value = new TextNatsJournal(join(dir, "recipient.sqlite"), {
      ...journalOptions,
      ...options,
    });
    journals.push(value);
    return value;
  };
  const journal = openJournal();
  const options = {
    route,
    transport,
    inbox,
    journal,
    gate,
    runtime,
    now: () => clock,
    runtimeTimeoutMs: timeout,
  };
  let recipient = new NatsTextRecipient(options);
  t.after(async () => {
    await recipient.close();
    inbox.close();
    for (const value of journals) value.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function deliver(packet = execute, sender = route.coordinator) {
    const delivery = {
      message: {
        ...packetMessage(
          packet,
          route,
          packet.type === "execute" ? packet.acceptedAt : clock,
        ),
        sender_id: sender,
      },
      generation: 1,
      lease_token: "a".repeat(43),
      lease_until: new Date(
        Math.min(Date.now() + 30000, acceptedAt + 3600000),
      ).toISOString(),
    };
    pending.push(delivery);
    return delivery.message;
  }
  return {
    route,
    execute,
    input,
    task,
    key,
    calls,
    ledger,
    runtime,
    gate,
    transport,
    inbox,
    journal,
    options,
    submits,
    deliver,
    openJournal,
    get recipient() {
      return recipient;
    },
    reopen(overrides = {}) {
      recipient = new NatsTextRecipient({ ...options, ...overrides });
      return recipient;
    },
    clock(value) {
      clock = value;
    },
    now: () => clock,
    revoke(value = true) {
      allowed = !value;
      epoch++;
    },
    ackFailure(value) {
      ackFailure = value;
    },
    submitFailure(value) {
      submitFailure = value;
    },
  };
}

async function saved(f, packet) {
  f.deliver(packet);
  await f.recipient.receiveOnce();
}
const packet = (message) => message.body.parts[0].value;

async function sendUntil(f, count) {
  for (
    let attempt = 0;
    attempt < count + 3 && f.submits.length < count;
    attempt++
  )
    await f.recipient.sendOnce();
  assert.equal(f.submits.length, count);
}

test("unit recipient saves and ACKs before explicit runtime execution", async (t) => {
  const f = fixture(t);
  await saved(f);
  assert.equal(f.calls.ack, 1);
  assert.equal(f.calls.create, 0);
  assert.equal(f.recipient.inspect(f.key), null);
  await f.recipient.executeOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(f.recipient.inspect(f.key).run.id, "unit-actual-run");
  assert.notEqual(f.recipient.inspect(f.key).run.id, f.execute.handle);
  await f.recipient.sendOnce();
  assert.equal(packet(f.submits[0]).phase, "outcome");
  assert.equal(packet(f.submits[0]).run.text, "unit answer");
  assert.equal(await f.recipient.executeOnce(), false);
  assert.equal(f.calls.create, 1);
});

test("unit recipient holds saved delivery until ACK response is confirmed", async (t) => {
  const f = fixture(t);
  f.ackFailure(true);
  f.deliver();
  await assert.rejects(f.recipient.receiveOnce(), /ack_transport_failed/);
  assert.equal(await f.recipient.executeOnce(), false);
  assert.equal(f.calls.create, 0);
  f.ackFailure(false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  await f.recipient.receiveOnce();
  await f.recipient.executeOnce();
  assert.equal(f.calls.create, 1);
});

test("unit recipient recovers lost admission response by lookup without create replay", async (t) => {
  const f = fixture(t);
  const create = f.runtime.createText;
  f.runtime.createText = async (input) => {
    await create(input);
    throw Error("unit_response_lost");
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /unit_response_lost/);
  assert.equal(f.recipient.inspect(f.key).state, "prepared");
  f.reopen({ journal: f.openJournal() });
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.lookup, 1);
  assert.equal(packet(f.submits[0]).run.state, "succeeded");
});

test("unit recipient never probes prepared uncertainty with create when lookup is missing", async (t) => {
  const f = fixture(t);
  f.runtime.createText = async () => {
    f.calls.create++;
    throw Error("unit_unknown");
  };
  f.runtime.lookupText = undefined;
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /unit_unknown/);
  f.reopen({ journal: f.openJournal() });
  assert.equal(await f.recipient.executeOnce(), false);
  await saved(f, inspectPacket(f.execute, 1));
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.lookup, 0);
  assert.equal(packet(f.submits[0]).outcome, "unknown");
});

test("unit recipient caches each query and allows only a new query to observe evolved state", async (t) => {
  const f = fixture(t);
  f.runtime.createText = async () => {
    f.calls.create++;
    throw Error("unit_unknown");
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /unit_unknown/);
  const query = inspectPacket(f.execute, 1);
  await saved(f, query);
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  const first = f.submits[0];
  assert.equal(packet(first).outcome, "not_found");
  f.ledger.set(f.key, {
    id: "unit-actual-run",
    state: "succeeded",
    text: "unit recovered",
  });
  await saved(f, query);
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(
    f.submits.filter((message) => packet(message).replyTo === query.requestId)
      .length,
    1,
  );
  await saved(f, inspectPacket(f.execute, 2));
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(packet(f.submits.at(-1)).run.text, "unit recovered");
  assert.equal(packet(first).outcome, "not_found");
});

test("unit recipient timeout leaves prepared uncertainty and a bounded lookup recovers", async (t) => {
  const f = fixture(t, { timeout: 20 });
  f.runtime.createText = async (input) => {
    f.calls.create++;
    f.ledger.set(input.idempotencyKey, {
      id: "unit-timeout-run",
      state: "running",
    });
    return new Promise(() => {});
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /text_runtime_timeout/);
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.lookup, 1);
  assert.equal(packet(f.submits[0]).phase, "admission");
});

test("unit recipient preserves private actual result after post-await revocation and withholds reply", async (t) => {
  const f = fixture(t);
  const create = f.runtime.createText;
  f.runtime.createText = async (input) => {
    const value = await create(input);
    f.revoke();
    return value;
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /unit_authority_revoked/);
  assert.equal(f.recipient.inspect(f.key).run.state, "succeeded");
  assert.equal(f.recipient.inspect(f.key).evidence, undefined);
  assert.equal(await f.recipient.sendOnce(), false);
  assert.equal(f.submits.length, 0);
  f.revoke(false);
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(packet(f.submits[0]).run.state, "succeeded");
});

test("unit recipient terminal disclosure and outbox roll back together on journal capacity failure", async (t) => {
  const f = fixture(t, { maxRecords: 1 });
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /text_journal_capacity/);
  assert.equal(f.recipient.inspect(f.key).run.state, "succeeded");
  assert.equal(f.recipient.inspect(f.key).evidence, undefined);
  assert.equal(f.journal.list("recipient_replies").length, 0);
  f.reopen({ journal: f.openJournal({ maxRecords: 100 }) });
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.create, 1);
  assert.equal(packet(f.submits[0]).phase, "outcome");
});

test("unit recipient CAS permits one initial create across independent journal handles", async (t) => {
  const f = fixture(t);
  const other = new NatsTextRecipient({
    ...f.options,
    journal: f.openJournal(),
  });
  t.after(() => other.close());
  await saved(f);
  await Promise.all([f.recipient.executeOnce(), other.executeOnce()]);
  assert.equal(f.calls.create, 1);
  assert.equal(f.recipient.inspect(f.key).run.state, "succeeded");
});

test("unit recipient uses known actual id for recovery and never regresses terminal state", async (t) => {
  const f = fixture(t);
  f.runtime.createText = async () => {
    f.calls.create++;
    const run = { id: "unit-real-id", state: "running" };
    f.ledger.set(f.key, run);
    return run;
  };
  await saved(f);
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(packet(f.submits[0]).phase, "admission");
  f.ledger.set(f.key, {
    id: "unit-real-id",
    state: "succeeded",
    text: "unit final",
  });
  f.reopen({ journal: f.openJournal() });
  await f.recipient.executeOnce();
  await f.recipient.sendOnce();
  assert.equal(f.calls.get, 1);
  assert.equal(f.calls.lookup, 0);
  f.ledger.set(f.key, { id: "unit-real-id", state: "running" });
  await saved(f, inspectPacket(f.execute, 4));
  await f.recipient.executeOnce();
  await sendUntil(f, 3);
  assert.equal(packet(f.submits[2]).run.state, "succeeded");
  assert.equal(f.calls.get, 1);
});

test("unit recipient rejects authenticated peer forgery before runtime", async (t) => {
  const f = fixture(t);
  f.deliver(f.execute, "unit-wrong-peer");
  await f.recipient.receiveOnce();
  await assert.rejects(f.recipient.executeOnce(), /foreign_text_packet/);
  assert.equal(f.calls.create, 0);
  assert.equal(f.recipient.inspect(f.key), null);
});

test("unit recipient reply retry preserves its own logical clock and exact envelope", async (t) => {
  const f = fixture(t);
  await saved(f);
  f.clock(f.now() + 1000);
  await f.recipient.executeOnce();
  f.submitFailure(true);
  await assert.rejects(f.recipient.sendOnce(), /unit_lost_submit_response/);
  const first = f.submits[0];
  assert.notEqual(
    first.first_sent_at,
    new Date(f.execute.acceptedAt).toISOString(),
  );
  f.clock(f.now() + 1000);
  f.submitFailure(false);
  await f.recipient.sendOnce();
  assert.deepEqual(f.submits[1], first);
});

test("unit recipient expires reply without refreshing TTL or retransmitting", async (t) => {
  const f = fixture(t);
  await saved(f);
  await f.recipient.executeOnce();
  f.clock(f.now() + 3600000);
  assert.equal(await f.recipient.sendOnce(), false);
  assert.equal(f.submits.length, 0);
  assert.equal(f.journal.list("recipient_replies")[0].data.state, "expired");
});

test("unit recipient inspection without actual saved execute never admits runtime", async (t) => {
  const f = fixture(t);
  await saved(f, inspectPacket(f.execute, 1));
  assert.equal(await f.recipient.executeOnce(), false);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.lookup, 0);
  assert.equal(f.submits.length, 0);
});

test("unit recipient rejects expired authority and unverified runtime before initial create", async (t) => {
  const f = fixture(t);
  await saved(f);
  f.task.lease = f.now();
  await assert.rejects(f.recipient.executeOnce(), /text_admission_denied/);
  assert.equal(f.calls.create, 0);
  f.task.lease = f.now() + 3600000;
  f.runtime.boundaryId = "unit-wrong-boundary";
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_runner_boundary_unverified/,
  );
  assert.equal(f.calls.create, 0);
  f.runtime.boundaryId = f.route.runtimeBoundaryId;
  f.runtime.retentionMs = 1;
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_runtime_retention_insufficient/,
  );
  assert.equal(f.calls.create, 0);
});

test("unit recipient close leaves injected stores and transport caller-owned", async (t) => {
  const f = fixture(t);
  await f.recipient.close();
  assert.equal(f.journal.list("recipient_runs").length, 0);
  assert.deepEqual(f.inbox.inbox(), []);
  await assert.rejects(f.recipient.receiveOnce(), /text_recipient_closed/);
  assert.throws(() => f.recipient.inspect(f.key), /text_recipient_closed/);
});

test("unit recipient holds lookup after original retention horizon without new admission", async (t) => {
  const f = fixture(t);
  f.runtime.createText = async () => {
    f.calls.create++;
    throw Error("unit_unknown");
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /unit_unknown/);
  f.clock(f.execute.acceptedAt + f.route.retentionMs);
  assert.equal(await f.recipient.executeOnce(), false);
  assert.equal(f.calls.lookup, 0);
  assert.equal(f.calls.create, 1);
});

test("unit recipient rejects changed actual runtime id and keeps private original evidence", async (t) => {
  const f = fixture(t);
  f.runtime.createText = async () => {
    f.calls.create++;
    return { id: "unit-original-id", state: "running" };
  };
  await saved(f);
  await f.recipient.executeOnce();
  f.runtime.get = async () => {
    f.calls.get++;
    return { id: "unit-wrong-id", state: "succeeded", text: "wrong" };
  };
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_runtime_identity_conflict/,
  );
  assert.equal(f.recipient.inspect(f.key).run.id, "unit-original-id");
  assert.equal(f.calls.create, 1);
});

test("unit recipient detects post-await epoch change before reply disclosure", async (t) => {
  const f = fixture(t);
  const create = f.runtime.createText;
  f.runtime.createText = async (input) => {
    const run = await create(input);
    f.revoke(false);
    return run;
  };
  await saved(f);
  await assert.rejects(f.recipient.executeOnce(), /text_authorization_changed/);
  assert.equal(f.recipient.inspect(f.key).run.state, "succeeded");
  assert.equal(f.recipient.inspect(f.key).evidence, undefined);
  assert.equal(f.journal.list("recipient_replies").length, 0);
});

test("unit recipient validates reopened journal records before runtime calls", async (t) => {
  const f = fixture(t);
  await saved(f);
  f.runtime.boundaryId = "unit-wrong-boundary";
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_runner_boundary_unverified/,
  );
  const entry = f.journal.entry("recipient_runs", f.key);
  f.journal.set(
    "recipient_runs",
    f.key,
    {
      ...entry.data,
      state: "prepared",
      run: { id: "invalid id!", state: "running" },
    },
    entry.version,
  );
  f.reopen({ journal: f.openJournal() });
  await assert.rejects(f.recipient.executeOnce());
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.lookup, 0);
});

test("unit recipient drains reply backlog beyond the bounded 128-record scan", async (t) => {
  const f = fixture(t, { maxRecords: 1000 });
  await saved(f);
  await f.recipient.executeOnce();
  for (let index = 1; index <= 140; index++) {
    await saved(f, inspectPacket(f.execute, index));
    await f.recipient.executeOnce();
  }
  await sendUntil(f, 130);
  await f.recipient.close();
  f.reopen({ journal: f.openJournal() });
  await sendUntil(f, 141);
  assert.equal(f.submits.length, 141);
  assert.equal(
    new Set(f.submits.map((message) => message.message_id)).size,
    141,
  );
  assert.equal(f.calls.create, 1);
});

for (const invalid of [
  "foreign peer",
  "malformed packet",
  "envelope correlation",
]) {
  test(`unit recipient quarantines ${invalid} once and allows the next legitimate command`, async (t) => {
    const f = fixture(t);
    const message = f.deliver(
      inspectPacket(f.execute, 99),
      invalid === "foreign peer" ? "unit-wrong-peer" : f.route.coordinator,
    );
    if (invalid === "malformed packet") message.body.parts[0].value = {};
    if (invalid === "envelope correlation")
      message.thread_id = "unit-wrong-thread";
    await f.recipient.receiveOnce();
    const original = structuredClone(f.inbox.inbox()[0]);
    await assert.rejects(f.recipient.executeOnce());
    assert.equal(f.calls.create, 0);
    assert.equal(f.recipient.inspect(f.key), null);
    const quarantined = f.journal.list("recipient_rejected");
    assert.equal(quarantined.length, 1);
    assert.deepEqual(quarantined[0].data.entry, original);
    assert.match(quarantined[0].data.reason, /^[a-z_]+$/);
    assert.deepEqual(f.inbox.inbox(), []);
    assert.equal(await f.recipient.executeOnce(), false);
    await saved(f);
    assert.equal(await f.recipient.executeOnce(), true);
    await sendUntil(f, 1);
    assert.equal(f.calls.create, 1);
    assert.equal(packet(f.submits[0]).run.text, "unit answer");
    assert.equal(f.journal.list("recipient_rejected").length, 1);
  });
}

test("unit recipient quarantines immutable execute and inspect conflicts without poisoning later work", async (t) => {
  const f = fixture(t);
  f.journal.insert("recipient_runs", f.key, {
    execute: f.execute,
    state: "ready",
  });
  const conflicting = executePacket(
    f.route,
    {
      ...f.input,
      content: { ...f.input.content, text: "unit conflicting text" },
    },
    f.execute.acceptedAt,
  );
  await saved(f, conflicting);
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_recipient_request_conflict/,
  );
  assert.equal(f.calls.create, 0);
  assert.deepEqual(f.inbox.inbox(), []);
  await saved(f, inspectPacket(conflicting, 1));
  await assert.rejects(
    f.recipient.executeOnce(),
    /text_recipient_request_conflict/,
  );
  assert.equal(f.calls.create, 0);
  assert.deepEqual(f.inbox.inbox(), []);
  await f.recipient.executeOnce();
  await sendUntil(f, 1);
  assert.equal(f.calls.create, 1);
  assert.equal(packet(f.submits[0]).run.text, "unit answer");
  assert.equal(f.journal.list("recipient_rejected").length, 2);
});

test("unit recipient retains rejected inbox body when quarantine cannot be saved", async (t) => {
  const f = fixture(t, { maxRecords: 1 });
  f.journal.insert("unit_fixture", "occupied", {});
  f.deliver(f.execute, "unit-wrong-peer");
  await f.recipient.receiveOnce();
  const original = structuredClone(f.inbox.inbox()[0]);
  await assert.rejects(f.recipient.executeOnce(), /text_journal_capacity/);
  assert.deepEqual(f.inbox.inbox(), [original]);
  assert.deepEqual(f.journal.list("recipient_rejected"), []);
  assert.equal(f.calls.create, 0);
  f.reopen({ journal: f.openJournal({ maxRecords: 100 }) });
  await assert.rejects(f.recipient.executeOnce(), /foreign_text_packet/);
  assert.deepEqual(
    f.journal.list("recipient_rejected")[0].data.entry,
    original,
  );
  assert.deepEqual(f.inbox.inbox(), []);
});

test("unit recipient holds valid input on admission, journal, and current authority failure", async (t) => {
  const f = fixture(t, { maxRecords: 1 });
  f.journal.insert("unit_fixture", "occupied", {});
  await saved(f);
  const original = structuredClone(f.inbox.inbox()[0]);
  await assert.rejects(f.recipient.executeOnce(), /text_journal_capacity/);
  assert.deepEqual(f.inbox.inbox(), [original]);
  f.reopen({ journal: f.openJournal({ maxRecords: 100 }) });
  f.revoke();
  await assert.rejects(f.recipient.executeOnce(), /unit_authority_revoked/);
  assert.deepEqual(f.recipient.inspect(f.key).execute, f.execute);
  assert.deepEqual(f.journal.list("recipient_rejected"), []);
  assert.equal(f.calls.create, 0);
  f.revoke(false);
  f.task.lease = f.now();
  await assert.rejects(f.recipient.executeOnce(), /text_admission_denied/);
  assert.deepEqual(f.journal.list("recipient_rejected"), []);
  f.task.lease = f.now() + 3600000;
  await f.recipient.executeOnce();
  await sendUntil(f, 1);
  assert.equal(f.calls.create, 1);
});

test("unit recipient close waits for in-flight runtime evidence before caller closes stores", async (t) => {
  const f = fixture(t);
  let started, finish;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  f.runtime.createText = async () => {
    f.calls.create++;
    started();
    return result;
  };
  await saved(f);
  const execution = assert.rejects(
    f.recipient.executeOnce(),
    /text_recipient_closed/,
  );
  await running;
  let closed = false;
  const closing = f.recipient.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  const closedEarly = closed;
  await assert.rejects(f.recipient.executeOnce(), /text_recipient_closed/);
  finish({
    id: "unit-drained-run",
    state: "succeeded",
    text: "unit drained result",
  });
  await execution;
  await closing;
  assert.equal(closedEarly, false);
  assert.equal(
    f.journal.entry("recipient_runs", f.key).data.run.id,
    "unit-drained-run",
  );
  assert.deepEqual(f.journal.list("recipient_replies"), []);
  assert.deepEqual(f.inbox.inbox(), []);
  f.reopen({ journal: f.openJournal() });
  await f.recipient.executeOnce();
  await sendUntil(f, 1);
  assert.equal(packet(f.submits[0]).run.text, "unit drained result");
  assert.equal(f.calls.create, 1);
});

test("unit recipient close drains runtime timeout and retains prepared uncertainty", async (t) => {
  const f = fixture(t, { timeout: 20 });
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  f.runtime.createText = async () => {
    f.calls.create++;
    started();
    return new Promise(() => {});
  };
  await saved(f);
  const execution = assert.rejects(
    f.recipient.executeOnce(),
    /text_runtime_timeout/,
  );
  await running;
  let closed = false;
  const closing = f.recipient.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  const closedEarly = closed;
  await closing;
  await execution;
  assert.equal(closedEarly, false);
  assert.equal(f.journal.entry("recipient_runs", f.key).data.state, "prepared");
  assert.equal(f.journal.entry("recipient_runs", f.key).data.run, undefined);
  assert.equal(f.calls.create, 1);
});

test("unit recipient close drains receiver ACK without closing injected resources", async (t) => {
  const f = fixture(t);
  let started, finish;
  const acknowledging = new Promise((resolve) => {
    started = resolve;
  });
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  const ack = f.transport.ack;
  f.transport.ack = async (request) => {
    started();
    await result;
    return ack(request);
  };
  f.deliver();
  const receive = f.recipient.receiveOnce();
  await acknowledging;
  let closed = false;
  const closing = f.recipient.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  const closedEarly = closed;
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
  finish();
  await receive;
  await closing;
  assert.equal(closedEarly, false);
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  assert.deepEqual(f.journal.list("recipient_rejected"), []);
  assert.equal(f.calls.create, 0);
});
