import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/sqlite.ts";
import { Adapter } from "../src/adapter.ts";
import { Journal } from "../src/journal.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { TextNatsJournal } from "../src/generic-nats/journal.ts";
import { NatsTextClient } from "../src/generic-nats/client.ts";
import { createTextTaskGate } from "../src/generic-nats/task-gate.ts";
import {
  defineRoute,
  evidencePacket,
  handleFor,
  packetMessage,
  textNatsLimits,
  TEXT_NATS_CONTRACT,
} from "../src/generic-nats/protocol.ts";
import { identities, request } from "./generic-async/fixtures.js";

function fixture(t, products = ["paper"], journalLimits = {}) {
  const root = mkdtempSync(join(tmpdir(), "generic-nats-client-unit-"));
  let clock = Date.now();
  const hub = new Hub(join(root, "tasks.db"), () => clock);
  const auth = new Map();
  const routes = products.map((product) => {
    const identity = identities(product);
    auth.set(product, identity);
    return defineRoute({
      id: product,
      coordinator: "unit-coordinator",
      recipient: `unit-${product}`,
      ownerSubject: identity.sender.subject,
      ownerClient: identity.sender.clientId,
      workerSubject: identity.worker.subject,
      workerClient: identity.worker.clientId,
      binding: identity.sender.textBinding,
      boundaryId: identity.worker.runnerScope,
      runtimeBoundaryId: `unit-${product}-inner-runtime`,
      retentionMs: 86_400_000,
    });
  });
  const inbox = new SQLiteInbox(join(root, "inbox.db"), {
    agent_id: "unit-coordinator",
    fingerprint_key: new Uint8Array(32).fill(1),
    limits: textNatsLimits,
    max_records: 1000,
    max_body_bytes: 10_000_000,
    max_ack_records: 1000,
    ack_retry_ms: 3_600_000,
    retry_base_ms: 1,
    retry_cap_ms: 1,
    max_attempts: 10,
  });
  inbox.migrate();
  const journalOptions = {
    binding: "synthetic-unit-client",
    fingerprintKey: new Uint8Array(32).fill(2),
    maxRecords: 1000,
    maxBytes: 10_000_000,
    ...journalLimits,
  };
  let journal = new TextNatsJournal(join(root, "client.db"), journalOptions);
  const incoming = [],
    sent = [];
  let ackFailure = false,
    submitHook,
    gateHook;
  const gate = createTextTaskGate(
    hub,
    (route) => auth.get(route.id).worker,
    () => clock,
  );
  const options = () => ({
    routes,
    inbox,
    journal,
    now: () => clock,
    gate: {
      async inspect(...args) {
        if (gateHook) await gateHook();
        return gate.inspect(...args);
      },
    },
    transport: {
      agentId: "unit-coordinator",
      async submit(message) {
        sent.push(message);
        if (submitHook) await submitHook(message);
        return {
          sender_id: "unit-coordinator",
          message_id: message.message_id,
          recipient_id: message.recipient_id,
          receipt_id: "unit-acceptance",
          accepted_at: new Date(clock).toISOString(),
          expires_at: message.expires_at,
          state: "pending",
        };
      },
      async status() {
        throw Error("unit_status_not_used");
      },
      async poll() {
        return incoming.shift() ?? null;
      },
      async ack(ack) {
        assert.ok(
          inbox
            .inbox()
            .some((entry) => entry.message.message_id === ack.message_id),
          "unit transport observes durable inbox save before ACK",
        );
        if (ackFailure) {
          ackFailure = false;
          throw Error("unit_ack_response_lost");
        }
        return {
          ...ack,
          recipient_id: "unit-coordinator",
          receipt_id: "unit-ack",
          acked_at: new Date().toISOString(),
          state: "acked",
        };
      },
    },
  });
  let client = new NatsTextClient(options());
  const workerJournals = [];
  t.after(async () => {
    await client.close();
    for (const workerJournal of workerJournals) workerJournal.close();
    journal.close();
    inbox.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    hub,
    routes,
    auth,
    inbox,
    sent,
    options,
    get client() {
      return client;
    },
    get journal() {
      return journal;
    },
    setClock(value) {
      clock = value;
    },
    get now() {
      return clock;
    },
    onSubmit(hook) {
      submitHook = hook;
    },
    onGate(hook) {
      gateHook = hook;
    },
    failAck() {
      ackFailure = true;
    },
    enqueue(route, packet, sender = route.recipient) {
      const message = packetMessage(packet, route, Date.now());
      incoming.push({
        message: { ...message, sender_id: sender },
        generation: 1,
        lease_token: "x".repeat(43),
        lease_until: new Date(Date.now() + 10_000).toISOString(),
      });
    },
    async reopen(limits = {}) {
      await client.close();
      Object.assign(journalOptions, limits);
      journal.close();
      journal = new TextNatsJournal(join(root, "client.db"), journalOptions);
      client = new NatsTextClient(options());
    },
    async prepare(product = "paper", attach = true) {
      const route = routes.find((item) => item.id === product);
      const identity = auth.get(product);
      const task = await hub.submitText(
        identity.sender,
        request(`unit-${product}-${randomUUID()}`, `hello ${product}`),
      );
      const claimed = await hub.claim(
        identity.worker,
        {},
        { textRetentionMs: route.retentionMs },
      );
      assert.equal(claimed.id, task.id);
      const stored = claimed.text_request;
      const input = {
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
      const run = await client.runs(product).createText(input);
      if (attach)
        await hub.heartbeat(identity.worker, {
          id: task.id,
          fence: claimed.fence,
          run_id: run.id,
        });
      return { route, identity, task, claimed, input, run };
    },
    async adapter(product = "paper") {
      const identity = auth.get(product);
      const task = await hub.submitText(
        identity.sender,
        request(`adapter-${product}`),
      );
      const workerJournal = new Journal(join(root, `${product}-worker.db`));
      workerJournals.push(workerJournal);
      const adapter = new Adapter(
        hub,
        identity.worker,
        client.runs(product),
        workerJournal,
      );
      await adapter.once();
      return { task, adapter, workerJournal, identity };
    },
  };
}

test("unit client prepares a durable proxy before canonical attachment and publication", async (t) => {
  const f = fixture(t);
  const p = await f.prepare("paper", false);
  assert.match(p.run.id, /^gn_[a-f0-9]{64}$/);
  assert.equal(p.run.state, "running");
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.client.sendOnce(), /text_handle_not_attached/);
  assert.deepEqual(await f.client.runs("paper").createText(p.input), p.run);
  await f.hub.heartbeat(p.identity.worker, {
    id: p.task.id,
    fence: p.claimed.fence,
    run_id: p.run.id,
  });
  assert.equal(await f.client.sendOnce(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.sent[0].first_sent_at,
    new Date(p.task.text_request.acceptedAt).toISOString(),
  );
  assert.equal(await f.client.sendOnce(), false);
  assert.deepEqual(await f.client.runs("paper").get(p.run.id), p.run);
  await assert.rejects(f.client.runs("paper").create({ prompt: "forbidden" }));
  await assert.rejects(
    f.client
      .runs("paper")
      .createText({
        ...p.input,
        content: { ...p.input.content, text: "changed" },
      }),
  );
});

test("unit client integrates existing Adapter and completes only from actual-runtime evidence", async (t) => {
  const f = fixture(t);
  const { task, adapter, identity, workerJournal } = await f.adapter();
  const key = `hub-${task.id}`;
  const record = f.client.inspect("paper", key);
  assert.equal(
    (await f.hub.get(identity.sender, task)).run_id,
    record.request.handle,
  );
  assert.equal((await f.hub.get(identity.sender, task)).state, "running");
  assert.ok(workerJournal.load());
  assert.equal(f.sent.length, 0);
  await f.client.sendOnce();
  assert.equal((await f.hub.get(identity.sender, task)).state, "running");
  f.enqueue(
    f.routes[0],
    evidencePacket(record.request, "outcome", {
      id: "unit-actual-run",
      state: "succeeded",
      text: "unit result",
    }),
  );
  await f.client.receiveOnce();
  assert.equal((await f.hub.get(identity.sender, task)).state, "running");
  await adapter.once();
  assert.equal((await f.hub.get(identity.sender, task)).result, "unit result");
  assert.equal(workerJournal.load(), null);
});

test("unit client retries lost submit response across reopen without refreshing clocks or envelope", async (t) => {
  const f = fixture(t);
  await f.prepare();
  f.onSubmit(() => {
    throw Error("unit_submit_response_lost");
  });
  await assert.rejects(f.client.sendOnce(), /unit_submit_response_lost/);
  await f.reopen();
  f.onSubmit(undefined);
  f.setClock(f.now + 10);
  await f.client.sendOnce();
  assert.deepEqual(f.sent[0], f.sent[1]);
});

test("unit client routes two recipients through one inbox and rejects cross-route handles", async (t) => {
  const f = fixture(t, ["paper", "mirror"]);
  const a = await f.prepare("paper"),
    b = await f.prepare("mirror");
  for (const p of [b, a]) {
    const record = f.client.inspect(p.route.id, p.input.idempotencyKey);
    f.enqueue(
      p.route,
      evidencePacket(record.request, "outcome", {
        id: `unit-run-${p.route.id}`,
        state: "succeeded",
        text: p.route.id,
      }),
    );
    await f.client.receiveOnce();
  }
  assert.equal((await f.client.runs("paper").get(a.run.id)).text, "paper");
  assert.equal((await f.client.runs("mirror").get(b.run.id)).text, "mirror");
  await assert.rejects(
    f.client.runs("paper").get(b.run.id),
    /foreign_text_handle/,
  );
  assert.equal(f.inbox.inbox().length, 0);
});

test("unit client read-only get never sends or requests status, while explicit queries keep their identity", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  await f.client.runs("paper").get(p.run.id);
  assert.equal(f.sent.length, 0);
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  assert.equal(
    f.client.inspect("paper", p.input.idempotencyKey).queries.length,
    1,
  );
  await f.client.sendOnce();
  assert.equal(f.sent[0].body.parts[0].value.type, "inspect");
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  assert.equal(
    f.client.inspect("paper", p.input.idempotencyKey).queries.length,
    1,
  );
  const query = f.client.inspect("paper", p.input.idempotencyKey).queries[0]
    .packet;
  f.enqueue(p.route, evidencePacket(query, "inspection", undefined));
  await f.client.receiveOnce();
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  const queries = f.client.inspect("paper", p.input.idempotencyKey).queries;
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0].packet.requestId, queries[1].packet.requestId);
  assert.deepEqual(await f.client.runs("paper").get(p.run.id), p.run);
});

test("unit client allows lookup after lease expiry and does not publish a held execute", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  f.setClock(f.now + 3_600_001);
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  assert.equal(await f.client.sendOnce(), true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.parts[0].value.type, "inspect");
  await assert.rejects(f.client.sendOnce(), /text_admission_denied/);
  assert.deepEqual(await f.client.runs("paper").get(p.run.id), p.run);
});

test("unit client retains ACK failure without adopting unconfirmed results", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  f.enqueue(
    p.route,
    evidencePacket(record.request, "outcome", {
      id: "unit-run",
      state: "succeeded",
      text: "durable",
    }),
  );
  f.failAck();
  await assert.rejects(f.client.receiveOnce(), /ack_transport_failed/);
  assert.equal((await f.client.runs("paper").get(p.run.id)).state, "running");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.client.receiveOnce();
  assert.equal((await f.client.runs("paper").get(p.run.id)).text, "durable");
});

test("unit client refuses authenticated-peer mismatch and fabricated correlations", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  const packet = evidencePacket(record.request, "outcome", {
    id: "unit-run",
    state: "succeeded",
    text: "forged",
  });
  f.enqueue(p.route, packet, "unit-untrusted");
  await assert.rejects(f.client.receiveOnce(), /foreign_text_packet/);
  assert.equal((await f.client.runs("paper").get(p.run.id)).state, "running");
});

test("unit client refuses unknown query identity even when all outer route fields match", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  const packet = evidencePacket(record.request, "outcome", {
    id: "unit-run",
    state: "succeeded",
    text: "forged",
  });
  f.enqueue(p.route, { ...packet, replyTo: "unit-unknown-query" });
  await assert.rejects(
    f.client.receiveOnce(),
    /text_evidence_correlation_denied/,
  );
  assert.equal((await f.client.runs("paper").get(p.run.id)).state, "running");
});

test("unit client preserves terminal evidence against late running and unknown replies", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  f.enqueue(
    p.route,
    evidencePacket(record.request, "outcome", {
      id: "unit-run",
      state: "succeeded",
      text: "final",
    }),
  );
  await f.client.receiveOnce();
  f.enqueue(
    p.route,
    evidencePacket(record.request, "admission", {
      id: "unit-run",
      state: "running",
    }),
  );
  await f.client.receiveOnce();
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  const query = f.client.inspect("paper", p.input.idempotencyKey).queries[0]
    .packet;
  f.enqueue(p.route, evidencePacket(query, "inspection", null));
  await f.client.receiveOnce();
  await f.reopen();
  assert.deepEqual(await f.client.runs("paper").get(p.run.id), {
    id: p.run.id,
    state: "succeeded",
    text: "final",
  });
});

test("unit client rejects changed actual runtime identity", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  f.enqueue(
    p.route,
    evidencePacket(record.request, "admission", {
      id: "unit-run-first",
      state: "running",
    }),
  );
  await f.client.receiveOnce();
  f.enqueue(
    p.route,
    evidencePacket(record.request, "outcome", {
      id: "unit-run-second",
      state: "succeeded",
      text: "wrong run",
    }),
  );
  await assert.rejects(
    f.client.receiveOnce(),
    /text_runtime_identity_conflict/,
  );
  assert.equal((await f.client.runs("paper").get(p.run.id)).state, "running");
});

test("unit client withholds acceptance after post-submit revocation and cannot expose cached result", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  f.onSubmit(async () => {
    await f.hub.authorization.setStopped(
      { kind: "client", id: p.identity.worker.clientId },
      true,
      await f.hub.authorization.epoch(),
      "unit-operator",
    );
  });
  await assert.rejects(f.client.sendOnce());
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.client.inspect("paper", p.input.idempotencyKey).delivery,
    "pending",
  );
  await assert.rejects(f.client.runs("paper").get(p.run.id));
});

test("unit client close drains active work and leaves caller-owned stores usable", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.onSubmit(() => blocked);
  const send = f.client.sendOnce();
  await new Promise((resolve) => setTimeout(resolve, 5));
  let closed = false;
  const close = f.client.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, false);
  release();
  await send;
  await close;
  await assert.rejects(f.client.sendOnce(), /text_client_closed/);
  assert.ok(f.journal.entry("client_jobs", p.run.id));
  assert.deepEqual(f.inbox.inbox(), []);
});

test("unit client makes a new read-only query after the previous query TTL expires", async (t) => {
  const f = fixture(t);
  const p = await f.prepare();
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  await f.client.sendOnce();
  const first = f.sent[0];
  f.setClock(f.now + 3_600_001);
  await f.client.requestStatus("paper", p.input.idempotencyKey);
  await f.client.sendOnce();
  assert.notEqual(f.sent[1].message_id, first.message_id);
  assert.equal(f.sent[1].body.parts[0].value.type, "inspect");
  assert.equal(f.sent[1].body.parts[0].value.handle, p.run.id);
  assert.equal(
    f.client.inspect("paper", p.input.idempotencyKey).queries[0].state,
    "expired",
  );
});

test("unit client rejects a Task witness changed across preparation awaits", async (t) => {
  const f = fixture(t);
  let checks = 0;
  f.onGate(async () => {
    if (++checks === 2)
      await f.hub.authorization.setStopped(
        { kind: "client", id: f.auth.get("paper").worker.clientId },
        true,
        await f.hub.authorization.epoch(),
        "unit-operator",
      );
  });
  await assert.rejects(f.prepare());
  assert.deepEqual(f.journal.list("client_jobs"), []);
  assert.equal(f.sent.length, 0);
});

test("unit client rejects duplicate recipient routes and mismatched coordinator transport", async (t) => {
  const f = fixture(t);
  const options = f.options();
  assert.throws(
    () =>
      new NatsTextClient({
        ...options,
        routes: [...options.routes, options.routes[0]],
      }),
    /invalid_text_routes/,
  );
  assert.throws(
    () =>
      new NatsTextClient({
        ...options,
        transport: { ...options.transport, agentId: "unit-other-coordinator" },
      }),
    /invalid_text_routes/,
  );
});

for (const [name, mutate, reason] of [
  ["wrong authenticated peer", (packet) => [packet, "unit-foreign"], /foreign_text_packet/],
  ["foreign route", (packet) => [{ ...packet, route: "unit-foreign" }], /unknown_text_route/],
  ["foreign scope", (packet) => [{ ...packet, scope: "0".repeat(64) }], /text_packet_conflict/],
  ["wrong fingerprint", (packet) => [{ ...packet, fingerprint: "0".repeat(64) }], /text_evidence_correlation_denied/],
  ["unknown correlation", (packet) => [{ ...packet, replyTo: "unit-unknown" }], /text_evidence_correlation_denied/],
  ["unknown handle", (packet, route) => {
    const key = `hub-${randomUUID()}`;
    return [{ ...packet, key, handle: handleFor(route, key) }];
  }, /unknown_text_handle/],
  ["malformed evidence", (packet) => [{ ...packet, run: { id: "unit-run", state: "succeeded" } }], /invalid_text_evidence/],
]) {
  test(`unit client quarantines ${name} once and adopts a later legitimate result across reopen`, async (t) => {
    const f = fixture(t);
    const p = await f.prepare();
    const record = f.client.inspect("paper", p.input.idempotencyKey);
    const packet = evidencePacket(record.request, "outcome", {
      id: "unit-run", state: "succeeded", text: "legitimate result",
    });
    const [bad, sender] = mutate(packet, p.route);
    f.enqueue(p.route, bad, sender);
    await assert.rejects(f.client.receiveOnce(), reason);
    assert.equal(f.inbox.inbox().length, 0, "rejected evidence no longer poisons the inbox");
    const quarantined = f.journal.list("client_rejected");
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0].data.reason, reason);
    assert.equal(quarantined[0].data.entry.sender_id, sender ?? p.route.recipient);
    assert.deepEqual(quarantined[0].data.entry.message.body.parts[0].value, bad);
    assert.equal(quarantined[0].data.entry.message.message_id, bad.requestId);
    assert.equal(quarantined[0].data.entry.receipt_confirmed, true);
    await f.reopen();
    await f.client.requestStatus("paper", p.input.idempotencyKey);
    const query = f.client.inspect("paper", p.input.idempotencyKey).queries[0].packet;
    f.enqueue(p.route, evidencePacket(query, "inspection", packet.run));
    await f.client.receiveOnce();
    assert.equal((await f.client.runs("paper").get(p.run.id)).text, "legitimate result");
    await f.client.receiveOnce();
    assert.equal(f.journal.list("client_rejected").length, 1);
  });
}

test("unit client retains poison evidence when its bounded durable quarantine is full", async (t) => {
  const f = fixture(t, ["paper"], { maxRecords: 1 });
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  const bad = evidencePacket(record.request, "outcome", {
    id: "unit-run", state: "succeeded", text: "retained body",
  });
  f.enqueue(p.route, bad, "unit-foreign");
  await assert.rejects(f.client.receiveOnce(), /text_journal_capacity/);
  assert.deepEqual(f.inbox.inbox()[0].message.body.parts[0].value, bad);
  assert.deepEqual(f.journal.list("client_rejected"), []);
});

for (const failure of ["authorization", "transient gate", "changed epoch", "journal write"]) {
  test(`unit client retains valid evidence after ${failure} and adopts it when permitted`, async (t) => {
    const f = fixture(t);
    const p = await f.prepare();
    const record = f.client.inspect("paper", p.input.idempotencyKey);
    f.enqueue(p.route, evidencePacket(record.request, "outcome", {
      id: "unit-run", state: "succeeded", text: "held result",
    }));
    if (failure === "authorization") await f.hub.authorization.setStopped(
      { kind: "client", id: p.identity.worker.clientId }, true,
      await f.hub.authorization.epoch(), "unit-operator",
    );
    let checks = 0;
    if (failure === "transient gate") f.onGate(() => { throw Error("unit_gate_unavailable"); });
    if (failure === "changed epoch") f.onGate(async () => {
      if (++checks === 2) {
        await f.hub.authorization.setStopped(
          { kind: "client", id: p.identity.worker.clientId }, true,
          await f.hub.authorization.epoch(), "unit-operator",
        );
        await f.hub.authorization.setStopped(
          { kind: "client", id: p.identity.worker.clientId }, false,
          await f.hub.authorization.epoch(), "unit-operator",
        );
      }
    });
    const set = f.journal.set;
    if (failure === "journal write") f.journal.set = () => { throw Error("unit_store_unavailable"); };
    await assert.rejects(f.client.receiveOnce());
    assert.equal(f.inbox.inbox().length, 1, "valid body stays available for authorized retry");
    assert.deepEqual(f.journal.list("client_rejected"), []);
    f.onGate(undefined);
    f.journal.set = set;
    if (failure === "authorization") await f.hub.authorization.setStopped(
      { kind: "client", id: p.identity.worker.clientId }, false,
      await f.hub.authorization.epoch(), "unit-operator",
    );
    await f.client.receiveOnce();
    assert.equal((await f.client.runs("paper").get(p.run.id)).text, "held result");
    assert.deepEqual(f.inbox.inbox(), []);
  });
}

test("unit client quarantines terminal runtime conflicts and preserves known terminal evidence", async (t) => {
  const f = fixture(t, ["paper", "mirror"]);
  const p = await f.prepare("paper");
  const other = await f.prepare("mirror");
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  f.enqueue(p.route, evidencePacket(record.request, "outcome", {
    id: "unit-known-run", state: "succeeded", text: "known terminal",
  }));
  await f.client.receiveOnce();
  for (const run of [
    { id: "unit-foreign-run", state: "succeeded", text: "conflicting runtime" },
    { id: "unit-known-run", state: "succeeded", text: "conflicting terminal" },
  ]) {
    await f.client.requestStatus("paper", p.input.idempotencyKey);
    const query = f.client.inspect("paper", p.input.idempotencyKey).queries.at(-1).packet;
    f.enqueue(p.route, evidencePacket(query, "inspection", run));
    await assert.rejects(f.client.receiveOnce(), /text_(runtime_identity|terminal_evidence)_conflict/);
    assert.deepEqual(f.inbox.inbox(), []);
    f.setClock(f.now + 3_600_001);
  }
  const otherRecord = f.client.inspect("mirror", other.input.idempotencyKey);
  f.enqueue(other.route, evidencePacket(otherRecord.request, "outcome", {
    id: "unit-other-run", state: "succeeded", text: "other result",
  }));
  await f.client.receiveOnce();
  assert.equal((await f.client.runs("paper").get(p.run.id)).text, "known terminal");
  assert.equal((await f.client.runs("mirror").get(other.run.id)).text, "other result");
  assert.equal(f.journal.list("client_rejected").length, 2);
});

test("unit client retains valid evidence across actual journal capacity failure and retry", async (t) => {
  const f = fixture(t, ["paper"], { maxBytes: 3000 });
  const p = await f.prepare();
  const record = f.client.inspect("paper", p.input.idempotencyKey);
  const text = "capacity retained result ".repeat(200);
  f.enqueue(p.route, evidencePacket(record.request, "outcome", {
    id: "unit-run", state: "succeeded", text,
  }));
  await assert.rejects(f.client.receiveOnce(), /text_journal_capacity/);
  assert.equal(f.inbox.inbox().length, 1);
  assert.deepEqual(f.journal.list("client_rejected"), []);
  await f.reopen({ maxBytes: 20_000 });
  await f.client.receiveOnce();
  assert.equal((await f.client.runs("paper").get(p.run.id)).text, text);
  assert.deepEqual(f.inbox.inbox(), []);
});
