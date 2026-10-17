import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSubmission,
  comparisonMaterial,
  makeReplayBoundMessageId,
} from "../src/relay/contract.ts";
import { makeUploadRequestId } from "../src/relay/attachments.ts";
import { RelayError } from "../src/relay/service.ts";
import {
  fixture as uploadFixture,
  payload,
  intent,
  code,
} from "./relay-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
function fixture(t) {
  const f = uploadFixture(t);
  const authorize = (peer) => {
    const decision = f.authorization.authorize(
      f.contexts.a,
      "begin",
      peer?.recipient_id,
      peer?.kind,
    );
    if (!decision) throw new RelayError("forbidden");
    return decision.agent_id;
  };
  const upload = (value = intent(), finalized = true) => {
    const receipt = f.api.begin(f.contexts.a, value);
    f.putAll(receipt.attachment_id);
    if (finalized) f.api.finalize(f.contexts.a, receipt.attachment_id);
    return {
      receipt,
      value,
      part: {
        type: "attachment",
        attachment_id: receipt.attachment_id,
        ...value.attachment,
      },
    };
  };
  const message = (u) => ({
    version: 1,
    message_id: u.value.message_id,
    recipient_id: u.value.recipient_id,
    kind: u.value.kind,
    first_sent_at: u.value.first_sent_at,
    expires_at: u.value.expires_at,
    thread_id: "attachment-thread",
    in_reply_to: null,
    body: {
      parts: [{ type: "text", text: "Synthetic private caption" }, u.part],
    },
  });
  const accepted = (m) => ({
    sender_id: "a",
    message_id: m.message_id,
    recipient_id: m.recipient_id,
    receipt_id: "synthetic-server-receipt",
    accepted_at: new Date().toISOString(),
    expires_at: m.expires_at,
    state: "pending",
  });
  const acceptance = (m) => {
    const msg = parseSubmission(m, limits);
    return {
      message: msg,
      sender_id: "a",
      comparison_material: comparisonMaterial("a", msg, limits),
    };
  };
  return { ...f, authorize, upload, message, accepted, acceptance };
}
test("attachment bindings: durable prepare fixes ordered refs and complete message fingerprint without storing its body", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    bound = f.store.prepare(m, limits, f.authorize);
  assert.equal(bound.state, "prepared");
  assert.equal(bound.receipt, null);
  assert.deepEqual(bound.attachment_ids, [u.receipt.attachment_id]);
  assert.deepEqual(f.store.prepare(m, limits, f.authorize), bound);
  assert.deepEqual(f.store.binding(m.message_id, f.authorize), bound);
  const stored = JSON.stringify(
    f.raw.prepare("SELECT * FROM attachment_bindings").all(),
  );
  assert.equal(stored.includes("Synthetic private caption"), false);
  assert.equal(stored.includes(u.value.attachment.filename), false);
});
test("attachment bindings: prepared refs block owner cancellation and preserve finalized bytes", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  assert.throws(
    () => f.api.cancel(f.contexts.a, u.receipt.attachment_id),
    code("upload_bound"),
  );
  assert.equal(
    f.api.finalize(f.contexts.a, u.receipt.attachment_id).state,
    "finalized",
  );
  assert.equal(f.count("attachment_chunks"), 3);
});
test("attachment bindings: pinned bytes survive orphan upload expiry until the original message deadline", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  const other = f.upload(intent(payload, { request_id: "unbound-orphan" }));
  f.raw.exec(
    "DROP TRIGGER attachment_identity_immutable; UPDATE attachment_uploads SET upload_expires_at=0",
  );
  assert.equal(
    f.api.status(f.contexts.a, u.receipt.attachment_id).state,
    "finalized",
  );
  assert.deepEqual(f.api.maintain(f.contexts.admin, 100), {
    expired: 1,
    purged: 0,
  });
  assert.equal(
    f.api.status(f.contexts.a, other.receipt.attachment_id).state,
    "expired",
  );
  assert.equal(f.count("attachment_chunks"), 3);
});
test("attachment bindings: owner, message, recipient, kind, times and every attachment descriptor must match", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    part = u.part;
  for (const patch of [
    { message_id: makeReplayBoundMessageId(m.first_sent_at, "2".repeat(32)) },
    { recipient_id: "c" },
    { kind: "notice" },
    { body: { parts: [{ ...part, sha256: "0".repeat(64) }] } },
    { body: { parts: [{ ...part, filename: "other.bin" }] } },
    { body: { parts: [{ ...part, size_bytes: 9 }] } },
    { body: { parts: [{ ...part, media_type: "image/png" }] } },
  ])
    assert.throws(
      () => f.store.prepare({ ...m, ...patch }, limits, () => "a"),
      code("attachment_reference_mismatch"),
    );
  assert.throws(
    () => f.store.prepare(m, limits, () => "b"),
    code("upload_not_found"),
  );
  assert.equal(f.count("attachment_refs"), 0);
});
test("attachment bindings: all refs prepare atomically and an incomplete sibling leaves no partial pin", (t) => {
  const f = fixture(t),
    u = f.upload(),
    v = {
      ...u.value,
      request_id: makeUploadRequestId(u.value.first_sent_at, "2".repeat(32)),
    };
  const incomplete = f.upload(v, false),
    m = f.message(u);
  m.body.parts.push(incomplete.part);
  assert.throws(
    () => f.store.prepare(m, limits, f.authorize),
    code("attachment_not_finalized"),
  );
  assert.equal(f.count("attachment_refs"), 0);
  assert.equal(f.count("attachment_bindings"), 0);
  assert.equal(
    f.api.cancel(f.contexts.a, u.receipt.attachment_id).state,
    "cancelled",
  );
});
test("attachment bindings: duplicate attachment IDs and legacy opaque message IDs are refused", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  assert.throws(
    () =>
      f.store.prepare(
        { ...m, body: { parts: [u.part, u.part] } },
        limits,
        f.authorize,
      ),
    code("invalid_attachment_message"),
  );
  assert.throws(
    () =>
      f.store.prepare({ ...m, message_id: "legacy-id" }, limits, f.authorize),
    code("invalid_attachment_message"),
  );
  assert.throws(
    () =>
      f.store.prepare(
        { ...m, body: { parts: [{ type: "text", text: "no file" }] } },
        limits,
        f.authorize,
      ),
    code("invalid_attachment_message"),
  );
});
test("attachment bindings: changed caption, order or thread cannot reuse a prepared message key", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  for (const patch of [
    { thread_id: "other-thread" },
    { body: { parts: [{ type: "text", text: "changed" }, u.part] } },
    { body: { parts: [u.part, m.body.parts[0]] } },
  ])
    assert.throws(
      () => f.store.prepare({ ...m, ...patch }, limits, f.authorize),
      code("attachment_binding_conflict"),
    );
  assert.equal(f.count("attachment_refs"), 1);
});
test("attachment bindings: unknown and foreign binding IDs share refusal and current policy applies to retries", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  for (const id of [m.message_id, "unknown"])
    assert.throws(
      () => f.store.binding(id, () => "b"),
      code("attachment_binding_not_found"),
    );
  f.mutable.peer = false;
  assert.throws(
    () => f.store.prepare(m, limits, f.authorize),
    code("forbidden"),
  );
  assert.throws(
    () => f.store.binding(m.message_id, f.authorize),
    code("forbidden"),
  );
});
test("attachment bindings: close and reopen retain reservations and prevent later cancellation", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    before = f.store.prepare(m, limits, f.authorize);
  f.close(f.store);
  const store = f.open();
  store.migrate();
  assert.deepEqual(store.prepare(m, limits, f.authorize), before);
  assert.throws(
    () => f.service(store).cancel(f.contexts.a, u.receipt.attachment_id),
    code("upload_bound"),
  );
});
test("attachment bindings: admission requires durable prepare and recomputes full material rather than trusting a stale snapshot", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    a = f.acceptance(m);
  assert.throws(
    () => f.store.checkPrepared(a, limits),
    code("attachment_binding_unavailable"),
  );
  f.store.prepare(m, limits, f.authorize);
  assert.doesNotThrow(() => f.store.checkPrepared(a, limits));
  assert.throws(
    () =>
      f.store.checkPrepared(
        { ...a, message: { ...a.message, thread_id: "tampered" } },
        limits,
      ),
    code("attachment_binding_unavailable"),
  );
  assert.throws(
    () =>
      f.store.checkPrepared(
        { ...a, comparison_material: "unverified" },
        limits,
      ),
    code("attachment_binding_unavailable"),
  );
});
test("attachment bindings: host receipt confirmation is idempotent but rejects mismatched owner, destination, deadline and receipt identity", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    receipt = f.accepted(m);
  f.store.prepare(m, limits, f.authorize);
  for (const patch of [
    { sender_id: "c" },
    { recipient_id: "c" },
    { expires_at: new Date().toISOString() },
    { accepted_at: "bad" },
    { state: "invented" },
  ])
    assert.throws(
      () =>
        f.store.confirm(m.message_id, { ...receipt, ...patch }, f.authorize),
      code("attachment_receipt_mismatch"),
    );
  const result = f.store.confirm(m.message_id, receipt, f.authorize);
  assert.equal(result.state, "accepted");
  assert.deepEqual(f.store.confirm(m.message_id, receipt, f.authorize), result);
  assert.throws(
    () =>
      f.store.confirm(
        m.message_id,
        { ...receipt, receipt_id: "different" },
        f.authorize,
      ),
    code("attachment_receipt_mismatch"),
  );
});
test("attachment bindings: failed confirmation leaves the prepared pin durable for later reconciliation", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  f.raw.exec(
    "CREATE TRIGGER fail_confirmation BEFORE UPDATE OF receipt ON attachment_bindings BEGIN SELECT RAISE(ABORT,'synthetic-private-failure'); END;",
  );
  assert.throws(
    () => f.store.confirm(m.message_id, f.accepted(m), f.authorize),
    code("attachment_store_unavailable"),
  );
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "prepared");
  assert.throws(
    () => f.api.cancel(f.contexts.a, u.receipt.attachment_id),
    code("upload_bound"),
  );
  f.raw.exec("DROP TRIGGER fail_confirmation");
  assert.equal(
    f.store.confirm(m.message_id, f.accepted(m), f.authorize).state,
    "accepted",
  );
});
test("attachment bindings: reference write failure rolls back the entire reservation without deleting uploads", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.raw.exec(
    "CREATE TRIGGER fail_ref BEFORE INSERT ON attachment_refs BEGIN SELECT RAISE(ABORT,'synthetic-private-failure'); END;",
  );
  assert.throws(
    () => f.store.prepare(m, limits, f.authorize),
    code("attachment_store_unavailable"),
  );
  assert.equal(f.count("attachment_bindings"), 0);
  assert.equal(f.count("attachment_refs"), 0);
  assert.equal(
    f.api.cancel(f.contexts.a, u.receipt.attachment_id).state,
    "cancelled",
  );
});
test("attachment bindings: original message expiry releases pinned bytes while retaining receipt and reference tombstones", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  f.raw.exec(
    "DROP TRIGGER attachment_binding_immutable; UPDATE attachment_bindings SET expires_at=0",
  );
  assert.equal(f.store.binding(m.message_id, f.authorize).state, "expired");
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 1,
    purged: 0,
  });
  assert.equal(f.count("attachment_chunks"), 0);
  assert.equal(f.count("attachment_bindings"), 1);
  assert.equal(f.count("attachment_refs"), 1);
});
test("attachment bindings: metadata GC removes refs before upload tombstones and remains bounded", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  f.store.prepare(m, limits, f.authorize);
  f.raw.exec(
    "DROP TRIGGER attachment_binding_immutable; UPDATE attachment_bindings SET expires_at=0",
  );
  f.api.maintain(f.contexts.admin, 1);
  f.raw.exec(
    "DROP TRIGGER attachment_identity_immutable; DROP TRIGGER attachment_terminal; UPDATE attachment_uploads SET terminal_at=0,upload_expires_at=0,retain_until=0; UPDATE attachment_bindings SET retain_until=0",
  );
  assert.deepEqual(f.api.maintain(f.contexts.admin, 1), {
    expired: 0,
    purged: 1,
  });
  assert.equal(f.count("attachment_refs"), 0);
  assert.equal(f.count("attachment_bindings"), 0);
  assert.equal(f.count("attachment_uploads"), 0);
});
test("attachment bindings: explicit version-1 migration preserves finalized chunks and records schema 2", (t) => {
  const f = fixture(t),
    u = f.upload();
  f.raw.exec(
    "DROP TRIGGER attachment_binding_immutable; DROP TABLE attachment_refs; DROP TABLE attachment_bindings; UPDATE attachment_schema SET version=1",
  );
  f.close(f.store);
  const store = f.open();
  store.migrate();
  assert.equal(
    f.raw.prepare("SELECT version FROM attachment_schema").get().version,
    2,
  );
  assert.equal(
    f.service(store).status(f.contexts.a, u.receipt.attachment_id).state,
    "finalized",
  );
  assert.equal(f.count("attachment_chunks"), 3);
});
test("attachment bindings: a competing cancel cannot pass between prepare validation and durable pin commit", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u),
    other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  let attempted = false;
  const authorize = (peer) => {
    if (peer && !attempted) {
      attempted = true;
      assert.throws(
        () => f.service(other).cancel(f.contexts.a, u.receipt.attachment_id),
        code("attachment_store_unavailable"),
      );
    }
    return f.authorize(peer);
  };
  f.store.prepare(m, limits, authorize);
  assert.equal(attempted, true);
  assert.throws(
    () => f.service(other).cancel(f.contexts.a, u.receipt.attachment_id),
    code("upload_bound"),
  );
});
test("attachment bindings: a decision revoked before COMMIT rolls back both binding and refs", (t) => {
  const f = fixture(t),
    u = f.upload(),
    m = f.message(u);
  let peers = 0,
    active = true;
  const authorize = (peer) => {
    if (!active) throw new RelayError("forbidden");
    if (peer && ++peers === 2) active = false;
    return "a";
  };
  assert.throws(() => f.store.prepare(m, limits, authorize), code("forbidden"));
  assert.equal(f.count("attachment_bindings"), 0);
  assert.equal(f.count("attachment_refs"), 0);
  assert.equal(f.count("attachment_chunks"), 3);
});
