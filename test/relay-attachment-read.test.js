import test from "node:test";
import process from "node:process";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  AttachmentReadService,
  parseAttachmentRead,
} from "../src/relay/attachment-read.ts";
import { AttachmentAcceptanceService } from "../src/relay/attachment-acceptance.ts";
import {
  AttachmentUploadService,
  makeUploadRequestId,
} from "../src/relay/attachments.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import {
  fixture as uploadFixture,
  options,
  intent,
  payload,
  code,
} from "./relay-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";

function fixture(t) {
  const f = uploadFixture(t),
    path = join(f.dir, "read-relay.sqlite"),
    stores = new Set();
  let blob = f.store,
    relay,
    sequence = 0;
  const contexts = { ...f.contexts, c: Symbol("foreign-receiver") },
    state = { active: true };
  const authorization = {
    authorize(ctx, op, peer, kind) {
      if (!state.active) return undefined;
      const name = ["a", "b", "c"].find((n) => contexts[n] === ctx);
      if (!name) return undefined;
      if (op === "poll" && (!peer || (peer === "a" && kind === "question")))
        return { agent_id: name };
      if (
        name === "a" &&
        ["submit", "status"].includes(op) &&
        (!peer || (peer === "b" && kind === "question"))
      )
        return { agent_id: name };
      return undefined;
    },
  };
  const relayOptions = {
    fingerprint_key: new Uint8Array(32).fill(95),
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
  const open = (admit = true) => {
    const s = new SQLiteRelayStore(
      path,
      relayOptions,
      admit ? { check: (a) => blob.checkPrepared(a, limits) } : undefined,
    );
    s.migrate();
    stores.add(s);
    return s;
  };
  relay = open();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
  });
  const accept = (refs = blob) =>
    new AttachmentAcceptanceService(relay, refs, limits, authorization);
  const upload = (bytes = payload, { submit = true, expiry } = {}) => {
    const v = intent(bytes),
      entropy = (++sequence).toString(16).padStart(32, "0");
    if (expiry) {
      v.first_sent_at = new Date(expiry - 3600000).toISOString();
      v.expires_at = new Date(expiry).toISOString();
    }
    v.message_id = makeReplayBoundMessageId(v.first_sent_at, entropy);
    v.request_id = makeUploadRequestId(v.first_sent_at, entropy);
    const api = new AttachmentUploadService(blob, options, f.authorization),
      r = api.begin(contexts.a, v);
    f.putAll(r.attachment_id, bytes, api, contexts.a);
    api.finalize(contexts.a, r.attachment_id);
    const m = {
      version: 1,
      message_id: v.message_id,
      recipient_id: v.recipient_id,
      kind: v.kind,
      first_sent_at: v.first_sent_at,
      expires_at: v.expires_at,
      thread_id: "synthetic-read-thread",
      in_reply_to: null,
      body: {
        parts: [
          { type: "text", text: "Synthetic caption" },
          {
            type: "attachment",
            attachment_id: r.attachment_id,
            ...v.attachment,
          },
        ],
      },
    };
    const receipt = submit ? accept().submit(contexts.a, m) : null;
    return {
      message: m,
      receipt,
      request: {
        version: 1,
        sender_id: "a",
        message_id: m.message_id,
        attachment_id: r.attachment_id,
        offset: 0,
      },
    };
  };
  const read = (r = relay, b = blob, auth = authorization) =>
    new AttachmentReadService(r, b, limits, auth);
  return {
    ...f,
    contexts,
    state,
    authorization,
    raw,
    blobRaw: f.raw,
    openRelay: open,
    upload,
    read,
    accept,
    get blob() {
      return blob;
    },
    get relay() {
      return relay;
    },
    reopen() {
      relay.close();
      stores.delete(relay);
      f.close(blob);
      blob = f.open();
      blob.migrate();
      relay = open();
    },
    authorize: () => "b",
    owner: () => "a",
  };
}
test("attachment reads: exact binary reconstruction has bounded chunks and unchanged manifest/expiry", (t) => {
  const f = fixture(t),
    u = f.upload(),
    chunks = [];
  let offset = 0;
  do {
    const r = f.read().read(f.contexts.b, { ...u.request, offset });
    assert.equal(r.sender_id, "a");
    assert.equal(r.recipient_id, "b");
    assert.equal(r.expires_at, u.message.expires_at);
    assert.equal(r.chunk_bytes, 4);
    assert.ok(r.data.length <= 4);
    assert.equal(r.offset, offset);
    assert.equal(r.filename, "synthetic.bin");
    chunks.push(r.data);
    offset = r.next_offset;
    if (r.eof) {
      assert.equal(offset, payload.length);
      break;
    }
  } while (offset < payload.length);
  const bytes = Buffer.concat(chunks);
  assert.deepEqual(bytes, Buffer.from(payload));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    u.message.body.parts[1].sha256,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "pending",
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_ack_receipts").get().n,
    0,
  );
});
test("attachment reads: repeated offsets cannot mutate stored bytes, progress or original receipt", (t) => {
  const f = fixture(t),
    u = f.upload(),
    before = f.blob.binding(u.message.message_id, f.owner);
  f.read().read(f.contexts.b, u.request).data.fill(0);
  assert.deepEqual(
    f.read().read(f.contexts.b, u.request).data,
    payload.subarray(0, 4),
  );
  assert.deepEqual(f.blob.binding(u.message.message_id, f.owner), before);
  assert.equal(f.count("attachment_chunks"), 3);
  assert.deepEqual(
    f.accept().status(f.contexts.a, u.message.message_id),
    u.receipt,
  );
});
test("attachment reads: close/reopen resumes from the saved next offset", (t) => {
  const f = fixture(t),
    u = f.upload(),
    r = f.read().read(f.contexts.b, u.request);
  f.reopen();
  const next = f
    .read()
    .read(f.contexts.b, { ...u.request, offset: r.next_offset });
  assert.deepEqual(next.data, payload.subarray(4, 8));
  assert.equal(next.expires_at, r.expires_at);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    1,
  );
});
test("attachment reads: empty files and explicit EOF return a zero-byte terminal chunk", (t) => {
  const f = fixture(t),
    empty = f.upload(new Uint8Array()),
    r = f.read().read(f.contexts.b, empty.request);
  assert.equal(r.eof, true);
  assert.equal(r.next_offset, 0);
  assert.equal(r.data.length, 0);
  const binary = f.upload(),
    end = f
      .read()
      .read(f.contexts.b, { ...binary.request, offset: payload.length });
  assert.equal(end.eof, true);
  assert.equal(end.offset, payload.length);
  assert.equal(end.data.length, 0);
});
test("attachment reads: uploader and another active individual cannot fetch recipient bytes", (t) => {
  const f = fixture(t),
    u = f.upload();
  for (const ctx of [f.contexts.a, f.contexts.c])
    assert.throws(
      () => f.read().read(ctx, u.request),
      code("attachment_read_not_found"),
    );
});
test("attachment reads: unknown message, unknown ID and another message's file share refusal", (t) => {
  const f = fixture(t),
    u = f.upload(),
    v = f.upload();
  for (const patch of [
    { sender_id: "unknown" },
    { message_id: "unknown" },
    { attachment_id: "unknown" },
    { attachment_id: v.request.attachment_id },
  ])
    assert.throws(
      () => f.read().read(f.contexts.b, { ...u.request, ...patch }),
      code("attachment_read_not_found"),
    );
});
test("attachment reads: absent, throwing and async policies deny and consume rejected promises", async (t) => {
  const f = fixture(t),
    u = f.upload(),
    unhandled = [],
    listener = (e) => unhandled.push(e);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  for (const auth of [
    undefined,
    {
      authorize() {
        throw Error("synthetic-private-policy");
      },
    },
    {
      authorize() {
        return Promise.reject(Error("synthetic-private-async"));
      },
    },
  ])
    assert.throws(
      () =>
        new AttachmentReadService(f.relay, f.blob, limits, auth).read(
          f.contexts.b,
          u.request,
        ),
      code("forbidden"),
    );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});
test("attachment reads: strict schema refuses receiver, URLs, lengths, proofs, getters and invalid offsets", (t) => {
  const f = fixture(t),
    u = f.upload();
  let gets = 0;
  const getter = { ...u.request };
  Object.defineProperty(getter, "offset", {
    enumerable: true,
    get() {
      gets++;
      return 0;
    },
  });
  for (const value of [
    { ...u.request, recipient_id: "b" },
    { ...u.request, url: "https://invalid.example" },
    { ...u.request, length: 10 },
    { ...u.request, grant: {} },
    { ...u.request, version: 2 },
    { ...u.request, offset: -1 },
    { ...u.request, offset: 0.5 },
    { ...u.request, offset: Number.MAX_SAFE_INTEGER + 1 },
    getter,
    Object.assign(Object.create({}), u.request),
  ])
    assert.throws(
      () => parseAttachmentRead(value),
      code("invalid_attachment_read"),
    );
  assert.equal(gets, 0);
  for (const offset of [1, 11, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => f.read().read(f.contexts.b, { ...u.request, offset }),
      code("invalid_attachment_read"),
    );
});
test("attachment reads: prepared orphan and accepted-but-unconfirmed file cannot be read", (t) => {
  const f = fixture(t),
    u = f.upload(payload, { submit: false });
  f.blob.prepare(u.message, limits, f.owner);
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
  const refs = {
    prepare: f.blob.prepare.bind(f.blob),
    confirm() {
      throw Error("synthetic-confirm-failure");
    },
  };
  assert.throws(
    () => f.accept(refs).submit(f.contexts.a, u.message),
    code("attachment_acceptance_failed"),
  );
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
  f.accept().submit(f.contexts.a, u.message);
  assert.deepEqual(
    f.read().read(f.contexts.b, u.request).data,
    payload.subarray(0, 4),
  );
});
test("attachment reads: default store refuses download even from previously accepted attachment rows", (t) => {
  const f = fixture(t),
    u = f.upload(),
    plain = f.openRelay(false);
  assert.throws(
    () => f.read(plain).read(f.contexts.b, u.request),
    code("attachment_store_unavailable"),
  );
});
test("attachment reads: ACKed, expired, quarantined or erased message rows deny bytes", (t) => {
  const f = fixture(t),
    u = f.upload();
  for (const state of ["acked", "expired", "quarantined"]) {
    f.raw.prepare("UPDATE relay_messages SET state=?").run(state);
    assert.throws(
      () => f.read().read(f.contexts.b, u.request),
      code("attachment_read_not_found"),
    );
  }
  f.raw.exec("UPDATE relay_messages SET state='pending',body=NULL");
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
});
test("attachment reads: message and bound-byte deadlines each independently stop reads", (t) => {
  const f = fixture(t),
    u = f.upload();
  f.raw.exec("UPDATE relay_messages SET expires_at=0");
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
  f.raw
    .prepare("UPDATE relay_messages SET expires_at=?")
    .run(Date.parse(u.message.expires_at));
  f.blobRaw.exec(
    "DROP TRIGGER attachment_binding_immutable; UPDATE attachment_bindings SET expires_at=0",
  );
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_binding_unavailable"),
  );
});
test("attachment reads: corrupted or missing chunks give a fixed error without deleting finalized files", (t) => {
  const f = fixture(t),
    u = f.upload();
  f.blobRaw
    .prepare(
      "UPDATE attachment_chunks SET data=? WHERE attachment_id=? AND offset=0",
    )
    .run(new Uint8Array(4), u.request.attachment_id);
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_integrity_failed"),
  );
  f.blobRaw
    .prepare("DELETE FROM attachment_chunks WHERE attachment_id=? AND offset=0")
    .run(u.request.attachment_id);
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_integrity_failed"),
  );
  assert.equal(
    f.blobRaw.prepare("SELECT state FROM attachment_uploads").get().state,
    "finalized",
  );
});
test("attachment reads: stored body corruption fails the original Relay fingerprint", (t) => {
  const f = fixture(t),
    u = f.upload(),
    changed = structuredClone(u.message);
  changed.body.parts[0].text = "Synthetic changed caption";
  f.raw
    .prepare("UPDATE relay_messages SET body=?")
    .run(JSON.stringify(changed));
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_integrity_failed"),
  );
});
test("attachment reads: captured grants expire outside their live Relay transaction", (t) => {
  const f = fixture(t),
    u = f.upload();
  let captured;
  f.relay.withAttachmentRead(u.request, limits, f.authorize, (grant) => {
    captured = grant;
    return f.blob.read(u.request, grant, limits, f.authorize);
  });
  assert.throws(
    () => captured.assertCurrent(),
    code("attachment_read_not_found"),
  );
  assert.throws(
    () => f.blob.read(u.request, captured, limits, f.authorize),
    code("attachment_read_not_found"),
  );
});
test("attachment reads: policy is rechecked after the byte store returns", (t) => {
  const f = fixture(t),
    u = f.upload(),
    port = {
      read(...args) {
        const r = f.blob.read(...args);
        f.state.active = false;
        return r;
      },
    };
  assert.throws(
    () => f.read(f.relay, port).read(f.contexts.b, u.request),
    code("forbidden"),
  );
  f.state.active = true;
  assert.equal(f.read().read(f.contexts.b, u.request).data.length, 4);
});
test("attachment reads: concurrent terminal update waits for Relay guard and then blocks later chunks", (t) => {
  const f = fixture(t),
    u = f.upload(),
    other = new DatabaseSync(join(f.dir, "read-relay.sqlite"));
  other.exec("PRAGMA busy_timeout=1");
  t.after(() => other.close());
  let tried = false;
  const port = {
    read(...args) {
      tried = true;
      assert.throws(
        () => other.exec("UPDATE relay_messages SET state='quarantined'"),
        (e) => e.code === "ERR_SQLITE_ERROR" && e.message.includes("locked"),
      );
      return f.blob.read(...args);
    },
  };
  assert.equal(
    f.read(f.relay, port).read(f.contexts.b, u.request).data.length,
    4,
  );
  assert.equal(tried, true);
  other.exec("UPDATE relay_messages SET state='quarantined'");
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
});
test("attachment reads: storage faults and async ports expose no private messages or unhandled rejection", async (t) => {
  const f = fixture(t),
    u = f.upload(),
    unhandled = [],
    listener = (e) => unhandled.push(e);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  for (const port of [
    {
      read() {
        throw Error("synthetic-private-db");
      },
    },
    {
      read() {
        return Promise.reject(Error("synthetic-private-async"));
      },
    },
  ])
    assert.throws(
      () => f.read(f.relay, port).read(f.contexts.b, u.request),
      code("attachment_read_failed"),
    );
  const port = {
    withAttachmentRead() {
      return Promise.reject(Error("synthetic-private-relay"));
    },
  };
  assert.throws(
    () => f.read(port).read(f.contexts.b, u.request),
    code("attachment_read_failed"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(f.read().read(f.contexts.b, u.request).data.length, 4);
});
test("attachment reads: expiry during IO suppresses the already-read chunk before return", (t) => {
  const f = fixture(t),
    expiry = Date.now() + 1500,
    u = f.upload(payload, { expiry });
  const port = {
    read(...args) {
      const r = f.blob.read(...args);
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(1, expiry - Date.now() + 20),
      );
      return r;
    },
  };
  assert.throws(
    () => f.read(f.relay, port).read(f.contexts.b, u.request),
    code("attachment_read_not_found"),
  );
});

test("attachment reads: confirmed refs survive the shorter orphan-upload deadline", (t) => {
  const f = fixture(t),
    u = f.upload();
  f.blobRaw.exec(
    "DROP TRIGGER attachment_identity_immutable; UPDATE attachment_uploads SET upload_expires_at=0",
  );
  assert.deepEqual(
    f.read().read(f.contexts.b, u.request).data,
    payload.subarray(0, 4),
  );
  assert.equal(
    f.blobRaw.prepare("SELECT state FROM attachment_uploads").get().state,
    "finalized",
  );
});
test("attachment reads: oversized stored chunks fail without returning a large allocation", (t) => {
  const f = fixture(t),
    u = f.upload();
  f.blobRaw
    .prepare(
      "UPDATE attachment_chunks SET data=zeroblob(1000000) WHERE attachment_id=? AND offset=0",
    )
    .run(u.request.attachment_id);
  assert.throws(
    () => f.read().read(f.contexts.b, u.request),
    code("attachment_integrity_failed"),
  );
});
