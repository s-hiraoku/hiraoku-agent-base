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
  RelayService,
  DurableReceiver,
} from "../src/relay/index.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
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
  agent_id: "b",
  fingerprint_key: new Uint8Array(32).fill(43),
  limits,
  max_records: 10,
  max_body_bytes: 100000,
  max_ack_records: 30,
  ack_retry_ms: day,
  retry_base_ms: 1000,
  retry_cap_ms: 60000,
  max_attempts: 5,
};
function message(at = Date.now() - 100, entropy = "1".repeat(32)) {
  const first = new Date(at).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(first, entropy),
    recipient_id: "b",
    kind: "question",
    body: { parts: [{ type: "text", text: "synthetic inbox fixture" }] },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function delivery(m = message(), generation = 1) {
  return {
    message: { ...m, sender_id: "a" },
    generation,
    lease_token: "x".repeat(43),
    lease_until: new Date(
      Math.min(Date.now() + 30000, Date.parse(m.expires_at)),
    ).toISOString(),
  };
}
function receipt(req) {
  return {
    recipient_id: "b",
    sender_id: req.sender_id,
    message_id: req.message_id,
    request_id: req.request_id,
    receipt_id: "receipt-dummy",
    acked_at: new Date().toISOString(),
    state: "acked",
  };
}
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-inbox-maintenance-")),
    path = join(dir, "inbox.sqlite"),
    stores = [];
  t.after(() => {
    for (const s of stores) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (extra = {}) => {
    const s = new SQLiteInbox(path, { ...options, ...patch, ...extra });
    stores.push(s);
    return s;
  };
  const store = open();
  store.migrate();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys=ON");
  t.after(() => raw.close());
  return { dir, path, store, raw, open };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
function row(f, id) {
  return f.raw
    .prepare("SELECT * FROM relay_inbox WHERE sender_id='a' AND message_id=?")
    .get(id);
}
function ack(f) {
  return f.raw
    .prepare("SELECT * FROM relay_receiver_acks ORDER BY generation")
    .get();
}
function seed(
  f,
  {
    entropy = "2".repeat(32),
    legacy,
    released = true,
    state = "confirmed",
    horizon = Date.now() - 39 * day,
  } = {},
) {
  const at = Date.now() - 40 * day,
    m = message(at, entropy);
  if (legacy) m.message_id = legacy;
  const expiry = Date.parse(m.expires_at),
    terminal = state === "pending" ? null : at + 1000,
    until = Math.max(expiry, horizon, at + 2000) + RECORD_RETENTION_MS;
  f.raw
    .prepare(
      `INSERT INTO relay_inbox(sender_id,message_id,body,fingerprint,received_at,receipt_confirmed,released_at,expires_at,ack_retry_until,ack_terminal_at,retain_until)
    VALUES('a',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      m.message_id,
      released ? "" : JSON.stringify(m),
      createHmac("sha256", options.fingerprint_key)
        .update(comparisonMaterial("a", m, limits))
        .digest("hex"),
      at,
      Number(state === "confirmed"),
      released ? at + 2000 : null,
      expiry,
      horizon,
      terminal,
      until,
    );
  const req = {
    sender_id: "a",
    message_id: m.message_id,
    generation: 1,
    lease_token: "x".repeat(43),
    request_id: `ack-${entropy}`,
  };
  const fingerprint = createHmac("sha256", options.fingerprint_key)
    .update(
      JSON.stringify([
        req.sender_id,
        req.message_id,
        req.generation,
        req.lease_token,
      ]),
    )
    .digest("hex");
  f.raw
    .prepare(
      `INSERT INTO relay_receiver_acks(request_id,sender_id,message_id,generation,request,fingerprint,state,retry_until,receipt,terminal_at,retain_until)
    VALUES(?,'a',?,1,?,?,?,?,?,?,?)`,
    )
    .run(
      req.request_id,
      m.message_id,
      state === "pending" ? JSON.stringify(req) : null,
      fingerprint,
      state,
      horizon,
      state === "confirmed" ? JSON.stringify(receipt(req)) : null,
      terminal,
      until,
    );
  return { m, req };
}
function realRelay(t, f) {
  const server = new SQLiteRelayStore(join(f.dir, "relay.sqlite"), {
    fingerprint_key: new Uint8Array(32).fill(42),
    max_pending: 10,
    max_records: 100,
    max_pending_per_recipient: 5,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 10,
    retry_cap_ms: 100,
    poll_scan_limit: 10,
  });
  t.after(() => server.close());
  server.migrate();
  const service = new RelayService(server, limits, {
    authorize(ctx) {
      return ["a", "b"].includes(ctx) ? { agent_id: ctx } : undefined;
    },
  });
  return service;
}

test("explicit application handoff is idempotent and released bodies never reappear on exact/new-generation delivery", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  const app = new Map();
  const entry = f.store.inbox()[0];
  app.set(
    `${entry.sender_id}/${entry.message.message_id}`,
    structuredClone(entry.message),
  );
  assert.equal(f.store.releaseBody("a", d.message.message_id), true);
  const before = row(f, d.message.message_id);
  assert.equal(before.body, "");
  assert.equal(before.receipt_confirmed, 0);
  assert.equal(f.store.inbox().length, 0);
  assert.equal(f.store.releaseBody("a", d.message.message_id), false);
  f.store.save(d);
  f.store.save({ ...d, generation: 2 });
  assert.equal(f.store.inbox().length, 0);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_inbox").get().n, 1);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    2,
  );
  assert.equal(row(f, d.message.message_id).released_at, before.released_at);
  assert.deepEqual(app.get(`a/${d.message.message_id}`), entry.message);
  const changed = structuredClone(d);
  changed.message.body.parts[0].text = "changed";
  code(() => f.store.save(changed), "inbox_content_conflict");
});

test("lost server ACK response recovers after release and restart without a second application handoff", async (t) => {
  const f = fixture(t),
    service = realRelay(t, f),
    m = message(),
    requests = [];
  service.submit("a", m);
  const receiver = new DurableReceiver(f.store, {
    async poll() {
      return service.poll("b");
    },
    async ack(req) {
      requests.push(req);
      service.ack("b", req);
      throw Error("synthetic response loss");
    },
  });
  await assert.rejects(receiver.receiveOnce(), /ack_transport_failed/);
  const app = structuredClone(receiver.inbox()[0].message);
  f.store.releaseBody("a", m.message_id);
  f.store.close();
  const reopened = f.open();
  reopened.migrate();
  f.raw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  await new DurableReceiver(reopened, {
    async poll() {
      return service.poll("b");
    },
    async ack(req) {
      requests.push(req);
      return service.ack("b", req);
    },
  }).receiveOnce();
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(app, m);
  assert.equal(reopened.inbox().length, 0);
  assert.equal(row(f, m.message_id).receipt_confirmed, 1);
  assert.equal(ack(f).state, "confirmed");
  assert.equal(ack(f).request, null);
});

test("failed release preserves the complete body and can be retried after another connection reopens", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  f.raw.exec(
    "CREATE TRIGGER fail_release BEFORE UPDATE OF released_at ON relay_inbox BEGIN SELECT RAISE(ABORT,'synthetic release failure'); END",
  );
  assert.throws(
    () => f.store.releaseBody("a", d.message.message_id),
    /synthetic release failure/,
  );
  assert.deepEqual(f.store.inbox()[0].message, messageFrom(d));
  assert.equal(row(f, d.message.message_id).released_at, null);
  f.raw.exec("DROP TRIGGER fail_release");
  const other = f.open();
  other.migrate();
  assert.equal(other.releaseBody("a", d.message.message_id), true);
  assert.equal(f.store.releaseBody("a", d.message.message_id), false);
});
function messageFrom(d) {
  const m = { ...d.message };
  delete m.sender_id;
  return m;
}

test("unknown/foreign release and malformed local inputs do not change another sender's body", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  code(() => f.store.releaseBody("c", d.message.message_id), "not_found");
  for (const id of ["", "../a", "a@b", 1, null])
    code(
      () => f.store.releaseBody(id, d.message.message_id),
      "invalid_request",
    );
  const req = f.store.claimAck();
  code(
    () =>
      f.store.rejectAck({ ...req, lease_token: "y".repeat(43) }, "invalid_ack"),
    "unknown_local_ack",
  );
  code(() => f.store.rejectAck(req, "unknown"), "invalid_failure_reason");
  assert.equal(ack(f).state, "pending");
  assert.equal(f.store.inbox().length, 1);
});

test("unseen expired delivery and new expired generations are rejected while an exact saved journal stays retryable", (t) => {
  const f = fixture(t),
    old = delivery(message(Date.now() - 2 * 3600000));
  code(() => f.store.save(old), "expired_delivery");
  assert.equal(f.store.inbox().length, 0);
  const { m } = seed(f, { released: false, state: "pending" });
  const d = delivery(m);
  f.store.save(d);
  code(() => f.store.save({ ...d, generation: 2 }), "expired_delivery");
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    1,
  );
  assert.equal(f.store.inbox().length, 1);
});

test("bounded maintenance clears exhausted token journals but never an unconsumed body even after 40 days", (t) => {
  const f = fixture(t),
    { m } = seed(f, { released: false, state: "pending" });
  const result = f.store.maintain(1);
  assert.deepEqual(result, {
    expired_acks: 1,
    purged_acks: 0,
    purged_messages: 0,
    safety_held: 0,
  });
  assert.equal(ack(f).state, "quarantined");
  assert.equal(ack(f).request, null);
  assert.ok(ack(f).terminal_at > Date.now() - 10000);
  assert.equal(f.store.maintain(1000).purged_messages, 0);
  assert.deepEqual(f.store.inbox()[0].message, m);
});

test("ACKs and released tombstones share the batch budget; collection recovers quotas and cannot replay the old delivery", (t) => {
  const f = fixture(t, { max_records: 1, max_ack_records: 1 }),
    { m } = seed(f);
  code(() => f.store.save(delivery()), "inbox_capacity_exceeded");
  assert.deepEqual(f.store.maintain(1), {
    expired_acks: 0,
    purged_acks: 1,
    purged_messages: 0,
    safety_held: 0,
  });
  assert.ok(row(f, m.message_id));
  code(() => f.store.save(delivery(m)), "expired_delivery");
  assert.deepEqual(f.store.maintain(1), {
    expired_acks: 0,
    purged_acks: 0,
    purged_messages: 1,
    safety_held: 0,
  });
  code(() => f.store.save(delivery(m)), "expired_delivery");
  const forged = message();
  forged.message_id = m.message_id;
  code(() => f.store.save(delivery(forged)), "invalid_contract");
  f.store.save(delivery());
  assert.equal(f.store.inbox().length, 1);
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  const totals = f.raw
    .prepare("SELECT * FROM relay_inbox_maintenance_totals")
    .all();
  assert.equal(totals.length, 1);
  assert.equal(totals[0].purged_messages, 1);
  assert.equal(Object.hasOwn(totals[0], "message_id"), false);
});

test("an old confirmed ACK may be collected while its unconsumed message remains available", (t) => {
  const f = fixture(t),
    { m } = seed(f, { released: false });
  assert.deepEqual(f.store.maintain(1000), {
    expired_acks: 0,
    purged_acks: 1,
    purged_messages: 0,
    safety_held: 0,
  });
  assert.deepEqual(f.store.inbox()[0].message, m);
  assert.equal(f.store.releaseBody("a", m.message_id), true);
  assert.equal(f.store.maintain(1000).purged_messages, 0);
  assert.ok(row(f, m.message_id).released_at > Date.now() - 10000);
});

test("legacy tombstones stay deduplicated after ACK collection without blocking time-bound IDs", (t) => {
  const f = fixture(t),
    legacy = seed(f, { legacy: "legacy-1" }),
    safe = seed(f, { entropy: "3".repeat(32) });
  assert.deepEqual(f.store.maintain(1000), {
    expired_acks: 0,
    purged_acks: 2,
    purged_messages: 1,
    safety_held: 1,
  });
  assert.ok(row(f, legacy.m.message_id));
  assert.equal(row(f, safe.m.message_id), undefined);
  code(() => f.store.save(delivery(legacy.m)), "expired_delivery");
  assert.equal(f.store.inbox().length, 0);
});

test("cached retention cannot bypass recent release/receive/expiry/ACK terminal/horizon dates or a live pending journal", (t) => {
  const f = fixture(t);
  const fields = [
    "released_at",
    "received_at",
    "expires_at",
    "ack_terminal_at",
    "ack_retry_until",
  ];
  for (let i = 0; i < fields.length; i++) {
    const { m } = seed(f, { entropy: String(i + 2).repeat(32) });
    f.raw
      .prepare(
        `UPDATE relay_inbox SET ${fields[i]}=?,retain_until=0 WHERE message_id=?`,
      )
      .run(Date.now() - day, m.message_id);
  }
  const pending = seed(f, {
    entropy: "7".repeat(32),
    state: "pending",
    horizon: Date.now() + day,
  });
  f.raw.exec("UPDATE relay_inbox SET retain_until=0");
  const result = f.store.maintain(1000);
  assert.equal(result.purged_messages, 0);
  assert.ok(row(f, pending.m.message_id));
  assert.equal(f.raw.prepare("SELECT count(*) n FROM relay_inbox").get().n, 6);
  const journal = f.raw
    .prepare("SELECT state,request FROM relay_receiver_acks WHERE request_id=?")
    .get(pending.req.request_id);
  assert.equal(journal.state, "pending");
  assert.deepEqual(JSON.parse(journal.request), pending.req);
});

test("exact save/confirm/reject/read/release repetitions never renew retention dates", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  const req = f.store.claimAck(),
    r = receipt(req);
  f.store.confirmAck(req, r);
  f.store.releaseBody("a", d.message.message_id);
  // Make any accidental renewal observable without relying on elapsed wall time.
  f.raw.exec(
    "UPDATE relay_inbox SET released_at=released_at-10000,ack_terminal_at=ack_terminal_at-10000,retain_until=retain_until-10000; UPDATE relay_receiver_acks SET terminal_at=terminal_at-10000,retain_until=retain_until-10000",
  );
  const before = row(f, d.message.message_id),
    journal = ack(f);
  f.store.save(d);
  f.store.confirmAck(req, r);
  f.store.rejectAck(req, "invalid_ack");
  f.store.releaseBody("a", d.message.message_id);
  f.store.inbox();
  f.store.maintain(1000);
  assert.deepEqual(row(f, d.message.message_id), before);
  assert.deepEqual(ack(f), journal);
  code(
    () => f.store.confirmAck(req, { ...r, receipt_id: "different" }),
    "local_ack_receipt_conflict",
  );
});

test("a late valid ACK receipt can reconcile exhausted journals after body release without reinserting data", (t) => {
  const f = fixture(t, { max_attempts: 1 }),
    d = delivery();
  f.store.save(d);
  const req = f.store.claimAck();
  f.store.releaseBody("a", d.message.message_id);
  assert.equal(f.store.maintain(1).expired_acks, 1);
  f.store.confirmAck(req, receipt(req));
  assert.equal(ack(f).state, "confirmed");
  assert.equal(row(f, d.message.message_id).receipt_confirmed, 1);
  assert.equal(f.store.inbox().length, 0);
  assert.equal(row(f, d.message.message_id).body, "");
});

test("purge failures roll back ACK deletion, tombstone deletion and maintenance totals together", (t) => {
  const f = fixture(t),
    a = seed(f),
    b = seed(f, { entropy: "3".repeat(32) }),
    pending = seed(f, {
      entropy: "4".repeat(32),
      state: "pending",
      released: false,
    });
  f.raw.exec(
    `CREATE TRIGGER fail_gc BEFORE DELETE ON relay_inbox WHEN OLD.message_id='${b.m.message_id}' BEGIN SELECT RAISE(ABORT,'synthetic purge failure'); END`,
  );
  assert.throws(() => f.store.maintain(1000), /synthetic purge failure/);
  assert.ok(row(f, a.m.message_id));
  assert.ok(row(f, b.m.message_id));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    3,
  );
  const rolledBack = f.raw
    .prepare("SELECT state,request FROM relay_receiver_acks WHERE request_id=?")
    .get(pending.req.request_id);
  assert.equal(rolledBack.state, "pending");
  assert.deepEqual(JSON.parse(rolledBack.request), pending.req);
  assert.equal(
    f.raw.prepare("SELECT last_at FROM relay_inbox_maintenance_totals").get()
      .last_at,
    0,
  );
  f.raw.exec("DROP TRIGGER fail_gc");
  assert.equal(f.store.maintain(1000).purged_messages, 2);
});

function downgrade(f) {
  f.store.close();
  f.raw
    .exec(`DROP TRIGGER relay_attachment_identity; DROP INDEX relay_inbox_retention; DROP INDEX relay_receiver_acks_retention;
    ALTER TABLE relay_inbox DROP COLUMN released_at; ALTER TABLE relay_inbox DROP COLUMN expires_at;
    ALTER TABLE relay_inbox DROP COLUMN ack_retry_until; ALTER TABLE relay_inbox DROP COLUMN ack_terminal_at;
    ALTER TABLE relay_inbox DROP COLUMN retain_until; ALTER TABLE relay_inbox DROP COLUMN has_attachments; ALTER TABLE relay_inbox DROP COLUMN attachment_guard;
    ALTER TABLE relay_receiver_acks DROP COLUMN terminal_at; ALTER TABLE relay_receiver_acks DROP COLUMN retain_until;
    DROP TABLE relay_inbox_maintenance_totals; UPDATE relay_inbox_meta SET version=1;`);
}

test("v1 migration preserves body and stable pending ACK, verifies identity before changes and rolls back a failed upgrade", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  const pending = ack(f).request;
  downgrade(f);
  f.raw.exec(
    "CREATE TRIGGER fail_upgrade BEFORE UPDATE ON relay_inbox_meta BEGIN SELECT RAISE(ABORT,'synthetic upgrade failure'); END",
  );
  const wrong = f.open({ agent_id: "c" });
  code(() => wrong.migrate(), "inbox_identity_mismatch");
  wrong.close();
  const upgraded = f.open();
  code(() => upgraded.maintain(1), "schema_not_ready");
  assert.throws(() => upgraded.migrate(), /synthetic upgrade failure/);
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_inbox_meta").get().version,
    1,
  );
  assert.equal(
    f.raw
      .prepare("PRAGMA table_info(relay_inbox)")
      .all()
      .some((r) => r.name === "released_at"),
    false,
  );
  code(() => upgraded.inbox(), "schema_not_ready");
  f.raw.exec("DROP TRIGGER fail_upgrade");
  upgraded.migrate();
  assert.deepEqual(upgraded.inbox()[0].message, messageFrom(d));
  assert.equal(ack(f).request, pending);
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_inbox_meta").get().version,
    3,
  );
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  const before = row(f, d.message.message_id);
  upgraded.migrate();
  assert.deepEqual(row(f, d.message.message_id), before);
});

test("v1 confirmed receipts are preserved with a conservative migration terminal date; corrupted body cannot be upgraded", (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.save(d);
  const req = f.store.claimAck(),
    r = receipt(req);
  f.store.confirmAck(req, r);
  const saved = ack(f).receipt;
  downgrade(f);
  const body = row(f, d.message.message_id).body;
  f.raw.exec("UPDATE relay_inbox SET body='{}'");
  const upgraded = f.open();
  assert.throws(() => upgraded.migrate());
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_inbox_meta").get().version,
    1,
  );
  f.raw.prepare("UPDATE relay_inbox SET body=?").run(body);
  upgraded.migrate();
  assert.equal(ack(f).receipt, saved);
  assert.ok(ack(f).terminal_at > Date.now() - 10000);
  assert.equal(
    ack(f).retain_until,
    Math.max(ack(f).retry_until, ack(f).terminal_at) + RECORD_RETENTION_MS,
  );
  assert.equal(upgraded.inbox()[0].receipt_confirmed, true);
});

test("invalid budgets, missing counters and unsupported schema fail closed without deleting data", (t) => {
  const f = fixture(t);
  seed(f);
  for (const limit of [0, -1, 1001, 0.1, NaN, "1", null])
    code(() => f.store.maintain(limit), "invalid_request");
  f.raw.exec("DELETE FROM relay_inbox_maintenance_totals");
  code(() => f.store.maintain(1000), "maintenance_state_unavailable");
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    1,
  );
  f.raw.exec("UPDATE relay_inbox_meta SET version=99");
  const newer = f.open();
  code(() => newer.migrate(), "unsupported_schema");
});
