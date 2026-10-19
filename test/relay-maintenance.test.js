import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import {
  RelayService,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
  parseSubmission,
  comparisonMaterial,
  RECORD_RETENTION_MS,
  MAX_ACK_RETRY_MS,
  DELIVERY_TTL_MS,
} from "../src/relay/index.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
const DAY = 86400000;
const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  attachment_bytes: 1000,
  total_attachment_bytes: 1000,
  parts: 8,
  attachments: 3,
  json_depth: 20,
  json_nodes: 1000,
};
const options = {
  fingerprint_key: new Uint8Array(32).fill(42),
  max_pending: 20,
  max_records: 100,
  max_pending_per_recipient: 20,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  max_attempts: 3,
  retry_base_ms: 10,
  retry_cap_ms: 100,
  poll_scan_limit: 20,
};
const policy = {
  authorize(ctx, op) {
    if (op === "maintenance")
      return ctx === "operator" ? { agent_id: "operator" } : undefined;
    return ["a", "b"].includes(ctx) ? { agent_id: ctx } : undefined;
  },
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-maint-")),
    path = join(dir, "relay.sqlite"),
    store = new SQLiteRelayStore(path, options);
  store.migrate();
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, store, db, service: new RelayService(store, limits, policy) };
}
function message(at = Date.now() - 100, entropy = "a".repeat(32)) {
  const first = new Date(at).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(first, entropy),
    recipient_id: "b",
    kind: "question",
    body: { parts: [{ type: "text", text: "dummy body" }] },
    thread_id: `thread-${entropy}`,
    in_reply_to: null,
    first_sent_at: first,
    expires_at: new Date(at + DELIVERY_TTL_MS).toISOString(),
  };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
// Historical fixture data, not a wall-clock override or a production migration.
function historical(
  f,
  { age = 31, state = "expired", legacy = false, n = 1, thread } = {},
) {
  const m = message(Date.now() - age * DAY, n.toString(16).padStart(32, "0"));
  if (legacy) m.message_id = `legacy-${n}`;
  if (thread) m.thread_id = thread;
  const expires = Date.parse(m.expires_at),
    sent = Date.parse(m.first_sent_at),
    acked = sent + 1000;
  const terminal =
    state === "acked" ? acked : state === "expired" ? expires : null;
  const retention =
    terminal === null
      ? null
      : Math.max(
          expires,
          state === "acked" ? acked + MAX_ACK_RETRY_MS : terminal,
        ) + RECORD_RETENTION_MS;
  const fingerprint = createHmac("sha256", options.fingerprint_key)
    .update(comparisonMaterial("a", m, limits))
    .digest("hex");
  f.db
    .prepare("INSERT OR IGNORE INTO relay_threads VALUES(?,?,?)")
    .run(m.thread_id, "a", "b");
  const body = ["acked", "expired"].includes(state) ? null : JSON.stringify(m);
  f.db
    .prepare(
      "INSERT INTO relay_messages(sender_id,message_id,recipient_id,receipt_id,thread_id,fingerprint,accepted_at,expires_at,state,body,body_bytes,kind,terminal_at,retain_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "a",
      m.message_id,
      "b",
      `receipt-${n}`,
      m.thread_id,
      fingerprint,
      sent + 100,
      expires,
      state,
      body,
      body ? Buffer.byteLength(body) : 0,
      "question",
      terminal,
      retention,
    );
  f.db
    .prepare(
      "INSERT INTO relay_deliveries(sender_id,message_id,recipient_id,state) VALUES(?,?,?,?)",
    )
    .run("a", m.message_id, "b", state);
  f.db
    .prepare(
      "INSERT INTO relay_delivery_audit(sender_id,message_id,at,event) VALUES(?,?,?,'accepted')",
    )
    .run("a", m.message_id, sent + 100);
  if (state === "acked")
    f.db
      .prepare("INSERT INTO relay_ack_receipts VALUES(?,?,?,?,?,?,?)")
      .run(
        "b",
        `ack-${n}`,
        "a",
        m.message_id,
        "dummy-fingerprint",
        `ack-receipt-${n}`,
        acked,
      );
  return m;
}

test("replay-bound IDs bind original send time and forbid timestamp/TTL renewal", () => {
  const m = message();
  assert.equal(
    isReplayBoundMessageId(m.message_id, Date.parse(m.expires_at)),
    true,
  );
  assert.equal(
    isReplayBoundMessageId("legacy", Date.parse(m.expires_at)),
    false,
  );
  assert.equal(parseSubmission(m, limits).message_id, m.message_id);
  const renewed = {
    ...m,
    first_sent_at: new Date(Date.parse(m.first_sent_at) + 1000).toISOString(),
    expires_at: new Date(Date.parse(m.expires_at) + 1000).toISOString(),
  };
  code(() => parseSubmission(renewed, limits), "invalid_contract");
  code(
    () => parseSubmission({ ...m, message_id: "rm1.bad" }, limits),
    "invalid_contract",
  );
  code(
    () => makeReplayBoundMessageId(m.first_sent_at, "not-random-hex"),
    "invalid_contract",
  );
});
test("maintenance requires separate verified authorization and rejects unknown/missing policy", (t) => {
  const f = fixture(t);
  historical(f);
  code(() => f.service.maintain("a", 10), "forbidden");
  code(
    () => new RelayService(f.store, limits).maintain("operator", 10),
    "forbidden",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
  for (const limit of [0, -1, 1001, 1.5])
    code(
      () => f.service.maintain("operator", limit),
      "invalid_maintenance_limit",
    );
  assert.equal(f.service.maintain("operator", 10).purged, 1);
});
test("idle expired deliveries erase body at maintenance and retain tombstones for 30 days", (t) => {
  const f = fixture(t),
    m = historical(f, { age: 1, state: "leased" });
  f.db
    .prepare(
      "UPDATE relay_deliveries SET generation=1,token_hash=?,lease_until=?",
    )
    .run("synthetic", Date.now() + 10000);
  const r = f.service.maintain("operator", 1);
  assert.equal(r.expired, 1);
  assert.equal(r.purged, 0);
  const row = f.db.prepare("SELECT * FROM relay_messages").get();
  assert.equal(row.body, null);
  assert.equal(row.state, "expired");
  assert.equal(row.terminal_at, Date.parse(m.expires_at));
  assert.equal(
    row.retain_until,
    Date.parse(m.expires_at) + RECORD_RETENTION_MS,
  );
  assert.equal(
    f.db.prepare("SELECT token_hash FROM relay_deliveries").get().token_hash,
    null,
  );
  assert.equal(f.service.maintain("operator", 10).purged, 0);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='expired'",
      )
      .get().n,
    1,
  );
});
test("old protected message, delivery, audit and ACK ledger purge together; orphan thread is collected", (t) => {
  const f = fixture(t),
    m = historical(f, { age: 61, state: "acked" });
  const r = f.service.maintain("operator", 10);
  assert.equal(r.purged, 1);
  assert.equal(r.threads, 1);
  for (const table of [
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
    "relay_ack_receipts",
    "relay_threads",
  ])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  code(() => f.service.status("a", m.message_id), "not_found");
  code(() => f.service.submit("a", m), "expired_before_acceptance");
  const modified = {
    ...m,
    first_sent_at: new Date(Date.now() - 100).toISOString(),
    expires_at: new Date(Date.now() - 100 + DELIVERY_TTL_MS).toISOString(),
  };
  code(() => f.service.submit("a", modified), "invalid_contract");
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.service.maintain("operator", 10).purged, 0);
  assert.equal(
    f.db.prepare("SELECT purged FROM relay_maintenance_totals").get().purged,
    1,
  );
});
test("purge never outruns message or committed ACK retry horizons even if cached retain_until is wrong", (t) => {
  const f = fixture(t);
  historical(f, { age: 31, state: "acked" });
  f.db.exec("UPDATE relay_messages SET retain_until=0");
  assert.equal(f.service.maintain("operator", 10).purged, 0);
  historical(f, { age: 1, state: "expired", n: 2 });
  f.db.exec("UPDATE relay_messages SET retain_until=0");
  assert.equal(f.service.maintain("operator", 10).purged, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM relay_messages").get().n,
    2,
  );
});
test("legacy unbound IDs are safety-held without starving safe IDs in the same batch", (t) => {
  const f = fixture(t);
  historical(f, { legacy: true, n: 1 });
  historical(f, { n: 2 });
  const r = f.service.maintain("operator", 1);
  assert.equal(r.purged, 1);
  assert.equal(r.safety_held, 1);
  assert.equal(
    f.db.prepare("SELECT message_id FROM relay_messages").get().message_id,
    "legacy-1",
  );
});
test("batch budget includes expiry, purge and orphan-thread units; active threads and pending bodies survive", (t) => {
  const f = fixture(t),
    thread = "shared";
  for (let n = 1; n <= 3; n++) historical(f, { n, thread });
  const active = message();
  active.thread_id = thread;
  f.service.submit("a", active);
  const a = f.service.maintain("operator", 2);
  assert.equal(a.expired + a.purged + a.threads, 2);
  assert.equal(a.purged, 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM relay_threads").get().n, 1);
  assert.ok(
    f.db.prepare("SELECT body FROM relay_messages WHERE state='pending'").get()
      .body,
  );
  assert.equal(f.service.maintain("operator", 2).purged, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM relay_threads").get().n, 1);
});
test("failure during final message deletion rolls back prior related deletes and counters", (t) => {
  const f = fixture(t);
  historical(f, { age: 61, state: "acked" });
  f.db.exec(
    "CREATE TRIGGER fail_purge BEFORE DELETE ON relay_messages BEGIN SELECT RAISE(ABORT,'purge failure'); END",
  );
  assert.throws(() => f.service.maintain("operator", 10), /purge failure/);
  for (const table of [
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
    "relay_ack_receipts",
  ])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
  assert.equal(
    f.db.prepare("SELECT purged FROM relay_maintenance_totals").get().purged,
    0,
  );
  f.db.exec("DROP TRIGGER fail_purge");
  assert.equal(f.service.maintain("operator", 10).purged, 1);
});
test("fresh ACK commit fixes retention once and ACK retry does not extend it", (t) => {
  const f = fixture(t),
    m = message();
  f.service.submit("a", m);
  const d = f.service.poll("b"),
    req = {
      sender_id: "a",
      message_id: m.message_id,
      generation: d.generation,
      lease_token: d.lease_token,
      request_id: "ack-1",
    };
  const ack = f.service.ack("b", req);
  const before = {
    ...f.db
      .prepare("SELECT terminal_at,retain_until FROM relay_messages")
      .get(),
  };
  assert.equal(before.terminal_at, Date.parse(ack.acked_at));
  assert.equal(
    before.retain_until,
    Math.max(Date.parse(m.expires_at), before.terminal_at + MAX_ACK_RETRY_MS) +
      RECORD_RETENTION_MS,
  );
  f.service.ack("b", req);
  assert.deepEqual(
    {
      ...f.db
        .prepare("SELECT terminal_at,retain_until FROM relay_messages")
        .get(),
    },
    before,
  );
  assert.equal(f.service.maintain("operator", 100).purged, 0);
});
test("v2 metadata migration is explicit, preserves receipts, and rolls back partially applied schema on failure", (t) => {
  const f = fixture(t),
    m = historical(f, { age: 61, state: "acked" });
  f.db.exec(
    "DROP TABLE relay_attachment_deletions; DROP TABLE relay_message_attachments; DROP INDEX relay_messages_retention; ALTER TABLE relay_messages DROP COLUMN terminal_at; ALTER TABLE relay_messages DROP COLUMN retain_until; DROP TABLE relay_maintenance_totals; UPDATE relay_schema SET version=2;",
  );
  f.db.exec(
    "CREATE TRIGGER fail_upgrade BEFORE UPDATE ON relay_schema BEGIN SELECT RAISE(ABORT,'upgrade failure'); END",
  );
  const upgraded = new SQLiteRelayStore(f.path, options);
  t.after(() => upgraded.close());
  assert.throws(() => upgraded.migrate(), /upgrade failure/);
  assert.equal(
    f.db.prepare("SELECT version FROM relay_schema").get().version,
    2,
  );
  assert.ok(
    !f.db
      .prepare("PRAGMA table_info(relay_messages)")
      .all()
      .some((x) => x.name === "retain_until"),
  );
  f.db.exec("DROP TRIGGER fail_upgrade");
  upgraded.migrate();
  upgraded.migrate();
  assert.equal(
    f.db.prepare("SELECT version FROM relay_schema").get().version,
    4,
  );
  assert.equal(
    new RelayService(upgraded, limits, policy).status("a", m.message_id)
      .receipt_id,
    "receipt-1",
  );
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    new RelayService(upgraded, limits, policy).maintain("operator", 10).purged,
    1,
  );
});

test("missing maintenance counter fails closed instead of silently losing deletion audit", (t) => {
  const f = fixture(t);
  historical(f);
  f.db.exec("DELETE FROM relay_maintenance_totals");
  code(
    () => f.service.maintain("operator", 10),
    "maintenance_state_unavailable",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
});
