// Delivery guarantees that the retired SQLite store's tests covered, proven on the JetStream journal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { JetStreamRelay } from "../src/backend.ts";
import {
  MAX_ACK_RETRY_MS,
  RECORD_RETENTION_MS,
} from "../../../src/messaging/contract.ts";
import { fixture, ackRequest } from "./fixture.js";

function journal(t, f) {
  const raw = new DatabaseSync(f.options.journal_path);
  t.after(() => raw.close());
  return {
    raw,
    events: (message_id) =>
      raw
        .prepare(
          "SELECT event FROM nats_delivery_audit WHERE message_id=? ORDER BY id",
        )
        .all(message_id)
        .map((row) => row.event),
    row: (message_id) =>
      raw
        .prepare("SELECT * FROM nats_messages WHERE message_id=?")
        .get(message_id),
    count: (table) =>
      Number(raw.prepare(`SELECT count(*) n FROM ${table}`).get().n),
    totals: () =>
      raw.prepare("SELECT expired,purged FROM nats_maintenance_totals").get(),
    failAudit(event) {
      raw.exec(
        `CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON nats_delivery_audit WHEN NEW.event='${event}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`,
      );
    },
    restoreAudit() {
      raw.exec("DROP TRIGGER synthetic_audit_failure");
    },
  };
}
// The contract fixes a one-hour TTL, so a soon-expiring message was sent almost an hour ago.
function expiring(f, ms, recipient = "b") {
  const expiry = Date.now() + ms;
  return f.message(recipient, {
    first_sent_at: new Date(expiry - 3_600_000).toISOString(),
    expires_at: new Date(expiry).toISOString(),
  });
}
// The journal reads Date.now() for every decision; the broker keeps its own clock.
function clock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  return { advance: (ms) => t.mock.timers.tick(ms) };
}
function senderCapacity(patch = {}) {
  return {
    max_pending_per_sender: 5,
    max_body_bytes_per_sender: 50_000,
    max_records_per_sender: 20,
    max_body_bytes_per_recipient: 50_000,
    max_records_per_recipient: 20,
    reservations: [],
    ...patch,
  };
}
// The host serves polls from the pump's cached candidates, where fairness applies.
async function cachedPollOrder(f, count) {
  const { authorization } = f.options;
  const order = [];
  for (let i = 0; i < count; i++) {
    for (let cycle = 0; cycle < 4; cycle++) await f.backend.pumpOnce();
    const delivery = f.backend.pollWithAuthorization("b", authorization);
    order.push(delivery.message.sender_id);
    f.backend.ackWithAuthorization(
      "b",
      ackRequest(delivery, "order-" + i),
      authorization,
    );
  }
  return order;
}
async function deliverAndAck(f, message, request_id) {
  await f.submit("a", message);
  return f.ack("b", ackRequest(await f.poll("b"), request_id));
}
// A message ID the journal may purge: bound to its original send time and TTL.
function replayBound(f, recipient = "b", patch = {}) {
  const sent = Date.now() - 50;
  return f.message(recipient, {
    message_id: `rm1.${sent}.${randomBytes(16).toString("hex")}`,
    first_sent_at: new Date(sent).toISOString(),
    expires_at: new Date(sent + 3_600_000).toISOString(),
    ...patch,
  });
}

test("each delivery state change writes one redacted audit event", async (t) => {
  const f = await fixture(t);
  const j = journal(t, f);
  const message = f.message();
  await f.submit("a", message);
  const delivery = await f.poll("b");
  await f.ack("b", ackRequest(delivery));
  assert.deepEqual(j.events(message.message_id), [
    "accepted",
    "leased",
    "acked",
  ]);
  assert.deepEqual(
    j.raw
      .prepare("PRAGMA table_info(nats_delivery_audit)")
      .all()
      .map((column) => column.name),
    ["id", "sender_id", "message_id", "at", "event"],
  );
});

test("audit failure rolls back admission, lease and ACK with their state; a retry commits", async (t) => {
  const f = await fixture(t, { max_pending: 1, max_pending_per_recipient: 1 });
  const j = journal(t, f);
  const message = f.message();
  j.failAudit("accepted");
  await assert.rejects(f.submit("a", message));
  assert.equal(j.count("nats_messages"), 0);
  assert.equal(j.count("nats_delivery_audit"), 0);
  j.restoreAudit();
  // The rolled-back admission consumed no allowance from the one-message pool.
  const receipt = await f.submit("a", message);
  assert.equal(receipt.state, "pending");

  j.failAudit("leased");
  await assert.rejects(f.poll("b"));
  const unleased = j.row(message.message_id);
  assert.equal(unleased.state, "pending");
  assert.equal(unleased.generation, 0);
  assert.equal(unleased.token_hash, null);
  j.restoreAudit();
  const delivery = await f.poll("b");
  assert.equal(delivery.generation, 1);

  j.failAudit("acked");
  await assert.rejects(f.ack("b", ackRequest(delivery)));
  const unacked = j.row(message.message_id);
  assert.equal(unacked.state, "leased");
  assert.equal(unacked.ack_request_id, null);
  assert.ok(unacked.body_bytes > 0);
  j.restoreAudit();
  assert.equal((await f.ack("b", ackRequest(delivery))).state, "acked");
  assert.deepEqual(j.events(message.message_id), [
    "accepted",
    "leased",
    "acked",
  ]);
});

test("missing maintenance totals fail closed instead of losing the expiry and purge counts", async (t) => {
  const f = await fixture(t);
  const j = journal(t, f);
  const message = expiring(f, 400);
  await f.submit("a", message);
  await delay(450);
  j.raw.exec("DELETE FROM nats_maintenance_totals");
  await assert.rejects(f.status("a", message.message_id), {
    code: "maintenance_state_unavailable",
  });
  await assert.rejects(f.backend.maintain("admin"), {
    code: "maintenance_state_unavailable",
  });
  assert.equal(j.row(message.message_id).state, "pending");
  assert.deepEqual(j.events(message.message_id), ["accepted"]);
  j.raw.exec(
    "INSERT INTO nats_maintenance_totals(id,last_at,expired,purged) VALUES(1,0,0,0)",
  );
  assert.equal((await f.status("a", message.message_id)).state, "expired");
  assert.equal(j.totals().expired, 1);
  assert.deepEqual(j.events(message.message_id), ["accepted", "expired"]);
});

test("journal clock refuses future and already expired messages; an expired duplicate never resurrects its body", async (t) => {
  const f = await fixture(t);
  const j = journal(t, f);
  const now = Date.now();
  await assert.rejects(
    f.submit(
      "a",
      f.message("b", {
        first_sent_at: new Date(now + 60_000).toISOString(),
        expires_at: new Date(now + 60_000 + 3_600_000).toISOString(),
      }),
    ),
    { code: "clock_skew" },
  );
  await assert.rejects(
    f.submit(
      "a",
      f.message("b", {
        first_sent_at: new Date(now - 3_601_000).toISOString(),
        expires_at: new Date(now - 1000).toISOString(),
      }),
    ),
    { code: "expired_before_acceptance" },
  );
  assert.equal(j.count("nats_messages"), 0);
  const short = expiring(f, 300);
  const receipt = await f.submit("a", short);
  await delay(350);
  const again = await f.submit("a", short);
  assert.equal(again.receipt_id, receipt.receipt_id);
  assert.equal(again.state, "expired");
  const row = j.row(short.message_id);
  assert.equal(row.outbox, null);
  assert.equal(row.candidate, null);
  assert.equal(row.body_bytes, 0);
  assert.equal(await f.poll("b"), null);
});

test("replies stay inside their agent pair; forged or cross-pair references fail", async (t) => {
  const f = await fixture(t);
  const j = journal(t, f);
  const question = f.message("b", { thread_id: "shared-name" });
  await f.submit("a", question);
  const reply = (patch) =>
    f.message("a", {
      kind: "answer",
      thread_id: "shared-name",
      in_reply_to: { sender_id: "a", message_id: question.message_id },
      ...patch,
    });
  // A third agent cannot answer a message that was not sent to it.
  await assert.rejects(f.submit("c", reply()), {
    code: "invalid_reference",
  });
  await assert.rejects(f.submit("b", reply({ thread_id: "other" })), {
    code: "invalid_reference",
  });
  await assert.rejects(
    f.submit(
      "b",
      reply({ in_reply_to: { sender_id: "a", message_id: "missing" } }),
    ),
    { code: "invalid_reference" },
  );
  assert.equal((await f.submit("b", reply())).state, "pending");
  // The same thread name between a different pair is a different thread.
  const squat = f.message("b", { thread_id: "shared-name" });
  await f.submit("c", squat);
  assert.notEqual(
    j.row(squat.message_id).thread_key,
    j.row(question.message_id).thread_key,
  );
  await assert.rejects(
    f.submit(
      "c",
      f.message("b", {
        kind: "answer",
        thread_id: "shared-name",
        in_reply_to: { sender_id: "a", message_id: question.message_id },
      }),
    ),
    { code: "invalid_reference" },
  );
});

test("wrong token, foreign inbox and ACK after expiry never confirm receipt", async (t) => {
  const f = await fixture(t, { lease_ms: 5000 });
  const j = journal(t, f);
  const message = expiring(f, 600);
  await f.submit("a", message);
  const delivery = await f.poll("b");
  await assert.rejects(f.ack("c", ackRequest(delivery)), {
    code: "invalid_ack",
  });
  await assert.rejects(
    f.ack("b", {
      ...ackRequest(delivery),
      lease_token: "A".repeat(43),
    }),
    { code: "invalid_ack" },
  );
  await assert.rejects(
    f.ack("b", {
      ...ackRequest(delivery),
      recipient_id: "c",
    }),
  );
  await delay(650);
  await assert.rejects(f.ack("b", ackRequest(delivery)), {
    code: "invalid_ack",
  });
  assert.equal((await f.status("a", message.message_id)).state, "expired");
  assert.equal(j.row(message.message_id).ack_request_id, null);
  assert.deepEqual(j.events(message.message_id), [
    "accepted",
    "leased",
    "expired",
  ]);
});

test("maintenance needs its own authorization and purges the message with its audit trail", async (t) => {
  const f = await fixture(t);
  const j = journal(t, f);
  await assert.rejects(f.backend.maintain("a"));
  const bound = replayBound(f);
  const unbound = f.message();
  for (const message of [bound, unbound]) {
    await f.submit("a", message);
    const delivery = await f.poll("b");
    await f.ack("b", ackRequest(delivery, "ack-" + message.message_id));
  }
  j.raw.exec("UPDATE nats_messages SET retain_until=0");
  const result = await f.backend.maintain("admin");
  assert.equal(result.purged, 1);
  assert.equal(result.safety_held, 1);
  assert.equal(j.row(bound.message_id), undefined);
  assert.deepEqual(j.events(bound.message_id), []);
  assert.deepEqual(j.events(unbound.message_id), [
    "accepted",
    "leased",
    "acked",
  ]);
  assert.equal(j.totals().purged, 1);
});

test("maintenance keeps an ACKed record through its committed ACK retry horizon and retention", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const message = replayBound(f);
  await f.submit("a", message);
  const request = ackRequest(await f.poll("b"), "horizon");
  const receipt = await f.ack("b", request);
  time.advance(MAX_ACK_RETRY_MS + RECORD_RETENTION_MS - 1);
  assert.equal((await f.backend.maintain("admin")).purged, 0);
  assert.deepEqual(await f.ack("b", request), receipt);
  assert.equal((await f.status("a", message.message_id)).state, "acked");
  time.advance(1);
  assert.equal((await f.backend.maintain("admin")).purged, 1);
  await assert.rejects(f.status("a", message.message_id), {
    code: "not_found",
  });
});

test("unbound message IDs are safety-held without starving a purgeable ID in the same batch", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const unbound = [f.message(), f.message()];
  const bound = replayBound(f);
  for (const [i, message] of [...unbound, bound].entries())
    await deliverAndAck(f, message, `held-${i}`);
  time.advance(MAX_ACK_RETRY_MS + RECORD_RETENTION_MS);
  const result = await f.backend.maintain("admin", 1);
  assert.equal(result.purged, 1);
  assert.equal(result.safety_held, 2);
  await assert.rejects(f.status("a", bound.message_id), {
    code: "not_found",
  });
  for (const message of unbound)
    assert.equal((await f.status("a", message.message_id)).state, "acked");
});

test("maintenance purges at most its batch limit and leaves pending work deliverable", async (t) => {
  const f = await fixture(t);
  const time = clock(t);
  const old = [replayBound(f), replayBound(f), replayBound(f)];
  for (const [i, message] of old.entries())
    await deliverAndAck(f, message, `old-${i}`);
  time.advance(MAX_ACK_RETRY_MS + RECORD_RETENTION_MS);
  const live = replayBound(f);
  await f.submit("a", live);
  assert.equal((await f.backend.maintain("admin", 2)).purged, 2);
  assert.equal((await f.backend.maintain("admin", 2)).purged, 1);
  for (const message of old)
    await assert.rejects(f.status("a", message.message_id), {
      code: "not_found",
    });
  const delivery = await f.poll("b");
  assert.equal(delivery.message.message_id, live.message_id);
  assert.deepEqual(delivery.message.body, live.body);
});

test("fair poll alternates eligible senders despite one sender's older backlog", async (t) => {
  // The host always prefetches the whole per-recipient window; fairness needs every sender visible.
  const f = await fixture(t, { fair_poll: true, prefetch_per_recipient: 5 });
  const backlog = [f.message(), f.message(), f.message()];
  for (const message of backlog) await f.submit("a", message);
  const late = f.message();
  await f.submit("c", late);
  assert.deepEqual(await cachedPollOrder(f, 4), ["a", "c", "a", "a"]);
});

test("fair poll opt-out keeps arrival order on the pump-cached path", async (t) => {
  const f = await fixture(t, { fair_poll: false, prefetch_per_recipient: 5 });
  for (let i = 0; i < 3; i++) await f.submit("a", f.message());
  await f.submit("c", f.message());
  assert.deepEqual(await cachedPollOrder(f, 4), ["a", "a", "a", "c"]);
});

test("expiry frees a sender's pending allowance but keeps the record and its receipt", async (t) => {
  const f = await fixture(t, {
    max_pending: 4,
    agent_capacity: {
      max_pending_per_sender: 1,
      max_body_bytes_per_sender: 50_000,
      max_records_per_sender: 3,
      max_body_bytes_per_recipient: 50_000,
      max_records_per_recipient: 10,
      reservations: [],
    },
  });
  const first = expiring(f, 300);
  const receipt = await f.submit("a", first);
  await assert.rejects(f.submit("a", f.message()), {
    code: "capacity_exceeded",
  });
  await delay(350);
  assert.equal((await f.submit("a", f.message())).state, "pending");
  const replay = await f.submit("a", first);
  assert.equal(replay.receipt_id, receipt.receipt_id);
  assert.equal(replay.state, "expired");
});

test("leased and quarantined messages still consume the sender's pending allowance", async (t) => {
  const f = await fixture(t, {
    agent_capacity: senderCapacity({ max_pending_per_sender: 1 }),
  });
  const time = clock(t);
  const stuck = f.message();
  await f.submit("a", stuck);
  for (let attempt = 1; attempt <= f.options.max_attempts; attempt++) {
    assert.equal((await f.poll("b")).generation, attempt);
    await assert.rejects(f.submit("a", f.message()), {
      code: "capacity_exceeded",
    });
    time.advance(f.options.lease_ms + f.options.retry_cap_ms);
  }
  assert.equal((await f.status("a", stuck.message_id)).state, "quarantined");
  await assert.rejects(f.submit("a", f.message()), {
    code: "capacity_exceeded",
  });
  assert.equal((await f.submit("c", f.message())).state, "pending");
});

test("a recipient's live bytes and retained records are bounded independently", async (t) => {
  const f = await fixture(t, {
    agent_capacity: senderCapacity({
      max_body_bytes_per_recipient: 6000,
      max_records_per_recipient: 2,
    }),
  });
  const large = () =>
    f.message("b", {
      body: { parts: [{ type: "text", text: "x".repeat(4000) }] },
    });
  await f.submit("a", large());
  // One live large body leaves no byte room for a second, though a record slot is free.
  await assert.rejects(f.submit("c", large()), { code: "capacity_exceeded" });
  await f.ack("b", ackRequest(await f.poll("b"), "bytes-1"));
  await f.submit("c", large());
  await f.ack("b", ackRequest(await f.poll("b"), "bytes-2"));
  // Both ACKed records keep counting, though their bodies no longer do.
  await assert.rejects(f.submit("a", f.message()), {
    code: "capacity_exceeded",
  });
  assert.equal((await f.submit("a", f.message("c"))).state, "pending");
});

test("invalid, duplicate or infeasible capacity reservations refuse to open before the journal changes", async (t) => {
  const f = await fixture(t, { max_body_bytes: 10_000 });
  const accepted = f.message();
  await f.submit("a", accepted);
  const valid = senderCapacity({
    max_body_bytes_per_sender: 10_000,
    max_body_bytes_per_recipient: 10_000,
    reservations: [
      { sender_id: "c", pending: 1, body_bytes: 1000, records: 1 },
    ],
  });
  const refused = [
    null,
    { ...valid, max_records_per_sender: 0 },
    { ...valid, reservations: [...valid.reservations, valid.reservations[0]] },
    {
      ...valid,
      reservations: [{ sender_id: "c", pending: 6, body_bytes: 1, records: 6 }],
    },
    {
      ...valid,
      reservations: [{ sender_id: "c", pending: 2, body_bytes: 1, records: 1 }],
    },
    {
      ...valid,
      reservations: [
        { sender_id: "a", pending: 1, body_bytes: 6000, records: 1 },
        { sender_id: "c", pending: 1, body_bytes: 6000, records: 1 },
      ],
    },
  ];
  const existing = readFileSync(f.options.journal_path);
  const fresh = join(f.dir, "refused.sqlite");
  for (const agent_capacity of refused)
    for (const journal_path of [f.options.journal_path, fresh])
      await assert.rejects(
        JetStreamRelay.open({ ...f.options, journal_path, agent_capacity }),
        { code: "invalid_agent_capacity_policy" },
      );
  assert.equal(existsSync(fresh), false);
  assert.deepEqual(readFileSync(f.options.journal_path), existing);
  assert.equal((await f.status("a", accepted.message_id)).state, "pending");
});

// Each gateway process opens its own journal connection and broker session.
const racer = `
const { JetStreamRelay } = await import(process.argv[1]);
process.once("message", async ({ options, message }) => {
  const authorization = { authorize: (context) => ({ agent_id: context }) };
  const backend = await JetStreamRelay.open({ ...options, authorization });
  process.send("ready");
  process.once("message", async () => {
    let outcome = "accepted";
    try {
      backend.admitWithAuthorization("a", message, authorization);
    } catch (error) {
      outcome = error.code ?? "failed";
    }
    await backend.close();
    process.send(outcome);
    process.disconnect();
  });
});
`;
async function spawnRacer(t, f, message) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      racer,
      new URL("../src/backend.ts", import.meta.url).href,
    ],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    },
  );
  t.after(() => child.kill("SIGKILL"));
  const options = { ...f.options };
  delete options.authorization;
  child.send({ options, message });
  const [ready] = await once(child, "message");
  assert.equal(ready, "ready");
  return child;
}

test("concurrent gateway processes cannot spend the same last unreserved slot", async (t) => {
  const f = await fixture(t, {
    max_pending: 3,
    agent_capacity: senderCapacity({
      max_pending_per_sender: 3,
      reservations: [
        { sender_id: "c", pending: 1, body_bytes: 2000, records: 1 },
      ],
    }),
  });
  await f.submit("a", f.message());
  const messages = [f.message(), f.message()];
  const racers = await Promise.all(
    messages.map((message) => spawnRacer(t, f, message)),
  );
  const outcomes = racers.map(
    async (child) => (await once(child, "message"))[0],
  );
  for (const child of racers) child.send("go");
  assert.deepEqual((await Promise.all(outcomes)).sort(), [
    "accepted",
    "capacity_exceeded",
  ]);
  const states = await Promise.all(
    messages.map((message) =>
      f.status("a", message.message_id).then(
        (receipt) => receipt.state,
        (error) => error.code,
      ),
    ),
  );
  assert.deepEqual(states.sort(), ["not_found", "pending"]);
  // The reserved slot for "c" survived the race.
  assert.equal((await f.submit("c", f.message())).state, "pending");
  await assert.rejects(f.submit("a", f.message()), {
    code: "capacity_exceeded",
  });
});
