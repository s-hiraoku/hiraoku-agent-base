import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture as uploadFixture } from "./relay-upload-worker-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { code, payload } from "./relay-attachment-fixtures.js";
import { loseOnce } from "./relay-attachment-client-fixtures.js";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { DurableSender } from "../src/relay/sender.ts";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
async function fixture(t, patch = {}) {
  const f = await uploadFixture(t),
    stores = new Set(),
    path = join(f.dir, "message-outbox.sqlite");
  const options = {
    agent_id: f.a.agent_id,
    fingerprint_key: new Uint8Array(32).fill(104),
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
    ...patch,
  };
  const open = (gate = f.journal) => {
    const s = new SQLiteOutbox(path, options, gate);
    s.migrate();
    stores.add(s);
    return s;
  };
  const outbox = open(),
    raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const prepared = async () => {
    const v = f.source();
    await f.finish();
    const r = f.journal.status(v.request_id).receipt;
    return { v, r, m: f.message(r) };
  };
  return {
    ...f,
    relayRaw: f.raw,
    outbox,
    open,
    close,
    raw,
    prepared,
    sender: (s = outbox, c = f.client()) => new DurableSender(s, c),
    due: () => raw.exec("UPDATE relay_outbox SET next_retry_at=0"),
  };
}
test("attachment outbox: guarded source to durable send, native receive and ACK", async (t) => {
  const f = await fixture(t),
    { v, r, m } = await f.prepared(),
    local = f.local(),
    b = f.client("b");
  f.sender().enqueue(m);
  assert.equal(f.outbox.get(m.message_id).state, "queued");
  assert.equal(f.sourceChunks(), 3);
  await f.sender().sendOnce();
  assert.equal(f.outbox.get(m.message_id).state, "accepted");
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
  const d = await b.poll();
  for (let n = 0; n < 3; n++) await local.stage(b, m);
  local.body.save(d);
  const ack = local.body.claimAck();
  local.body.confirmAck(ack, await b.ack(ack));
  assert.equal(local.body.inbox()[0].receipt_confirmed, true);
  assert.equal(f.deletionWorker().workOnce(f.operator).state, "done");
  assert.equal(f.journal.release(v.request_id), true);
  assert.deepEqual(
    local.files.read(f.a.agent_id, m.message_id, r.attachment_id, 0),
    payload.subarray(0, 4),
  );
});
test("attachment outbox: default configuration refuses new attachment work", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared(),
    s = f.open(null);
  assert.throws(() => s.enqueue(m), code("attachment_store_unavailable"));
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 0);
});
test("attachment outbox: remount without admission withholds persisted submission", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  f.outbox.enqueue(m);
  f.close(f.outbox);
  const s = f.open(null),
    before = f.tools.length;
  await f.sender(s).sendOnce();
  assert.equal(f.tools.length, before);
  assert.equal(s.get(m.message_id).submit_attempts, 0);
  assert.equal(f.open().claim().message.message_id, m.message_id);
});
for (const field of [
  "message_id",
  "recipient_id",
  "kind",
  "filename",
  "sha256",
  "size_bytes",
]) {
  test(
    "attachment outbox: source binding rejects changed " + field,
    async (t) => {
      const f = await fixture(t),
        { m } = await f.prepared(),
        bad = structuredClone(m);
      if (field === "message_id")
        bad.message_id = makeReplayBoundMessageId(
          m.first_sent_at,
          "e".repeat(32),
        );
      else if (field === "recipient_id") bad.recipient_id = f.c.agent_id;
      else if (field === "kind") bad.kind = "notification";
      else if (field === "filename") bad.body.parts[1].filename = "other.bin";
      else if (field === "sha256") bad.body.parts[1].sha256 = "0".repeat(64);
      else bad.body.parts[1].size_bytes++;
      assert.throws(() => f.outbox.enqueue(bad));
      assert.equal(
        f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n,
        0,
      );
    },
  );
}
test("attachment outbox: duplicate ID and unknown receipt cannot stand in for local source", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared(),
    bad = structuredClone(m);
  bad.body.parts.push(bad.body.parts[1]);
  assert.throws(() => f.outbox.enqueue(bad));
  const external = await f.completeNative(f.client(), f.beginInput());
  assert.throws(
    () => f.outbox.enqueue(f.message(external)),
    code("upload_journal_not_found"),
  );
});
test("attachment outbox: explicit release before handoff blocks new work", async (t) => {
  const f = await fixture(t),
    { v, m } = await f.prepared();
  f.journal.release(v.request_id);
  assert.throws(() => f.outbox.enqueue(m), code("upload_journal_closed"));
});
test("attachment outbox: release after handoff preserves exact retries and restart", async (t) => {
  const f = await fixture(t),
    { v, m } = await f.prepared();
  f.outbox.enqueue(m);
  f.journal.release(v.request_id);
  f.close(f.outbox);
  const s = f.open();
  assert.equal(s.enqueue(m).state, "queued");
  const changed = structuredClone(m);
  changed.body.parts[0].text = "other";
  assert.throws(() => s.enqueue(changed), code("outbox_content_conflict"));
  await f.sender(s).sendOnce();
  assert.equal(s.get(m.message_id).state, "accepted");
  assert.equal(s.enqueue(m).state, "accepted");
  assert.equal(f.sourceChunks(), 0);
});
test("attachment outbox: retained source corruption prevents handoff", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  f.journalRaw.exec(
    "UPDATE upload_journal_chunks SET data=zeroblob(length(data))",
  );
  assert.throws(() => f.outbox.enqueue(m), code("upload_journal_integrity"));
});
test("attachment outbox: durable message body corruption is rejected before claim", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  f.outbox.enqueue(m);
  const changed = structuredClone(m);
  changed.body.parts[0].text = "other";
  f.raw.prepare("UPDATE relay_outbox SET body=?").run(JSON.stringify(changed));
  assert.throws(() => f.outbox.claim(), code("outbox_integrity"));
  assert.equal(f.outbox.get(m.message_id).submit_attempts, 0);
});
test("attachment outbox: failed durable insert retains source and no message job", async (t) => {
  const f = await fixture(t, { max_body_bytes: 1 }),
    { m } = await f.prepared();
  assert.throws(() => f.outbox.enqueue(m), code("outbox_capacity_exceeded"));
  assert.equal(f.sourceChunks(), 3);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 0);
});
test("attachment outbox: lost submit reply retries same message after restart", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared(),
    loss = loseOnce("relay_submit");
  f.outbox.enqueue(m);
  await assert.rejects(
    f.sender(f.outbox, f.client("a", { fetch: loss.fetch })).sendOnce(),
    code("sender_transport_failed"),
  );
  f.close(f.outbox);
  f.due();
  const s = f.open();
  await f.sender(s).sendOnce();
  assert.equal(s.get(m.message_id).state, "accepted");
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 1);
  assert.equal(
    f.relayRaw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
});
test("attachment outbox: multiple finalized sources and structured body preserve order", async (t) => {
  const f = await fixture(t),
    { v, m } = await f.prepared();
  const next = {
    ...v,
    request_id: makeUploadRequestId(v.first_sent_at, "b".repeat(32)),
  };
  f.source(next);
  await f.finish();
  const r = f.journal.status(next.request_id).receipt;
  m.body.parts.push(
    {
      type: "data",
      schema_id: "synthetic",
      schema_version: 1,
      value: { synthetic: true },
    },
    { type: "attachment", attachment_id: r.attachment_id, ...r.attachment },
  );
  f.outbox.enqueue(m);
  const job = f.outbox.claim();
  assert.deepEqual(
    JSON.parse(JSON.stringify(job.message.body.parts)),
    m.body.parts,
  );
});
test("attachment outbox: scoped guard rejects async, repeated and escaped actions", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  let escaped;
  const invalid = f.open({
    withReady(_owner, _m, _l, run) {
      escaped = run;
      return Promise.resolve();
    },
    withClaim(_owner, _l, run) {
      return run(() => {});
    },
  });
  assert.throws(() => invalid.enqueue(m), code("invalid_outbox_admission"));
  assert.throws(() => escaped(), code("invalid_outbox_admission"));
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 0);
  let checker;
  f.journal.withClaim(f.a.agent_id, limits, (check) => {
    checker = check;
  });
  assert.throws(() => checker(m), code("upload_journal_busy"));
});
test("attachment outbox: uncertain admission commit leaves one recoverable durable message", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  const s = f.open({
    withReady(owner, v, l, run) {
      f.journal.withReady(owner, v, l, run);
      throw Error("synthetic after commit");
    },
    withClaim: f.journal.withClaim.bind(f.journal),
  });
  assert.throws(() => s.enqueue(m));
  assert.equal(f.open().enqueue(m).state, "queued");
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 1);
});

test("attachment outbox: status recovery after expiry needs no attachment admission", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  f.outbox.enqueue(m);
  const first = f.outbox.claim();
  f.outbox.defer(first, true);
  f.raw.exec("UPDATE relay_outbox SET expires_at=0,next_retry_at=0");
  const unmounted = f.open(null),
    job = unmounted.claim();
  assert.equal(job.operation, "status");
  assert.equal(job.message_id, m.message_id);
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
});

test("attachment outbox: journal capability is bound to the same local sender", async (t) => {
  const f = await fixture(t),
    { m } = await f.prepared();
  assert.throws(
    () => f.journal.withReady(f.c.agent_id, m, limits, () => {}),
    code("upload_journal_identity_mismatch"),
  );
  assert.throws(
    () => f.journal.withClaim(f.c.agent_id, limits, () => {}),
    code("upload_journal_identity_mismatch"),
  );
});
