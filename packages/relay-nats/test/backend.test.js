import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { JetStreamRelay } from "../src/backend.ts";
import { DurableReceiver } from "../../../src/relay/receiver.ts";
import { fixture, ackRequest, gatePubAck } from "./fixture.js";

test("pinned file stream preserves UTF-8 and save-before-ACK, then erases broker body", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const accepted = await f.backend.submit("a", message);
  assert.equal(accepted.state, "pending");
  const info = await f.manager.streams.info("HAB");
  assert.equal(info.config.storage, "file");
  assert.equal(info.config.num_replicas, 1);
  assert.equal(info.config.discard, "new");
  const receiver = f.receiver("b", {
    async ack(request) {
      const witness = f.inbox("b");
      assert.deepEqual(
        witness.inbox().map((entry) => entry.message),
        [message],
      );
      return f.backend.ack("b", request);
    },
  });
  await receiver.once();
  assert.equal(receiver.entries()[0].receipt_confirmed, true);
  assert.equal(
    (await f.backend.status("a", message.message_id)).state,
    "acked",
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  const raw = new DatabaseSync(f.options.journal_path);
  t.after(() => raw.close());
  assert.equal(
    raw.prepare("SELECT outbox,cleaned FROM nats_messages").get().outbox,
    null,
  );
  assert.equal(
    raw.prepare("SELECT cleaned FROM nats_messages").get().cleaned,
    1,
  );
});

test("duplicate admission, including after broker dedup expires, retains original receipt and rejects changes", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const receipt = await f.backend.submit("a", message);
  await f.manager.streams.update("HAB", { duplicate_window: 100_000_000 });
  await delay(150);
  assert.deepEqual(await f.backend.submit("a", message), receipt);
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  await assert.rejects(
    f.backend.submit("a", {
      ...message,
      body: { parts: [{ type: "text", text: "changed" }] },
    }),
    { code: "idempotency_conflict" },
  );
});

test("two independent gateway instances sharing a journal obtain only one active lease", async (t) => {
  const f = await fixture(t, { lease_ms: 2000 });
  await f.backend.submit("a", f.message());
  const other = await f.open();
  const original = await JetStreamRelay.open(f.options);
  t.after(() => original.close());
  const results = await Promise.all([original.poll("b"), other.poll("b")]);
  assert.equal(results.filter(Boolean).length, 1);
  await other.ack("b", ackRequest(results.find(Boolean)));
});

test("redelivery increments application fence, enforces backoff, and rejects a stale ACK", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  await f.backend.submit("a", message);
  const first = await f.backend.poll("b");
  assert.equal(await f.backend.poll("b"), null);
  await delay(f.options.lease_ms + f.options.retry_base_ms + 20);
  const second = await f.backend.poll("b");
  assert.ok(second);
  assert.equal(second.generation, first.generation + 1);
  await assert.rejects(f.backend.ack("b", ackRequest(first)), {
    code: "invalid_ack",
  });
  await f.backend.ack("b", ackRequest(second));
});

test("lost application ACK response survives backend and broker restart with the exact receipt", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  await f.backend.submit("a", message);
  const delivery = await f.backend.poll("b");
  const request = ackRequest(delivery);
  const receipt = await f.backend.ack("b", request);
  await f.restart();
  assert.deepEqual(await f.backend.ack("b", request), receipt);
  assert.equal(await f.backend.poll("b"), null);
  await assert.rejects(f.backend.ack("b", { ...request, generation: 2 }), {
    code: "ack_idempotency_conflict",
  });
});

test("accepted pending message survives abrupt broker process exit", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const accepted = await f.backend.submit("a", message);
  await f.restart();
  const receiver = f.receiver("b");
  await receiver.once();
  assert.deepEqual(receiver.entries()[0].message, message);
  assert.equal(
    (await f.backend.status("a", message.message_id)).receipt_id,
    accepted.receipt_id,
  );
});

test("receiver save failure cannot ACK and redelivery remains available", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  await f.backend.submit("a", message);
  let acks = 0;
  const receiver = new DurableReceiver(
    {
      save() {
        throw Error("synthetic full inbox");
      },
      claimAck: () => null,
    },
    {
      poll: () => f.backend.poll("b"),
      ack: async (request) => {
        acks++;
        return f.backend.ack("b", request);
      },
    },
  );
  await assert.rejects(receiver.receiveOnce(), /synthetic full inbox/);
  assert.equal(acks, 0);
  assert.equal(
    (await f.backend.status("a", message.message_id)).state,
    "leased",
  );
  await delay(350);
  const recovered = f.receiver("b");
  await recovered.once();
  assert.equal(recovered.entries().length, 1);
});

test("absolute TTL expires without refreshing on retry, refuses ACK, and removes broker data", async (t) => {
  const f = await fixture(t, { lease_ms: 1000 });
  const expiry = Date.now() + 500;
  const message = f.message("b", {
    first_sent_at: new Date(expiry - 3600000).toISOString(),
    expires_at: new Date(expiry).toISOString(),
  });
  await f.backend.submit("a", message);
  const delivery = await f.backend.poll("b");
  assert.ok(delivery);
  assert.equal(delivery.lease_until, message.expires_at);
  await delay(550);
  await assert.rejects(f.backend.ack("b", ackRequest(delivery)), {
    code: "invalid_ack",
  });
  await f.backend.maintain("admin");
  assert.equal(
    (await f.backend.status("a", message.message_id)).state,
    "expired",
  );
  assert.equal((await f.backend.submit("a", message)).state, "expired");
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
});

test("finite application delivery attempts quarantine instead of silently discarding", async (t) => {
  const f = await fixture(t, { max_attempts: 2 });
  const message = f.message();
  await f.backend.submit("a", message);
  assert.equal((await f.backend.poll("b")).generation, 1);
  await delay(350);
  assert.equal((await f.backend.poll("b")).generation, 2);
  await delay(450);
  assert.equal(await f.backend.poll("b"), null);
  assert.equal(
    (await f.backend.status("a", message.message_id)).state,
    "quarantined",
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
});

test("identity, mailbox, operation, and stopped sender permissions fail closed", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  await assert.rejects(f.backend.submit("unknown", message), {
    code: "forbidden",
  });
  await f.backend.submit("a", message);
  await assert.rejects(f.backend.status("c", message.message_id), {
    code: "not_found",
  });
  assert.equal(await f.backend.poll("c"), null);
  const delivery = await f.backend.poll("b");
  await assert.rejects(f.backend.ack("c", ackRequest(delivery)), {
    code: "invalid_ack",
  });
  await assert.rejects(f.backend.maintain("b"), { code: "forbidden" });
  f.revoke();
  await assert.rejects(f.backend.ack("b", ackRequest(delivery)), {
    code: "forbidden",
  });
  await assert.rejects(f.backend.submit("a", f.message()), {
    code: "forbidden",
  });
});

test("journal and broker capacity reject new work without evicting accepted work", async (t) => {
  const f = await fixture(t, { max_pending: 1, max_pending_per_recipient: 1 });
  const first = f.message();
  await f.backend.submit("a", first);
  await assert.rejects(f.backend.submit("a", f.message()), {
    code: "capacity_exceeded",
  });
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  assert.equal(
    (await f.backend.poll("b")).message.message_id,
    first.message_id,
  );
});

test("synchronous durable admission survives a publisher that has not run", async (t) => {
  const f = await fixture(t);
  const message = f.message();
  const receipt = f.backend.admit("a", message);
  assert.equal(receipt instanceof Promise, false);
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.equal(
    (await f.backend.status("a", message.message_id)).state,
    "pending",
  );
  await f.restart();
  const delivery = await f.backend.poll("b");
  assert.deepEqual(delivery.message, { ...message, sender_id: "a" });
  assert.equal(
    (await f.backend.status("a", message.message_id)).receipt_id,
    receipt.receipt_id,
  );
});

test("lost PubAck is reconciled against the unique subject without duplicate publication", async (t) => {
  const f = await fixture(t);
  const proxy = await gatePubAck(t, f.options.server);
  const backend = await JetStreamRelay.open({
    ...f.options,
    server: proxy.server,
    request_timeout_ms: 300,
  });
  t.after(() => backend.close());
  const message = f.message();
  const sending = backend.submit("a", message);
  await proxy.gated;
  proxy.release(true);
  assert.equal((await sending).state, "pending");
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  assert.deepEqual((await backend.poll("b")).message, {
    ...message,
    sender_id: "a",
  });
});

test("revocation during publish respects the earlier committed admission and denies receiving the stopped sender", async (t) => {
  const f = await fixture(t);
  const proxy = await gatePubAck(t, f.options.server);
  const backend = await JetStreamRelay.open({
    ...f.options,
    server: proxy.server,
  });
  t.after(() => backend.close());
  const message = f.message();
  const sending = backend.submit("a", message);
  await proxy.gated;
  const before = await backend.status("a", message.message_id);
  assert.equal(before.state, "pending");
  f.revoke();
  proxy.release();
  const receipt = await sending;
  assert.equal(receipt.receipt_id, before.receipt_id);
  await assert.rejects(backend.poll("b"), { code: "forbidden" });
  f.revoke(false);
  await delay(100);
  assert.ok(await backend.poll("b"));
});

test("raw broker credentials cannot read another subject or use JetStream APIs", async (t) => {
  const f = await fixture(t);
  const nc = await connect({
    servers: f.options.server,
    user: "outsider",
    pass: "synthetic-outsider",
    reconnect: false,
    timeout: 300,
  });
  t.after(() => nc.close());
  const manager = await jetstreamManager(nc, { timeout: 300, checkAPI: false });
  await assert.rejects(manager.streams.info("HAB"));
  const statuses = nc.status();
  const sub = nc.subscribe("hab.>");
  const seen = await Promise.race([
    (async () => {
      for await (const status of statuses)
        if (status.type === "error") return status.error;
    })(),
    delay(1000).then(() => null),
  ]);
  sub.unsubscribe();
  await statuses.stop();
  assert.ok(seen);
});

test("unsupported payload and nonloopback broker reject before touching production", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    JetStreamRelay.open({ ...f.options, server: "nats://example.com:4222" }),
    { code: "loopback_broker_required" },
  );
  await assert.rejects(
    f.backend.submit(
      "a",
      f.message("b", {
        body: {
          parts: [
            {
              type: "attachment",
              attachment_id: "file",
              media_type: "text/plain",
              size_bytes: 1,
              sha256: "a".repeat(64),
            },
          ],
        },
      }),
    ),
    { code: "attachment_store_unavailable" },
  );
});

test("committed receiver receipt recovers when the broker ACK never arrives", async (t) => {
  const f = await fixture(t, { lease_ms: 2000 });
  const proxy = await gatePubAck(t, f.options.server, "ack-request");
  const backend = f.track(
    await JetStreamRelay.open({
      ...f.options,
      server: proxy.server,
      request_timeout_ms: 300,
    }),
  );
  const message = f.message();
  await backend.submit("a", message);
  const delivery = await backend.poll("b");
  const request = ackRequest(delivery);
  const acknowledging = backend.ack("b", request);
  await proxy.gated;
  assert.equal((await backend.status("a", message.message_id)).state, "acked");
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  proxy.release(true);
  const saved = await acknowledging;
  assert.equal(saved.state, "acked");
  assert.equal(backend.diagnostics("admin").pending_cleanup, 1);
  await f.close(backend);
  await f.restart();
  const receipt = await f.backend.ack("b", request);
  assert.deepEqual(receipt, saved);
  assert.equal(f.backend.diagnostics("admin").pending_cleanup, 0);
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
  assert.equal(await f.backend.poll("b"), null);
});

test("broker byte limit retains the unconfirmed intent and every earlier accepted message", async (t) => {
  const f = await fixture(t, { broker_max_bytes: 1200 });
  const first = f.message();
  await f.backend.submit("a", first);
  const second = f.message("b", {
    body: { parts: [{ type: "text", text: "x".repeat(1000) }] },
  });
  await assert.rejects(f.backend.submit("a", second), {
    code: "capacity_exceeded",
  });
  assert.equal(
    (await f.backend.status("a", second.message_id)).state,
    "pending",
  );
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 1);
  const delivery = await f.backend.poll("b");
  assert.equal(delivery.message.message_id, first.message_id);
});

test("receiver policy revocation during broker pull prevents the lease commit", async (t) => {
  const f = await fixture(t);
  const polling = f.backend.poll("b");
  await delay(30);
  f.backend.admit("a", f.message());
  f.revoke();
  await f.backend.publishPending();
  await assert.rejects(polling, { code: "forbidden" });
  f.revoke(false);
  assert.equal((await f.backend.poll("b")).generation, 1);
});

test("missing accepted broker store fails closed instead of creating an empty replacement", async (t) => {
  const f = await fixture(t);
  await f.backend.submit("a", f.message());
  await f.manager.streams.delete("HAB");
  await assert.rejects(JetStreamRelay.open(f.options), {
    code: "broker_store_missing",
  });
  await assert.rejects(f.manager.streams.info("HAB"));
});

test("journal route, key, foreign database, and changed staged body are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    JetStreamRelay.open({ ...f.options, subject_prefix: "other" }),
    { code: "journal_key_or_version_mismatch" },
  );
  await assert.rejects(
    JetStreamRelay.open({
      ...f.options,
      fingerprint_key: new Uint8Array(32).fill(99),
    }),
    { code: "journal_key_or_version_mismatch" },
  );
  const foreign = `${f.dir}/foreign.sqlite`;
  const raw = new DatabaseSync(foreign);
  raw.exec("CREATE TABLE unrelated(id INTEGER)");
  raw.close();
  const fs = await import("node:fs");
  fs.chmodSync(foreign, 0o600);
  await assert.rejects(
    JetStreamRelay.open({ ...f.options, journal_path: foreign }),
    { code: "unknown_journal_schema" },
  );
  const witness = new DatabaseSync(foreign);
  assert.deepEqual(
    witness
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
    ["unrelated"],
  );
  witness.close();
  const message = f.message();
  f.backend.admit("a", message);
  const journal = new DatabaseSync(f.options.journal_path);
  const altered = {
    sender_id: "a",
    message: {
      ...message,
      body: { parts: [{ type: "text", text: "altered" }] },
    },
  };
  journal
    .prepare("UPDATE nats_messages SET outbox=?")
    .run(JSON.stringify(altered));
  journal.close();
  await assert.rejects(f.backend.publishPending(), {
    code: "journal_integrity_failed",
  });
  assert.equal((await f.manager.streams.info("HAB")).state.messages, 0);
});
