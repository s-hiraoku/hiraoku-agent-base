import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { JetStreamRelay } from "../src/backend.ts";
import { fixture, ackRequest } from "./fixture.js";

function scope(context, operation, action, peerAllowed = () => true) {
  let active = true;
  const authorization = {
    authorize(incoming, op, peer) {
      return active &&
        incoming === context &&
        op === operation &&
        (peer === undefined || peerAllowed(peer))
        ? { agent_id: context }
        : undefined;
    },
  };
  try {
    const result = action(authorization);
    assert.equal(result instanceof Promise, false);
    return result;
  } finally {
    active = false;
  }
}
function raw(t, path) {
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  return db;
}
const admit = (backend, sender, message) =>
  scope(sender, "submit", (auth) =>
    backend.admitWithAuthorization(sender, message, auth),
  );
const poll = (backend, recipient, peerAllowed) =>
  scope(
    recipient,
    "poll",
    (auth) => backend.pollWithAuthorization(recipient, auth),
    peerAllowed,
  );
const acknowledge = (backend, recipient, request) =>
  scope(recipient, "ack", (auth) =>
    backend.ackWithAuthorization(recipient, request, auth),
  );

test("pump retains no scoped authority and synchronous save receipt survives candidate reopen", async (t) => {
  const f = await fixture(t, {
    authorization: {
      authorize() {
        throw Error("constructor authorization must not be used");
      },
    },
  });
  const message = f.message();
  let stale;
  const accepted = scope("a", "submit", (auth) => {
    stale = auth;
    return f.backend.admitWithAuthorization("a", message, auth);
  });
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.throws(
    () => f.backend.admitWithAuthorization("a", f.message(), stale),
    { code: "forbidden" },
  );
  await f.backend.pumpOnce();
  const journal = raw(t, f.options.journal_path);
  const before = journal
    .prepare("SELECT candidate,state,generation FROM nats_messages")
    .get();
  assert.equal(typeof before.candidate, "string");
  assert.equal(before.state, "pending");
  assert.equal(before.generation, 0);
  await f.close(f.backend);
  const reopened = f.track(await JetStreamRelay.open(f.options));
  const delivery = poll(reopened, "b");
  assert.deepEqual(delivery.message, { ...message, sender_id: "a" });
  assert.equal(
    reopened.lookupReceipt("a", message.message_id).receipt_id,
    accepted.receipt_id,
  );
  const receipt = acknowledge(reopened, "b", ackRequest(delivery));
  assert.equal(receipt.state, "acked");
  assert.equal(
    journal.prepare("SELECT candidate FROM nats_messages").get().candidate,
    null,
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  await reopened.pumpOnce();
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.deepEqual(acknowledge(reopened, "b", ackRequest(delivery)), receipt);
});

test("bounded prefetch skips a forbidden sender without ACK/drop and reactivation restores its candidate", async (t) => {
  const f = await fixture(t, { prefetch_per_recipient: 2 });
  const blocked = f.message();
  const permitted = f.message();
  admit(f.backend, "a", blocked);
  admit(f.backend, "c", permitted);
  await f.backend.pumpOnce();
  const journal = raw(t, f.options.journal_path);
  assert.equal(
    journal
      .prepare(
        "SELECT count(*) n FROM nats_messages WHERE candidate IS NOT NULL",
      )
      .get().n,
    2,
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 2);
  const delivery = poll(f.backend, "b", (peer) => peer !== "a");
  assert.equal(delivery.message.message_id, permitted.message_id);
  acknowledge(f.backend, "b", ackRequest(delivery, "permitted-ack"));
  await f.backend.pumpOnce();
  assert.equal(
    poll(f.backend, "b", (peer) => peer !== "a"),
    null,
  );
  assert.equal(
    f.backend.lookupReceipt("a", blocked.message_id).state,
    "pending",
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  const restored = poll(f.backend, "b");
  assert.equal(restored.message.message_id, blocked.message_id);
  acknowledge(f.backend, "b", ackRequest(restored, "restored-ack"));
  await f.backend.pumpOnce();
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
});

test("prefetch window remains bounded and callback failure cannot consume an application attempt", async (t) => {
  const f = await fixture(t, { prefetch_per_recipient: 2 });
  for (let n = 0; n < 3; n++) admit(f.backend, "a", f.message());
  await f.backend.pumpOnce();
  const journal = raw(t, f.options.journal_path);
  assert.equal(
    journal
      .prepare(
        "SELECT count(*) n FROM nats_messages WHERE candidate IS NOT NULL",
      )
      .get().n,
    2,
  );
  assert.equal(
    journal.prepare("SELECT sum(generation) n FROM nats_messages").get().n,
    0,
  );
  assert.throws(
    () =>
      f.backend.pollWithAuthorization("b", {
        authorize() {
          return undefined;
        },
      }),
    { code: "forbidden" },
  );
  assert.equal(
    journal.prepare("SELECT sum(generation) n FROM nats_messages").get().n,
    0,
  );
});

test("cached redelivery preserves backoff and rejects an old application fence", async (t) => {
  const f = await fixture(t, {
    lease_ms: 80,
    retry_base_ms: 60,
    retry_cap_ms: 120,
  });
  admit(f.backend, "a", f.message());
  await f.backend.pumpOnce();
  const first = poll(f.backend, "b");
  await delay(100);
  assert.equal(poll(f.backend, "b"), null);
  await delay(70);
  const second = poll(f.backend, "b");
  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => acknowledge(f.backend, "b", ackRequest(first)), {
    code: "invalid_ack",
  });
  acknowledge(f.backend, "b", ackRequest(second));
  await f.backend.pumpOnce();
});

test("routing epoch pins new admissions, preserves exact retries, and persists next-owner turn", async (t) => {
  const f = await fixture(t, { route_epoch: 1 });
  const first = f.message();
  f.backend.configureRouting(1, "a".repeat(64));
  f.backend.configureRouting(1, "a".repeat(64));
  const accepted = admit(f.backend, "a", first);
  f.backend.recordPollTurn("b", "jetstream");
  const advanced = f.track(
    await JetStreamRelay.open({ ...f.options, route_epoch: 2 }),
  );
  advanced.configureRouting(2, "b".repeat(64));
  assert.equal(advanced.pollTurn("b"), "jetstream");
  assert.throws(() => f.backend.configureRouting(1, "a".repeat(64)), {
    code: "routing_epoch_rejected",
  });
  assert.throws(() => admit(f.backend, "a", f.message()), {
    code: "routing_epoch_rejected",
  });
  assert.equal(admit(f.backend, "a", first).receipt_id, accepted.receipt_id);
  assert.throws(() => advanced.configureRouting(2, "c".repeat(64)), {
    code: "routing_epoch_rejected",
  });
  const second = f.message();
  admit(advanced, "c", second);
  const journal = raw(t, f.options.journal_path);
  assert.equal(
    journal
      .prepare("SELECT route_epoch FROM nats_messages WHERE message_id=?")
      .get(first.message_id).route_epoch,
    1,
  );
  assert.equal(
    journal
      .prepare("SELECT route_epoch FROM nats_messages WHERE message_id=?")
      .get(second.message_id).route_epoch,
    2,
  );
  assert.equal(advanced.pollTurn("unknown"), "sqlite");
});

const capacity = {
  max_pending_per_sender: 2,
  max_body_bytes_per_sender: 10000,
  max_records_per_sender: 2,
  max_body_bytes_per_recipient: 50000,
  max_records_per_recipient: 50,
  reservations: [],
};
test("per-sender retained-record budget is enforced inside admission without penalizing another sender", async (t) => {
  const f = await fixture(t, { agent_capacity: capacity });
  const first = f.message();
  admit(f.backend, "a", first);
  admit(f.backend, "a", f.message());
  assert.throws(() => admit(f.backend, "a", f.message()), {
    code: "capacity_exceeded",
  });
  admit(f.backend, "c", f.message());
  await f.backend.pumpOnce();
  const delivery = poll(f.backend, "b");
  acknowledge(f.backend, "b", ackRequest(delivery));
  assert.throws(() => admit(f.backend, "a", f.message()), {
    code: "capacity_exceeded",
  });
  assert.equal(
    admit(f.backend, "a", first).receipt_id,
    f.backend.lookupReceipt("a", first.message_id).receipt_id,
  );
});

test("capacity reservations keep a second sender's admission available", async (t) => {
  const f = await fixture(t, {
    max_pending: 3,
    max_records: 10,
    agent_capacity: {
      max_pending_per_sender: 3,
      max_body_bytes_per_sender: 50000,
      max_records_per_sender: 5,
      max_body_bytes_per_recipient: 50000,
      max_records_per_recipient: 10,
      reservations: [
        { sender_id: "c", pending: 2, body_bytes: 2000, records: 2 },
      ],
    },
  });
  admit(f.backend, "a", f.message());
  assert.throws(() => admit(f.backend, "a", f.message()), {
    code: "capacity_exceeded",
  });
  admit(f.backend, "c", f.message());
});

test("P4 journal upgrade requires explicit migration and preserves the admitted body and receipt", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const accepted = admit(f.backend, "a", message);
  await f.close(f.backend);
  const journal = raw(t, f.options.journal_path);
  journal.exec(
    "DROP INDEX nats_cached_candidates; DROP TABLE nats_routing; DROP TABLE nats_poll_turns; ALTER TABLE nats_messages DROP COLUMN candidate; ALTER TABLE nats_messages DROP COLUMN route_epoch; ALTER TABLE nats_messages DROP COLUMN scan_order; UPDATE nats_meta SET version=1",
  );
  await assert.rejects(JetStreamRelay.open(f.options), {
    code: "journal_migration_required",
  });
  assert.equal(
    journal.prepare("SELECT version FROM nats_meta").get().version,
    1,
  );
  assert.equal(
    journal
      .prepare("PRAGMA table_info(nats_messages)")
      .all()
      .some((row) => row.name === "candidate"),
    false,
  );
  const migrated = f.track(
    await JetStreamRelay.open({ ...f.options, migrate_journal: true }),
  );
  assert.equal(
    journal.prepare("SELECT version FROM nats_meta").get().version,
    3,
  );
  assert.equal(
    migrated.lookupReceipt("a", message.message_id).receipt_id,
    accepted.receipt_id,
  );
  await migrated.pumpOnce();
  assert.deepEqual(poll(migrated, "b").message, { ...message, sender_id: "a" });
});

test("changed durable candidate fails integrity verification before leasing", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  admit(f.backend, "a", message);
  await f.backend.pumpOnce();
  const journal = raw(t, f.options.journal_path);
  const altered = {
    sender_id: "a",
    message: {
      ...message,
      body: { parts: [{ type: "text", text: "altered" }] },
    },
  };
  journal
    .prepare("UPDATE nats_messages SET candidate=?")
    .run(JSON.stringify(altered));
  assert.throws(() => poll(f.backend, "b"), {
    code: "journal_integrity_failed",
  });
  assert.equal(
    journal.prepare("SELECT generation FROM nats_messages").get().generation,
    0,
  );
});

test("concurrent new journal initialization creates one schema identity", async (t) => {
  const f = await fixture(t);
  const path = `${f.dir}/concurrent.sqlite`;
  const shared = new SharedArrayBuffer(4);
  let ready = 0;
  const run = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        `
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.module).then(({ NatsJournal }) => {
        parentPort.postMessage("ready");
        Atomics.wait(new Int32Array(workerData.shared), 0, 0);
        const journal = new NatsJournal(workerData.path, workerData.options, "concurrent");
        journal.close(); parentPort.postMessage("opened");
      }).catch(error => { parentPort.postMessage({code:error.code,message:error.message}); });
    `,
        {
          eval: true,
          workerData: {
            module: new URL("../src/journal.ts", import.meta.url).href,
            shared,
            path,
            options: {
              fingerprint_key: new Uint8Array(32).fill(42),
              max_records: 100,
              max_pending: 10,
              max_pending_per_recipient: 5,
              max_body_bytes: 100000,
              max_clock_skew_ms: 1000,
              lease_ms: 250,
              max_attempts: 3,
              retry_base_ms: 50,
              retry_cap_ms: 200,
            },
          },
        },
      );
      worker.on("message", (message) => {
        if (message === "ready") {
          if (++ready === 2) {
            Atomics.store(new Int32Array(shared), 0, 1);
            Atomics.notify(new Int32Array(shared), 0);
          }
        } else if (message === "opened") resolve();
        else reject(Error(JSON.stringify(message)));
      });
      worker.once("error", reject);
      t.after(() => worker.terminate());
    });
  const first = run(),
    second = run();
  await Promise.all([first, second]);
  const journal = raw(t, path);
  assert.equal(journal.prepare("SELECT count(*) n FROM nats_meta").get().n, 1);
  assert.equal(
    journal.prepare("SELECT version FROM nats_meta").get().version,
    3,
  );
});

test("owner-enabled recovery reconnects the same backend without offline PUB buffering", async (t) => {
  const f = await fixture(t, { reconnect: true, request_timeout_ms: 300 });
  const backend = f.backend;
  const first = f.message();
  const firstReceipt = await backend.submit("a", first);
  await f.stop();
  const second = f.message();
  const secondReceipt = admit(backend, "a", second);
  await assert.rejects(backend.pumpOnce(), { code: "broker_unavailable" });
  await assert.rejects(JetStreamRelay.open(f.options), {
    code: "broker_unavailable",
  });
  assert.equal(
    backend.lookupReceipt("a", second.message_id).receipt_id,
    secondReceipt.receipt_id,
  );
  await f.start();
  await backend.pumpOnce();
  const one = poll(backend, "b");
  assert.equal(one.message.message_id, first.message_id);
  acknowledge(backend, "b", ackRequest(one, "reconnect-first"));
  await backend.pumpOnce();
  const two = poll(backend, "b");
  assert.equal(two.message.message_id, second.message_id);
  assert.equal(two.message.expires_at, second.expires_at);
  acknowledge(backend, "b", ackRequest(two, "reconnect-second"));
  await backend.pumpOnce();
  assert.equal(f.backend, backend);
  assert.equal(
    backend.lookupReceipt("a", first.message_id).receipt_id,
    firstReceipt.receipt_id,
  );
  assert.equal(
    backend.lookupReceipt("a", second.message_id).receipt_id,
    secondReceipt.receipt_id,
  );
  assert.equal(poll(backend, "b"), null);
});

test("v2 migration adds fair cursor only with explicit opt-in and retains the next-store turn", async (t) => {
  const f = await fixture(t);
  f.backend.recordPollTurn("b", "jetstream");
  await f.close(f.backend);
  const journal = raw(t, f.options.journal_path);
  journal.exec(
    "ALTER TABLE nats_poll_turns DROP COLUMN last_sender_id; ALTER TABLE nats_messages DROP COLUMN scan_order; UPDATE nats_meta SET version=2",
  );
  await assert.rejects(JetStreamRelay.open(f.options), {
    code: "journal_migration_required",
  });
  assert.equal(
    journal.prepare("SELECT version FROM nats_meta").get().version,
    2,
  );
  const migrated = f.track(
    await JetStreamRelay.open({ ...f.options, migrate_journal: true }),
  );
  assert.equal(migrated.pollTurn("b"), "jetstream");
  assert.equal(
    journal.prepare("SELECT version FROM nats_meta").get().version,
    3,
  );
});

test("fair scan rotates message position within a sender when its first kind is forbidden", async (t) => {
  const f = await fixture(t, {
    fair_poll: true,
    poll_scan_limit: 1,
    prefetch_per_recipient: 2,
  });
  const blocked = f.message("b", { kind: "question" }),
    allowed = f.message("b", { kind: "notice" });
  admit(f.backend, "a", blocked);
  admit(f.backend, "a", allowed);
  await f.backend.pumpOnce();
  const authorization = {
    authorize: (context, op, peer, kind) =>
      context === "b" && op === "poll" && kind !== "question"
        ? { agent_id: "b" }
        : undefined,
  };
  assert.equal(f.backend.pollWithAuthorization("b", authorization), null);
  await f.close(f.backend);
  const reopened = f.track(await JetStreamRelay.open(f.options));
  assert.equal(
    reopened.pollWithAuthorization("b", authorization).message.message_id,
    allowed.message_id,
  );
});

test("direct prefetch fails closed on missing or replaced broker sequence without republishing", async (t) => {
  for (const replacement of [false, true]) {
    const f = await fixture(t);
    const message = f.message();
    const accepted = await f.backend.submit("a", message);
    const journal = raw(t, f.options.journal_path);
    const row = journal
      .prepare("SELECT subject,sequence FROM nats_messages")
      .get();
    const stored = await f.manager.streams.getMessage("HAB", {
      seq: row.sequence,
    });
    await f.manager.streams.deleteMessage("HAB", row.sequence, true);
    if (replacement) {
      const nc = await connect({
        servers: f.options.server,
        user: f.options.user,
        pass: f.options.password,
        reconnect: false,
      });
      try {
        await jetstream(nc).publish(row.subject, stored.data);
      } finally {
        await nc.close();
      }
    }
    await assert.rejects(f.backend.pumpOnce(), {
      code: "broker_integrity_failed",
    });
    assert.equal(
      (await f.backend.status("a", message.message_id)).receipt_id,
      accepted.receipt_id,
    );
    assert.equal(
      journal.prepare("SELECT candidate FROM nats_messages").get().candidate,
      null,
    );
    assert.equal(
      (await f.manager.streams.info("HAB")).state.messages,
      replacement ? 1 : 0,
    );
  }
});
