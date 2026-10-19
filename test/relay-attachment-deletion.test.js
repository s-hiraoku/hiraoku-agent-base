import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  deletionPolicy,
} from "./relay-attachment-deletion-fixtures.js";
import { code } from "./relay-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
test("attachment deletion queue: acceptance atomically fixes minimal ordered references without enabling delivery", (t) => {
  const f = fixture(t),
    m = f.message();
  f.service.submit("a", m);
  assert.equal(f.count("relay_message_attachments"), 1);
  assert.equal(f.service.poll("b"), null);
  assert.throws(
    () => f.raw.exec("UPDATE relay_message_attachments SET refs='[]'"),
    /immutable/,
  );
  assert.equal(f.count("relay_attachment_deletions"), 0);
});
test("attachment deletion queue: expiry commits body deletion, audit and one redacted outbox job together", (t) => {
  const f = fixture(t),
    m = f.expired(),
    row = f.raw.prepare("SELECT * FROM relay_messages").get(),
    job = f.raw.prepare("SELECT * FROM relay_attachment_deletions").get();
  assert.equal(row.state, "expired");
  assert.equal(row.body, null);
  assert.equal(job.state, "pending");
  const payload = JSON.parse(job.payload);
  assert.deepEqual(payload.attachment_ids, [m.body.parts[1].attachment_id]);
  assert.equal(payload.receipt.message_id, m.message_id);
  assert.equal(job.payload.includes("Synthetic private caption"), false);
  assert.equal(job.payload.includes("synthetic.bin"), false);
  f.service.maintain("operator", 10);
  assert.equal(f.count("relay_attachment_deletions"), 1);
});
test("attachment deletion queue: enqueue failure rolls back body clearing, delivery and audit", (t) => {
  const f = fixture(t),
    m = f.seed();
  f.raw.exec(
    "CREATE TRIGGER fail_delete_enqueue BEFORE INSERT ON relay_attachment_deletions BEGIN SELECT RAISE(ABORT,'synthetic-enqueue-failure');END;",
  );
  assert.throws(
    () => f.service.maintain("operator", 10),
    /synthetic-enqueue-failure/,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "pending",
  );
  assert.equal(f.count("relay_attachment_deletions"), 0);
  f.raw.exec("DROP TRIGGER fail_delete_enqueue");
  f.service.maintain("operator", 10);
  assert.equal(f.count("relay_attachment_deletions"), 1);
  assert.equal(f.service.status("a", m.message_id).state, "expired");
});
test("attachment deletion queue: competing connections get one lease and persist only the token hash", (t) => {
  const f = fixture(t);
  f.expired();
  const other = f.open();
  other.migrate();
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  assert.equal(job.generation, 1);
  assert.equal(job.lease_token.length, 43);
  assert.equal(
    other.claimAttachmentDeletion(f.authorize, deletionPolicy),
    null,
  );
  assert.equal(
    JSON.stringify(
      f.raw.prepare("SELECT * FROM relay_attachment_deletions").get(),
    ).includes(job.lease_token),
    false,
  );
});
test("attachment deletion queue: reopen preserves lease and reclaims only after expiry with a new fence", (t) => {
  const f = fixture(t);
  f.expired();
  const first = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.close(f.store);
  const s = f.open();
  s.migrate();
  assert.equal(s.claimAttachmentDeletion(f.authorize, deletionPolicy), null);
  f.raw.exec("UPDATE relay_attachment_deletions SET lease_until=0");
  const next = s.claimAttachmentDeletion(f.authorize, deletionPolicy);
  assert.equal(next.job_id, first.job_id);
  assert.equal(next.generation, 2);
  assert.notEqual(next.lease_token, first.lease_token);
  for (const action of [
    () => s.completeAttachmentDeletion(first, f.authorize),
    () => s.failAttachmentDeletion(first, f.authorize, deletionPolicy),
    () => s.withAttachmentDeletion(first, f.authorize, () => assert.fail()),
  ])
    assert.throws(action, code("stale_attachment_deletion"));
});
test("attachment deletion queue: terminal proof is scoped and cannot escape its transaction", (t) => {
  const f = fixture(t);
  f.expired();
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  let grant;
  assert.equal(
    f.store.withAttachmentDeletion(job, f.authorize, (g) => {
      grant = g;
      g.assertCurrent();
      return true;
    }),
    true,
  );
  assert.throws(() => grant.assertCurrent(), code("stale_attachment_deletion"));
});
test("attachment deletion queue: exact completion retries recover even after lease expiry, while current authority still applies", (t) => {
  const f = fixture(t);
  f.expired();
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.store.completeAttachmentDeletion(job, f.authorize);
  f.store.completeAttachmentDeletion(job, f.authorize);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "done",
  );
  assert.equal(
    f.store.claimAttachmentDeletion(f.authorize, deletionPolicy),
    null,
  );
  f.context.active = false;
  assert.throws(
    () => f.store.completeAttachmentDeletion(job, f.authorize),
    code("forbidden"),
  );
});
test("attachment deletion queue: failures back off and park at the finite ceiling without automatic revival", (t) => {
  const f = fixture(t);
  f.expired();
  const first = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.store.failAttachmentDeletion(first, f.authorize, deletionPolicy);
  assert.equal(
    f.raw.prepare("SELECT last_error FROM relay_attachment_deletions").get()
      .last_error,
    "delete_failed",
  );
  assert.equal(
    f.store.claimAttachmentDeletion(f.authorize, deletionPolicy),
    null,
  );
  f.raw.exec("UPDATE relay_attachment_deletions SET next_retry_at=0");
  const second = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.store.failAttachmentDeletion(second, f.authorize, deletionPolicy);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "parked",
  );
  assert.equal(
    f.store.claimAttachmentDeletion(f.authorize, {
      ...deletionPolicy,
      max_attempts: 1000,
    }),
    null,
  );
});
test("attachment deletion queue: missing, failing and asynchronous maintenance authority deny without effects", async (t) => {
  const f = fixture(t);
  f.expired();
  for (const auth of [
    undefined,
    () => {
      throw Error("synthetic-private-denial");
    },
    () => Promise.reject(Error("synthetic-private-async")),
  ])
    assert.throws(
      () => f.store.claimAttachmentDeletion(auth, deletionPolicy),
      code("forbidden"),
    );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    f.raw.prepare("SELECT attempts FROM relay_attachment_deletions").get()
      .attempts,
    0,
  );
});
test("attachment deletion queue: invalid or incomplete worker policies fail before leasing", (t) => {
  const f = fixture(t);
  f.expired();
  for (const patch of [
    { lease_ms: 0 },
    { lease_ms: 3600001 },
    { max_attempts: 1001 },
    { retry_cap_ms: 1 },
    { max_attempts: NaN },
  ])
    assert.throws(
      () =>
        f.store.claimAttachmentDeletion(f.authorize, {
          ...deletionPolicy,
          ...patch,
        }),
      code("invalid_attachment_deletion_policy"),
    );
  assert.throws(
    () => f.store.claimAttachmentDeletion(f.authorize, {}),
    code("invalid_attachment_deletion_policy"),
  );
});
test("attachment deletion queue: authority loss and asynchronous proof callbacks roll back", async (t) => {
  const f = fixture(t);
  f.expired();
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  assert.throws(
    () =>
      f.store.withAttachmentDeletion(job, f.authorize, () => {
        f.context.active = false;
      }),
    code("forbidden"),
  );
  f.context.active = true;
  assert.throws(
    () =>
      f.store.withAttachmentDeletion(job, f.authorize, () =>
        Promise.reject(Error("synthetic-async")),
      ),
    code("attachment_deletion_conflict"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "leased",
  );
});
test("attachment deletion queue: expired proof cannot complete even if an old worker finishes late", (t) => {
  const f = fixture(t);
  f.expired();
  const job = f.store.claimAttachmentDeletion(f.authorize, {
    ...deletionPolicy,
    lease_ms: 30,
  });
  assert.throws(
    () =>
      f.store.withAttachmentDeletion(job, f.authorize, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      }),
    code("stale_attachment_deletion"),
  );
  assert.throws(
    () => f.store.completeAttachmentDeletion(job, f.authorize),
    code("stale_attachment_deletion"),
  );
});
test("attachment deletion queue: corrupt immutable payload is refused before returning work", (t) => {
  const f = fixture(t);
  f.expired();
  f.raw.exec(
    "DROP TRIGGER relay_attachment_deletion_immutable; UPDATE relay_attachment_deletions SET payload='{}'",
  );
  assert.throws(
    () => f.store.claimAttachmentDeletion(f.authorize, deletionPolicy),
    code("attachment_deletion_conflict"),
  );
  assert.equal(
    f.raw.prepare("SELECT attempts FROM relay_attachment_deletions").get()
      .attempts,
    0,
  );
});
test("attachment deletion queue: schema 3 attachment migration requires explicit limits and preserves original receipt", (t) => {
  const f = fixture(t),
    m = f.message(),
    original = f.service.submit("a", m);
  f.close(f.store);
  f.raw.exec(
    "DROP TABLE relay_attachment_deletions;DROP TABLE relay_message_attachments;UPDATE relay_schema SET version=3",
  );
  const s = f.open();
  assert.throws(
    () => s.migrate(),
    code("attachment_migration_limits_required"),
  );
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_schema").get().version,
    3,
  );
  s.migrate(limits);
  assert.equal(f.count("relay_message_attachments"), 1);
  assert.equal(
    s.status(() => ({ sender_id: "a", message_id: m.message_id })).receipt_id,
    original.receipt_id,
  );
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_schema").get().version,
    4,
  );
});
test("attachment deletion queue: old attachment body corruption cannot migrate to a trusted manifest", (t) => {
  const f = fixture(t),
    m = f.message();
  f.service.submit("a", m);
  f.close(f.store);
  f.raw.exec(
    "DROP TABLE relay_attachment_deletions;DROP TABLE relay_message_attachments;UPDATE relay_schema SET version=3",
  );
  const changed = structuredClone(m);
  changed.body.parts[1].attachment_id = "changed-file";
  f.raw
    .prepare("UPDATE relay_messages SET body=?")
    .run(JSON.stringify(changed));
  assert.throws(
    () => f.open().migrate(limits),
    code("attachment_reference_mismatch"),
  );
});
test("attachment deletion queue: unfinished work blocks message GC and completed work collects with original tombstone", (t) => {
  const f = fixture(t);
  f.expired(40 * 86400000);
  assert.equal(f.service.maintain("operator", 100).purged, 0);
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.store.completeAttachmentDeletion(job, f.authorize);
  assert.equal(f.service.maintain("operator", 100).purged, 1);
  assert.equal(f.count("relay_attachment_deletions"), 0);
  assert.equal(f.count("relay_message_attachments"), 0);
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
});
test("attachment deletion queue: completion write failure rolls back and the original fenced retry works", (t) => {
  const f = fixture(t);
  f.expired();
  const job = f.store.claimAttachmentDeletion(f.authorize, deletionPolicy);
  f.raw.exec(
    "CREATE TRIGGER fail_done BEFORE UPDATE OF state ON relay_attachment_deletions WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'synthetic-completion-failure');END;",
  );
  assert.throws(
    () => f.store.completeAttachmentDeletion(job, f.authorize),
    /synthetic-completion-failure/,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "leased",
  );
  f.raw.exec("DROP TRIGGER fail_done");
  f.store.completeAttachmentDeletion(job, f.authorize);
});
test("attachment deletion queue: ordinary text ACK creates no attachment job", (t) => {
  const f = fixture(t),
    m = f.message(undefined, false);
  f.service.submit("a", m);
  const d = f.service.poll("b");
  f.service.ack("b", {
    sender_id: "a",
    message_id: m.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: "synthetic-ack",
  });
  assert.equal(f.count("relay_attachment_deletions"), 0);
});
