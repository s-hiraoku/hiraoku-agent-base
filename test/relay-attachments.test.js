import test from "node:test";
import assert from "node:assert/strict";
import {
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import {
  AttachmentUploadService,
  parseUploadIntent,
  makeUploadRequestId,
} from "../src/relay/attachments.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import {
  fixture,
  options,
  intent,
  payload,
  digest,
  code,
} from "./relay-attachment-fixtures.js";

test("uploads: strict version-1 metadata retains original message ID/deadline and rejects identity, URL and path selectors", () => {
  const valid = intent();
  assert.deepEqual(parseUploadIntent(valid, 4096), valid);
  for (const patch of [
    { version: 2 },
    { owner_id: "a" },
    { url: "https://invalid.example/" },
    { expires_at: new Date(Date.parse(valid.expires_at) + 1).toISOString() },
    { recipient_id: "b\n" },
    { attachment: { ...valid.attachment, filename: "../synthetic.bin" } },
    {
      attachment: {
        ...valid.attachment,
        sha256: valid.attachment.sha256 + "\n",
      },
    },
    {
      attachment: {
        ...valid.attachment,
        media_type: "application/octet-stream\n",
      },
    },
    { attachment: { ...valid.attachment, attachment_id: "chosen" } },
    { attachment: { ...valid.attachment, size_bytes: -1 } },
  ])
    assert.throws(
      () => parseUploadIntent({ ...valid, ...patch }, 4096),
      code("invalid_upload_request"),
    );
  assert.throws(
    () => parseUploadIntent(valid, 1),
    code("invalid_upload_request"),
  );
  let touched = false;
  const getter = { ...valid };
  Object.defineProperty(getter, "recipient_id", {
    enumerable: true,
    get() {
      touched = true;
      return "b";
    },
  });
  assert.throws(
    () => parseUploadIntent(getter, 4096),
    code("invalid_upload_request"),
  );
  assert.equal(touched, false);
  assert.throws(
    () => parseUploadIntent({ ...valid, [Symbol("unknown")]: true }, 4096),
    code("invalid_upload_request"),
  );
});
test("uploads: ordered binary chunks, exact retries and digest-checked finalize persist a stable manifest", (t) => {
  const f = fixture(t),
    value = intent(),
    receipt = f.api.begin(f.contexts.a, value),
    id = receipt.attachment_id;
  assert.equal(receipt.owner_id, "a");
  assert.equal(receipt.state, "uploading");
  assert.equal(receipt.next_offset, 0);
  assert.ok(
    Date.parse(receipt.upload_expires_at) <= Date.parse(value.expires_at),
  );
  f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4));
  assert.equal(
    f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4)).next_offset,
    4,
  );
  f.putAll(id);
  const finalized = f.api.finalize(f.contexts.a, id);
  assert.equal(finalized.state, "finalized");
  assert.equal(finalized.received_bytes, payload.byteLength);
  assert.deepEqual(f.api.finalize(f.contexts.a, id), finalized);
  assert.deepEqual(f.api.begin(f.contexts.a, value), finalized);
  assert.deepEqual(f.api.status(f.contexts.a, id), finalized);
  assert.equal(f.count("attachment_uploads"), 1);
  assert.equal(f.count("attachment_chunks"), 3);
  const stored = f.raw
    .prepare("SELECT data FROM attachment_chunks ORDER BY offset")
    .all();
  assert.deepEqual(
    Buffer.concat(stored.map((r) => Buffer.from(r.data))),
    Buffer.from(payload),
  );
});
test("uploads: close/reopen recovers begin and uncertain chunk responses without replacing IDs or extending expiry", (t) => {
  const f = fixture(t),
    value = intent(),
    first = f.api.begin(f.contexts.a, value),
    id = first.attachment_id;
  f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4));
  f.close(f.store);
  const reopened = f.open();
  reopened.migrate();
  const api = f.service(reopened);
  const restored = api.begin(f.contexts.a, value);
  assert.equal(restored.attachment_id, id);
  assert.equal(restored.upload_expires_at, first.upload_expires_at);
  assert.equal(restored.expires_at, first.expires_at);
  assert.equal(restored.next_offset, 4);
  f.putAll(id, payload, api);
  assert.equal(api.finalize(f.contexts.a, id).state, "finalized");
  f.close(reopened);
  const again = f.open();
  again.migrate();
  assert.equal(f.service(again).status(f.contexts.a, id).state, "finalized");
});
test("uploads: request keys are owner-scoped and changed metadata never reuses an accepted reservation", (t) => {
  const f = fixture(t),
    value = intent(),
    first = f.api.begin(f.contexts.a, value);
  assert.throws(
    () =>
      f.api.begin(f.contexts.a, {
        ...value,
        attachment: { ...value.attachment, filename: "different.bin" },
      }),
    code("upload_idempotency_conflict"),
  );
  const other = f.api.begin(f.contexts.b, value);
  assert.notEqual(first.attachment_id, other.attachment_id);
  assert.equal(f.count("attachment_uploads"), 2);
});
test("uploads: only exact aligned chunks can advance; gaps, overlap and changed retries are refused", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, intent()).attachment_id;
  for (const [offset, bytes, error] of [
    [4, payload.subarray(4, 8), "upload_invalid_offset"],
    [1, payload.subarray(0, 4), "invalid_upload_chunk"],
    [0, payload.subarray(0, 3), "invalid_upload_chunk"],
    [0, new Uint8Array(0), "invalid_upload_chunk"],
    [0, payload, "invalid_upload_chunk"],
    [10, payload.subarray(0, 2), "invalid_upload_chunk"],
    [-1, payload.subarray(0, 4), "invalid_upload_chunk"],
  ])
    assert.throws(
      () => f.api.put(f.contexts.a, id, offset, bytes),
      code(error),
    );
  assert.equal(f.api.status(f.contexts.a, id).next_offset, 0);
  f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4));
  assert.throws(
    () => f.api.put(f.contexts.a, id, 0, new Uint8Array(4)),
    code("upload_chunk_conflict"),
  );
  assert.equal(f.api.status(f.contexts.a, id).next_offset, 4);
});
test("uploads: incomplete finalize is resumable but full-content digest mismatch is terminal and releases chunks", (t) => {
  const f = fixture(t),
    value = intent(),
    id = f.api.begin(f.contexts.a, {
      ...value,
      attachment: { ...value.attachment, sha256: "0".repeat(64) },
    }).attachment_id;
  assert.throws(
    () => f.api.finalize(f.contexts.a, id),
    code("upload_incomplete"),
  );
  f.putAll(id);
  const rejected = f.api.finalize(f.contexts.a, id);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.reason, "digest_mismatch");
  assert.equal(f.count("attachment_chunks"), 0);
  assert.deepEqual(f.api.finalize(f.contexts.a, id), rejected);
  assert.throws(
    () => f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    code("upload_closed"),
  );
});
test("uploads: corrupted, missing or reordered stored chunks cannot finalize", (t) => {
  const f = fixture(t);
  for (const [index, mutate] of [
    (id) =>
      f.raw
        .prepare(
          "UPDATE attachment_chunks SET data=? WHERE attachment_id=? AND offset=0",
        )
        .run(new Uint8Array(4), id),
    (id) =>
      f.raw
        .prepare(
          "DELETE FROM attachment_chunks WHERE attachment_id=? AND offset=4",
        )
        .run(id),
    (id) =>
      f.raw
        .prepare(
          "UPDATE attachment_chunks SET offset=100 WHERE attachment_id=? AND offset=4",
        )
        .run(id),
  ].entries()) {
    const id = f.api.begin(
      f.contexts.a,
      intent(payload, { request_id: `corruption-${index}` }),
    ).attachment_id;
    f.putAll(id);
    mutate(id);
    const result = f.api.finalize(f.contexts.a, id);
    assert.equal(result.state, "rejected");
    assert.equal(result.reason, "integrity_failed");
    assert.equal(
      f.raw
        .prepare(
          "SELECT count(*) n FROM attachment_chunks WHERE attachment_id=?",
        )
        .get(id).n,
      0,
    );
  }
});
test("uploads: zero-byte files finalize only with the canonical empty digest", (t) => {
  const f = fixture(t),
    bytes = new Uint8Array(0),
    id = f.api.begin(f.contexts.a, intent(bytes)).attachment_id;
  assert.equal(f.api.finalize(f.contexts.a, id).state, "finalized");
  assert.equal(f.count("attachment_chunks"), 0);
  assert.equal(digest(bytes), intent(bytes).attachment.sha256);
});
test("uploads: default, unknown, throwing and async authority deny without leaked errors or unhandled rejection", async (t) => {
  const f = fixture(t);
  for (const authority of [
    undefined,
    {
      authorize() {
        throw Error("synthetic-private");
      },
    },
    {
      authorize: async () => {
        throw Error("synthetic-private");
      },
    },
  ]) {
    const api = new AttachmentUploadService(f.store, options, authority);
    assert.throws(() => api.begin(f.contexts.a, intent()), code("forbidden"));
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(f.count("attachment_uploads"), 0);
});
test("uploads: attachment IDs confer no foreign status, write, finalize or cancellation authority", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, intent()).attachment_id;
  for (const foreign of [id, "unknown-upload"]) {
    for (const operation of [
      () => f.api.status(f.contexts.b, foreign),
      () => f.api.put(f.contexts.b, foreign, 0, payload.subarray(0, 4)),
      () => f.api.finalize(f.contexts.b, foreign),
      () => f.api.cancel(f.contexts.b, foreign),
    ])
      assert.throws(operation, code("upload_not_found"));
  }
  assert.equal(f.api.status(f.contexts.a, id).state, "uploading");
});
test("uploads: current peer/kind and operation rights are rechecked on exact retries", (t) => {
  const f = fixture(t),
    value = intent(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  f.putAll(id);
  f.api.finalize(f.contexts.a, id);
  f.mutable.peer = false;
  for (const operation of [
    () => f.api.begin(f.contexts.a, value),
    () => f.api.status(f.contexts.a, id),
    () => f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    () => f.api.finalize(f.contexts.a, id),
    () => f.api.cancel(f.contexts.a, id),
  ])
    assert.throws(operation, code("forbidden"));
  f.mutable.peer = true;
  f.mutable.denied.add("cancel");
  assert.throws(() => f.api.cancel(f.contexts.a, id), code("forbidden"));
  assert.equal(f.api.status(f.contexts.a, id).state, "finalized");
});
test("uploads: cancellation releases bytes but preserves immutable reservations and exact begin receipts", (t) => {
  const f = fixture(t),
    value = intent(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  f.putAll(id);
  f.api.finalize(f.contexts.a, id);
  const cancelled = f.api.cancel(f.contexts.a, id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(f.count("attachment_chunks"), 0);
  assert.equal(f.count("attachment_uploads"), 1);
  assert.deepEqual(f.api.cancel(f.contexts.a, id), cancelled);
  assert.deepEqual(f.api.begin(f.contexts.a, value), cancelled);
  assert.throws(() =>
    f.raw
      .prepare("DELETE FROM attachment_uploads WHERE attachment_id=?")
      .run(id),
  );
  assert.throws(() =>
    f.raw
      .prepare(
        "UPDATE attachment_uploads SET owner_id='b' WHERE attachment_id=?",
      )
      .run(id),
  );
});
test("uploads: expiry reclaims partial and finalized chunks through bounded separately authorized maintenance", (t) => {
  const f = fixture(t);
  for (const number of [1, 2]) {
    const id = f.api.begin(
      f.contexts.a,
      intent(payload, { request_id: `expire-${number}` }),
    ).attachment_id;
    f.putAll(id);
    if (number === 2) f.api.finalize(f.contexts.a, id);
  }
  // Test-only clock acceleration. The production API cannot alter immutable deadlines.
  f.raw.exec(
    "DROP TRIGGER attachment_identity_immutable; UPDATE attachment_uploads SET upload_expires_at=0",
  );
  assert.throws(() => f.api.maintain(f.contexts.a, 1), code("forbidden"));
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 1,
    purged: 0,
  });
  assert.equal(f.count("attachment_chunks"), 3);
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 1,
    purged: 0,
  });
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 0,
    purged: 0,
  });
  assert.equal(f.count("attachment_chunks"), 0);
  assert.equal(f.count("attachment_uploads"), 2);
});
test("uploads: status and finalize honor an expired upload without extending its original message deadline", (t) => {
  const f = fixture(t),
    value = intent(),
    first = f.api.begin(f.contexts.a, value);
  f.api.put(f.contexts.a, first.attachment_id, 0, payload.subarray(0, 4));
  f.raw.exec(
    "DROP TRIGGER attachment_identity_immutable; UPDATE attachment_uploads SET upload_expires_at=0",
  );
  const expired = f.api.status(f.contexts.a, first.attachment_id);
  assert.equal(expired.state, "expired");
  assert.equal(expired.expires_at, value.expires_at);
  assert.equal(
    f.api.begin(f.contexts.a, value).attachment_id,
    first.attachment_id,
  );
  assert.equal(
    f.api.finalize(f.contexts.a, first.attachment_id).state,
    "expired",
  );
  assert.equal(f.count("attachment_chunks"), 0);
});
test("uploads: declared-byte and per-owner reservations reject growth before receiving bytes", (t) => {
  const f = fixture(t, { max_live_bytes: 15, max_live_bytes_per_owner: 10 });
  const one = intent(),
    id = f.api.begin(f.contexts.a, one).attachment_id;
  assert.throws(
    () =>
      f.api.begin(
        f.contexts.a,
        intent(payload, { request_id: "owner-overflow" }),
      ),
    code("upload_capacity_exceeded"),
  );
  assert.throws(
    () =>
      f.api.begin(
        f.contexts.b,
        intent(payload, { request_id: "global-overflow" }),
      ),
    code("upload_capacity_exceeded"),
  );
  f.api.cancel(f.contexts.a, id);
  assert.equal(f.api.begin(f.contexts.b, one).state, "uploading");
});
test("uploads: active-count and retained-record caps deny growth without evicting accepted requests", (t) => {
  const f = fixture(t, {
    max_open_per_owner: 1,
    max_open_uploads: 2,
    max_records: 2,
  });
  const value = intent(),
    first = f.api.begin(f.contexts.a, value);
  assert.throws(
    () => f.api.begin(f.contexts.a, intent(payload, { request_id: "another" })),
    code("upload_capacity_exceeded"),
  );
  f.api.begin(f.contexts.b, value);
  assert.deepEqual(f.api.begin(f.contexts.a, value), first);
  f.api.cancel(f.contexts.a, first.attachment_id);
  assert.throws(
    () => f.api.begin(f.contexts.a, intent(payload, { request_id: "third" })),
    code("upload_capacity_exceeded"),
  );
  assert.equal(f.count("attachment_uploads"), 2);
});
test("uploads: expired new intent and unsupported future clock never reserve an upload", (t) => {
  const f = fixture(t),
    value = intent();
  const at = Date.now() - 3601000;
  assert.throws(
    () =>
      f.api.begin(f.contexts.a, {
        ...value,
        message_id: "legacy-expired",
        request_id: makeUploadRequestId(
          new Date(at).toISOString(),
          "1".repeat(32),
        ),
        first_sent_at: new Date(at).toISOString(),
        expires_at: new Date(at + 3600000).toISOString(),
      }),
    code("expired_before_acceptance"),
  );
  const future = Date.now() + 60000;
  assert.throws(
    () =>
      f.api.begin(f.contexts.a, {
        ...value,
        message_id: "legacy-future",
        request_id: makeUploadRequestId(
          new Date(future).toISOString(),
          "1".repeat(32),
        ),
        first_sent_at: new Date(future).toISOString(),
        expires_at: new Date(future + 3600000).toISOString(),
      }),
    code("upload_clock_skew"),
  );
  assert.equal(f.count("attachment_uploads"), 0);
});
test("uploads: private file permissions, symlinks, foreign databases and explicit schema/key/chunk policy checks", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const link = join(f.dir, "linked.sqlite");
  symlinkSync(f.path, link);
  assert.throws(
    () => new SQLiteAttachmentStore(link, options),
    code("attachment_store_unavailable"),
  );
  const loose = join(f.dir, "loose.sqlite");
  writeFileSync(loose, "");
  chmodSync(loose, 0o644);
  assert.throws(
    () => new SQLiteAttachmentStore(loose, options),
    code("attachment_store_unavailable"),
  );
  for (const [patch, error] of [
    [
      { fingerprint_key: new Uint8Array(32).fill(84) },
      "attachment_key_mismatch",
    ],
    [{ chunk_bytes: 8 }, "attachment_chunk_policy_mismatch"],
  ]) {
    const opened = f.open(patch);
    assert.throws(() => opened.migrate(), code(error));
    assert.throws(
      () => f.service(opened).begin(f.contexts.a, intent()),
      code("upload_not_migrated"),
    );
  }
  const alien = join(f.dir, "alien.sqlite"),
    db = new DatabaseSync(alien);
  db.exec("CREATE TABLE unrelated(id TEXT)");
  db.close();
  chmodSync(alien, 0o600);
  const foreign = new SQLiteAttachmentStore(alien, options);
  t.after(() => foreign.close());
  assert.throws(() => foreign.migrate(), code("unknown_attachment_schema"));
});
test("uploads: unsafe or unbounded store policies are refused before a file is opened", () => {
  for (const patch of [
    { chunk_bytes: 0 },
    { chunk_bytes: 1048577 },
    { max_attachment_bytes: 4097 },
    { max_records: Infinity },
    { max_live_bytes: 0 },
    { upload_ttl_ms: 3600001 },
    { max_clock_skew_ms: -1 },
    { busy_timeout_ms: 1001 },
    { fingerprint_key: new Uint8Array(1) },
  ])
    assert.throws(
      () => new SQLiteAttachmentStore(":memory:", { ...options, ...patch }),
      code("invalid_attachment_options"),
    );
});
test("uploads: failed chunk/manifest writes roll back atomically and normalize storage details", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, intent()).attachment_id;
  f.raw.exec(
    "CREATE TRIGGER fail_progress BEFORE UPDATE OF received_bytes ON attachment_uploads BEGIN SELECT RAISE(ABORT,'synthetic-private-storage-error'); END;",
  );
  assert.throws(
    () => f.api.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    code("attachment_store_unavailable"),
  );
  assert.equal(f.count("attachment_chunks"), 0);
  assert.equal(f.api.status(f.contexts.a, id).next_offset, 0);
  f.raw.exec("DROP TRIGGER fail_progress");
  f.putAll(id);
  f.raw.exec(
    "CREATE TRIGGER fail_finalize BEFORE UPDATE OF finalized_at ON attachment_uploads BEGIN SELECT RAISE(ABORT,'synthetic-private-storage-error'); END;",
  );
  assert.throws(
    () => f.api.finalize(f.contexts.a, id),
    code("attachment_store_unavailable"),
  );
  assert.equal(f.api.status(f.contexts.a, id).state, "uploading");
  assert.equal(f.count("attachment_chunks"), 3);
});
test("uploads: public receipt contains no bytes or credentials and pure entry remains independent of HAB/MCP/SQLite", (t) => {
  const f = fixture(t),
    receipt = f.api.begin(f.contexts.a, intent());
  assert.equal("bytes" in receipt, false);
  assert.equal("token" in receipt, false);
  assert.equal("context" in receipt, false);
  const source = readFileSync(
    new URL("../src/relay/attachments.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "node:sqlite",
    "node:fs",
    "node:http",
    "../hab/",
    "@modelcontextprotocol",
    "process.env",
  ])
    assert.equal(source.includes(forbidden), false);
  const core = readFileSync(
    new URL("../src/relay/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(core.includes("attachments"), false);
});
test("uploads: time-bound request IDs permit 30-day receipt GC without reopening an old request", (t) => {
  const f = fixture(t),
    fresh = f.api.begin(f.contexts.a, intent());
  f.api.cancel(f.contexts.a, fresh.attachment_id);
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 0,
    purged: 0,
  });
  const oldAt = Date.now() - 32 * 86400000,
    first = new Date(oldAt).toISOString();
  const old = {
    ...intent(),
    message_id: "synthetic-old-message",
    request_id: makeUploadRequestId(first, "4".repeat(32)),
    first_sent_at: first,
    expires_at: new Date(oldAt + 3600000).toISOString(),
  };
  const canonical = JSON.stringify(parseUploadIntent(old, 4096));
  const fingerprint = createHmac("sha256", options.fingerprint_key)
    .update("intent-v1\0")
    .update(canonical)
    .digest("hex");
  // Test-only aging makes an internally consistent terminal manifest, not a production API.
  f.raw.exec(
    "DROP TRIGGER attachment_identity_immutable; DROP TRIGGER attachment_terminal",
  );
  f.raw
    .prepare(
      "UPDATE attachment_uploads SET request_id=?,fingerprint=?,intent=?,created_at=?,upload_expires_at=?,terminal_at=?,retain_until=? WHERE attachment_id=?",
    )
    .run(
      old.request_id,
      fingerprint,
      canonical,
      oldAt,
      oldAt + 60000,
      oldAt + 1000,
      oldAt + 31 * 86400000,
      fresh.attachment_id,
    );
  assert.equal(f.api.begin(f.contexts.a, old).state, "cancelled");
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 0,
    purged: 1,
  });
  assert.equal(f.count("attachment_uploads"), 0);
  assert.throws(
    () => f.api.begin(f.contexts.a, old),
    code("expired_before_acceptance"),
  );
  const now = new Date().toISOString();
  assert.throws(
    () =>
      f.api.begin(f.contexts.a, {
        ...old,
        first_sent_at: now,
        expires_at: new Date(Date.parse(now) + 3600000).toISOString(),
      }),
    code("invalid_upload_request"),
  );
});
test("uploads: receipt collection rejects unbounded batches and retains tombstones during the horizon", (t) => {
  const f = fixture(t),
    value = intent(),
    first = f.api.begin(f.contexts.a, value);
  f.api.cancel(f.contexts.a, first.attachment_id);
  for (const limit of [0, 101, Infinity])
    assert.throws(
      () => f.api.maintain(f.contexts.admin, limit),
      code("invalid_upload_request"),
    );
  assert.deepEqual(f.api.maintain(f.contexts.admin, 100), {
    expired: 0,
    purged: 0,
  });
  assert.equal(f.api.begin(f.contexts.a, value).state, "cancelled");
  assert.equal(f.count("attachment_uploads"), 1);
});
test("uploads: a second connection cannot cancel between current authorization and chunk commit", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, intent()).attachment_id;
  const other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  const competing = f.service(other);
  let tried = false;
  const api = new AttachmentUploadService(f.store, options, {
    authorize(ctx, op) {
      if (op === "chunk" && !tried) {
        tried = true;
        assert.throws(
          () => competing.cancel(f.contexts.a, id),
          code("attachment_store_unavailable"),
        );
      }
      return { agent_id: "a" };
    },
  });
  api.put(f.contexts.a, id, 0, payload.subarray(0, 4));
  assert.equal(tried, true);
  assert.equal(competing.status(f.contexts.a, id).next_offset, 4);
  assert.equal(competing.cancel(f.contexts.a, id).state, "cancelled");
});
test("uploads: reentrant access and changing owner decisions cannot append a chunk", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, intent()).attachment_id;
  let api;
  api = new AttachmentUploadService(f.store, options, {
    authorize() {
      return api.status(f.contexts.a, id);
    },
  });
  assert.throws(
    () => api.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    code("forbidden"),
  );
  const changing = new AttachmentUploadService(f.store, options, {
    authorize(ctx, op, peer) {
      return { agent_id: peer ? "b" : "a" };
    },
  });
  assert.throws(
    () => changing.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    code("forbidden"),
  );
  assert.equal(f.api.status(f.contexts.a, id).next_offset, 0);
});
