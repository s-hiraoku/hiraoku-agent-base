import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import {
  comparisonMaterial,
  makeReplayBoundMessageId,
  RECORD_RETENTION_MS,
} from "../src/relay/index.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";

const day = 86400000;
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
  agent_id: "a",
  fingerprint_key: new Uint8Array(32).fill(44),
  limits,
  max_records: 10,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  retry_base_ms: 1000,
  retry_cap_ms: 60000,
  max_submit_attempts: 3,
  max_status_attempts: 3,
  status_retry_ms: day,
};
function message(at = Date.now() - 100, entropy = "1".repeat(32)) {
  const first = new Date(at).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(first, entropy),
    recipient_id: "b",
    kind: "question",
    body: { parts: [{ type: "text", text: "synthetic maintenance fixture" }] },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function receipt(m) {
  return {
    sender_id: "a",
    message_id: m.message_id,
    recipient_id: "b",
    receipt_id: "receipt-dummy",
    accepted_at: new Date(Date.parse(m.first_sent_at) + 10).toISOString(),
    expires_at: m.expires_at,
    state: "pending",
  };
}
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-outbox-maintenance-")),
    path = join(dir, "outbox.sqlite"),
    stores = [];
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (extra = {}) => {
    const store = new SQLiteOutbox(path, { ...options, ...patch, ...extra });
    stores.push(store);
    return store;
  };
  const store = open();
  store.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  return { store, raw, open };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
function seed(
  f,
  {
    at = Date.now() - 40 * day,
    entropy = "2".repeat(32),
    legacy,
    state = "accepted",
    statusUntil,
    terminalAt,
  } = {},
) {
  const m = message(at, entropy);
  if (legacy) m.message_id = legacy;
  const expiry = Date.parse(m.expires_at),
    until = statusUntil ?? expiry + day,
    terminal = terminalAt ?? expiry;
  f.raw
    .prepare(
      `INSERT INTO relay_outbox(message_id,recipient_id,expires_at,first_sent_at,fingerprint,body,state,status_until,receipt,terminal_at,retain_until)
    VALUES(?,?,?,?,?,NULL,?,?,?,?,?)`,
    )
    .run(
      m.message_id,
      "b",
      expiry,
      at,
      createHmac("sha256", options.fingerprint_key)
        .update(comparisonMaterial("a", m, limits))
        .digest("hex"),
      state,
      until,
      state === "accepted" ? JSON.stringify(receipt(m)) : null,
      terminal,
      Math.max(expiry, until, terminal) + RECORD_RETENTION_MS,
    );
  return m;
}
function row(f, id) {
  return f.raw.prepare("SELECT * FROM relay_outbox WHERE message_id=?").get(id);
}

test("outbox expiry is explicit and bounded, drops payload, and preserves status recovery without a network call", (t) => {
  const f = fixture(t),
    m = message();
  f.store.enqueue(m);
  f.raw
    .prepare("UPDATE relay_outbox SET expires_at=0 WHERE message_id=?")
    .run(m.message_id);
  assert.equal(row(f, m.message_id).body.includes("synthetic"), true);
  assert.deepEqual(f.store.maintain(1), {
    expired: 1,
    purged: 0,
    safety_held: 0,
  });
  const r = row(f, m.message_id);
  assert.equal(r.body, null);
  assert.equal(r.state, "queued");
  assert.equal(r.status_only, 1);
  assert.equal(r.terminal_at, null);
  assert.equal(f.store.claim().operation, "status");
});

test("active sender leases survive maintenance; an expired exhausted lease is fenced and closed as uncertain", (t) => {
  const f = fixture(t),
    m = message();
  f.store.enqueue(m);
  const job = f.store.claim();
  f.raw.exec("UPDATE relay_outbox SET expires_at=0,status_until=0");
  assert.equal(f.store.maintain(1).expired, 1);
  assert.equal(row(f, m.message_id).state, "sending");
  assert.equal(row(f, m.message_id).fence, job.fence);
  assert.equal(f.store.maintain(1).expired, 0);
  const other = f.open();
  other.migrate();
  f.raw.exec("UPDATE relay_outbox SET lease_until=0");
  assert.equal(other.maintain(1).expired, 1);
  const r = row(f, m.message_id);
  assert.equal(r.state, "expired_unknown");
  assert.equal(r.lease_until, null);
  assert.equal(r.fence, job.fence + 1);
  assert.equal(r.reason, "status_retry_exhausted");
  assert.ok(r.terminal_at > Date.now() - 10000);
  assert.equal(r.retain_until, r.terminal_at + RECORD_RETENTION_MS);
  code(() => f.store.confirm(job, receipt(m)), "stale_sender_lease");
  code(() => f.store.defer(job), "stale_sender_lease");
  assert.equal(other.claim(), null);
});

test("quarantine retains a live payload until expiry; cleanup closes it without claiming nondelivery", (t) => {
  const f = fixture(t),
    m = message();
  f.store.enqueue(m);
  f.store.quarantine(f.store.claim(), "forbidden");
  assert.equal(f.store.maintain(1).expired, 0);
  assert.ok(row(f, m.message_id).body);
  f.raw.exec("UPDATE relay_outbox SET expires_at=0");
  assert.equal(f.store.maintain(1).expired, 1);
  const r = row(f, m.message_id);
  assert.equal(r.state, "expired_unknown");
  assert.equal(r.body, null);
  assert.equal(r.reason, "delivery_window_closed");
  assert.equal(
    r.retain_until,
    Math.max(r.terminal_at, r.status_until) + RECORD_RETENTION_MS,
  );
});

test("expiry cleanup allows a valid in-flight acceptance response to commit after the delivery deadline", (t) => {
  const f = fixture(t),
    m = seed(f, { at: Date.now() - 3601000 });
  f.raw
    .prepare(
      "UPDATE relay_outbox SET state='sending',body=?,fence=1,lease_until=?,operation='submit',receipt=NULL,terminal_at=NULL,retain_until=NULL WHERE message_id=?",
    )
    .run(JSON.stringify(m), Date.now() + 30000, m.message_id);
  assert.equal(f.store.maintain(1).expired, 1);
  f.store.confirm(
    { message_id: m.message_id, fence: 1, operation: "submit", message: m },
    receipt(m),
  );
  assert.equal(f.store.get(m.message_id).state, "accepted");
  assert.equal(row(f, m.message_id).body, null);
});

test("confirmed acceptance retains metadata through the original status horizon and reads/replays do not extend it", (t) => {
  const f = fixture(t),
    m = message();
  f.store.enqueue(m);
  f.store.confirm(f.store.claim(), receipt(m));
  const before = row(f, m.message_id);
  assert.equal(before.body, null);
  assert.ok(before.terminal_at > Date.now() - 10000);
  assert.equal(
    before.retain_until,
    Math.max(before.expires_at, before.status_until, before.terminal_at) +
      RECORD_RETENTION_MS,
  );
  f.store.get(m.message_id);
  f.store.enqueue(m);
  f.store.maintain(1000);
  assert.equal(row(f, m.message_id).terminal_at, before.terminal_at);
  assert.equal(row(f, m.message_id).retain_until, before.retain_until);
});

test("collected accepted/unknown records release capacity but old submissions cannot reopen the dedup window", (t) => {
  const f = fixture(t, { max_records: 2 }),
    a = seed(f),
    b = seed(f, { entropy: "3".repeat(32), state: "expired_unknown" });
  code(() => f.store.enqueue(message()), "outbox_capacity_exceeded");
  assert.deepEqual(f.store.maintain(2), {
    expired: 0,
    purged: 2,
    safety_held: 0,
  });
  code(() => f.store.get(a.message_id), "not_found");
  code(() => f.store.enqueue(a), "expired_before_enqueue");
  code(() => f.store.enqueue(b), "expired_before_enqueue");
  const forged = message();
  forged.message_id = a.message_id;
  code(() => f.store.enqueue(forged), "invalid_contract");
  assert.equal(f.store.enqueue(message()).state, "queued");
  const totals = f.raw
    .prepare("SELECT * FROM relay_outbox_maintenance_totals")
    .all();
  assert.equal(totals.length, 1);
  assert.equal(totals[0].purged, 2);
  assert.equal(Object.hasOwn(totals[0], "message_id"), false);
});

test("legacy IDs are held without starving eligible records and still count against the finite quota", (t) => {
  const f = fixture(t, { max_records: 2 });
  const old = seed(f, { legacy: "legacy-first" }),
    eligible = seed(f);
  assert.deepEqual(f.store.maintain(1), {
    expired: 0,
    purged: 1,
    safety_held: 1,
  });
  assert.ok(row(f, old.message_id));
  assert.equal(row(f, eligible.message_id), undefined);
  const original = f.store.get(old.message_id);
  assert.deepEqual(f.store.enqueue(old), original);
  assert.equal(f.store.enqueue(message()).state, "queued");
  code(
    () => f.store.enqueue(message(Date.now() - 100, "4".repeat(32))),
    "outbox_capacity_exceeded",
  );
});

test("expiry transitions and purges share one budget and never collect queued, quarantined or leased work", (t) => {
  const f = fixture(t),
    m = message();
  f.store.enqueue(m);
  f.raw.exec("UPDATE relay_outbox SET expires_at=0");
  const old = seed(f);
  assert.deepEqual(f.store.maintain(1), {
    expired: 1,
    purged: 0,
    safety_held: 0,
  });
  assert.ok(row(f, old.message_id));
  assert.deepEqual(f.store.maintain(1), {
    expired: 0,
    purged: 1,
    safety_held: 0,
  });
  assert.equal(f.store.get(m.message_id).state, "queued");
  assert.equal(f.store.claim().operation, "status");
  assert.equal(f.store.maintain(1000).purged, 0);
});

test("purge rechecks underlying expiry, terminal and status dates even if cached retention is shortened", (t) => {
  const f = fixture(t),
    now = Date.now();
  const messages = [
    seed(f, { at: now - 29 * day }),
    seed(f, { entropy: "3".repeat(32), terminalAt: now - day }),
    seed(f, { entropy: "4".repeat(32), statusUntil: now - day }),
  ];
  f.raw.exec("UPDATE relay_outbox SET retain_until=0");
  assert.equal(f.store.maintain(1000).purged, 0);
  for (const m of messages) assert.ok(row(f, m.message_id));
});

test("maintenance failures roll back expiration, deletions and aggregate counters together", (t) => {
  const f = fixture(t),
    live = message();
  f.store.enqueue(live);
  f.raw
    .prepare("UPDATE relay_outbox SET expires_at=0 WHERE message_id=?")
    .run(live.message_id);
  const a = seed(f),
    b = seed(f, { entropy: "3".repeat(32) });
  f.raw.exec(
    `CREATE TRIGGER fail_gc BEFORE DELETE ON relay_outbox WHEN OLD.message_id='${b.message_id}' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`,
  );
  assert.throws(() => f.store.maintain(3), /synthetic failure/);
  assert.ok(row(f, live.message_id).body);
  assert.ok(row(f, a.message_id));
  assert.ok(row(f, b.message_id));
  assert.equal(
    f.raw.prepare("SELECT last_at FROM relay_outbox_maintenance_totals").get()
      .last_at,
    0,
  );
  f.raw.exec("DROP TRIGGER fail_gc");
  assert.deepEqual(f.store.maintain(3), {
    expired: 1,
    purged: 2,
    safety_held: 0,
  });
});

test("v1 upgrade is explicit, checks identity first, conservatively dates old receipts and rolls back on failure", (t) => {
  const f = fixture(t),
    m = seed(f);
  const saved = f.store.get(m.message_id).receipt;
  f.store.close();
  f.raw.exec(`DROP INDEX relay_outbox_retention;
    ALTER TABLE relay_outbox DROP COLUMN terminal_at;
    ALTER TABLE relay_outbox DROP COLUMN retain_until;
    DROP TABLE relay_outbox_maintenance_totals;
    UPDATE relay_outbox_meta SET version=1;
    CREATE TRIGGER fail_upgrade BEFORE UPDATE ON relay_outbox_meta BEGIN SELECT RAISE(ABORT,'synthetic upgrade failure'); END;`);
  const badOwner = f.open({ agent_id: "wrong" });
  code(() => badOwner.migrate(), "outbox_identity_mismatch");
  badOwner.close();
  const store = f.open();
  code(() => store.maintain(1), "schema_not_ready");
  assert.throws(() => store.migrate(), /synthetic upgrade failure/);
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_outbox_meta").get().version,
    1,
  );
  assert.equal(
    f.raw
      .prepare("PRAGMA table_info(relay_outbox)")
      .all()
      .some((r) => r.name === "terminal_at"),
    false,
  );
  code(() => store.get(m.message_id), "schema_not_ready");
  f.raw.exec("DROP TRIGGER fail_upgrade");
  store.migrate();
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_outbox_meta").get().version,
    2,
  );
  assert.deepEqual(store.get(m.message_id).receipt, saved);
  assert.ok(row(f, m.message_id).terminal_at > Date.now() - 10000);
  assert.equal(store.maintain(1000).purged, 0);
  const before = row(f, m.message_id).retain_until;
  store.migrate();
  assert.equal(row(f, m.message_id).retain_until, before);
});

test("maintenance rejects invalid budgets, unknown schema and missing aggregate state without repair", (t) => {
  const f = fixture(t);
  for (const limit of [0, -1, 1001, 0.5, NaN, "1", null])
    code(() => f.store.maintain(limit), "invalid_request");
  seed(f);
  f.raw.exec("DELETE FROM relay_outbox_maintenance_totals");
  code(() => f.store.maintain(1000), "maintenance_state_unavailable");
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_outbox").get().n, 1);
  f.raw.exec("UPDATE relay_outbox_meta SET version=3");
  const future = f.open();
  code(() => future.migrate(), "unsupported_schema");
});
