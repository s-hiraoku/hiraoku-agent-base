import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createHash, createHmac } from "node:crypto";
import { RelayService, comparisonMaterial } from "../src/relay/index.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
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
};
const policy = {
  authorize(context) {
    return typeof context === "string" && ["a", "b", "c"].includes(context)
      ? { agent_id: context }
      : undefined;
  },
};
function message(key = "m-1", recipient = "b") {
  const at = Date.now() - 100;
  return {
    version: 1,
    message_id: key,
    recipient_id: recipient,
    kind: "question",
    body: { parts: [{ type: "text", text: "dummy private body" }] },
    thread_id: `thread-${recipient}`,
    in_reply_to: null,
    first_sent_at: new Date(at).toISOString(),
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-delivery-")),
    path = join(dir, "relay.sqlite"),
    stores = [];
  t.after(() => {
    for (const s of stores) {
      try {
        s.close();
      } catch {
        /* closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const s = new SQLiteRelayStore(path, { ...options, ...patch });
    stores.push(s);
    return s;
  };
  const store = open();
  store.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  return {
    path,
    store,
    raw,
    open,
    service: new RelayService(store, limits, policy),
  };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
function ack(delivery, id = "ack-1") {
  return {
    sender_id: delivery.message.sender_id,
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: id,
  };
}
function forceRetry(f) {
  f.raw.exec(
    "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0 WHERE state='leased'",
  );
}

test("poll leases own mailbox once; ACK atomically erases body and recovers after response loss and restart", (t) => {
  const f = fixture(t),
    m = message(),
    accepted = f.service.submit("a", m),
    d = f.service.poll("b");
  assert.ok(d);
  assert.deepEqual(d.message, { ...m, sender_id: "a" });
  assert.equal(d.generation, 1);
  assert.equal(d.lease_token.length, 43);
  assert.equal(f.service.poll("b"), null);
  assert.equal(f.service.poll("c"), null);
  const r = f.service.ack("b", ack(d));
  assert.equal(r.state, "acked");
  assert.equal(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_deliveries").get().state,
    "acked",
  );
  assert.equal(
    f.raw.prepare("SELECT token_hash FROM relay_deliveries").get().token_hash,
    null,
  );
  f.store.close();
  const s = f.open();
  s.migrate();
  const service = new RelayService(s, limits, policy);
  f.raw.exec("UPDATE relay_messages SET expires_at=0");
  assert.deepEqual(service.ack("b", ack(d)), r);
  assert.equal(service.status("a", m.message_id).state, "acked");
  assert.equal(service.submit("a", m).receipt_id, accepted.receipt_id);
  assert.equal(service.poll("b"), null);
  const changed = structuredClone(m);
  changed.body.parts[0].text = "changed";
  code(() => service.submit("a", changed), "idempotency_conflict");
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='acked'",
      )
      .get().n,
    1,
  );
  const dbText = JSON.stringify(
    f.raw.prepare("SELECT * FROM relay_ack_receipts").all(),
  );
  assert.ok(!dbText.includes(d.lease_token));
  assert.ok(!dbText.includes("dummy private body"));
});
test("stale generation, wrong token, foreign inbox and unknown ACK after expiry never confirm receipt", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d1 = f.service.poll("b");
  code(() => f.service.ack("c", ack(d1)), "invalid_ack");
  code(
    () => f.service.ack("b", { ...ack(d1), lease_token: "x".repeat(43) }),
    "invalid_ack",
  );
  forceRetry(f);
  code(() => f.service.ack("b", ack(d1)), "invalid_ack");
  const d2 = f.service.poll("b");
  assert.equal(d2.generation, 2);
  assert.notEqual(d2.lease_token, d1.lease_token);
  code(() => f.service.ack("b", ack(d1)), "invalid_ack");
  f.raw.exec("UPDATE relay_messages SET expires_at=0");
  code(() => f.service.ack("b", ack(d2)), "invalid_ack");
  assert.equal(f.service.poll("b"), null);
  assert.equal(f.service.status("a", "m-1").state, "expired");
});
test("ACK request IDs are idempotent only for the exact committed request; new IDs cannot reconfirm", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d = f.service.poll("b"),
    r = f.service.ack("b", ack(d));
  assert.deepEqual(f.service.ack("b", ack(d)), r);
  code(
    () => f.service.ack("b", { ...ack(d), generation: d.generation + 1 }),
    "ack_idempotency_conflict",
  );
  code(() => f.service.ack("b", ack(d, "new-request")), "invalid_ack");
  const next = message("m-2");
  f.service.submit("a", next);
  const d2 = f.service.poll("b");
  code(() => f.service.ack("b", ack(d2)), "ack_idempotency_conflict");
  assert.equal(f.service.ack("b", ack(d2, "ack-2")).state, "acked");
});
test("ACK audit failure rolls back body deletion and ledger; retry can safely commit", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d = f.service.poll("b");
  f.raw.exec(
    "CREATE TRIGGER fail_ack BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='acked' BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  assert.throws(() => f.service.ack("b", ack(d)), /injected/);
  assert.ok(f.raw.prepare("SELECT body FROM relay_messages").get().body);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    0,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_deliveries").get().state,
    "leased",
  );
  f.raw.exec("DROP TRIGGER fail_ack");
  assert.equal(f.service.ack("b", ack(d)).state, "acked");
});
test("persisted leases survive restart, cap at message expiry and only requeue after bounded backoff", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d = f.service.poll("b");
  f.store.close();
  const s = f.open();
  s.migrate();
  const service = new RelayService(s, limits, policy);
  assert.equal(service.poll("b"), null);
  f.raw.exec(
    "UPDATE relay_deliveries SET lease_until=0,next_visible_at=9223372036854775807",
  );
  assert.equal(service.poll("b"), null);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_deliveries").get().state,
    "pending",
  );
  f.raw.exec("UPDATE relay_deliveries SET next_visible_at=0");
  const d2 = service.poll("b");
  assert.equal(d2.generation, d.generation + 1);
  assert.ok(Date.parse(d2.lease_until) <= Date.parse(d2.message.expires_at));
});
test("retry ceiling quarantines instead of repeatedly leasing; another recipient continues", (t) => {
  const f = fixture(t, { max_attempts: 1 });
  f.service.submit("a", message());
  f.service.poll("b");
  forceRetry(f);
  assert.equal(f.service.poll("b"), null);
  assert.equal(f.service.status("a", "m-1").state, "quarantined");
  f.service.submit("a", message("for-c", "c"));
  assert.ok(f.service.poll("c"));
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='quarantined'",
      )
      .get().n,
    1,
  );
  f.service.poll("b");
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='quarantined'",
      )
      .get().n,
    1,
  );
});
test("policy is rechecked on poll, candidate selection, ACK and even committed ACK retries", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  let active = true,
    blocked = false;
  const service = new RelayService(f.store, limits, {
    authorize(ctx, op, peer) {
      if (!active || (blocked && peer === "a")) return;
      return policy.authorize(ctx, op, peer);
    },
  });
  blocked = true;
  assert.equal(service.poll("b"), null);
  blocked = false;
  const d = service.poll("b");
  active = false;
  code(() => service.ack("b", ack(d)), "forbidden");
  code(() => service.poll("b"), "forbidden");
  active = true;
  service.ack("b", ack(d));
  blocked = true;
  code(() => service.ack("b", ack(d)), "forbidden");
});
test("ACK input is strict and does not accept recipient self-assertion or execute getters", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d = f.service.poll("b");
  for (const patch of [
    { recipient_id: "b" },
    { generation: 0 },
    { lease_token: "bad" },
    { request_id: "" },
  ])
    code(() => f.service.ack("b", { ...ack(d), ...patch }), "invalid_contract");
  let invoked = false;
  const req = ack(d);
  Object.defineProperty(req, "lease_token", {
    enumerable: true,
    get() {
      invoked = true;
      return d.lease_token;
    },
  });
  code(() => f.service.ack("b", req), "invalid_contract");
  assert.equal(invoked, false);
});
test("simultaneous polls through different SQLite connections issue one lease", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const source = `const{parentPort,workerData}=await import('node:worker_threads');const{SQLiteRelayStore}=await import(workerData.storeURL);const{RelayService}=await import(workerData.serviceURL);const s=new SQLiteRelayStore(workerData.path,workerData.options);s.migrate();const svc=new RelayService(s,workerData.limits,{authorize(){return {agent_id:'b'};}});parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(svc.poll(null));}finally{s.close();}});`;
  const workers = [1, 2].map(
    () =>
      new Worker(source, {
        eval: true,
        workerData: {
          path: f.path,
          options,
          limits,
          storeURL: new URL("../src/relay/sqlite-store.ts", import.meta.url)
            .href,
          serviceURL: new URL("../src/relay/service.ts", import.meta.url).href,
        },
      }),
  );
  t.after(async () => {
    await Promise.all(workers.map((w) => w.terminate()));
  });
  await Promise.all(
    workers.map(
      (w) =>
        new Promise((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    ),
  );
  const result = workers.map(
    (w) =>
      new Promise((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
      }),
  );
  workers.forEach((w) => w.postMessage("poll"));
  const all = await Promise.all(result);
  assert.equal(all.filter(Boolean).length, 1);
  assert.equal(
    f.raw.prepare("SELECT attempts FROM relay_deliveries").get().attempts,
    1,
  );
});

// A real schema-v1 fixture, independent of migration implementation.
const legacy = `CREATE TABLE relay_schema(version INTEGER NOT NULL,fingerprint_key_check TEXT NOT NULL);
CREATE TABLE relay_threads(id TEXT PRIMARY KEY,a TEXT NOT NULL,b TEXT NOT NULL);
CREATE TABLE relay_messages(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,recipient_id TEXT NOT NULL,receipt_id TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL REFERENCES relay_threads(id),fingerprint TEXT NOT NULL,accepted_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','expired')),body TEXT,body_bytes INTEGER NOT NULL CHECK(body_bytes>=0),PRIMARY KEY(sender_id,message_id));
CREATE TABLE relay_deliveries(sender_id TEXT NOT NULL,message_id TEXT NOT NULL,recipient_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','expired')),PRIMARY KEY(sender_id,message_id),FOREIGN KEY(sender_id,message_id) REFERENCES relay_messages(sender_id,message_id));
CREATE TABLE relay_delivery_audit(id INTEGER PRIMARY KEY,sender_id TEXT NOT NULL,message_id TEXT NOT NULL,at INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('accepted','expired')));`;
test("explicit v1-to-v2 migration preserves accepted receipts and allows delivery; rollback leaves no partial schema", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-v1-")),
    path = join(dir, "old.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw.exec(legacy);
  raw
    .prepare("INSERT INTO relay_schema VALUES(1,?)")
    .run(createHash("sha256").update(options.fingerprint_key).digest("hex"));
  raw.exec("INSERT INTO relay_threads VALUES('thread-b','a','b')");
  const m = message();
  const body = JSON.stringify(m);
  raw
    .prepare(
      "INSERT INTO relay_messages VALUES('a',?,'b','old-receipt','thread-b',?,?,?,'pending',?,?)",
    )
    .run(
      m.message_id,
      createHmac("sha256", options.fingerprint_key)
        .update(comparisonMaterial("a", m, limits))
        .digest("hex"),
      Date.now(),
      Date.parse(m.expires_at),
      body,
      Buffer.byteLength(body),
    );
  raw.exec("INSERT INTO relay_deliveries VALUES('a','m-1','b','pending')");
  // Wrong key must refuse before altering tables.
  const wrong = new SQLiteRelayStore(path, {
    ...options,
    fingerprint_key: new Uint8Array(32).fill(7),
  });
  t.after(() => wrong.close());
  code(() => wrong.migrate(), "fingerprint_key_mismatch");
  assert.equal(
    raw.prepare("SELECT version FROM relay_schema").get().version,
    1,
  );
  const store = new SQLiteRelayStore(path, options);
  t.after(() => store.close());
  raw.exec(
    "CREATE TRIGGER fail_migration BEFORE UPDATE ON relay_schema BEGIN SELECT RAISE(ABORT,'migration failure'); END",
  );
  assert.throws(() => store.migrate(), /migration failure/);
  assert.equal(
    raw.prepare("SELECT version FROM relay_schema").get().version,
    1,
  );
  assert.equal(
    raw
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name LIKE '%_v2' OR name='relay_ack_receipts'",
      )
      .get().n,
    0,
  );
  assert.equal(raw.prepare("SELECT body FROM relay_messages").get().body, body);
  raw.exec("DROP TRIGGER fail_migration");
  store.migrate();
  store.migrate();
  assert.equal(
    raw.prepare("SELECT version FROM relay_schema").get().version,
    2,
  );
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  const service = new RelayService(store, limits, policy);
  assert.equal(service.submit("a", m).receipt_id, "old-receipt");
  const d = service.poll("b");
  assert.equal(service.ack("b", ack(d)).state, "acked");
});

test("poll audit failure never leaks an uncommitted lease or consumes an attempt", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  f.raw.exec(
    "CREATE TRIGGER fail_poll BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='leased' BEGIN SELECT RAISE(ABORT,'poll failure'); END",
  );
  assert.throws(() => f.service.poll("b"), /poll failure/);
  assert.deepEqual(
    {
      ...f.raw
        .prepare(
          "SELECT state,generation,attempts,token_hash FROM relay_deliveries",
        )
        .get(),
    },
    { state: "pending", generation: 0, attempts: 0, token_hash: null },
  );
  f.raw.exec("DROP TRIGGER fail_poll");
  assert.equal(f.service.poll("b").generation, 1);
});
