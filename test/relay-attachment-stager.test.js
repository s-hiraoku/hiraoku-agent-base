import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AttachmentStager } from "../src/relay/attachment-stager.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { SQLiteAttachmentInbox } from "../src/relay/sqlite-attachment-inbox.ts";
import { RelayError } from "../src/relay/service.ts";
import { HabAttachmentRead } from "../src/hab/attachment-read.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import {
  fixture as localFixture,
  message,
  packet,
  inboxOptions,
} from "./relay-attachment-inbox-fixtures.js";
import { fixture as habFixture } from "./hab-attachment-fixtures.js";
import { payload, code } from "./relay-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
const bodyOptions = {
  agent_id: "b",
  fingerprint_key: new Uint8Array(32).fill(97),
  limits,
  max_records: 10,
  max_body_bytes: 100000,
  max_ack_records: 30,
  ack_retry_ms: 86400000,
  retry_base_ms: 1,
  retry_cap_ms: 10,
  max_attempts: 5,
};
const delivery = (m, sender = "a") => ({
  message: { ...m, sender_id: sender },
  generation: 1,
  lease_token: "a".repeat(43),
  lease_until: new Date(
    Math.min(Date.now() + 30000, Date.parse(m.expires_at)),
  ).toISOString(),
});
function fixture(t) {
  const f = localFixture(t),
    path = join(f.dir, "body.sqlite"),
    stores = new Set();
  const open = (gate = f.store) => {
    const s = new SQLiteInbox(
      path,
      bodyOptions,
      gate === null ? undefined : gate,
    );
    stores.add(s);
    s.migrate();
    return s;
  };
  const client = open(),
    bodyRaw = new DatabaseSync(path);
  t.after(() => {
    bodyRaw.close();
    for (const s of stores) s.close();
  });
  return {
    ...f,
    client,
    bodyRaw,
    openClient: open,
    closeClient(s) {
      s.close();
      stores.delete(s);
    },
    stager: (m, port, store = f.store) =>
      new AttachmentStager(
        store,
        port ?? {
          async read(req) {
            return packet(m, req.offset);
          },
        },
        limits,
      ),
    acks: () =>
      Number(
        bodyRaw.prepare("SELECT count(*) n FROM relay_receiver_acks").get().n,
      ),
  };
}
test("attachment staging: each invocation saves one bounded chunk and ACK is queued only after all bytes verify", async (t) => {
  const f = fixture(t),
    m = message(),
    d = delivery(m),
    seen = [];
  const stager = f.stager(m, {
    async read(req) {
      seen.push(req.offset);
      assert.equal(
        f.store.status("a", m.message_id).files[0].next_offset,
        req.offset,
      );
      assert.equal(f.acks(), 0);
      return packet(m, req.offset);
    },
  });
  for (let i = 0; i < 2; i++) {
    assert.equal((await stager.stageOnce("a", m)).state, "receiving");
    assert.throws(() => f.client.save(d), code("attachment_inbox_unverified"));
  }
  assert.equal((await stager.stageOnce("a", m)).state, "verified");
  assert.deepEqual(seen, [0, 4, 8]);
  f.client.save(d);
  assert.equal(f.acks(), 1);
  assert.equal(f.client.claimAck().message_id, m.message_id);
});
test("attachment staging: a lost read response retries the original offset after re-creation", async (t) => {
  const f = fixture(t),
    m = message(),
    offsets = [];
  await assert.rejects(
    f
      .stager(m, {
        async read(req) {
          offsets.push(req.offset);
          throw Error("synthetic-private-response-loss");
        },
      })
      .stageOnce("a", m),
    code("attachment_read_transport_failed"),
  );
  assert.equal(f.store.status("a", m.message_id).files[0].next_offset, 0);
  await f
    .stager(m, {
      async read(req) {
        offsets.push(req.offset);
        return packet(m, req.offset);
      },
    })
    .stageOnce("a", m);
  assert.deepEqual(offsets, [0, 0]);
  assert.equal(f.acks(), 0);
});
test("attachment staging: lost local commit response resumes at the committed offset after reopen", async (t) => {
  const f = fixture(t),
    m = message(),
    port = {
      prepare: f.store.prepare.bind(f.store),
      put(...args) {
        f.store.put(...args);
        throw new RelayError("attachment_inbox_unavailable");
      },
      verify: f.store.verify.bind(f.store),
    };
  await assert.rejects(
    f.stager(m, undefined, port).stageOnce("a", m),
    code("attachment_inbox_unavailable"),
  );
  f.close(f.store);
  const s = f.open();
  s.migrate();
  const offsets = [];
  await f
    .stager(
      m,
      {
        async read(req) {
          offsets.push(req.offset);
          return packet(m, req.offset);
        },
      },
      s,
    )
    .stageOnce("a", m);
  assert.deepEqual(offsets, [4]);
  assert.equal(s.status("a", m.message_id).files[0].next_offset, 8);
});
test("attachment staging: multipart incompleteness and rejected whole digest cannot create ACK", async (t) => {
  const f = fixture(t),
    m = message(payload, [payload]);
  f.store.prepare("a", m);
  for (const n of [0, 4, 8]) f.store.put("a", m.message_id, packet(m, n));
  assert.throws(
    () => f.client.save(delivery(m)),
    code("attachment_inbox_unverified"),
  );
  assert.equal(f.acks(), 0);
  const bad = message();
  bad.body.parts[1].sha256 = "0".repeat(64);
  const s = f.stager(bad);
  await s.stageOnce("a", bad);
  await s.stageOnce("a", bad);
  await assert.rejects(
    s.stageOnce("a", bad),
    code("attachment_staging_rejected"),
  );
  assert.throws(
    () => f.client.save(delivery(bad)),
    code("attachment_inbox_unverified"),
  );
  assert.equal(f.acks(), 0);
});
test("attachment ACK gate: corruption after save is rechecked before claiming the saved request", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.client.save(delivery(m));
  f.raw.exec(
    "UPDATE attachment_inbox_chunks SET data=zeroblob(4) WHERE offset=0",
  );
  assert.throws(() => f.client.claimAck(), code("attachment_inbox_integrity"));
  assert.equal(
    f.bodyRaw.prepare("SELECT attempts FROM relay_receiver_acks").get()
      .attempts,
    0,
  );
  f.raw
    .prepare("UPDATE attachment_inbox_chunks SET data=? WHERE offset=0")
    .run(payload.subarray(0, 4));
  assert.equal(f.client.claimAck().message_id, m.message_id);
  assert.equal(f.acks(), 1);
});
test("attachment ACK gate: body handoff and both DB reopens retain the exact ACK without another body copy", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.client.save(delivery(m));
  const first = f.client.claimAck();
  f.client.releaseBody("a", m.message_id);
  f.closeClient(f.client);
  f.close(f.store);
  const blob = f.open();
  blob.migrate();
  const client = f.openClient(blob);
  f.bodyRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  assert.deepEqual(client.claimAck(), first);
  assert.equal(client.inbox().length, 0);
  const row = f.bodyRaw
    .prepare("SELECT body,has_attachments FROM relay_inbox")
    .get();
  assert.equal(row.body, "");
  assert.equal(row.has_attachments, 1);
  client.confirmAck(first, {
    ...first,
    recipient_id: "b",
    receipt_id: "synthetic-ack-receipt",
    acked_at: new Date().toISOString(),
    state: "acked",
  });
  assert.equal(
    f.bodyRaw.prepare("SELECT receipt_confirmed FROM relay_inbox").get()
      .receipt_confirmed,
    1,
  );
});
test("attachment ACK gate: absent gate refuses new save and reopened attached ACK even after body handoff", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  const plain = f.openClient(null);
  assert.throws(
    () => plain.save(delivery(m)),
    code("attachment_store_unavailable"),
  );
  f.client.save(delivery(m));
  f.client.releaseBody("a", m.message_id);
  assert.throws(() => plain.claimAck(), code("attachment_store_unavailable"));
  assert.equal(
    f.bodyRaw.prepare("SELECT attempts FROM relay_receiver_acks").get()
      .attempts,
    0,
  );
});
test("attachment ACK gate: early attachment release blocks ACK rather than treating metadata as durable bytes", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.client.save(delivery(m));
  f.store.release("a", m.message_id);
  assert.throws(() => f.client.claimAck(), code("attachment_inbox_unverified"));
  assert.equal(f.acks(), 1);
});
test("attachment staging: overlapping invocations are refused and one caller causes at most one read", async (t) => {
  const f = fixture(t),
    m = message();
  let release,
    calls = 0;
  const s = f.stager(m, {
    read() {
      calls++;
      return new Promise((resolve) => {
        release = () => resolve(packet(m));
      });
    },
  });
  const first = s.stageOnce("a", m);
  await assert.rejects(s.stageOnce("a", m), code("attachment_stager_busy"));
  assert.equal(calls, 1);
  release();
  assert.equal((await first).files[0].next_offset, 4);
  assert.equal(calls, 1);
});
test("attachment ACK gate: schema 2 migration preserves released text ACKs and rolls back a failed upgrade", (t) => {
  const f = fixture(t),
    m = message();
  m.body.parts = m.body.parts.filter((p) => p.type === "text");
  f.client.save(delivery(m));
  const saved = f.bodyRaw
    .prepare("SELECT request FROM relay_receiver_acks")
    .get().request;
  f.client.releaseBody("a", m.message_id);
  f.closeClient(f.client);
  f.bodyRaw.exec(
    "DROP TRIGGER relay_attachment_identity; ALTER TABLE relay_inbox DROP COLUMN has_attachments; ALTER TABLE relay_inbox DROP COLUMN attachment_guard; UPDATE relay_inbox_meta SET version=2; CREATE TRIGGER fail_v3 BEFORE UPDATE ON relay_inbox_meta BEGIN SELECT RAISE(ABORT,'synthetic-migration-failure');END;",
  );
  assert.throws(() => f.openClient(null), /synthetic-migration-failure/);
  assert.equal(
    f.bodyRaw.prepare("SELECT version FROM relay_inbox_meta").get().version,
    2,
  );
  assert.equal(
    f.bodyRaw
      .prepare("PRAGMA table_info(relay_inbox)")
      .all()
      .some((r) => r.name === "has_attachments"),
    false,
  );
  f.bodyRaw.exec("DROP TRIGGER fail_v3");
  const client = f.openClient(null);
  assert.equal(
    f.bodyRaw.prepare("SELECT version FROM relay_inbox_meta").get().version,
    3,
  );
  assert.deepEqual(client.claimAck(), JSON.parse(saved));
  assert.equal(client.inbox().length, 0);
});
test("attachment staging: real mock HAB reads persist exact binary before local ACK admission", async (t) => {
  const f = habFixture(t),
    m = f.upload();
  f.api().submit(f.contexts.a, m);
  const local = new SQLiteAttachmentInbox(
    join(f.dir, "local-attachment.sqlite"),
    { ...inboxOptions, agent_id: f.b.agent_id },
  );
  local.migrate();
  const body = new SQLiteInbox(
    join(f.dir, "local-body.sqlite"),
    { ...bodyOptions, agent_id: f.b.agent_id },
    local,
  );
  body.migrate();
  t.after(() => {
    body.close();
    local.close();
  });
  const reader = new HabAttachmentRead(f.registry, f.relay, f.blob, limits),
    requests = [];
  const stager = new AttachmentStager(
    local,
    {
      async read(req) {
        requests.push(req);
        return reader.read(f.contexts.b, req);
      },
    },
    limits,
  );
  await stager.stageOnce(f.a.agent_id, m);
  await stager.stageOnce(f.a.agent_id, m);
  assert.throws(
    () => body.save(delivery(m, f.a.agent_id)),
    code("attachment_inbox_unverified"),
  );
  assert.equal((await stager.stageOnce(f.a.agent_id, m)).state, "verified");
  body.save(delivery(m, f.a.agent_id));
  assert.equal(body.claimAck().sender_id, f.a.agent_id);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    local.read(f.a.agent_id, m.message_id, m.body.parts[1].attachment_id, 0),
    payload.subarray(0, 4),
  );
  assert.equal(
    new HabRelayService(f.registry, f.relay, limits).poll(f.contexts.b),
    null,
  );
});
test("attachment staging: empty files verify without network reads and keep ACK gated until verification", async (t) => {
  const f = fixture(t),
    m = message(new Uint8Array()),
    stager = f.stager(m, {
      async read() {
        assert.fail("empty file needs no chunk request");
      },
    });
  assert.equal((await stager.stageOnce("a", m)).state, "verified");
  f.client.save(delivery(m));
  assert.ok(f.client.claimAck());
});
test("attachment ACK gate: async and retained callbacks cannot escape the synchronous readiness scope", async (t) => {
  const f = fixture(t),
    m = message();
  let captured;
  const gate = {
    withVerified(_s, _m, action) {
      captured = action;
      return Promise.resolve();
    },
    withRetained() {
      return Promise.resolve();
    },
  };
  const client = f.openClient(gate);
  assert.throws(
    () => client.save(delivery(m)),
    code("attachment_inbox_unverified"),
  );
  assert.throws(() => captured(), code("attachment_inbox_unverified"));
  assert.equal(f.acks(), 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
test("attachment ACK gate: body/journal failure preserves verified bytes and exact retry creates one ACK", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.bodyRaw.exec(
    "CREATE TRIGGER fail_attached_ack BEFORE INSERT ON relay_receiver_acks BEGIN SELECT RAISE(ABORT,'synthetic-ack-journal-failure');END;",
  );
  assert.throws(
    () => f.client.save(delivery(m)),
    code("attachment_inbox_unavailable"),
  );
  assert.equal(f.acks(), 0);
  assert.equal(f.store.status("a", m.message_id).state, "verified");
  f.bodyRaw.exec("DROP TRIGGER fail_attached_ack");
  const d = delivery(m);
  f.client.save(d);
  f.client.save(d);
  assert.equal(f.acks(), 1);
  assert.equal(f.client.claimAck().message_id, m.message_id);
});

test("attachment ACK gate: a corrupted readiness flag cannot bypass retained-byte verification", (t) => {
  const f = fixture(t),
    m = message();
  f.fill(m);
  f.client.save(delivery(m));
  f.client.releaseBody("a", m.message_id);
  f.bodyRaw.exec(
    "DROP TRIGGER relay_attachment_identity; UPDATE relay_inbox SET has_attachments=0",
  );
  assert.throws(() => f.client.claimAck(), code("invalid_inbox_record"));
  assert.equal(
    f.bodyRaw.prepare("SELECT attempts FROM relay_receiver_acks").get()
      .attempts,
    0,
  );
});

test("attachment staging: another member's response cannot replace the requested file/offset", async (t) => {
  const f = fixture(t),
    m = message(payload, [payload]);
  const stager = f.stager(m, {
    async read() {
      return packet(m, 0, payload, 1);
    },
  });
  await assert.rejects(
    stager.stageOnce("a", m),
    code("invalid_attachment_chunk"),
  );
  assert.deepEqual(
    f.store.status("a", m.message_id).files.map((f) => f.next_offset),
    [0, 0],
  );
  assert.equal(f.acks(), 0);
});
