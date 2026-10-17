import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { RelayService } from "../src/relay/index.ts";
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
  authorize(context, op, recipient) {
    if (context !== "connection-a" && context !== "connection-b") return;
    if (recipient === "blocked") return;
    return { agent_id: context === "connection-a" ? "agent-a" : "agent-b" };
  },
};
function message(key = "m-1", recipient = "agent-b") {
  const sent = Date.now() - 100;
  return {
    version: 1,
    message_id: key,
    recipient_id: recipient,
    kind: "question",
    body: { parts: [{ type: "text", text: "dummy message" }] },
    thread_id: "thread-1",
    in_reply_to: null,
    first_sent_at: new Date(sent).toISOString(),
    expires_at: new Date(sent + 3600000).toISOString(),
  };
}
function fixture(t, opts = options) {
  const dir = mkdtempSync(join(tmpdir(), "relay-test-")),
    path = join(dir, "relay.sqlite");
  const stores = [];
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
  const open = () => {
    const store = new SQLiteRelayStore(path, opts);
    stores.push(store);
    return store;
  };
  const store = open();
  store.migrate();
  return {
    path,
    store,
    open,
    service: new RelayService(store, limits, policy),
  };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}

test("acceptance is durable, contains no body, and recovers an unchanged receipt after restart", (t) => {
  const f = fixture(t),
    input = message();
  const first = f.service.submit("connection-a", input);
  assert.equal(first.sender_id, "agent-a");
  assert.equal(first.state, "pending");
  assert.equal("body" in first, false);
  f.store.close();
  const reopened = f.open();
  reopened.migrate();
  const service = new RelayService(reopened, limits, policy);
  assert.deepEqual(service.submit("connection-a", input), first);
  assert.deepEqual(service.status("connection-a", input.message_id), first);
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  for (const table of [
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
  ])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
  const different = structuredClone(input);
  different.body.parts[0].text = "different";
  code(() => service.submit("connection-a", different), "idempotency_conflict");
});
test("missing, throwing and revoked policy fail closed; foreign status and sender spoofing do not disclose body", (t) => {
  const f = fixture(t),
    m = message();
  code(
    () => new RelayService(f.store, limits).submit("connection-a", m),
    "forbidden",
  );
  code(
    () =>
      new RelayService(f.store, limits, {
        authorize() {
          throw Error("sensitive");
        },
      }).submit("connection-a", m),
    "forbidden",
  );
  code(() => f.service.submit({ agent_id: "agent-a" }, m), "forbidden");
  f.service.submit("connection-a", m);
  code(() => f.service.status("connection-b", m.message_id), "not_found");
  code(
    () => f.service.submit("connection-a", { ...m, sender_id: "agent-b" }),
    "invalid_contract",
  );
  code(
    () => f.service.submit("connection-a", message("blocked", "blocked")),
    "forbidden",
  );
  let active = true;
  const service = new RelayService(f.store, limits, {
    authorize() {
      return active ? { agent_id: "agent-a" } : undefined;
    },
  });
  assert.equal(service.status(null, m.message_id).state, "pending");
  active = false;
  code(() => service.submit(null, m), "forbidden");
  code(() => service.status(null, m.message_id), "forbidden");
});
test("DB clock rejects expired/future messages and expired accepted duplicates never resurrect body", (t) => {
  const f = fixture(t);
  const old = message("old");
  old.first_sent_at = new Date(Date.now() - 7200000).toISOString();
  old.expires_at = new Date(Date.now() - 3600000).toISOString();
  code(
    () => f.service.submit("connection-a", old),
    "expired_before_acceptance",
  );
  const future = message("future");
  future.first_sent_at = new Date(Date.now() + 60000).toISOString();
  future.expires_at = new Date(
    Date.parse(future.first_sent_at) + 3600000,
  ).toISOString();
  code(() => f.service.submit("connection-a", future), "clock_skew");
  const m = message();
  const first = f.service.submit("connection-a", m);
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.prepare("UPDATE relay_messages SET expires_at=0").run();
  const expired = f.service.submit("connection-a", m);
  assert.equal(expired.state, "expired");
  assert.equal(expired.receipt_id, first.receipt_id);
  assert.equal(db.prepare("SELECT body FROM relay_messages").get().body, null);
  assert.equal(
    db.prepare("SELECT state FROM relay_deliveries").get().state,
    "expired",
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='expired'",
      )
      .get().n,
    1,
  );
  f.service.status("connection-a", m.message_id);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM relay_delivery_audit WHERE event='expired'",
      )
      .get().n,
    1,
  );
});
test("message, delivery, audit and new thread roll back together when audit persistence fails", (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER test_fail BEFORE INSERT ON relay_delivery_audit BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  assert.throws(
    () => f.service.submit("connection-a", message()),
    /injected failure/,
  );
  for (const table of [
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
    "relay_threads",
  ])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  db.exec("DROP TRIGGER test_fail");
  assert.equal(f.service.submit("connection-a", message()).state, "pending");
});
test("capacity rejection does not discard an accepted message and duplicate retry needs no new capacity", (t) => {
  const f = fixture(t, { ...options, max_pending: 1 }),
    m = message();
  const first = f.service.submit("connection-a", m);
  assert.deepEqual(f.service.submit("connection-a", m), first);
  code(
    () => f.service.submit("connection-a", message("m-2")),
    "capacity_exceeded",
  );
  assert.deepEqual(f.service.status("connection-a", m.message_id), first);
  const small = new SQLiteRelayStore(":memory:", {
    ...options,
    max_body_bytes: 1,
  });
  t.after(() => small.close());
  small.migrate();
  code(
    () =>
      new RelayService(small, limits, policy).submit("connection-a", message()),
    "capacity_exceeded",
  );
});
test("reciprocal replies use the same pair; foreign threads and forged reply references fail", (t) => {
  const f = fixture(t),
    m = message();
  f.service.submit("connection-a", m);
  const reply = message("answer", "agent-a");
  reply.in_reply_to = { sender_id: "agent-a", message_id: m.message_id };
  assert.equal(f.service.submit("connection-b", reply).sender_id, "agent-b");
  const foreign = message("foreign", "agent-c");
  code(() => f.service.submit("connection-a", foreign), "invalid_reference");
  const missing = message("missing");
  missing.in_reply_to = { sender_id: "agent-b", message_id: "absent" };
  code(() => f.service.submit("connection-a", missing), "invalid_reference");
});
test("unimplemented attachment storage fails closed rather than issuing a false acceptance", (t) => {
  const f = fixture(t),
    m = message();
  m.body.parts.push({
    type: "attachment",
    attachment_id: "file-1",
    media_type: "application/pdf",
    size_bytes: 10,
    sha256: "a".repeat(64),
  });
  code(
    () => f.service.submit("connection-a", m),
    "attachment_store_unavailable",
  );
  code(() => f.service.status("connection-a", m.message_id), "not_found");
});
test("opening never applies schema; explicit migration rejects unknown schema and changed fingerprint key", (t) => {
  const f = fixture(t);
  const fresh = f.open();
  code(
    () =>
      new RelayService(fresh, limits, policy).submit("connection-a", message()),
    "schema_not_ready",
  );
  fresh.migrate();
  const changed = new SQLiteRelayStore(f.path, {
    ...options,
    fingerprint_key: new Uint8Array(32).fill(7),
  });
  t.after(() => changed.close());
  code(() => changed.migrate(), "fingerprint_key_mismatch");
  const unknown = new SQLiteRelayStore(":memory:", options);
  t.after(() => unknown.close()); // readiness is explicit even for memory databases
  code(
    () => new RelayService(unknown, limits, policy).status("connection-a", "m"),
    "schema_not_ready",
  );
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec("UPDATE relay_schema SET version=999");
  const newer = f.open();
  code(() => newer.migrate(), "unsupported_schema");
});

test("concurrent SQLite connections return one receipt for duplicate submit and enforce capacity atomically", async (t) => {
  const f = fixture(t, { ...options, max_pending: 1 });
  const m = message();
  const source = `const {parentPort,workerData}=await import('node:worker_threads');const {SQLiteRelayStore}=await import(workerData.storeURL);const {RelayService}=await import(workerData.serviceURL);const s=new SQLiteRelayStore(workerData.path,workerData.options);s.migrate();const service=new RelayService(s,workerData.limits,{authorize(){return {agent_id:'agent-a'};}});parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage({receipt:service.submit(null,workerData.message)});}catch(e){parentPort.postMessage({error:e.code});}finally{s.close();}});`;
  async function pair(messages, path = f.path) {
    const workers = messages.map(
      (message) =>
        new Worker(source, {
          eval: true,
          workerData: {
            path,
            options: { ...options, max_pending: 1 },
            limits,
            message,
            storeURL: new URL("../src/relay/sqlite-store.ts", import.meta.url)
              .href,
            serviceURL: new URL("../src/relay/service.ts", import.meta.url)
              .href,
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
    const results = workers.map(
      (w) =>
        new Promise((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    );
    workers.forEach((w) => w.postMessage("go"));
    return Promise.all(results);
  }
  const dup = await pair([m, m]);
  assert.deepEqual(dup[0].receipt, dup[1].receipt);
  assert.ok(dup[0].receipt);
  const empty = fixture(t, { ...options, max_pending: 1 });
  const race = await pair([message("new-1"), message("new-2")], empty.path);
  assert.equal(race.filter((x) => x.receipt).length, 1);
  assert.equal(race.filter((x) => x.error === "capacity_exceeded").length, 1);
});

test("unknown database is not adopted and retained-record capacity is finite", (t) => {
  const f = fixture(t, { ...options, max_records: 1 });
  const m = message();
  f.service.submit("connection-a", m);
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec("UPDATE relay_messages SET expires_at=0");
  f.service.status("connection-a", m.message_id);
  code(
    () => f.service.submit("connection-a", message("next")),
    "capacity_exceeded",
  );
  const path = join(
    mkdtempSync(join(tmpdir(), "relay-unknown-")),
    "other.sqlite",
  );
  t.after(() => rmSync(join(path, ".."), { recursive: true, force: true }));
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE unrelated(value TEXT)");
  raw.close();
  const store = new SQLiteRelayStore(path, options);
  t.after(() => store.close());
  code(() => store.migrate(), "unknown_schema");
});
