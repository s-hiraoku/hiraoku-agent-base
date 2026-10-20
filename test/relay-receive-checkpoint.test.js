import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fixture, waitPast } from "./relay-receive-checkpoint-fixtures.js";
import { code } from "./relay-attachment-fixtures.js";
import { loseOnce } from "./relay-attachment-client-fixtures.js";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { DurableSender } from "../src/relay/sender.ts";
import { limits } from "./relay-http-fixtures.js";
import { SQLiteReceiveCheckpoint } from "../src/relay/sqlite-receive-checkpoint.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
test("receive checkpoint: native poll, three chunk steps, save, ACK and deletion are finite", async (t) => {
  const f = await fixture(t),
    { m, r } = await f.submitted(),
    w = f.worker(),
    states = [];
  const start = f.tools.length;
  for (let n = 0; n < 6; n++) {
    const before = f.tools.length;
    states.push((await w.workOnce()).state);
    assert.ok(f.tools.length - before <= 1);
    if (n < 4) assert.equal(f.staged(), 0);
  }
  assert.deepEqual(states, [
    "polled",
    "staging",
    "staging",
    "staging",
    "saved",
    "acked",
  ]);
  assert.deepEqual(f.tools.slice(start), [
    "relay_poll",
    "relay_attachment_read",
    "relay_attachment_read",
    "relay_attachment_read",
    "relay_ack",
  ]);
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(
    f.checkpointRaw.prepare("SELECT payload FROM receive_checkpoint").get()
      .payload,
    null,
  );
  assert.equal(f.local.body.inbox()[0].receipt_confirmed, true);
  assert.equal(f.deletionWorker().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.equal(
    f.local.files.status(f.a.agent_id, m.message_id).state,
    "verified",
  );
  assert.equal(
    f.local.files.read(f.a.agent_id, m.message_id, r.attachment_id, 0).length,
    4,
  );
});
test("receive checkpoint: text delivery uses the same durable handoff without file IO", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  // A second text-only message is used after explicitly receiving the first below.
  for (let n = 0; n < 6; n++) await f.worker().workOnce();
  const text = {
    ...m,
    message_id: makeReplayBoundMessageId(m.first_sent_at, "d".repeat(32)),
    body: { parts: [{ type: "text", text: "synthetic text" }] },
  };
  await f.client().submit(text);
  const start = f.tools.length,
    w = f.worker();
  assert.equal((await w.workOnce()).state, "polled");
  assert.equal((await w.workOnce()).state, "saved");
  assert.equal((await w.workOnce()).state, "acked");
  assert.deepEqual(f.tools.slice(start), ["relay_poll", "relay_ack"]);
});
test("receive checkpoint: full delivery and exact next chunk survive reopening all local stores", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  await f.worker().workOnce();
  await f.worker().workOnce();
  f.close(f.checkpoint);
  f.local.close(f.local.body);
  f.local.close(f.local.files);
  const s = f.open();
  s.migrate();
  const files = f.local.openFiles(),
    body = f.local.openBody(files),
    start = f.tools.length;
  const w = f.worker(s, f.client("b"), body, files);
  assert.equal((await w.workOnce()).state, "staging");
  assert.equal(
    files.status(f.a.agent_id, m.message_id).files[0].next_offset,
    8,
  );
  assert.deepEqual(f.tools.slice(start), ["relay_attachment_read"]);
  assert.equal(body.inbox().length, 0);
});
test("receive checkpoint: only one process claims; expired fences cannot mutate a replacement", async (t) => {
  const f = await fixture(t),
    s = f.open();
  s.migrate();
  const old = f.checkpoint.claim();
  assert.equal(s.claim(), null);
  f.leaseExpired();
  const next = s.claim();
  assert.ok(next.fence > old.fence);
  for (const method of ["release", "complete"])
    assert.throws(() => f.checkpoint[method](old), code("stale_receive_job"));
  assert.throws(
    () => f.checkpoint.fail(old, "transport"),
    code("stale_receive_job"),
  );
  s.release(next);
});
test("receive checkpoint: lost read reply retains old offset and does not poll or ACK", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted(),
    loss = loseOnce("relay_attachment_read");
  await f.worker().workOnce();
  const start = f.tools.length;
  assert.equal(
    (
      await f
        .worker(f.checkpoint, f.client("b", { fetch: loss.fetch }))
        .workOnce()
    ).state,
    "deferred",
  );
  assert.equal(
    f.local.files.status(f.a.agent_id, m.message_id).files[0].next_offset,
    0,
  );
  assert.equal(f.staged(), 0);
  f.due();
  assert.equal((await f.worker().workOnce()).state, "staging");
  assert.deepEqual(f.tools.slice(start), [
    "relay_attachment_read",
    "relay_attachment_read",
  ]);
});
test("receive checkpoint: lost ACK reply reuses the durable ACK request after restart", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  for (let n = 0; n < 5; n++) await f.worker().workOnce();
  const loss = loseOnce("relay_ack");
  assert.equal(
    (
      await f
        .worker(f.checkpoint, f.client("b", { fetch: loss.fetch }))
        .workOnce()
    ).state,
    "deferred",
  );
  const before = f.local.raw
    .prepare("SELECT request FROM relay_receiver_acks")
    .get().request;
  f.close(f.checkpoint);
  const s = f.open();
  s.migrate();
  f.due();
  assert.equal((await f.worker(s).workOnce()).state, "acked");
  assert.equal(
    f.local.raw.prepare("SELECT request FROM relay_receiver_acks").get()
      .request,
    null,
  );
  assert.ok(before.includes("lease_token"));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    1,
  );
});
test("receive checkpoint: local save failure retains bytes and never ACKs", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  for (let n = 0; n < 4; n++) await f.worker().workOnce();
  const start = f.tools.length;
  const w = f.worker(
    f.checkpoint,
    f.client("b"),
    f.inbox({
      save() {
        throw Error("synthetic disk");
      },
    }),
  );
  assert.equal((await w.workOnce()).state, "deferred");
  assert.equal(f.checkpoint.status().pending, true);
  assert.equal(f.staged(), 0);
  assert.equal(f.tools.length, start);
  f.due();
  assert.equal((await f.worker().workOnce()).state, "saved");
});
test("receive checkpoint: crash after inbox commit before checkpoint clear deduplicates handoff", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  for (let n = 0; n < 4; n++) await f.worker().workOnce();
  const w = f.worker(
    f.port({
      complete() {
        throw Error("synthetic clear");
      },
    }),
  );
  assert.equal((await w.workOnce()).state, "deferred");
  assert.equal(f.staged(), 1);
  assert.equal(f.checkpoint.status().pending, true);
  f.due();
  assert.equal((await f.worker().workOnce()).state, "acked");
  assert.equal((await f.worker().workOnce()).state, "saved");
  assert.equal(f.staged(), 1);
  assert.equal(
    f.local.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    1,
  );
  assert.equal(f.checkpoint.status().pending, false);
});
test("receive checkpoint: lease expiry during chunk transfer is renewed only after all bytes", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  await f.worker().workOnce();
  // Model passage of server delivery time while preserving the signed local checkpoint.
  f.rewrite((r) => {
    const d = JSON.parse(r.payload);
    d.lease_until = new Date(Date.now() - 10).toISOString();
    r.payload = JSON.stringify(d);
  });
  f.raw.exec("UPDATE relay_deliveries SET lease_until=0,next_visible_at=0");
  const start = f.tools.length,
    w = f.worker();
  for (let n = 0; n < 3; n++)
    assert.equal((await w.workOnce()).state, "staging");
  assert.deepEqual(f.tools.slice(start), [
    "relay_attachment_read",
    "relay_attachment_read",
    "relay_attachment_read",
  ]);
  assert.equal((await w.workOnce()).state, "refreshed");
  assert.equal(
    f.raw
      .prepare("SELECT attempts FROM relay_deliveries WHERE message_id=?")
      .get(m.message_id).attempts,
    2,
  );
  assert.equal((await w.workOnce()).state, "saved");
  assert.equal((await w.workOnce()).state, "acked");
});
test("receive checkpoint: renewed poll returning another message quarantines the original without overwrite", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  for (let n = 0; n < 4; n++) await f.worker().workOnce();
  f.rewrite((r) => {
    const d = JSON.parse(r.payload);
    d.lease_until = new Date(Date.now() - 10).toISOString();
    r.payload = JSON.stringify(d);
  });
  const before = f.checkpointRaw
    .prepare("SELECT payload FROM receive_checkpoint")
    .get().payload;
  const alternate = {
    ...JSON.parse(before),
    generation: 2,
    lease_until: new Date(Date.now() + 10000).toISOString(),
  };
  alternate.message.message_id = makeReplayBoundMessageId(
    m.first_sent_at,
    "e".repeat(32),
  );
  const w = f.worker(
    f.checkpoint,
    f.transport({
      async poll() {
        return alternate;
      },
    }),
  );
  assert.equal((await w.workOnce()).state, "closed");
  assert.equal(f.checkpoint.status().reason, "delivery_changed");
  assert.equal(
    f.checkpointRaw.prepare("SELECT payload FROM receive_checkpoint").get()
      .payload,
    before,
  );
  assert.equal((await w.workOnce()).state, "idle");
  assert.equal(f.staged(), 0);
});
test("receive checkpoint: current revocation blocks reads and ACK and parks pending work", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  await f.worker().workOnce();
  f.change(f.b, "stopped");
  assert.equal((await f.worker().workOnce()).state, "closed");
  assert.equal(f.checkpoint.status().state, "quarantined");
  assert.equal(f.staged(), 0);
  assert.equal(f.local.body.claimAck(), null);
  const start = f.tools.length;
  await f.worker().workOnce();
  assert.equal(f.tools.length, start);
});
test("receive checkpoint: file corruption before handoff prevents ACK", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  for (let n = 0; n < 4; n++) await f.worker().workOnce();
  const path = join(f.dir, "native-files.sqlite");
  const { DatabaseSync } = await import("node:sqlite"),
    raw = new DatabaseSync(path);
  try {
    raw.exec("UPDATE attachment_inbox_chunks SET data=zeroblob(length(data))");
  } finally {
    raw.close();
  }
  const before = f.tools.length;
  assert.equal((await f.worker().workOnce()).state, "closed");
  assert.equal(f.tools.length, before);
  assert.equal(f.staged(), 0);
});
test("receive checkpoint: tampered payload or lease metadata fails closed before IO", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  await f.worker().workOnce();
  f.checkpointRaw.exec(
    "UPDATE receive_checkpoint SET lease_until=0,fence=fence+1",
  );
  const before = f.tools.length;
  await assert.rejects(
    f.worker().workOnce(),
    code("receive_checkpoint_integrity"),
  );
  assert.equal(f.tools.length, before);
});
test("receive checkpoint: timeout keeps instance busy and late read cannot persist bytes", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  await f.worker().workOnce();
  let finish;
  const real = f.transport(),
    w = f.worker(
      f.checkpoint,
      f.transport({
        read: (request) =>
          new Promise((resolve) => {
            finish = async () => resolve(await real.read(request));
          }),
      }),
      f.local.body,
      f.local.files,
      { timeout_ms: 20 },
    );
  assert.equal((await w.workOnce()).state, "deferred");
  await assert.rejects(w.workOnce(), code("receive_worker_busy"));
  await finish();
  await setImmediate();
  f.due();
  assert.equal(
    f.local.files.status(f.a.agent_id, m.message_id).files[0].next_offset,
    0,
  );
  assert.equal((await f.worker().workOnce()).state, "staging");
});
test("receive checkpoint: repeated transport errors stop after a finite durable budget", async (t) => {
  const f = await fixture(t),
    w = f.worker(
      f.checkpoint,
      f.transport({
        async poll() {
          throw Error("synthetic network");
        },
      }),
    );
  for (let n = 0; n < 3; n++) {
    assert.equal((await w.workOnce()).state, "deferred");
    f.due();
  }
  assert.equal(f.checkpoint.status().state, "quarantined");
  assert.equal((await w.workOnce()).state, "idle");
  f.checkpoint.discard();
  assert.equal(f.checkpoint.status().state, "idle");
});
test("receive checkpoint: private file, owner and key are checked without automatic migration repair", async (t) => {
  const f = await fixture(t),
    path = join(f.dir, "receive-checkpoint.sqlite");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: f.a.agent_id },
    { fingerprint_key: new Uint8Array(32).fill(7) },
  ])
    assert.throws(
      () => f.open(patch).migrate(),
      code("receive_checkpoint_identity_mismatch"),
    );
  const link = join(f.dir, "checkpoint-link.sqlite");
  symlinkSync(path, link);
  const options = {
    agent_id: f.b.agent_id,
    fingerprint_key: new Uint8Array(32).fill(105),
    limits: (await import("./relay-http-fixtures.js")).limits,
    max_payload_bytes: 65536,
    busy_timeout_ms: 50,
    lease_ms: 1000,
    max_attempts: 3,
    retry_base_ms: 1,
    retry_cap_ms: 10,
  };
  assert.throws(
    () => new SQLiteReceiveCheckpoint(link, options),
    code("receive_checkpoint_unavailable"),
  );
  chmodSync(path, 0o644);
  assert.throws(() => f.open(), code("receive_checkpoint_unavailable"));
  chmodSync(path, 0o600);
});
test("receive checkpoint: foreign or malformed delivery cannot occupy durable payload", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  const d = await f.client("b").poll(),
    job = f.checkpoint.claim();
  for (const changed of [
    { ...d, generation: 0 },
    { ...d, lease_token: "bad" },
    { ...d, message: { ...d.message, recipient_id: f.c.agent_id } },
  ])
    assert.throws(
      () => f.checkpoint.save(job, changed),
      code("invalid_receive_delivery"),
    );
  assert.equal(f.checkpoint.status().pending, false);
  f.checkpoint.release(job);
});
test("receive checkpoint: expiry purges only pending checkpoint, not verified local bytes", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  for (let n = 0; n < 4; n++) await f.worker().workOnce();
  f.rewrite((r) => {
    const d = JSON.parse(r.payload),
      first = new Date(Date.now() - 3600100).toISOString();
    d.message.first_sent_at = first;
    d.message.expires_at = new Date(Date.parse(first) + 3600000).toISOString();
    d.message.message_id = makeReplayBoundMessageId(first, "f".repeat(32));
    d.lease_until = d.message.expires_at;
    r.payload = JSON.stringify(d);
    r.expires_at = Date.parse(d.message.expires_at);
  });
  assert.equal(f.checkpoint.maintain(), true);
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(f.checkpoint.status().reason, "expired");
  assert.equal(f.local.body.claimAck(), null);
  assert.equal(
    f.local.files.status(f.a.agent_id, m.message_id).state,
    "verified",
  );
  assert.equal(f.checkpoint.maintain(), false);
});
test("receive checkpoint: expired local work lease prevents late save and clears no body", async (t) => {
  const f = await fixture(t, { lease_ms: 30 });
  await f.submitted();
  const job = f.checkpoint.claim(),
    d = await f.client("b").poll();
  await waitPast(job.lease_until);
  assert.throws(() => f.checkpoint.save(job, d), code("stale_receive_job"));
  assert.equal(f.checkpoint.status().pending, false);
});
test("receive checkpoint: asynchronous local store cannot authorize polling", async (t) => {
  const f = await fixture(t),
    before = f.tools.length;
  await assert.rejects(
    f
      .worker(
        f.port({
          claim() {
            return Promise.resolve(null);
          },
        }),
      )
      .workOnce(),
    code("receive_worker_uncertain"),
  );
  assert.equal(f.tools.length, before);
});
test("receive checkpoint: commit failure rolls back payload and cannot issue an ACK", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  f.checkpointRaw.exec(
    "CREATE TRIGGER synthetic_write_failure BEFORE UPDATE ON receive_checkpoint WHEN NEW.payload IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic storage'); END",
  );
  assert.equal((await f.worker().workOnce()).state, "deferred");
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(f.staged(), 0);
  assert.equal(f.local.body.claimAck(), null);
  assert.equal(
    f.raw.prepare("SELECT attempts FROM relay_deliveries").get().attempts,
    1,
  );
});
test("receive checkpoint: crash after checkpoint save resumes after local lease without new poll", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  const d = await f.client("b").poll(),
    job = f.checkpoint.claim();
  f.checkpoint.save(job, d);
  f.close(f.checkpoint);
  const s = f.open();
  s.migrate();
  assert.equal(s.claim(), null);
  f.leaseExpired();
  const start = f.tools.length;
  assert.equal((await f.worker(s).workOnce()).state, "staging");
  assert.deepEqual(f.tools.slice(start), ["relay_attachment_read"]);
});
test("receive checkpoint: ACK permission loss after handoff leaves a quarantined ACK", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  for (let n = 0; n < 5; n++) await f.worker().workOnce();
  f.change(f.b, "stopped");
  assert.equal((await f.worker().workOnce()).state, "closed");
  assert.equal(
    f.local.raw.prepare("SELECT state FROM relay_receiver_acks").get().state,
    "quarantined",
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_attachment_deletions").get().n,
    0,
  );
});
test("receive checkpoint: payload quota parks delivery without ACK or partial durable body", async (t) => {
  const f = await fixture(t, { max_payload_bytes: 10 });
  await f.submitted();
  assert.equal((await f.worker().workOnce()).state, "deferred");
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(f.staged(), 0);
});
test("receive checkpoint: discard and expiry maintenance never invalidate active work", async (t) => {
  const f = await fixture(t);
  await f.submitted();
  const d = await f.client("b").poll(),
    job = f.checkpoint.claim();
  f.checkpoint.save(job, d);
  assert.throws(() => f.checkpoint.discard(), code("receive_checkpoint_busy"));
  assert.equal(f.checkpoint.maintain(), false);
  f.checkpoint.release(job);
  f.checkpoint.discard();
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(f.local.body.claimAck(), null);
});
test("receive checkpoint: schema mismatch, missing singleton and oversized payload refuse repair", async (t) => {
  const f = await fixture(t),
    second = f.open();
  f.checkpointRaw.exec("UPDATE receive_checkpoint_meta SET version=99");
  assert.throws(
    () => second.migrate(),
    code("unsupported_receive_checkpoint_schema"),
  );
  f.checkpointRaw.exec(
    "UPDATE receive_checkpoint_meta SET version=1; UPDATE receive_checkpoint SET payload=printf('%070000d',0)",
  );
  assert.throws(
    () => f.checkpoint.status(),
    code("receive_checkpoint_integrity"),
  );
  f.checkpointRaw.exec("DELETE FROM receive_checkpoint");
  assert.throws(
    () => f.checkpoint.status(),
    code("receive_checkpoint_integrity"),
  );
});
test("receive checkpoint: delayed SQL application cannot commit after local work lease", async (t) => {
  const f = await fixture(t, { lease_ms: 20 });
  await f.submitted();
  const d = await f.client("b").poll(),
    job = f.checkpoint.claim();
  f.checkpointRaw.exec(
    "CREATE TRIGGER synthetic_delay_write BEFORE UPDATE ON receive_checkpoint WHEN NEW.payload IS NOT NULL BEGIN SELECT sum(n) FROM (WITH RECURSIVE delay(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM delay WHERE n<1000000) SELECT n FROM delay); END",
  );
  assert.throws(() => f.checkpoint.save(job, d), code("stale_receive_job"));
  assert.equal(f.checkpoint.status().pending, false);
});

test("receive checkpoint: operator status exposes metadata without body or lease token", async (t) => {
  const f = await fixture(t),
    { m } = await f.submitted();
  await f.worker().workOnce();
  const status = f.checkpoint.status();
  assert.equal(status.message_id, m.message_id);
  assert.equal(status.sender_id, f.a.agent_id);
  assert.equal(status.expires_at, m.expires_at);
  assert.equal("message" in status, false);
  assert.equal("payload" in status, false);
  assert.equal("lease_token" in status, false);
});

test("receive checkpoint: sealed source through guarded outbox to verified receive and physical deletion", async (t) => {
  const f = await fixture(t),
    v = f.source();
  await f.finish(f.uploadWorker());
  const r = f.journal.status(v.request_id).receipt,
    m = f.message(r);
  const outbox = new SQLiteOutbox(
    join(f.dir, "integrated-outbox.sqlite"),
    {
      agent_id: f.a.agent_id,
      fingerprint_key: new Uint8Array(32).fill(106),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      max_submit_attempts: 3,
      max_status_attempts: 3,
      status_retry_ms: 86400000,
    },
    f.journal,
  );
  t.after(() => outbox.close());
  outbox.migrate();
  const sender = new DurableSender(outbox, f.client());
  sender.enqueue(m);
  assert.equal(f.journal.release(v.request_id), true);
  await sender.sendOnce();
  assert.equal(outbox.get(m.message_id).state, "accepted");
  const w = f.worker();
  for (let n = 0; n < 6; n++) await w.workOnce();
  assert.equal(f.local.body.inbox()[0].receipt_confirmed, true);
  assert.equal(f.checkpoint.status().pending, false);
  assert.equal(f.deletionWorker().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.equal(f.sourceChunks(), 0);
  assert.equal(
    f.local.files.read(f.a.agent_id, m.message_id, r.attachment_id, 0).length,
    4,
  );
});
