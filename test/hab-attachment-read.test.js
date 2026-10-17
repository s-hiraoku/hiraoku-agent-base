import test from "node:test";
import assert from "node:assert/strict";
import { HabAttachmentRead } from "../src/hab/attachment-read.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { fixture } from "./hab-attachment-fixtures.js";
import { code } from "./hab-registry-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { payload } from "./relay-attachment-fixtures.js";
function setup(t, enrollC = true) {
  const f = fixture(t, enrollC),
    message = f.upload();
  f.api().submit(f.contexts.a, message);
  const request = {
    version: 1,
    sender_id: f.a.agent_id,
    message_id: message.message_id,
    attachment_id: message.body.parts[1].attachment_id,
    offset: 0,
  };
  const read = (registry = f.registry, relay = f.relay, blobs = f.blob) =>
    new HabAttachmentRead(registry, relay, blobs, limits);
  return { ...f, message, request, read };
}
test("HAB attachment reads: current bound receiver gets exact bytes and immutable individual identity", (t) => {
  const f = setup(t),
    r = f.read().read(f.contexts.b, f.request);
  assert.equal(r.sender_id, f.a.agent_id);
  assert.equal(r.recipient_id, f.b.agent_id);
  assert.equal(r.expires_at, f.message.expires_at);
  assert.deepEqual(r.data, payload.subarray(0, 4));
  assert.equal(
    new HabRelayService(f.registry, f.relay, limits).poll(f.contexts.b),
    null,
  );
  assert.equal(f.count(), 1);
  for (const name of ["poll", "ack", "submit", "maintain", "confirm", "begin"])
    assert.equal(name in f.read(), false);
});
test("HAB attachment reads: management, claimed identity and unbound connections cannot read", (t) => {
  const f = setup(t, false);
  for (const context of [
    f.admin,
    null,
    {},
    { agent_id: f.b.agent_id },
    f.contexts.c,
  ])
    assert.throws(() => f.read().read(context, f.request), code("forbidden"));
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    3,
  );
});
test("HAB attachment reads: status authority does not grant download while current poll authority does", (t) => {
  const f = setup(t);
  f.change(f.b, "active", ["status"]);
  assert.throws(
    () => f.read().read(f.contexts.b, f.request),
    code("forbidden"),
  );
  f.change(f.b, "active", ["poll"]);
  assert.deepEqual(
    f.read().read(f.contexts.b, f.request).data,
    payload.subarray(0, 4),
  );
});
test("HAB attachment reads: sender and another active individual cannot read a recipient's attachment", (t) => {
  const f = setup(t);
  for (const context of [f.contexts.a, f.contexts.c])
    assert.throws(
      () => f.read().read(context, f.request),
      code("attachment_read_not_found"),
    );
  assert.throws(
    () =>
      f.read().read(f.contexts.b, { ...f.request, attachment_id: "unknown" }),
    code("attachment_read_not_found"),
  );
});
test("HAB attachment reads: stopped sender or receiver blocks saved-offset retries without deleting bytes", (t) => {
  const f = setup(t),
    r = f.read().read(f.contexts.b, f.request),
    request = { ...f.request, offset: r.next_offset };
  for (const who of [f.a, f.b]) {
    f.change(who, "stopped");
    assert.throws(
      () => f.read().read(f.contexts.b, request),
      code("forbidden"),
    );
    f.change(who, "active");
    assert.deepEqual(
      f.read().read(f.contexts.b, request).data,
      payload.subarray(4, 8),
    );
  }
  assert.equal(f.count(), 1);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    3,
  );
});
test("HAB attachment reads: the original sender-to-recipient block applies to each chunk", (t) => {
  const f = setup(t),
    r = f.read().read(f.contexts.b, f.request),
    request = { ...f.request, offset: r.next_offset };
  f.block(true, "block-chunk-read");
  assert.throws(() => f.read().read(f.contexts.b, request), code("forbidden"));
  f.block(false, "unblock-chunk-read");
  assert.deepEqual(
    f.read().read(f.contexts.b, request).data,
    payload.subarray(4, 8),
  );
});
test("HAB attachment reads: recipient binding revocation cannot reuse its former connection", (t) => {
  const f = setup(t);
  f.registry.revoke(f.admin, {
    request_id: "revoke-read-receiver",
    binding_id: f.bindings.get("b").binding_id,
    expected_epoch: f.b.epoch,
  });
  assert.throws(
    () => f.read().read(f.contexts.b, f.request),
    code("forbidden"),
  );
  assert.equal(f.count(), 1);
});
test("HAB attachment reads: expired, overlong and missing verified contexts deny retained bytes", (t) => {
  const f = setup(t);
  for (const stamp of [Date.now() - 1, Date.now() + 120000]) {
    f.mutable.expires_at = new Date(stamp).toISOString();
    assert.throws(
      () => f.read().read(f.contexts.b, f.request),
      code("forbidden"),
    );
  }
  f.mutable.expires_at = null;
  f.mutable.individual = false;
  assert.throws(
    () => f.read().read(f.contexts.b, f.request),
    code("forbidden"),
  );
});
test("HAB attachment reads: emergency stop denies downloads without granting deletion authority", (t) => {
  const f = setup(t);
  f.registry.emergencyStop(f.admin);
  assert.throws(
    () => f.read().read(f.contexts.b, f.request),
    code("forbidden"),
  );
  assert.equal(
    f.blobRaw.prepare("SELECT state FROM attachment_uploads").get().state,
    "finalized",
  );
});
test("HAB attachment reads: registry guard spans live Relay proof and byte-store read against another connection", (t) => {
  const f = setup(t),
    other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  const revoke = {
    request_id: "concurrent-read-revoke",
    binding_id: f.bindings.get("b").binding_id,
    expected_epoch: f.b.epoch,
  };
  const stages = [],
    attempt = (stage) => {
      stages.push(stage);
      assert.throws(
        () => other.revoke(f.admin, revoke),
        code("registry_unavailable"),
      );
    };
  const relay = {
    withAttachmentRead(request, limits, authorize, action) {
      attempt("relay");
      return f.relay.withAttachmentRead(request, limits, authorize, (grant) => {
        attempt("proof");
        return action(grant);
      });
    },
  };
  const blobs = {
    read(...args) {
      attempt("chunk");
      return f.blob.read(...args);
    },
  };
  assert.equal(
    f.read(f.registry, relay, blobs).read(f.contexts.b, f.request).data.length,
    4,
  );
  assert.deepEqual(stages, ["relay", "proof", "chunk"]);
  other.revoke(f.admin, revoke);
  assert.throws(
    () => f.read().read(f.contexts.b, f.request),
    code("forbidden"),
  );
});
test("HAB attachment reads: captured authorization and proof cannot escape the registry/Relay scope", (t) => {
  const f = setup(t);
  let captured, proof;
  const relay = {
    withAttachmentRead(request, limits, authorize, action) {
      captured = authorize;
      return f.relay.withAttachmentRead(request, limits, authorize, (grant) => {
        proof = grant;
        return action(grant);
      });
    },
  };
  f.read(f.registry, relay).read(f.contexts.b, f.request);
  assert.throws(() => captured(), code("forbidden"));
  assert.throws(() => proof.assertCurrent(), code("attachment_read_not_found"));
  assert.throws(
    () => f.blob.read(f.request, proof, limits, captured),
    code("attachment_read_not_found"),
  );
});
test("HAB attachment reads: context expiry after byte lookup suppresses the chunk and fresh context resumes same offset", (t) => {
  const f = setup(t),
    expiry = Date.now() + 1500;
  f.mutable.expires_at = new Date(expiry).toISOString();
  const blobs = {
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
    () => f.read(f.registry, f.relay, blobs).read(f.contexts.b, f.request),
    code("forbidden"),
  );
  f.mutable.expires_at = null;
  assert.deepEqual(
    f.read().read(f.contexts.b, f.request).data,
    payload.subarray(0, 4),
  );
  assert.equal(f.count(), 1);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    3,
  );
});
test("HAB attachment reads: current configured kind policy is rechecked for the saved message", (t) => {
  const f = setup(t),
    registry = f.open({ allowed_kinds: ["notice"] });
  registry.migrate();
  assert.throws(
    () => f.read(registry).read(f.contexts.b, f.request),
    code("forbidden"),
  );
  assert.deepEqual(
    f.read().read(f.contexts.b, f.request).data,
    payload.subarray(0, 4),
  );
});
