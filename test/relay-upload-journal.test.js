import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { statSync, chmodSync, symlinkSync } from "node:fs";
import { fixture, journalOptions } from "./relay-upload-journal-fixtures.js";
import { intent, payload, code } from "./relay-attachment-fixtures.js";
import { SQLiteUploadJournal } from "../src/relay/sqlite-upload-journal.ts";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
const waitPast = (job) => {
  const until = Date.parse(job.lease_until) + 10;
  while (Date.now() < until)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      until - Date.now(),
    );
};
test("upload journal: private dedicated database requires explicit migration and fixed identity", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.journalPath).mode & 0o777, 0o600);
  const fresh = new SQLiteUploadJournal(
    join(f.dir, "not-migrated.sqlite"),
    journalOptions,
  );
  t.after(() => fresh.close());
  assert.throws(() => fresh.claim(), code("upload_journal_not_ready"));
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(104) },
    { chunk_bytes: 8 },
  ]) {
    const s = f.journalOpen(patch);
    assert.throws(() => s.migrate(), code("upload_journal_identity_mismatch"));
    f.journalClose(s);
  }
});
test("upload journal: no claim before whole source is durably saved and SHA verified", (t) => {
  const f = fixture(t),
    v = intent();
  f.journal.prepare(v);
  assert.equal(f.journal.claim(), null);
  f.journal.putSource(v.request_id, 0, payload.subarray(0, 4));
  assert.throws(
    () => f.journal.seal(v.request_id),
    code("upload_journal_incomplete"),
  );
  assert.equal(f.journal.claim(), null);
  f.fill(v);
  const job = f.journal.claim();
  assert.equal(job.operation, "begin");
  assert.equal(job.data, null);
  assert.deepEqual(job.intent, v);
  assert.equal(f.count("attachment_uploads"), 0);
});
test("upload journal: exact prepare and source retries preserve original identity and expiry", (t) => {
  const f = fixture(t),
    v = intent(),
    first = f.journal.prepare(v),
    again = f.journal.prepare(v);
  assert.deepEqual(again, first);
  assert.throws(
    () =>
      f.journal.prepare({
        ...v,
        attachment: { ...v.attachment, filename: "changed.bin" },
      }),
    code("upload_journal_conflict"),
  );
  f.journal.putSource(v.request_id, 0, payload.subarray(0, 4));
  const before = f.journal.status(v.request_id);
  assert.deepEqual(
    f.journal.putSource(v.request_id, 0, payload.subarray(0, 4)),
    before,
  );
  assert.throws(
    () => f.journal.putSource(v.request_id, 0, new Uint8Array(4)),
    code("upload_journal_conflict"),
  );
  assert.equal(f.journal.status(v.request_id).expires_at, v.expires_at);
});
test("upload journal: source offsets, binary copy and restart retain exact bytes", (t) => {
  const f = fixture(t),
    v = intent(),
    data = Uint8Array.from(payload.subarray(0, 4));
  f.journal.prepare(v);
  f.journal.putSource(v.request_id, 0, data);
  data.fill(0);
  for (const [offset, bytes] of [
    [8, payload.subarray(8)],
    [1, payload.subarray(0, 4)],
    [4, new Uint8Array(1)],
    [4, new Uint8Array(5)],
  ])
    assert.throws(
      () => f.journal.putSource(v.request_id, offset, bytes),
      code("invalid_upload_chunk"),
    );
  f.journalClose(f.journal);
  const s = f.journalOpen();
  s.migrate();
  assert.equal(s.status(v.request_id).source_bytes, 4);
  f.fill(v, payload, s);
  const begin = s.claim();
  s.accept(begin, f.reply(begin));
  const put = s.claim();
  assert.deepEqual(put.data, payload.subarray(0, 4));
  put.data.fill(0);
  assert.equal(f.sourceChunks(), 3);
});
test("upload journal: chunk and source progress roll back together on write failure", (t) => {
  const f = fixture(t),
    v = intent();
  f.journal.prepare(v);
  f.journalRaw.exec(
    "CREATE TRIGGER fail_source_progress BEFORE UPDATE OF source_bytes ON upload_journal_entries BEGIN SELECT RAISE(ABORT,'synthetic failure');END",
  );
  assert.throws(
    () => f.journal.putSource(v.request_id, 0, payload.subarray(0, 4)),
    code("upload_journal_unavailable"),
  );
  assert.equal(f.sourceChunks(), 0);
  assert.equal(f.journal.status(v.request_id).source_bytes, 0);
  f.journalRaw.exec("DROP TRIGGER fail_source_progress");
  f.fill(v);
  assert.equal(f.journal.claim().operation, "begin");
});
test("upload journal: digest mismatch quarantines without sending and drops invalid source", (t) => {
  const f = fixture(t),
    v = intent();
  v.attachment.sha256 = "0".repeat(64);
  const result = f.fill(v);
  assert.equal(result.state, "quarantined");
  assert.equal(result.reason, "source_integrity");
  assert.equal(result.source_retained, false);
  assert.equal(f.sourceChunks(), 0);
  assert.equal(f.journal.claim(), null);
});
test("upload journal: corrupted and oversized source BLOB cannot become a claim", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  f.journalRaw
    .prepare(
      "UPDATE upload_journal_chunks SET data=zeroblob(100000) WHERE request_id=? AND offset=0",
    )
    .run(v.request_id);
  assert.throws(() => f.journal.claim(), code("upload_journal_integrity"));
  assert.equal(f.journal.status(v.request_id).total_attempts, 0);
  assert.equal(f.count("attachment_uploads"), 0);
});
test("upload journal: competing connections and reopen respect one durable active lease", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const other = f.journalOpen();
  other.migrate();
  const job = f.journal.claim();
  assert.equal(other.claim(), null);
  f.journalClose(f.journal);
  const reopened = f.journalOpen();
  reopened.migrate();
  assert.equal(reopened.claim(), null);
  const receipt = f.reply(job);
  assert.equal(reopened.accept(job, receipt).state, "queued");
});
test("upload journal: expired lease advances fence and stale accept or fail cannot update the next worker", (t) => {
  const f = fixture(t, { lease_ms: 200 }),
    v = intent();
  f.fill(v);
  const first = f.journal.claim(),
    receipt = f.reply(first);
  waitPast(first);
  const second = f.journal.claim();
  assert.equal(second.fence, first.fence + 1);
  assert.throws(
    () => f.journal.accept(first, receipt),
    code("stale_upload_job"),
  );
  assert.throws(
    () => f.journal.fail(first, "transport"),
    code("stale_upload_job"),
  );
  f.journal.accept(second, receipt);
  assert.equal(
    f.journal.status(v.request_id).attachment_id,
    receipt.attachment_id,
  );
});
test("upload journal: begin, bounded source chunks and finalize preserve server identity", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const operations = [];
  for (let n = 0; n < 8; n++) {
    const job = f.journal.claim();
    assert.ok(job);
    operations.push(job.operation);
    if (job.operation === "put") {
      assert.equal(job.data.length, Math.min(4, payload.length - job.offset));
      assert.equal(
        job.attachment_id,
        f.journal.status(v.request_id).attachment_id,
      );
    }
    const result = f.journal.accept(job, f.reply(job));
    if (result.state === "finalized") break;
  }
  assert.deepEqual(operations, ["begin", "put", "put", "put", "finalize"]);
  const result = f.journal.status(v.request_id);
  assert.equal(result.state, "finalized");
  assert.equal(result.total_attempts, 5);
  assert.equal(result.source_retained, true);
  assert.equal(f.sourceChunks(), 3);
  assert.equal(f.journal.claim(), null);
});
test("upload journal: foreign owner or changed intent receipt rolls back local progress", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const job = f.journal.claim(),
    receipt = f.reply(job);
  for (const patch of [
    { owner_id: "c" },
    { kind: "answer" },
    { request_id: "wrong-id" },
    { unexpected: "synthetic" },
  ])
    assert.throws(
      () => f.journal.accept(job, { ...receipt, ...patch }),
      code("invalid_upload_journal_receipt"),
    );
  assert.equal(f.journal.status(v.request_id).attachment_id, null);
  f.journal.accept(job, receipt);
  const put = f.journal.claim(),
    response = f.reply(put);
  assert.throws(
    () =>
      f.journal.accept(put, { ...response, attachment_id: "different-upload" }),
    code("invalid_upload_journal_receipt"),
  );
  assert.throws(
    () =>
      f.journal.accept(put, { ...response, next_offset: 0, received_bytes: 0 }),
    code("invalid_upload_journal_receipt"),
  );
  f.journal.accept(put, response);
});
test("upload journal: response before local progress failure is reconciled with the same receipt", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const job = f.journal.claim(),
    receipt = f.reply(job);
  f.journalRaw.exec(
    "CREATE TRIGGER fail_remote_progress BEFORE UPDATE OF remote_id ON upload_journal_entries BEGIN SELECT RAISE(ABORT,'synthetic failure');END",
  );
  assert.throws(
    () => f.journal.accept(job, receipt),
    code("upload_journal_unavailable"),
  );
  assert.equal(f.journal.status(v.request_id).state, "running");
  f.journalRaw.exec("DROP TRIGGER fail_remote_progress");
  f.journal.accept(job, receipt);
  assert.equal(f.count("attachment_uploads"), 1);
});
test("upload journal: transport backoff is finite and cannot silently resume after exhaustion", (t) => {
  const f = fixture(t, { max_attempts: 2 }),
    v = intent();
  f.fill(v);
  f.journal.fail(f.journal.claim(), "transport");
  assert.equal(f.journal.claim(), null);
  f.signedUpdate(v.request_id, { next_retry_at: 0 });
  f.journal.fail(f.journal.claim(), "transport");
  const r = f.journal.status(v.request_id);
  assert.equal(r.state, "quarantined");
  assert.equal(r.reason, "retry_exhausted");
  assert.equal(r.source_retained, true);
  assert.equal(f.journal.prepare(v).state, "quarantined");
  assert.equal(f.journal.claim(), null);
});
test("upload journal: no-progress finalize responses exhaust attempts instead of resetting budget", (t) => {
  const f = fixture(t, { max_attempts: 2 }),
    v = intent();
  f.fill(v);
  for (let n = 0; n < 4; n++) {
    const job = f.journal.claim();
    f.journal.accept(job, f.reply(job));
  }
  for (let n = 0; n < 2; n++) {
    const job = f.journal.claim();
    assert.equal(job.operation, "finalize");
    const old = f.api.status(f.contexts.a, job.attachment_id);
    f.journal.accept(job, old);
  }
  assert.equal(f.journal.claim(), null);
  assert.equal(f.journal.status(v.request_id).reason, "retry_exhausted");
});
test("upload journal: forbidden and remote terminal outcomes retain source for explicit release", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  f.journal.fail(f.journal.claim(), "forbidden");
  assert.equal(f.journal.status(v.request_id).source_retained, true);
  assert.equal(f.journal.release(v.request_id), true);
  assert.equal(f.journal.release(v.request_id), false);
  assert.equal(f.journal.prepare(v).state, "released");
  assert.equal(f.sourceChunks(), 0);
  const other = intent(payload, { request_id: "remote-cancelled" });
  f.fill(other);
  const job = f.journal.claim(),
    r = f.reply(job);
  const closed = f.api.cancel(f.contexts.a, r.attachment_id);
  assert.equal(f.journal.accept(job, closed).reason, "remote_closed");
});
test("upload journal: finalized readiness rescans source, refuses async or reentrant handoff and preserves bytes", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const result = f.finish(v);
  assert.equal(
    f.journal.withFinalized(v.request_id, (r) => r.attachment_id),
    result.attachment_id,
  );
  assert.throws(
    () =>
      f.journal.withFinalized(v.request_id, () =>
        Promise.reject(Error("synthetic")),
      ),
    code("upload_journal_busy"),
  );
  assert.throws(
    () =>
      f.journal.withFinalized(v.request_id, () =>
        f.journal.release(v.request_id),
      ),
    code("upload_journal_busy"),
  );
  f.journalRaw
    .prepare(
      "UPDATE upload_journal_chunks SET data=? WHERE request_id=? AND offset=0",
    )
    .run(new Uint8Array(4), v.request_id);
  assert.throws(
    () => f.journal.withFinalized(v.request_id, () => {}),
    code("upload_journal_integrity"),
  );
});
test("upload journal: row-state corruption cannot forge finalized readiness or reset attempts", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  f.journalRaw
    .prepare(
      "UPDATE upload_journal_entries SET state='finalized' WHERE request_id=?",
    )
    .run(v.request_id);
  assert.throws(
    () => f.journal.withFinalized(v.request_id, () => {}),
    code("upload_journal_integrity"),
  );
  assert.throws(
    () => f.journal.status(v.request_id),
    code("upload_journal_integrity"),
  );
});
test("upload journal: quotas reserve whole declared source and exact retry remains available at capacity", (t) => {
  const f = fixture(t, { max_records: 2, max_live_bytes: 10 }),
    v = intent();
  f.journal.prepare(v);
  assert.throws(
    () => f.journal.prepare(intent(payload, { request_id: "quota-second" })),
    code("upload_journal_capacity"),
  );
  assert.equal(f.journal.prepare(v).request_id, v.request_id);
  f.journal.release(v.request_id);
  const other = intent(payload, { request_id: "quota-second" });
  f.journal.prepare(other);
  f.journal.release(other.request_id);
  assert.throws(
    () => f.journal.prepare(intent(payload, { request_id: "quota-third" })),
    code("upload_journal_capacity"),
  );
});
test("upload journal: empty source verifies and requires only begin then finalize", (t) => {
  const f = fixture(t),
    empty = new Uint8Array(),
    v = intent(empty);
  f.fill(v, empty);
  const begin = f.journal.claim();
  assert.equal(begin.operation, "begin");
  f.journal.accept(begin, f.reply(begin));
  const final = f.journal.claim();
  assert.equal(final.operation, "finalize");
  const result = f.journal.accept(final, f.reply(final));
  assert.equal(result.state, "finalized");
  assert.equal(result.total_attempts, 2);
  assert.equal(f.sourceChunks(), 0);
});
test("upload journal: release refuses a running attempt and does not act as server cancel", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  const job = f.journal.claim(),
    r = f.reply(job);
  assert.throws(
    () => f.journal.release(v.request_id),
    code("upload_journal_busy"),
  );
  f.journal.accept(job, r);
  assert.equal(f.journal.release(v.request_id), true);
  assert.equal(f.api.status(f.contexts.a, r.attachment_id).state, "uploading");
});
test("upload journal: historical expiry and terminal GC share a finite maintenance budget", (t) => {
  const f = fixture(t),
    expired = f.seed(32 * 86400000, "preparing", true),
    old = f.seed();
  assert.deepEqual(f.journal.maintain(1), { expired: 1, purged: 0 });
  assert.equal(f.journal.status(expired.request_id).state, "expired");
  assert.deepEqual(f.journal.maintain(1), { expired: 0, purged: 1 });
  assert.throws(
    () => f.journal.status(old.request_id),
    code("upload_journal_not_found"),
  );
  assert.equal(f.journal.status(expired.request_id).state, "expired");
});
test("upload journal: retained quarantine is not garbage-collected and reads never extend retention", (t) => {
  const f = fixture(t),
    held = f.seed(32 * 86400000, "quarantined", true),
    released = f.seed();
  const before = f.journalRaw
    .prepare(
      "SELECT retain_until FROM upload_journal_entries WHERE request_id=?",
    )
    .get(released.request_id).retain_until;
  f.journal.status(released.request_id);
  f.journal.prepare(
    JSON.parse(
      f.journalRaw
        .prepare("SELECT intent FROM upload_journal_entries WHERE request_id=?")
        .get(released.request_id).intent,
    ),
  );
  assert.equal(
    f.journalRaw
      .prepare(
        "SELECT retain_until FROM upload_journal_entries WHERE request_id=?",
      )
      .get(released.request_id).retain_until,
    before,
  );
  assert.deepEqual(f.journal.maintain(100), { expired: 0, purged: 1 });
  assert.equal(f.journal.status(held.request_id).source_retained, true);
});
test("upload journal: source expiry cannot be rebased with the same request ID", (t) => {
  const f = fixture(t),
    old = f.seed(2 * 3600000, "preparing", true);
  assert.equal(f.journal.status(old.request_id).state, "expired");
  assert.equal(f.sourceChunks(), 0);
  assert.throws(
    () =>
      f.journal.prepare({
        ...old,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    code("invalid_upload_request"),
  );
  assert.equal(f.journal.claim(), null);
});
test("upload journal: unsafe files, unknown schemas and invalid finite policies fail closed", (t) => {
  const f = fixture(t);
  const link = join(f.dir, "source-link.sqlite");
  symlinkSync(f.journalPath, link);
  assert.throws(
    () => new SQLiteUploadJournal(link, journalOptions),
    code("upload_journal_unavailable"),
  );
  const bad = join(f.dir, "unknown.sqlite"),
    db = new DatabaseSync(bad);
  db.exec("CREATE TABLE unrelated(n)");
  db.close();
  chmodSync(bad, 0o600);
  const s = new SQLiteUploadJournal(bad, journalOptions);
  t.after(() => s.close());
  assert.throws(() => s.migrate(), code("unknown_upload_journal_schema"));
  for (const patch of [
    { lease_ms: 0 },
    { max_attempts: 1001 },
    { retry_base_ms: 60001, retry_cap_ms: 60000 },
    { max_records: Infinity },
    { max_live_bytes: 0 },
    { chunk_bytes: 0 },
  ])
    assert.throws(
      () => f.journalOpen(patch),
      code("invalid_upload_journal_options"),
    );
  for (const n of [0, 101, Infinity])
    assert.throws(
      () => f.journal.maintain(n),
      code("invalid_upload_journal_request"),
    );
});
test("upload journal: invalid intent time, owner fields and token fields cannot enter source records", (t) => {
  const f = fixture(t),
    v = intent();
  for (const patch of [
    { owner_id: "c" },
    { token: "synthetic-token" },
    { url: "https://files.example/file" },
  ])
    assert.throws(
      () => f.journal.prepare({ ...v, ...patch }),
      code("invalid_upload_request"),
    );
  const first = new Date(Date.now() + 10000).toISOString(),
    future = {
      ...v,
      first_sent_at: first,
      expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
      message_id: makeReplayBoundMessageId(first, "d".repeat(32)),
      request_id: makeUploadRequestId(first, "d".repeat(32)),
    };
  assert.throws(() => f.journal.prepare(future), code("upload_clock_skew"));
});

test("upload journal: sealed source is immutable while exact chunk retry remains safe", (t) => {
  const f = fixture(t),
    v = intent();
  f.fill(v);
  assert.equal(
    f.journal.putSource(v.request_id, 0, payload.subarray(0, 4)).state,
    "queued",
  );
  assert.throws(
    () => f.journal.putSource(v.request_id, 0, new Uint8Array(4)),
    code("upload_journal_conflict"),
  );
  assert.equal(f.journal.status(v.request_id).total_attempts, 0);
});

function shortIntent(ms = 300) {
  const first = new Date(Date.now() - 3600000 + ms).toISOString();
  return intent(payload, {
    first_sent_at: first,
    expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
    message_id: makeReplayBoundMessageId(first, "e".repeat(32)),
    request_id: "short-deadline",
  });
}
test("upload journal: message expiry fences a late receipt and maintenance removes pending source", (t) => {
  const f = fixture(t),
    v = shortIntent();
  v.request_id = makeUploadRequestId(v.first_sent_at, "e".repeat(32));
  f.fill(v);
  const job = f.journal.claim(),
    receipt = f.reply(job);
  waitPast(job);
  assert.throws(() => f.journal.accept(job, receipt), code("stale_upload_job"));
  assert.deepEqual(f.journal.maintain(1), { expired: 1, purged: 0 });
  assert.equal(f.journal.status(v.request_id).source_retained, false);
  assert.equal(f.sourceChunks(), 0);
});
test("upload journal: finalized handoff rechecks original expiry at transaction commit", (t) => {
  const f = fixture(t),
    v = shortIntent();
  v.request_id = makeUploadRequestId(v.first_sent_at, "e".repeat(32));
  f.fill(v);
  f.finish(v);
  assert.throws(
    () =>
      f.journal.withFinalized(v.request_id, () => {
        waitPast({ lease_until: v.expires_at });
        return "synthetic handoff";
      }),
    code("upload_journal_closed"),
  );
  assert.equal(f.journal.status(v.request_id).source_retained, true);
  assert.equal(f.journal.release(v.request_id), true);
});
