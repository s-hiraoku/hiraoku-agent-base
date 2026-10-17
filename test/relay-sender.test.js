import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  DurableSender,
  DurableReceiver,
  RelayService,
  RelayError,
} from "../src/relay/index.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
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
  status_retry_ms: 86400000,
};
const relayOptions = {
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
  authorize(ctx) {
    return ["a", "b", "c"].includes(ctx) ? { agent_id: ctx } : undefined;
  },
};
function message(key = "m-1") {
  const at = Date.now() - 100;
  return {
    version: 1,
    message_id: key,
    recipient_id: "b",
    kind: "question",
    body: { parts: [{ type: "text", text: "dummy text" }] },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: new Date(at).toISOString(),
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-sender-")),
    path = join(dir, "outbox.sqlite"),
    serverPath = join(dir, "relay.sqlite"),
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
  const server = new SQLiteRelayStore(serverPath, relayOptions);
  stores.push(server);
  server.migrate();
  const service = new RelayService(server, limits, policy);
  const open = () => {
    const s = new SQLiteOutbox(path, { ...options, ...patch });
    stores.push(s);
    return s;
  };
  const outbox = open();
  outbox.migrate();
  const raw = new DatabaseSync(path),
    relayRaw = new DatabaseSync(serverPath);
  t.after(() => {
    raw.close();
    relayRaw.close();
  });
  const transport = {
    async submit(m) {
      return service.submit("a", m);
    },
    async status(id) {
      return service.status("a", id);
    },
  };
  return { dir, path, service, outbox, open, raw, relayRaw, transport };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
function due(f) {
  f.raw.exec("UPDATE relay_outbox SET next_retry_at=0");
}
function expireLease(f) {
  f.raw.exec("UPDATE relay_outbox SET lease_until=0 WHERE state='sending'");
}

test("outbox commits before network, preserves immutable input, and removes body only after validated acceptance", async (t) => {
  const f = fixture(t),
    original = message(),
    m = structuredClone(original);
  let sends = 0;
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    async submit(input) {
      sends++;
      assert.equal(
        f.raw.prepare("SELECT state FROM relay_outbox").get().state,
        "sending",
      );
      assert.deepEqual(
        JSON.parse(f.raw.prepare("SELECT body FROM relay_outbox").get().body),
        original,
      );
      assert.deepEqual(input, original);
      return f.transport.submit(input);
    },
  });
  sender.enqueue(m);
  m.body.parts[0].text = "changed externally";
  await sender.sendOnce();
  const r = sender.get(m.message_id);
  assert.equal(r.state, "accepted");
  assert.equal(r.receipt.sender_id, "a");
  assert.equal("body" in r, false);
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(sender.enqueue(original), r);
  code(() => sender.enqueue(m), "outbox_content_conflict");
  await sender.sendOnce();
  assert.equal(sends, 1);
});
test("lost acceptance response survives restart and resends the same ID, recipient, contents and deadline", async (t) => {
  const f = fixture(t),
    m = message(),
    seen = [];
  const failing = new DurableSender(f.outbox, {
    ...f.transport,
    async submit(input) {
      seen.push(input);
      await f.transport.submit(input);
      throw Error("private network detail");
    },
  });
  failing.enqueue(m);
  await assert.rejects(
    failing.sendOnce(),
    (e) =>
      e.code === "sender_transport_failed" && !e.message.includes("private"),
  );
  const receipt = f.service.status("a", m.message_id);
  assert.equal(failing.get(m.message_id).state, "queued");
  f.outbox.close();
  const store = f.open();
  store.migrate();
  due(f);
  const sender = new DurableSender(store, {
    ...f.transport,
    async submit(input) {
      seen.push(input);
      return f.transport.submit(input);
    },
  });
  await sender.sendOnce();
  assert.deepEqual(seen, [m, m]);
  assert.equal(sender.get(m.message_id).receipt.receipt_id, receipt.receipt_id);
  assert.equal(
    f.relayRaw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
});
test("submission budget switches to status, recovering acceptance without another submission", async (t) => {
  const f = fixture(t, { max_submit_attempts: 1 }),
    m = message();
  let sends = 0,
    lookups = 0;
  const sender = new DurableSender(f.outbox, {
    async submit(input) {
      sends++;
      await f.transport.submit(input);
      throw Error("lost");
    },
    async status(id) {
      lookups++;
      return f.transport.status(id);
    },
  });
  sender.enqueue(m);
  await assert.rejects(sender.sendOnce(), /sender_transport_failed/);
  due(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "accepted");
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
});
test("restart after claim before transmission recovers the stable queued payload", async (t) => {
  const f = fixture(t),
    m = message();
  f.outbox.enqueue(m);
  const abandoned = f.outbox.claim();
  assert.equal(abandoned.operation, "submit");
  f.outbox.close();
  expireLease(f);
  const store = f.open();
  store.migrate();
  let input;
  await new DurableSender(store, {
    ...f.transport,
    async submit(value) {
      input = value;
      return f.transport.submit(value);
    },
  }).sendOnce();
  assert.deepEqual(input, m);
  assert.equal(store.get(m.message_id).state, "accepted");
});
test("stale sender fence cannot confirm, defer or quarantine a newer lease", (t) => {
  const f = fixture(t),
    m = message();
  f.outbox.enqueue(m);
  const old = f.outbox.claim(),
    receipt = f.service.submit("a", m);
  assert.equal(f.outbox.claim(), null);
  expireLease(f);
  const current = f.outbox.claim();
  assert.ok(current.fence > old.fence);
  for (const fn of [
    () => f.outbox.confirm(old, receipt),
    () => f.outbox.defer(old),
    () => f.outbox.quarantine(old, "forbidden"),
  ])
    code(fn, "stale_sender_lease");
  f.outbox.confirm(current, receipt);
  assert.equal(f.outbox.get(m.message_id).state, "accepted");
});
test("expired delivery attempts only status, clears payload and eventually records uncertain expiry", async (t) => {
  const f = fixture(t, { max_status_attempts: 1 }),
    m = message();
  let sends = 0,
    lookups = 0;
  const sender = new DurableSender(f.outbox, {
    async submit() {
      sends++;
      throw Error("must not send");
    },
    async status() {
      lookups++;
      throw new RelayError("not_found");
    },
  });
  sender.enqueue(m);
  f.raw.exec("UPDATE relay_outbox SET expires_at=0");
  await sender.sendOnce();
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
  due(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "expired_unknown");
  assert.equal(sends, 0);
  assert.equal(lookups, 1);
  assert.equal(
    f.relayRaw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    0,
  );
});
test("status not found is retried finitely rather than interpreted as definitive non-delivery", async (t) => {
  const f = fixture(t, { max_submit_attempts: 1, max_status_attempts: 2 }),
    m = message();
  let lookups = 0;
  const sender = new DurableSender(f.outbox, {
    async submit() {
      throw Error("unknown");
    },
    async status() {
      lookups++;
      throw new RelayError("not_found");
    },
  });
  sender.enqueue(m);
  await assert.rejects(sender.sendOnce(), /sender_transport_failed/);
  due(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "queued");
  due(f);
  await sender.sendOnce();
  due(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "quarantined");
  assert.equal(lookups, 2);
  assert.equal(sender.get(m.message_id).reason, "status_retry_exhausted");
});
test("server expiry rejection forces status-only without extending the message deadline", async (t) => {
  const f = fixture(t),
    m = message();
  let sends = 0,
    lookups = 0;
  const sender = new DurableSender(f.outbox, {
    async submit() {
      sends++;
      throw new RelayError("expired_before_acceptance");
    },
    async status() {
      lookups++;
      throw new RelayError("not_found");
    },
  });
  sender.enqueue(m);
  await sender.sendOnce();
  due(f);
  await sender.sendOnce();
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
  assert.equal(sender.get(m.message_id).expires_at, m.expires_at);
});
test("permanent refusal quarantines without changing identity, credentials or recipient", async (t) => {
  const f = fixture(t),
    m = message();
  let calls = 0;
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    async submit() {
      calls++;
      throw new RelayError("forbidden");
    },
  });
  sender.enqueue(m);
  await sender.sendOnce();
  await sender.sendOnce();
  assert.equal(calls, 1);
  assert.equal(sender.get(m.message_id).state, "quarantined");
  assert.equal(sender.get(m.message_id).reason, "forbidden");
  assert.equal(sender.get(m.message_id).recipient_id, "b");
  f.raw.exec("UPDATE relay_outbox SET expires_at=0");
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "expired_unknown");
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
});
test("wrong receipt cannot clear body; successful local confirmation is transactional and recoverable", async (t) => {
  const f = fixture(t),
    m = message();
  let corrupt = true;
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    async submit(input) {
      const receipt = await f.transport.submit(input);
      return corrupt ? { ...receipt, sender_id: "foreign" } : receipt;
    },
  });
  sender.enqueue(m);
  await assert.rejects(sender.sendOnce(), /invalid_acceptance_receipt/);
  assert.ok(f.raw.prepare("SELECT body FROM relay_outbox").get().body);
  expireLease(f);
  corrupt = false;
  f.raw.exec(
    "CREATE TRIGGER fail_confirm BEFORE UPDATE ON relay_outbox WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'confirm failed'); END",
  );
  await assert.rejects(sender.sendOnce(), /confirm failed/);
  assert.equal(sender.get(m.message_id).state, "sending");
  assert.ok(f.raw.prepare("SELECT body FROM relay_outbox").get().body);
  f.raw.exec("DROP TRIGGER fail_confirm");
  expireLease(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "accepted");
  assert.equal(
    f.relayRaw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
});
test("enqueue failure makes no transport call; record and byte capacity refuse without dropping accepted intents", async (t) => {
  const f = fixture(t, { max_records: 1 }),
    m = message();
  let sends = 0;
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    async submit(input) {
      sends++;
      return f.transport.submit(input);
    },
  });
  f.raw.exec(
    "CREATE TRIGGER fail_enqueue BEFORE INSERT ON relay_outbox BEGIN SELECT RAISE(ABORT,'enqueue failed'); END",
  );
  assert.throws(() => sender.enqueue(m), /enqueue failed/);
  await sender.sendOnce();
  assert.equal(sends, 0);
  f.raw.exec("DROP TRIGGER fail_enqueue");
  sender.enqueue(m);
  code(() => sender.enqueue(message("m-2")), "outbox_capacity_exceeded");
  assert.equal(sender.get(m.message_id).state, "queued");
  const tiny = new SQLiteOutbox(":memory:", { ...options, max_body_bytes: 1 });
  t.after(() => tiny.close());
  tiny.migrate();
  code(() => tiny.enqueue(m), "outbox_capacity_exceeded");
});
test("private file, immutable owner/key and explicit schema boundaries are enforced", (t) => {
  const f = fixture(t);
  const other = new SQLiteOutbox(f.path, { ...options, agent_id: "c" });
  t.after(() => other.close());
  code(() => other.migrate(), "outbox_identity_mismatch");
  const wrong = new SQLiteOutbox(f.path, {
    ...options,
    fingerprint_key: new Uint8Array(32).fill(7),
  });
  t.after(() => wrong.close());
  code(() => wrong.migrate(), "outbox_identity_mismatch");
  const blank = new SQLiteOutbox(":memory:", options);
  t.after(() => blank.close());
  code(() => blank.claim(), "schema_not_ready");
  const loose = join(f.dir, "loose.sqlite");
  writeFileSync(loose, "");
  chmodSync(loose, 0o644);
  code(() => new SQLiteOutbox(loose, options), "insecure_outbox_file");
  const link = join(f.dir, "link.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new SQLiteOutbox(link, options));
});
test("transport cannot mutate the durable original; local overlapping send is refused", async (t) => {
  const f = fixture(t),
    m = message();
  let release;
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    submit(input) {
      input.recipient_id = "c";
      return new Promise((resolve) => {
        release = () => resolve(f.service.submit("a", m));
      });
    },
  });
  sender.enqueue(m);
  const sending = sender.sendOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(sender.sendOnce(), /sender_busy/);
  assert.equal(
    JSON.parse(f.raw.prepare("SELECT body FROM relay_outbox").get().body)
      .recipient_id,
    "b",
  );
  release();
  await sending;
  assert.equal(sender.get(m.message_id).receipt.recipient_id, "b");
});
test("concurrent SQLite connections claim only one sender job", async (t) => {
  const f = fixture(t);
  f.outbox.enqueue(message());
  f.outbox.enqueue(message("m-2"));
  const source = `const{parentPort,workerData}=await import('node:worker_threads');const{SQLiteOutbox}=await import(workerData.url);const s=new SQLiteOutbox(workerData.path,workerData.options);s.migrate();parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(s.claim());}finally{s.close();}});`;
  const workers = [1, 2].map(
    () =>
      new Worker(source, {
        eval: true,
        workerData: {
          path: f.path,
          options,
          url: new URL("../src/relay/sqlite-outbox.ts", import.meta.url).href,
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
  workers.forEach((w) => w.postMessage("claim"));
  assert.equal((await Promise.all(results)).filter(Boolean).length, 1);
});
test("model-free durable sender to relay to durable receiver survives both response losses", async (t) => {
  const f = fixture(t, { max_submit_attempts: 1 }),
    m = message();
  const sender = new DurableSender(f.outbox, {
    ...f.transport,
    async submit(input) {
      await f.transport.submit(input);
      throw Error("acceptance response lost");
    },
  });
  sender.enqueue(m);
  await assert.rejects(sender.sendOnce(), /sender_transport_failed/);
  const inbox = new SQLiteInbox(join(f.dir, "receiver.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(43),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_ack_records: 30,
    ack_retry_ms: 86400000,
    retry_base_ms: 1000,
    retry_cap_ms: 60000,
    max_attempts: 5,
  });
  t.after(() => inbox.close());
  inbox.migrate();
  const rxRaw = new DatabaseSync(join(f.dir, "receiver.sqlite"));
  t.after(() => rxRaw.close());
  let lose = true;
  const receiver = new DurableReceiver(inbox, {
    async poll() {
      return f.service.poll("b");
    },
    async ack(req) {
      const r = f.service.ack("b", req);
      if (lose) {
        lose = false;
        throw Error("ACK response lost");
      }
      return r;
    },
  });
  await assert.rejects(receiver.receiveOnce(), /ack_transport_failed/);
  rxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  await receiver.receiveOnce();
  due(f);
  await sender.sendOnce();
  assert.equal(sender.get(m.message_id).state, "accepted");
  assert.equal(sender.get(m.message_id).receipt.state, "acked");
  assert.equal(receiver.inbox().length, 1);
  assert.deepEqual(receiver.inbox()[0].message, m);
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
  assert.equal(
    f.relayRaw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
});

test("acceptance receipt identity, deadline, state and UTC time are checked before payload deletion", (t) => {
  const f = fixture(t),
    m = message();
  f.outbox.enqueue(m);
  const job = f.outbox.claim(),
    receipt = f.service.submit("a", m);
  for (const patch of [
    { recipient_id: "c" },
    { message_id: "foreign" },
    { expires_at: "2030-01-01T00:00:00.000Z" },
    { state: "executed" },
    { accepted_at: m.expires_at },
    { accepted_at: "not-a-time" },
    { receipt_id: "bad id" },
  ])
    code(
      () => f.outbox.confirm(job, { ...receipt, ...patch }),
      "invalid_acceptance_receipt",
    );
  assert.ok(f.raw.prepare("SELECT body FROM relay_outbox").get().body);
  f.outbox.confirm(job, { ...receipt, untrusted_body: "must not persist" });
  assert.ok(
    !f.raw
      .prepare("SELECT receipt FROM relay_outbox")
      .get()
      .receipt.includes("must not persist"),
  );
});
test("expired/future enqueue and unavailable attachments fail closed; expired status horizon cannot send", async (t) => {
  const f = fixture(t),
    m = message();
  let calls = 0;
  const sender = new DurableSender(f.outbox, {
    async submit() {
      calls++;
      throw Error("unexpected");
    },
    async status() {
      calls++;
      throw Error("unexpected");
    },
  });
  const old = message("old");
  old.first_sent_at = new Date(Date.now() - 7200000).toISOString();
  old.expires_at = new Date(
    Date.parse(old.first_sent_at) + 3600000,
  ).toISOString();
  code(() => sender.enqueue(old), "expired_before_enqueue");
  const future = message("future");
  future.first_sent_at = new Date(Date.now() + 60000).toISOString();
  future.expires_at = new Date(
    Date.parse(future.first_sent_at) + 3600000,
  ).toISOString();
  code(() => sender.enqueue(future), "clock_skew");
  const file = message("file");
  file.body.parts.push({
    type: "attachment",
    attachment_id: "file-1",
    media_type: "image/png",
    size_bytes: 10,
    sha256: "a".repeat(64),
  });
  code(() => sender.enqueue(file), "attachment_store_unavailable");
  sender.enqueue(m);
  f.raw.exec("UPDATE relay_outbox SET expires_at=0,status_until=0");
  await sender.sendOnce();
  assert.equal(calls, 0);
  assert.equal(sender.get(m.message_id).state, "expired_unknown");
  assert.equal(f.raw.prepare("SELECT body FROM relay_outbox").get().body, null);
});
