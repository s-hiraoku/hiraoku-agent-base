import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { main, reconcile } from "../scripts/relay-rollback-reconcile.mjs";

// Minimal read-only SQLite projections, not a broker or inbox-integrity proof.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "rollback-list-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = (name, sql) => {
    const path = join(dir, name);
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    return path;
  };
  const schema =
    "CREATE TABLE nats_messages(sender_id,message_id,recipient_id,state,expires_at);";
  const backup = database("before", schema);
  const upgraded = database("after", schema);
  const inboxSchema = `CREATE TABLE relay_inbox_meta(agent_id);
    INSERT INTO relay_inbox_meta VALUES ('b');
    CREATE TABLE relay_inbox(sender_id,message_id,expires_at,released_at);`;
  const inbox = database(
    "inbox",
    inboxSchema +
      `
    INSERT INTO relay_inbox VALUES ('a','waiting',1000,NULL),('a','done',1000,2000);`,
  );
  const backupInbox = database("backup-inbox", inboxSchema);
  const execution = join(dir, "execution.json");
  writeFileSync(
    execution,
    JSON.stringify({
      recipient_id: "b",
      handled: [
        { sender_id: "a", message_id: "done" },
        { sender_id: "a", message_id: "app-only" },
      ],
    }),
  );
  return {
    backup,
    upgraded,
    inboxes: [inbox],
    backupInboxes: [backupInbox],
    executions: [execution],
    now: 40 * 86400000,
  };
}

test("journal-GCed post-backup IDs survive in the recipient evidence union", (t) => {
  const options = fixture(t);
  const before = options.inboxes.map((path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("SELECT * FROM relay_inbox").all();
    db.close();
    return rows;
  });
  const out = reconcile(options);
  assert.deepEqual(
    out.messages.map((r) => r.message_id),
    ["app-only", "done", "waiting"],
  );
  const app = out.messages.find((r) => r.message_id === "app-only");
  assert.equal(app.expires_at, null);
  assert.equal(app.execution_record, "handled");
  assert.equal(
    app.action,
    "unknown",
    "execution evidence alone does not invent a relay save",
  );
  assert.equal(
    out.messages.find((r) => r.message_id === "waiting").action,
    "delivered",
  );
  assert.deepEqual(out.retained_bodies, [
    {
      recipient_id: "b",
      sender_id: "a",
      message_id: "waiting",
      expires_at: new Date(1000).toISOString(),
      backup_record: "absent",
      execution_record: "absent",
      action: "review_application_handoff",
    },
  ]);
  assert.deepEqual(out.restored_bodies, []);
  const db = new DatabaseSync(options.inboxes[0], { readOnly: true });
  assert.deepEqual(db.prepare("SELECT * FROM relay_inbox").all(), before[0]);
  db.close();
});

test("retained bodies with missing execution or backup evidence stay unknown", (t) => {
  const options = fixture(t);
  assert.equal(
    reconcile({ ...options, executions: [] }).retained_bodies[0].action,
    "unknown",
  );
  assert.equal(
    reconcile({ ...options, backupInboxes: [] }).retained_bodies[0].action,
    "unknown",
  );
});

test("retained handled bodies never request another handoff; restored bodies stay separate", (t) => {
  const options = fixture(t);
  const db = new DatabaseSync(options.inboxes[0]);
  db.exec("UPDATE relay_inbox SET released_at=NULL WHERE message_id='done'");
  db.close();
  const backup = new DatabaseSync(options.backupInboxes[0]);
  backup.exec("INSERT INTO relay_inbox VALUES ('a','waiting',1000,NULL)");
  backup.close();
  const out = reconcile(options);
  assert.deepEqual(
    out.retained_bodies.map((r) => [r.message_id, r.action]),
    [["done", "do_not_process"]],
  );
  assert.deepEqual(
    out.restored_bodies.map((r) => [r.message_id, r.action]),
    [["waiting", "process"]],
  );
});

test("a released backup record does not authorize a retained-copy handoff", (t) => {
  const options = fixture(t);
  const db = new DatabaseSync(options.backupInboxes[0]);
  db.exec("INSERT INTO relay_inbox VALUES ('a','waiting',1000,2000)");
  db.close();
  const [body] = reconcile(options).retained_bodies;
  assert.equal(body.backup_record, "released");
  assert.equal(body.action, "unknown");
});

test("large restored journals compute the incomplete expiry without changing evidence", (t) => {
  const { backup, upgraded } = fixture(t);
  const args = ["--upgraded-journal", upgraded, "--backup-journal", backup];
  assert.equal(main(args).restored_incomplete_expire_by, null);

  // Above the pinned Node runtime's argument-count limit. Use real SQLite reads
  // through the CLI entry point, without printing the large reconciliation list.
  const count = 150000;
  const expiry = Date.UTC(2026, 10, 7);
  const db = new DatabaseSync(backup);
  try {
    db.prepare(
      `WITH RECURSIVE ids(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n+1 < ?
    ) INSERT INTO nats_messages
      SELECT 'a',printf('message-%06d',n),'b',
        CASE n WHEN 0 THEN 'staging' WHEN 1 THEN 'leased'
          WHEN 2 THEN 'quarantined' ELSE 'pending' END,
        ? + CASE n WHEN 2 THEN ? ELSE n END FROM ids`,
    ).run(count, expiry, count);
    db.prepare("INSERT INTO nats_messages VALUES ('a',?,'b',?,?)").run(
      "already-acked",
      "acked",
      expiry + count + 1000,
    );
    db.prepare("INSERT INTO nats_messages VALUES ('a',?,'b',?,?)").run(
      "already-expired",
      "expired",
      expiry + count + 2000,
    );
  } finally {
    db.close();
  }
  const digest = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = [backup, upgraded].map(digest);
  const out = main(args);
  assert.equal(
    out.restored_incomplete_expire_by,
    new Date(expiry + count).toISOString(),
  );
  assert.equal(out.messages.length, count);
  assert.ok(
    out.messages.every(
      (row) => row.final_state === null && row.action === "unknown",
    ),
    "a large backup with no upgraded or recipient evidence stays unknown",
  );
  assert.deepEqual(out.restored_bodies, []);
  assert.deepEqual(out.retained_bodies, []);
  assert.deepEqual([backup, upgraded].map(digest), before);
});
