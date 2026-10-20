import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fixture, afterLease } from "./relay-upload-worker-fixtures.js";
import { loseOnce } from "./relay-attachment-client-fixtures.js";
import { payload, code } from "./relay-attachment-fixtures.js";
import { AttachmentUploadSender } from "../src/relay/upload-sender.ts";
import { RelayError } from "../src/relay/service.ts";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
test("upload worker: one call transfers one operation, then native HTTP durable receipt and cleanup preserve source", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    w = f.worker();
  assert.equal((await w.workOnce()).state, "progress");
  assert.deepEqual(f.tools, ["relay_attachment_begin"]);
  const final = await f.finish(w);
  assert.equal(final.request_id, v.request_id);
  assert.deepEqual(f.tools, [
    "relay_attachment_begin",
    "relay_attachment_put",
    "relay_attachment_put",
    "relay_attachment_put",
    "relay_attachment_finalize",
  ]);
  assert.equal(f.sourceChunks(), 3);
  assert.equal((await w.workOnce()).state, "idle");
  const r = f.journal.withFinalized(v.request_id, (x) => x),
    m = f.message(r),
    a = f.client(),
    b = f.client("b"),
    local = f.local();
  await a.submit(m);
  const d = await b.poll();
  for (let n = 0; n < 10; n++)
    if ((await local.stage(b, m)).state === "verified") break;
  local.body.save(d);
  const ack = local.body.claimAck();
  local.body.confirmAck(ack, await b.ack(ack));
  assert.equal(f.deletionWorker().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.equal(f.journal.release(v.request_id), true);
  assert.equal(f.sourceChunks(), 0);
  assert.deepEqual(
    local.files.read(f.a.agent_id, m.message_id, r.attachment_id, 0),
    payload.subarray(0, 4),
  );
});
test("upload worker: preparing or rejected source never reaches the network", async (t) => {
  const f = await fixture(t),
    v = f.beginInput();
  f.journal.prepare(v);
  assert.equal((await f.worker().workOnce()).state, "idle");
  assert.equal(f.tools.length, 0);
  f.source({
    ...v,
    request_id: makeUploadRequestId(v.first_sent_at, "c".repeat(32)),
    attachment: { ...v.attachment, sha256: "0".repeat(64) },
  });
  assert.equal((await f.worker().workOnce()).state, "idle");
  assert.equal(f.tools.length, 0);
});
test("upload worker: begin response loss reopens journal and uses original intent without duplicate upload", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    loss = loseOnce("relay_attachment_begin"),
    w = f.worker(f.journal, f.client("a", { fetch: loss.fetch }));
  assert.equal((await w.workOnce()).state, "deferred");
  assert.equal(f.count(), 1);
  assert.equal(f.tools.length, 1);
  await setImmediate();
  assert.equal(f.tools.length, 1);
  f.journalClose(f.journal);
  const s = f.journalOpen();
  f.due(v.request_id);
  assert.equal((await f.worker(s).workOnce()).state, "progress");
  assert.equal(f.count(), 1);
  assert.equal(
    s.status(v.request_id).attachment_id,
    f.blobRaw.prepare("SELECT attachment_id FROM attachment_uploads").get()
      .attachment_id,
  );
});
test("upload worker: lost chunk reply retries the same saved source offset after restart", async (t) => {
  const f = await fixture(t),
    v = f.source();
  await f.worker().workOnce();
  const loss = loseOnce("relay_attachment_put");
  assert.equal(
    (await f.worker(f.journal, f.client("a", { fetch: loss.fetch })).workOnce())
      .state,
    "deferred",
  );
  assert.equal(f.journal.status(v.request_id).next_offset, 0);
  f.journalClose(f.journal);
  const s = f.journalOpen();
  f.due(v.request_id);
  assert.equal((await f.worker(s).workOnce()).state, "progress");
  assert.equal(s.status(v.request_id).next_offset, 4);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    1,
  );
});
test("upload worker: lost finalize response reconciles the same finalized server file", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    w = f.worker();
  for (let n = 0; n < 4; n++) await w.workOnce();
  const loss = loseOnce("relay_attachment_finalize");
  assert.equal(
    (await f.worker(f.journal, f.client("a", { fetch: loss.fetch })).workOnce())
      .state,
    "deferred",
  );
  f.due(v.request_id);
  assert.equal((await f.worker().workOnce()).state, "finalized");
  assert.equal(f.count(), 1);
  assert.equal(f.journal.status(v.request_id).source_retained, true);
});
test("upload worker: local progress write failure stays uncertain and retries after fenced reopen", async (t) => {
  const f = await fixture(t, { lease_ms: 200 }),
    v = f.source();
  f.journalRaw.exec(
    "CREATE TRIGGER fail_worker_progress BEFORE UPDATE OF remote_id ON upload_journal_entries WHEN OLD.state='running' BEGIN SELECT RAISE(ABORT,'synthetic failure');END",
  );
  await assert.rejects(
    () => f.worker().workOnce(),
    code("upload_sender_uncertain"),
  );
  const row = f.journalRaw
    .prepare("SELECT lease_until FROM upload_journal_entries")
    .get();
  f.journalRaw.exec("DROP TRIGGER fail_worker_progress");
  afterLease({ lease_until: new Date(row.lease_until).toISOString() });
  f.journalClose(f.journal);
  const s = f.journalOpen();
  assert.equal((await f.worker(s).workOnce()).state, "progress");
  assert.equal(f.count(), 1);
  assert.equal(s.status(v.request_id).total_attempts, 2);
});
test("upload worker: a lost local commit result never overwrites committed progress", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    port = f.port({
      accept(job, r) {
        f.journal.accept(job, r);
        throw new RelayError("upload_journal_unavailable");
      },
    });
  await assert.rejects(
    () => f.worker(port).workOnce(),
    code("upload_sender_uncertain"),
  );
  assert.ok(f.journal.status(v.request_id).attachment_id);
  await f.worker().workOnce();
  assert.equal(f.tools.filter((n) => n === "relay_attachment_begin").length, 1);
  assert.equal(f.journal.status(v.request_id).next_offset, 4);
});
test("upload worker: timeout keeps its own slot until the old transport settles and discards the late receipt", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    receipt = f.uploads.begin(f.contexts.a, v);
  let release;
  const port = f.transport({
    async beginUpload(input) {
      assert.equal(input.request_id, v.request_id);
      await new Promise((resolve) => {
        release = resolve;
      });
      return receipt;
    },
  });
  const old = f.worker(f.journal, port, { timeout_ms: 30 });
  assert.equal((await old.workOnce()).state, "deferred");
  await assert.rejects(() => old.workOnce(), code("upload_sender_busy"));
  f.due(v.request_id);
  assert.equal((await f.worker().workOnce()).state, "progress");
  release();
  await setImmediate();
  await setImmediate();
  assert.equal(f.journal.status(v.request_id).next_offset, 0);
  assert.equal(f.journal.status(v.request_id).total_attempts, 2);
});
test("upload worker: another process cannot claim while a live operation holds the durable lease", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    a = f.client();
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    port = f.transport({
      async beginUpload(input) {
        const r = await a.beginUpload(input);
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
        return r;
      },
    });
  const pending = f.worker(f.journal, port).workOnce();
  await ready;
  const s = f.journalOpen();
  assert.equal((await f.worker(s).workOnce()).state, "idle");
  assert.equal(f.tools.length, 1);
  release();
  await pending;
  assert.equal(f.journal.status(v.request_id).total_attempts, 1);
});
test("upload worker: original expiry bounds waiting and fences an in-flight late response", async (t) => {
  const f = await fixture(t),
    first = new Date(Date.now() - 3600000 + 1500).toISOString(),
    v = f.beginInput();
  v.first_sent_at = first;
  v.expires_at = new Date(Date.parse(first) + 3600000).toISOString();
  v.request_id = makeUploadRequestId(first, "e".repeat(32));
  v.message_id = makeReplayBoundMessageId(first, "e".repeat(32));
  f.source(v);
  // Produce the receipt synchronously; only the returned transport promise is delayed.
  // HTTP setup latency must not decide whether this expiry test enters the operation.
  const receipt = f.uploads.begin(f.contexts.a, v);
  let release;
  const port = f.transport({
    async beginUpload(input) {
      assert.equal(input.request_id, v.request_id);
      await new Promise((resolve) => {
        release = resolve;
      });
      return receipt;
    },
  });
  const w = f.worker(f.journal, port, { timeout_ms: 2000 });
  await assert.rejects(() => w.workOnce(), code("upload_sender_uncertain"));
  assert.equal(typeof release, "function");
  release();
  await setImmediate();
  await setImmediate();
  assert.deepEqual(f.journal.maintain(1), { expired: 1, purged: 0 });
  assert.equal(f.journal.status(v.request_id).state, "expired");
});
test("upload worker: missing credential authorization quarantines source without network traffic", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    w = f.worker(f.journal, f.client("a", { authorization: () => "" }));
  assert.equal((await w.workOnce()).state, "deferred");
  const s = f.journal.status(v.request_id);
  assert.equal(s.state, "quarantined");
  assert.equal(s.reason, "forbidden");
  assert.equal(s.source_retained, true);
  assert.equal(f.tools.length, 0);
  assert.equal((await w.workOnce()).state, "idle");
});
test("upload worker: a false owner receipt is rejected and never persisted", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    a = f.client(),
    port = f.transport({
      async beginUpload(input) {
        return { ...(await a.beginUpload(input)), owner_id: f.c.agent_id };
      },
    });
  assert.equal((await f.worker(f.journal, port).workOnce()).state, "deferred");
  const r = f.journal.status(v.request_id);
  assert.equal(r.reason, "invalid_receipt");
  assert.equal(r.receipt, null);
  assert.equal(r.source_retained, true);
});
test("upload worker: a conflicting server chunk quarantines instead of silently changing the source", async (t) => {
  const f = await fixture(t),
    v = f.source();
  await f.worker().workOnce();
  const r = f.journal.status(v.request_id);
  f.uploads.put(f.contexts.a, r.attachment_id, 0, new Uint8Array(4));
  assert.equal((await f.worker().workOnce()).state, "deferred");
  assert.equal(f.journal.status(v.request_id).reason, "remote_conflict");
  assert.equal(f.sourceChunks(), 3);
});
test("upload worker: malformed host jobs cannot choose URL, operation or foreign source identity", async (t) => {
  const f = await fixture(t);
  f.source();
  const original = f.journal.claim();
  for (const patch of [
    { operation: "shell" },
    { intent: { ...original.intent, url: "https://files.example/file" } },
    { request_id: "different" },
    { operation: "put", attachment_id: "../../file", data: new Uint8Array(4) },
  ]) {
    const port = f.port({ claim: () => ({ ...original, ...patch }) });
    await assert.rejects(
      () => f.worker(port).workOnce(),
      code("invalid_upload_sender_job"),
    );
  }
  assert.equal(f.tools.length, 0);
});
test("upload worker: absent ports and invalid timeout fail before a source claim", async (t) => {
  const f = await fixture(t),
    v = f.source();
  for (const n of [0, 30001, Infinity])
    assert.throws(
      () => f.worker(f.journal, f.client(), { timeout_ms: n }),
      code("invalid_upload_sender_options"),
    );
  assert.throws(
    () =>
      new AttachmentUploadSender(f.journal, undefined, { timeout_ms: 1000 }),
    code("invalid_upload_sender_options"),
  );
  assert.throws(
    () =>
      new AttachmentUploadSender(undefined, f.client(), { timeout_ms: 1000 }),
    code("invalid_upload_sender_options"),
  );
  assert.equal(f.journal.status(v.request_id).total_attempts, 0);
});
test("upload worker: asynchronous local claim, accept and fail ports are refused without unhandled rejection", async (t) => {
  const f = await fixture(t);
  const v = f.source();
  await assert.rejects(
    () =>
      f
        .worker(f.port({ claim: () => Promise.reject(Error("synthetic")) }))
        .workOnce(),
    code("invalid_upload_sender_job"),
  );
  assert.equal(f.tools.length, 0);
  await assert.rejects(
    () =>
      f
        .worker(f.port({ accept: () => Promise.reject(Error("synthetic")) }))
        .workOnce(),
    code("upload_sender_uncertain"),
  );
  f.due(v.request_id);
  const broken = f.port({ fail: () => Promise.reject(Error("synthetic")) });
  await assert.rejects(
    () =>
      f
        .worker(
          broken,
          f.transport({
            beginUpload: async () => {
              throw Error("synthetic");
            },
          }),
        )
        .workOnce(),
    code("upload_sender_uncertain"),
  );
});
test("upload worker: no-progress finalized responses consume finite attempts and idle is not success", async (t) => {
  const f = await fixture(t, { max_attempts: 2 }),
    v = f.source(),
    w = f.worker();
  for (let n = 0; n < 4; n++) await w.workOnce();
  const a = f.client(),
    port = f.transport({ finalizeUpload: (id) => a.uploadStatus(id) }),
    waiting = f.worker(f.journal, port);
  assert.equal((await waiting.workOnce()).state, "progress");
  assert.equal((await waiting.workOnce()).state, "progress");
  assert.equal((await waiting.workOnce()).state, "idle");
  const r = f.journal.status(v.request_id);
  assert.equal(r.state, "quarantined");
  assert.equal(r.reason, "retry_exhausted");
});
test("upload worker: empty durable source uses begin and finalize only", async (t) => {
  const f = await fixture(t),
    bytes = new Uint8Array(),
    v = f.source(f.beginInput(bytes), bytes);
  assert.equal((await f.worker().workOnce()).state, "progress");
  assert.equal((await f.worker().workOnce()).state, "finalized");
  assert.deepEqual(f.tools, [
    "relay_attachment_begin",
    "relay_attachment_finalize",
  ]);
  assert.equal(f.journal.status(v.request_id).source_retained, true);
});
test("upload worker: corrupt local source fails before any remote upload", async (t) => {
  const f = await fixture(t),
    v = f.source();
  f.journalRaw
    .prepare(
      "UPDATE upload_journal_chunks SET data=zeroblob(100000) WHERE request_id=? AND offset=0",
    )
    .run(v.request_id);
  await assert.rejects(
    () => f.worker().workOnce(),
    code("upload_journal_integrity"),
  );
  assert.equal(f.tools.length, 0);
  assert.equal(f.journal.status(v.request_id).total_attempts, 0);
});
test("upload worker: remote terminal receipt returns closed and retains source for explicit handoff decision", async (t) => {
  const f = await fixture(t),
    v = f.source(),
    a = f.client(),
    port = f.transport({
      async beginUpload(input) {
        const r = await a.beginUpload(input);
        return a.cancelUpload(r.attachment_id);
      },
    });
  assert.equal((await f.worker(f.journal, port).workOnce()).state, "closed");
  assert.equal(f.journal.status(v.request_id).reason, "remote_closed");
  assert.equal(f.sourceChunks(), 3);
});
