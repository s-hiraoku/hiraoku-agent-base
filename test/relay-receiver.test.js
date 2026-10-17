import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RelayService, DurableReceiver } from "../src/relay/index.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
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
const serverOptions = {
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
const inboxOptions = {
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
    body: { parts: [{ type: "text", text: "dummy message" }] },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: new Date(at).toISOString(),
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-receiver-")),
    serverPath = join(dir, "server.sqlite"),
    path = join(dir, "inbox.sqlite"),
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
  const server = new SQLiteRelayStore(serverPath, serverOptions);
  stores.push(server);
  server.migrate();
  const service = new RelayService(server, limits, policy);
  const open = () => {
    const s = new SQLiteInbox(path, { ...inboxOptions, ...patch });
    stores.push(s);
    return s;
  };
  const inbox = open();
  inbox.migrate();
  const raw = new DatabaseSync(path),
    serverRaw = new DatabaseSync(serverPath);
  t.after(() => {
    raw.close();
    serverRaw.close();
  });
  const transport = {
    async poll() {
      return service.poll("b");
    },
    async ack(req) {
      return service.ack("b", req);
    },
  };
  return { dir, path, server, service, inbox, open, raw, serverRaw, transport };
}
function code(fn, expected) {
  assert.throws(fn, (e) => e.code === expected);
}
function due(f) {
  f.raw.exec(
    "UPDATE relay_receiver_acks SET next_retry_at=0 WHERE state='pending'",
  );
}
function redeliver(f) {
  f.serverRaw.exec(
    "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0 WHERE state='leased'",
  );
}

test("normal receive commits durable inbox and stable ACK before contacting server, then retains local body only", async (t) => {
  const f = fixture(t),
    m = message();
  f.service.submit("a", m);
  let calls = 0;
  const receiver = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack(req) {
      calls++;
      assert.equal(f.inbox.inbox().length, 1);
      assert.equal(
        f.raw.prepare("SELECT request_id FROM relay_receiver_acks").get()
          .request_id,
        req.request_id,
      );
      assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
      return f.transport.ack(req);
    },
  });
  await receiver.receiveOnce();
  assert.equal(calls, 1);
  assert.deepEqual(receiver.inbox()[0].message, m);
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
  assert.equal(
    f.serverRaw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
  assert.equal(
    f.raw.prepare("SELECT request FROM relay_receiver_acks").get().request,
    null,
  );
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});
test("ACK response loss is recovered after client restart using exactly the durable request without duplicate inbox", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const requests = [];
  const failing = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack(req) {
      requests.push(req);
      await f.transport.ack(req);
      throw Error("sensitive transport detail");
    },
  });
  await assert.rejects(
    failing.receiveOnce(),
    (e) =>
      e.code === "ack_transport_failed" && !e.message.includes("sensitive"),
  );
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
  assert.equal(f.service.status("a", "m-1").state, "acked");
  f.inbox.close();
  const reopened = f.open();
  reopened.migrate();
  due(f);
  const recovered = new DurableReceiver(reopened, {
    ...f.transport,
    async ack(req) {
      requests.push(req);
      return f.transport.ack(req);
    },
  });
  await recovered.receiveOnce();
  assert.equal(recovered.inbox().length, 1);
  assert.equal(recovered.inbox()[0].receipt_confirmed, true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(
    f.raw.prepare("SELECT attempts FROM relay_receiver_acks").get().attempts,
    2,
  );
});
test("inbox/journal transaction failure sends no ACK; redelivery after restart is safe", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  let acks = 0;
  const receiver = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack(req) {
      acks++;
      return f.transport.ack(req);
    },
  });
  f.raw.exec(
    "CREATE TRIGGER fail_save BEFORE INSERT ON relay_receiver_acks BEGIN SELECT RAISE(ABORT,'save failure'); END",
  );
  await assert.rejects(receiver.receiveOnce(), /save failure/);
  assert.equal(acks, 0);
  assert.equal(f.inbox.inbox().length, 0);
  assert.equal(f.service.status("a", "m-1").state, "leased");
  f.raw.exec("DROP TRIGGER fail_save");
  redeliver(f);
  await receiver.receiveOnce();
  assert.equal(acks, 1);
  assert.equal(receiver.inbox().length, 1);
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
});
test("lost ACK before server commit plus stale lease yields new ACK generation without new inbox entry", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const offline = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack() {
      throw Error("offline");
    },
  });
  await assert.rejects(offline.receiveOnce(), /ack_transport_failed/);
  redeliver(f);
  due(f);
  const receiver = new DurableReceiver(f.inbox, f.transport);
  await receiver.receiveOnce();
  assert.equal(receiver.inbox().length, 1);
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
  assert.deepEqual(
    f.raw
      .prepare(
        "SELECT generation,state FROM relay_receiver_acks ORDER BY generation",
      )
      .all()
      .map((x) => ({ ...x })),
    [
      { generation: 1, state: "obsolete" },
      { generation: 2, state: "confirmed" },
    ],
  );
});
test("wrong receipt is not confirmed locally and later exact request retry recovers", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const receiver = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack(req) {
      const r = await f.transport.ack(req);
      return { ...r, recipient_id: "c" };
    },
  });
  await assert.rejects(receiver.receiveOnce(), /invalid_ack_receipt/);
  assert.equal(receiver.inbox()[0].receipt_confirmed, false);
  due(f);
  await new DurableReceiver(f.inbox, f.transport).receiveOnce();
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
});
test("same ID content/lease conflicts never replace durable content; foreign or incomplete attachment delivery is refused", (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const d = f.service.poll("b");
  f.inbox.save(d);
  f.inbox.save(d);
  assert.equal(f.inbox.inbox().length, 1);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
    1,
  );
  const changed = structuredClone(d);
  changed.message.body.parts[0].text = "altered";
  code(() => f.inbox.save(changed), "inbox_content_conflict");
  code(
    () => f.inbox.save({ ...d, lease_token: "x".repeat(43) }),
    "inbox_lease_conflict",
  );
  const foreign = structuredClone(d);
  foreign.message.recipient_id = "c";
  code(() => f.inbox.save(foreign), "foreign_delivery");
  const attachment = structuredClone(d);
  attachment.message.body.parts.push({
    type: "attachment",
    attachment_id: "file-1",
    media_type: "image/png",
    size_bytes: 10,
    sha256: "a".repeat(64),
  });
  code(() => f.inbox.save(attachment), "attachment_store_unavailable");
});
test("capacity and retry limits are explicit and finite; exhausted token is removed without dropping inbox", async (t) => {
  const f = fixture(t, { max_attempts: 1, max_records: 1 });
  f.service.submit("a", message());
  const receiver = new DurableReceiver(f.inbox, {
    ...f.transport,
    async ack() {
      throw Error("offline");
    },
  });
  await assert.rejects(receiver.receiveOnce(), /ack_transport_failed/);
  assert.equal(f.inbox.claimAck(), null);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_receiver_acks").get().state,
    "quarantined",
  );
  assert.equal(
    f.raw.prepare("SELECT request FROM relay_receiver_acks").get().request,
    null,
  );
  assert.equal(f.inbox.inbox().length, 1);
  const other = message("m-2");
  f.service.submit("a", other);
  f.serverRaw.exec(
    "UPDATE relay_messages SET expires_at=0 WHERE message_id='m-1'",
  );
  const newer = f.service.poll("b");
  assert.equal(newer.message.message_id, "m-2");
  code(() => f.inbox.save(newer), "inbox_capacity_exceeded");
  assert.equal(f.inbox.inbox().length, 1);
});
test("identity/key binding is checked on reopening and constructor never auto-migrates", (t) => {
  const f = fixture(t);
  const other = new SQLiteInbox(f.path, { ...inboxOptions, agent_id: "c" });
  t.after(() => other.close());
  code(() => other.migrate(), "inbox_identity_mismatch");
  const wrong = new SQLiteInbox(f.path, {
    ...inboxOptions,
    fingerprint_key: new Uint8Array(32).fill(7),
  });
  t.after(() => wrong.close());
  code(() => wrong.migrate(), "inbox_identity_mismatch");
  const fresh = new SQLiteInbox(":memory:", inboxOptions);
  t.after(() => fresh.close());
  code(() => fresh.inbox(), "schema_not_ready");
});
test("loose files and symlinks are refused without rewriting target permissions", (t) => {
  const f = fixture(t),
    loose = join(f.dir, "loose.sqlite");
  writeFileSync(loose, "");
  chmodSync(loose, 0o644);
  code(() => new SQLiteInbox(loose, inboxOptions), "insecure_inbox_file");
  assert.equal(statSync(loose).mode & 0o777, 0o644);
  const link = join(f.dir, "link.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new SQLiteInbox(link, inboxOptions));
});
test("local overlapping receive is refused and poll errors expose no raw details", async (t) => {
  const f = fixture(t);
  let finish;
  const receiver = new DurableReceiver(f.inbox, {
    ...f.transport,
    poll() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const running = receiver.receiveOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(receiver.receiveOnce(), /receiver_busy/);
  finish(null);
  await running;
  await assert.rejects(
    new DurableReceiver(f.inbox, {
      ...f.transport,
      async poll() {
        throw Error("secret detail");
      },
    }).receiveOnce(),
    (e) => e.code === "poll_transport_failed" && !e.message.includes("secret"),
  );
});
test("three model-free opaque individuals exchange messages independently", async (t) => {
  const f = fixture(t),
    receivers = {};
  for (const id of ["a", "b", "c"]) {
    const store = new SQLiteInbox(join(f.dir, `${id}.sqlite`), {
      ...inboxOptions,
      agent_id: id,
    });
    t.after(() => store.close());
    store.migrate();
    receivers[id] = new DurableReceiver(store, {
      async poll() {
        return f.service.poll(id);
      },
      async ack(req) {
        return f.service.ack(id, req);
      },
    });
  }
  for (const [from, to] of [
    ["a", "b"],
    ["b", "a"],
    ["a", "c"],
    ["c", "a"],
    ["b", "c"],
    ["c", "b"],
  ]) {
    const m = message(`${from}-${to}`);
    m.recipient_id = to;
    m.thread_id = [from, to].sort().join("-");
    f.service.submit(from, m);
    await receivers[to].receiveOnce();
  }
  for (const id of ["a", "b", "c"]) {
    assert.equal(receivers[id].inbox().length, 2);
    assert.ok(receivers[id].inbox().every((x) => x.receipt_confirmed));
  }
  assert.equal(
    f.serverRaw
      .prepare(
        "SELECT count(*) n FROM relay_messages WHERE state='acked' AND body IS NULL",
      )
      .get().n,
    6,
  );
});

test("restart after inbox save but before ACK sends the saved request first", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  const delivery = f.service.poll("b");
  f.inbox.save(delivery);
  const saved = JSON.parse(
    f.raw.prepare("SELECT request FROM relay_receiver_acks").get().request,
  );
  f.inbox.close();
  const reopened = f.open();
  reopened.migrate();
  let observed;
  await new DurableReceiver(reopened, {
    ...f.transport,
    async ack(req) {
      observed = req;
      return f.transport.ack(req);
    },
  }).receiveOnce();
  assert.deepEqual(observed, saved);
  assert.equal(reopened.inbox().length, 1);
  assert.equal(reopened.inbox()[0].receipt_confirmed, true);
});

test("local receipt confirmation failure rolls back journal cleanup and can recover server ACK", async (t) => {
  const f = fixture(t);
  f.service.submit("a", message());
  f.raw.exec(
    "CREATE TRIGGER fail_confirm BEFORE UPDATE ON relay_inbox WHEN NEW.receipt_confirmed=1 BEGIN SELECT RAISE(ABORT,'confirmation failure'); END",
  );
  const receiver = new DurableReceiver(f.inbox, f.transport);
  await assert.rejects(receiver.receiveOnce(), /confirmation failure/);
  assert.equal(f.service.status("a", "m-1").state, "acked");
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_receiver_acks").get().state,
    "pending",
  );
  assert.ok(
    f.raw.prepare("SELECT request FROM relay_receiver_acks").get().request,
  );
  f.raw.exec("DROP TRIGGER fail_confirm");
  due(f);
  await receiver.receiveOnce();
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
});
