// Delivery guarantees that the retired SQLite store's tests covered, proven on the JetStream journal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
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

test("fair poll alternates eligible senders despite one sender's older backlog", async (t) => {
  // The host always prefetches the whole per-recipient window; fairness needs every sender visible.
  const f = await fixture(t, { fair_poll: true, prefetch_per_recipient: 5 });
  const backlog = [f.message(), f.message(), f.message()];
  for (const message of backlog) await f.submit("a", message);
  const late = f.message();
  await f.submit("c", late);
  // The host serves polls from the pump's cached candidates, where fairness applies.
  const { authorization } = f.options;
  const order = [];
  for (let i = 0; i < 4; i++) {
    for (let cycle = 0; cycle < 4; cycle++) await f.backend.pumpOnce();
    const delivery = f.backend.pollWithAuthorization("b", authorization);
    order.push(delivery.message.sender_id);
    f.backend.ackWithAuthorization(
      "b",
      ackRequest(delivery, "fair-" + i),
      authorization,
    );
  }
  assert.deepEqual(order, ["a", "c", "a", "a"]);
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
