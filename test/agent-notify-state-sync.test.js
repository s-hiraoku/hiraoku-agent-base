import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteNotices } from "../src/agent-notify/sqlite-notices.ts";
import { NoticeStateProjection } from "../src/agent-notify/state-sync.ts";

const notice = {
  sender_id: "sender",
  message_id: "message",
  from: null,
  kind: "question",
  thread_id: "thread",
  in_reply_to: null,
  sent_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-02T00:00:00Z",
  display: "HAB message",
  handoff_prompt: "Only after approval",
};
const snapshot = (revision, state) => ({
  ...{ sender_id: notice.sender_id, message_id: notice.message_id },
  revision,
  state,
});

for (const product of [
  "hermes-desktop",
  "gemini-example-only",
  "future-agent-example",
]) {
  test(`${product}: common state contract is independent of product and notice cursor`, () => {
    const projection = new NoticeStateProjection(product);
    projection.notice(product, notice);
    projection.merge({
      binding_id: product,
      states: [snapshot(1, "accept_waiting")],
    });
    // No new notices: retry completion is still delivered by the independent snapshot.
    projection.merge({ binding_id: product, states: [snapshot(3, "queued")] });
    projection.merge({
      binding_id: product,
      states: [snapshot(2, "accepting")],
    });
    projection.notice(product, notice); // remount/page repeat is not a payload change
    projection.merge({ binding_id: product, states: [] }); // absent is not undecided
    assert.equal(projection.state("sender", "message").state, "queued");
    assert.equal(projection.state("sender", "message").revision, 3);
    assert.throws(
      () => projection.notice(product, { ...notice, display: "changed" }),
      /payload_conflict/,
    );
    assert.throws(
      () =>
        projection.merge({
          binding_id: "another-conversation",
          states: [snapshot(99, "started")],
        }),
      /target_mismatch/,
    );
    assert.throws(
      () =>
        projection.merge({
          binding_id: product,
          states: [snapshot(3, "shown")],
        }),
      /state_conflict/,
    );
    assert.equal(projection.state("sender", "message").state, "queued");
    const reopened = new NoticeStateProjection(product);
    reopened.notice(product, notice);
    reopened.merge({ binding_id: product, states: [snapshot(3, "queued")] });
    assert.deepEqual(
      reopened.state("sender", "message"),
      projection.state("sender", "message"),
    );
  });
}

test("snapshot merge validates atomically and keeps senders distinct", () => {
  const projection = new NoticeStateProjection("binding");
  projection.merge({ binding_id: "binding", states: [snapshot(1, "shown")] });
  assert.throws(
    () =>
      projection.merge({
        binding_id: "binding",
        states: [snapshot(2, "later"), snapshot(-1, "shown")],
      }),
    /invalid_notice_state/,
  );
  assert.equal(projection.state("sender", "message").state, "shown");
  projection.merge({
    binding_id: "binding",
    states: [{ ...snapshot(2, "declined"), sender_id: "another" }],
  });
  assert.equal(projection.state("sender", "message").state, "shown");
  assert.equal(projection.state("another", "message").state, "declined");
});

test("durable revisions survive restart, competing writers, clock rollback and expiry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-state-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notices.sqlite");
  let store = new SQLiteNotices(path, "binding");
  store.insertShowing(notice, 100);
  const initial = store.get(notice).revision;
  assert.ok(initial > 0);
  store.transition(notice, ["showing"], "shown", 99);
  const shown = store.get(notice).revision;
  assert.ok(shown > initial);
  store.close();
  store = new SQLiteNotices(path, "binding");
  const other = new SQLiteNotices(path, "binding");
  t.after(() => {
    store.close();
    other.close();
  });
  other.transition(notice, ["shown"], "later", 98);
  assert.ok(store.get(notice).revision > shown);
  const later = store.get(notice).revision;
  assert.equal(store.transition(notice, ["shown"], "accepting", 97), false);
  assert.equal(store.get(notice).revision, later);
  store.maintain(Date.parse(notice.expires_at));
  assert.ok(store.get(notice).revision > later);
  assert.equal(store.states().states[0].state, "expired");
  assert.throws(
    () => new SQLiteNotices(path, "different-recipient"),
    /target_mismatch/,
  );
});

test("legacy database migration preserves decisions and starts ordered revisions", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { chmodSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "hab-state-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notices.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE notices_meta(id INTEGER PRIMARY KEY, target TEXT NOT NULL);
    INSERT INTO notices_meta VALUES(1,'binding');
    CREATE TABLE notices(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,state TEXT NOT NULL,
      sender TEXT,expires_at INTEGER NOT NULL,shown_at INTEGER NOT NULL,decided_at INTEGER,
      message TEXT NOT NULL,PRIMARY KEY(sender_id,message_id));`);
  old
    .prepare("INSERT INTO notices VALUES(?,?,'accept_waiting',NULL,?,1,2,?)")
    .run(
      notice.sender_id,
      notice.message_id,
      Date.parse(notice.expires_at),
      JSON.stringify(notice),
    );
  old.close();
  chmodSync(path, 0o600);
  const before = new DatabaseSync(path, { readOnly: true });
  const schema = before
    .prepare("SELECT * FROM sqlite_master ORDER BY name")
    .all();
  const data = before.prepare("SELECT * FROM notices").all();
  const journal = before.prepare("PRAGMA journal_mode").get();
  before.close();
  assert.throws(
    () => new SQLiteNotices(path, "wrong-binding"),
    /target_mismatch/,
  );
  const after = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    after.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
    schema,
  );
  assert.deepEqual(after.prepare("SELECT * FROM notices").all(), data);
  assert.deepEqual(after.prepare("PRAGMA journal_mode").get(), journal);
  after.close();
  const store = new SQLiteNotices(path, "binding");
  t.after(() => store.close());
  assert.equal(store.get(notice).state, "accept_waiting");
  assert.equal(store.get(notice).revision, 0);
  store.transition(notice, ["accept_waiting"], "accepting", 1);
  assert.ok(store.get(notice).revision > 0);
  store.transition(notice, ["accepting"], "queued", 0);
  const finalRevision = store.get(notice).revision;
  assert.ok(finalRevision > 1);
  const second = new SQLiteNotices(path, "binding");
  assert.equal(second.get(notice).revision, finalRevision);
  second.close();
});
