import test from "node:test";
import assert from "node:assert/strict";
import { statSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SQLiteAttachmentInbox } from "../src/relay/sqlite-attachment-inbox.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
import { payload, code } from "./relay-attachment-fixtures.js";
import {
  inboxOptions,
  message,
  packet,
  fixture,
} from "./relay-attachment-inbox-fixtures.js";

test("attachment inbox: private durable chunks and whole SHA produce one verified manifest", (t) => {
  const f = fixture(t),
    m = message();
  assert.equal(f.store.prepare("a", m).state, "receiving");
  assert.equal(f.fill(m).state, "verified");
  const chunks = [0, 4, 8].map((n) =>
    f.store.read("a", m.message_id, m.body.parts[1].attachment_id, n),
  );
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(payload));
  assert.equal(
    f.store.withVerified("a", m, () => true),
    true,
  );
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(
    JSON.stringify(
      f.raw.prepare("SELECT * FROM attachment_inbox_messages").all(),
    ).includes("Synthetic caption"),
    false,
  );
});
test("attachment inbox: atomic progress resumes after reopen and duplicate chunks are exact", (t) => {
  const f = fixture(t),
    m = message();
  f.store.prepare("a", m);
  f.store.put("a", m.message_id, packet(m));
  f.close(f.store);
  const s = f.open();
  s.migrate();
  assert.equal(s.status("a", m.message_id).files[0].next_offset, 4);
  s.put("a", m.message_id, packet(m));
  assert.equal(s.status("a", m.message_id).files[0].next_offset, 4);
  s.put("a", m.message_id, packet(m, 4));
  s.put("a", m.message_id, packet(m, 8));
  assert.equal(s.verify("a", m.message_id).state, "verified");
  assert.equal(f.count("attachment_inbox_chunks"), 3);
});
test("attachment inbox: changed caption, order, recipient and sender cannot reuse one manifest", (t) => {
  const f = fixture(t),
    m = message(payload, [payload]);
  f.store.prepare("a", m);
  const changed = structuredClone(m);
  changed.body.parts[0].text = "Synthetic changed";
  assert.throws(
    () => f.store.prepare("a", changed),
    code("attachment_inbox_conflict"),
  );
  const reordered = structuredClone(m);
  reordered.body.parts.reverse();
  assert.throws(
    () => f.store.prepare("a", reordered),
    code("attachment_inbox_conflict"),
  );
  assert.throws(
    () => f.store.prepare("a", { ...m, recipient_id: "c" }),
    code("foreign_delivery"),
  );
  assert.throws(
    () => f.store.status("other", m.message_id),
    code("attachment_inbox_not_found"),
  );
});
test("attachment inbox: incomplete or partially complete multipart input cannot pass readiness", (t) => {
  const f = fixture(t),
    m = message(payload, [payload]);
  f.store.prepare("a", m);
  for (const offset of [0, 4, 8])
    f.store.put("a", m.message_id, packet(m, offset));
  assert.throws(
    () => f.store.verify("a", m.message_id),
    code("attachment_inbox_incomplete"),
  );
  assert.throws(
    () => f.store.withVerified("a", m, () => assert.fail("must not run")),
    code("attachment_inbox_unverified"),
  );
  assert.throws(
    () => f.store.read("a", m.message_id, m.body.parts[1].attachment_id, 0),
    code("attachment_inbox_unverified"),
  );
});
test("attachment inbox: wrong whole digest rejects the message and deletes partial bytes permanently", (t) => {
  const f = fixture(t),
    m = message();
  m.body.parts[1].sha256 = "0".repeat(64);
  assert.equal(f.fill(m).state, "rejected");
  assert.equal(f.count("attachment_inbox_chunks"), 0);
  assert.equal(f.store.prepare("a", m).state, "rejected");
  assert.throws(
    () => f.store.put("a", m.message_id, packet(m)),
    code("attachment_inbox_closed"),
  );
});
test("attachment inbox: unknown fields, getters, overlong chunks, gaps, changed duplicates and descriptor changes fail", (t) => {
  const f = fixture(t),
    m = message();
  f.store.prepare("a", m);
  const p = packet(m);
  let gets = 0;
  const getter = { ...p };
  Object.defineProperty(getter, "data", {
    enumerable: true,
    get() {
      gets++;
      return payload;
    },
  });
  for (const v of [
    { ...p, url: "https://invalid.example" },
    getter,
    { ...p, data: new Uint8Array(5) },
    { ...p, recipient_id: "c" },
    { ...p, sha256: "0".repeat(64) },
    { ...p, next_offset: 8 },
    { ...p, eof: true },
    { ...p, chunk_bytes: 8 },
    packet(m, 4),
  ])
    assert.throws(
      () => f.store.put("a", m.message_id, v),
      code("invalid_attachment_chunk"),
    );
  assert.equal(gets, 0);
  assert.equal(f.count("attachment_inbox_chunks"), 0);
  f.store.put("a", m.message_id, p);
  assert.throws(
    () => f.store.put("a", m.message_id, { ...p, data: new Uint8Array(4) }),
    code("attachment_inbox_conflict"),
  );
});
test("attachment inbox: chunk-write failure rolls back progress with no private SQL details", (t) => {
  const f = fixture(t),
    m = message();
  f.store.prepare("a", m);
  f.raw.exec(
    "CREATE TRIGGER fail_chunk BEFORE UPDATE OF received_bytes ON attachment_inbox_files BEGIN SELECT RAISE(ABORT,'synthetic-private-sql');END;",
  );
  assert.throws(
    () => f.store.put("a", m.message_id, packet(m)),
    code("attachment_inbox_unavailable"),
  );
  assert.equal(f.count("attachment_inbox_chunks"), 0);
  assert.equal(f.store.status("a", m.message_id).files[0].next_offset, 0);
  f.raw.exec("DROP TRIGGER fail_chunk");
  assert.equal(
    f.store.put("a", m.message_id, packet(m)).files[0].next_offset,
    4,
  );
});
test("attachment inbox: finite byte reservation and record limits preserve existing retry and release", (t) => {
  const f = fixture(t, { max_live_bytes: 10, max_records: 2 }),
    m = message(),
    next = message();
  f.store.prepare("a", m);
  assert.throws(
    () => f.store.prepare("a", next),
    code("attachment_inbox_capacity"),
  );
  f.fill(m);
  f.store.release("a", m.message_id);
  f.store.prepare("a", next);
  assert.equal(f.store.prepare("a", m).state, "released");
  assert.throws(
    () => f.store.prepare("a", message()),
    code("attachment_inbox_capacity"),
  );
});
test("attachment inbox: zero-byte attachment verifies the empty SHA and returns EOF locally", (t) => {
  const f = fixture(t),
    m = message(new Uint8Array());
  assert.equal(f.fill(m, [new Uint8Array()]).state, "verified");
  assert.equal(
    f.store.read("a", m.message_id, m.body.parts[1].attachment_id, 0).length,
    0,
  );
  assert.equal(f.count("attachment_inbox_chunks"), 0);
});
test("attachment inbox: expiry halts partial writes and bounded maintenance reclaims only partial data", (t) => {
  const f = fixture(t),
    m = message(),
    done = message();
  f.store.prepare("a", m);
  f.store.put("a", m.message_id, packet(m));
  f.fill(done);
  f.raw.exec(
    "DROP TRIGGER attachment_inbox_identity; UPDATE attachment_inbox_messages SET expires_at=0",
  );
  assert.throws(
    () => f.store.put("a", m.message_id, packet(m, 4)),
    code("expired_delivery"),
  );
  assert.deepEqual(f.store.maintain(1), { expired: 1, purged: 0 });
  assert.equal(f.store.status("a", m.message_id).state, "expired");
  assert.equal(f.store.status("a", done.message_id).state, "verified");
  assert.deepEqual(
    f.store.read("a", done.message_id, done.body.parts[1].attachment_id, 0),
    payload.subarray(0, 4),
  );
});
test("attachment inbox: verified bytes remain local after server TTL until explicit durable handoff", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.raw.exec(
    "DROP TRIGGER attachment_inbox_identity; UPDATE attachment_inbox_messages SET expires_at=0",
  );
  assert.deepEqual(f.store.maintain(100), { expired: 0, purged: 0 });
  assert.equal(
    f.store.withVerified("a", m, () => true),
    true,
  );
  assert.equal(f.store.release("a", m.message_id), true);
  assert.equal(f.store.release("a", m.message_id), false);
  assert.equal(f.count("attachment_inbox_chunks"), 0);
  assert.throws(
    () => f.store.withVerified("a", m, () => true),
    code("attachment_inbox_unverified"),
  );
});
test("attachment inbox: content corruption is rechecked before readiness or local read", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.raw.exec(
    "UPDATE attachment_inbox_chunks SET data=zeroblob(1000000) WHERE offset=0",
  );
  assert.throws(
    () => f.store.withVerified("a", m, () => assert.fail("must not run")),
    code("attachment_inbox_integrity"),
  );
  assert.throws(
    () => f.store.read("a", m.message_id, m.body.parts[1].attachment_id, 0),
    code("attachment_inbox_integrity"),
  );
  assert.equal(f.store.verify("a", m.message_id).state, "rejected");
  assert.equal(f.count("attachment_inbox_chunks"), 0);
});
test("attachment inbox: a missing file row cannot become a false complete proof", (t) => {
  const f = fixture(t),
    m = message(payload, [new Uint8Array()]);
  f.fill(m, [payload, new Uint8Array()]);
  f.raw
    .prepare("DELETE FROM attachment_inbox_files WHERE attachment_id=?")
    .run(m.body.parts[2].attachment_id);
  assert.throws(
    () => f.store.withVerified("a", m, () => assert.fail("must not run")),
    code("attachment_inbox_integrity"),
  );
});
test("attachment inbox: terminal tombstones retain identity and 30-day GC is bounded and replay-safe", (t) => {
  const f = fixture(t),
    m = message(),
    old = Date.now() - 32 * 86400000;
  const id = makeReplayBoundMessageId(
    new Date(old - 3600000).toISOString(),
    "a".repeat(32),
  );
  f.raw
    .prepare(
      "INSERT INTO attachment_inbox_messages(sender_id,message_id,fingerprint,expires_at,state,file_count,created_at,terminal_at,retain_until) VALUES(?,?,?,?,'expired',1,?,?,?)",
    )
    .run("a", id, "synthetic-historical", old, old, old, old + 30 * 86400000);
  assert.deepEqual(f.store.maintain(1), { expired: 0, purged: 1 });
  const historic = {
    ...m,
    message_id: id,
    first_sent_at: new Date(old - 3600000).toISOString(),
    expires_at: new Date(old).toISOString(),
  };
  assert.throws(() => f.store.prepare("a", historic), code("expired_delivery"));
  f.fill(m);
  f.store.release("a", m.message_id);
  assert.deepEqual(f.store.maintain(100), { expired: 0, purged: 0 });
});
test("attachment inbox: a second connection cannot release verified bytes during readiness action", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  const other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  f.store.withVerified("a", m, () =>
    assert.throws(
      () => other.release("a", m.message_id),
      code("attachment_inbox_unavailable"),
    ),
  );
  assert.equal(other.release("a", m.message_id), true);
  assert.throws(
    () => f.store.withVerified("a", m, () => true),
    code("attachment_inbox_unverified"),
  );
});
test("attachment inbox: private file, explicit migration, identity/key/chunk policy and unknown schema fail closed", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(3) },
    { chunk_bytes: 8 },
  ])
    assert.throws(
      () => f.open(patch).migrate(),
      code("attachment_inbox_identity_mismatch"),
    );
  chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), code("attachment_inbox_unavailable"));
  chmodSync(f.path, 0o600);
  const link = join(f.dir, "symlink.sqlite");
  symlinkSync(f.path, link);
  assert.throws(
    () => new SQLiteAttachmentInbox(link, inboxOptions),
    code("attachment_inbox_unavailable"),
  );
  f.raw.exec("UPDATE attachment_inbox_meta SET version=99");
  assert.throws(
    () => f.open().migrate(),
    code("unsupported_attachment_inbox_schema"),
  );
});
test("attachment inbox: only synchronous ready actions run and nested access is refused", async (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  assert.throws(
    () => f.store.withVerified("a", m, () => f.store.status("a", m.message_id)),
    code("attachment_inbox_busy"),
  );
  assert.throws(
    () =>
      f.store.withVerified("a", m, () =>
        Promise.reject(Error("synthetic-private-async")),
      ),
    code("attachment_inbox_unverified"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
});
