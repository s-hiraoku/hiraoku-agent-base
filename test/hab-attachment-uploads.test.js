import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HabAttachmentUploads } from "../src/hab/attachment-uploads.ts";
import { AttachmentUploadService } from "../src/relay/attachments.ts";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import {
  fixture as registryFixture,
  code,
  operations,
} from "./hab-registry-fixtures.js";
import { options, intent, payload } from "./relay-attachment-fixtures.js";

function fixture(t, enrollC = true) {
  const f = registryFixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  if (enrollC) f.enroll("c");
  const path = join(f.dir, "attachments.sqlite"),
    blob = new SQLiteAttachmentStore(path, options);
  blob.migrate();
  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    blob.close();
  });
  const api = new HabAttachmentUploads(f.registry, blob, options);
  const value = (patch = {}) =>
    intent(payload, { ...patch, recipient_id: b.agent_id });
  const change = (
    who,
    state,
    rights = state === "active" ? operations : [],
  ) => {
    const current = f.registry.inspect(f.admin, who.agent_id);
    return f.registry.setAccess(f.admin, {
      request_id: `access-${who.agent_id}-${current.epoch}`,
      agent_id: who.agent_id,
      expected_epoch: current.epoch,
      state,
      operations: rights,
    });
  };
  const calls = (id, original) => [
    () => api.begin(f.contexts.a, original),
    () => api.status(f.contexts.a, id),
    () => api.put(f.contexts.a, id, 0, payload.subarray(0, 4)),
    () => api.finalize(f.contexts.a, id),
    () => api.cancel(f.contexts.a, id),
  ];
  const port = (patch) => ({
    ...Object.fromEntries(
      ["begin", "status", "put", "finalize", "cancel", "maintain"].map(
        (name) => [name, blob[name].bind(blob)],
      ),
    ),
    ...patch,
  });
  return { ...f, a, b, api, blob, raw, value, change, calls, port };
}
test("HAB uploads: verified individual owns the manifest and the saved recipient/kind is checked on every stage", (t) => {
  const f = fixture(t),
    value = f.value(),
    first = f.api.begin(f.contexts.a, value),
    id = first.attachment_id;
  assert.equal(first.owner_id, f.a.agent_id);
  assert.equal(first.recipient_id, f.b.agent_id);
  for (let offset = 0; offset < payload.length; offset += 4)
    f.api.put(f.contexts.a, id, offset, payload.subarray(offset, offset + 4));
  assert.equal(f.api.finalize(f.contexts.a, id).state, "finalized");
  assert.equal(f.api.begin(f.contexts.a, value).attachment_id, id);
  assert.equal(f.api.cancel(f.contexts.a, id).state, "cancelled");
});
test("HAB uploads: management context, claimed names, unknown and unbound individual contexts do not self-enroll", (t) => {
  const f = fixture(t, false);
  for (const ctx of [
    f.admin,
    null,
    {},
    { agent_id: f.a.agent_id },
    f.contexts.c,
  ])
    assert.throws(() => f.api.begin(ctx, f.value()), code("forbidden"));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM attachment_uploads").get().n,
    0,
  );
});
test("HAB uploads: extra owner claims and arbitrary destinations are rejected rather than becoming authority", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.api.begin(f.contexts.a, { ...f.value(), owner_id: f.b.agent_id }),
    code("invalid_upload_request"),
  );
  assert.throws(
    () => f.api.begin(f.contexts.a, { ...f.value(), recipient_id: "unknown" }),
    code("forbidden"),
  );
  assert.throws(
    () =>
      f.api.begin(f.contexts.a, {
        ...f.value(),
        recipient_id: "https://invalid.example/",
      }),
    code("invalid_upload_request"),
  );
});
test("HAB uploads: another active individual cannot inspect, append, finalize or cancel an owned upload", (t) => {
  const f = fixture(t),
    id = f.api.begin(f.contexts.a, f.value()).attachment_id;
  for (const target of [id, "unknown-upload"])
    for (const operation of [
      () => f.api.status(f.contexts.b, target),
      () => f.api.put(f.contexts.b, target, 0, payload.subarray(0, 4)),
      () => f.api.finalize(f.contexts.b, target),
      () => f.api.cancel(f.contexts.b, target),
    ])
      assert.throws(operation, code("upload_not_found"));
});
test("HAB uploads: stopped owner loses all upload operations, including exact begin retry", (t) => {
  const f = fixture(t),
    value = f.value(),
    first = f.api.begin(f.contexts.a, value);
  f.change(f.a, "stopped");
  for (const call of f.calls(first.attachment_id, value))
    assert.throws(call, code("forbidden"));
  f.change(f.a, "active");
  assert.equal(f.api.status(f.contexts.a, first.attachment_id).next_offset, 0);
  assert.equal(
    f.api.begin(f.contexts.a, value).attachment_id,
    first.attachment_id,
  );
});
test("HAB uploads: stopped recipient denies further operations without deleting a partial upload", (t) => {
  const f = fixture(t),
    value = f.value(),
    first = f.api.begin(f.contexts.a, value);
  f.api.put(f.contexts.a, first.attachment_id, 0, payload.subarray(0, 4));
  f.change(f.b, "stopped");
  for (const call of f.calls(first.attachment_id, value))
    assert.throws(call, code("forbidden"));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    1,
  );
  f.change(f.b, "active");
  assert.equal(f.api.status(f.contexts.a, first.attachment_id).next_offset, 4);
});
test("HAB uploads: directional block denies saved-peer retries while another sender can still upload", (t) => {
  const f = fixture(t),
    value = f.value(),
    first = f.api.begin(f.contexts.a, value);
  const toggle = (blocked, request_id) => {
    const a = f.registry.inspect(f.admin, f.a.agent_id),
      b = f.registry.inspect(f.admin, f.b.agent_id);
    f.registry.setBlock(f.admin, {
      request_id,
      sender_id: a.agent_id,
      recipient_id: b.agent_id,
      sender_epoch: a.epoch,
      recipient_epoch: b.epoch,
      blocked,
    });
  };
  toggle(true, "block-uploads");
  for (const call of f.calls(first.attachment_id, value))
    assert.throws(call, code("forbidden"));
  assert.equal(f.api.begin(f.contexts.c, value).state, "uploading");
  toggle(false, "unblock-uploads");
  assert.equal(
    f.api.begin(f.contexts.a, value).attachment_id,
    first.attachment_id,
  );
});
test("HAB uploads: configured kind and current submit grant are mandatory; receipt rights alone do not grant upload", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.api.begin(f.contexts.a, f.value({ kind: "execute-shell" })),
    code("forbidden"),
  );
  const value = f.value(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  f.change(f.a, "active", ["status", "poll", "ack", "resolve"]);
  for (const call of f.calls(id, value)) assert.throws(call, code("forbidden"));
});
test("HAB uploads: revoked binding cannot operate on retained uploads or silently recover through the old connection", (t) => {
  const f = fixture(t),
    value = f.value(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  f.registry.revoke(f.admin, {
    request_id: "revoke-upload-owner",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: f.a.epoch,
  });
  for (const call of f.calls(id, value)) assert.throws(call, code("forbidden"));
  assert.equal(
    f.raw.prepare("SELECT state FROM attachment_uploads").get().state,
    "uploading",
  );
});
test("HAB uploads: expired, missing and overlong host identity attestations fail closed", (t) => {
  const f = fixture(t),
    value = f.value(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  for (const time of [Date.now() - 1, Date.now() + 120000]) {
    f.mutable.expires_at = new Date(time).toISOString();
    assert.throws(() => f.api.status(f.contexts.a, id), code("forbidden"));
  }
  f.mutable.expires_at = null;
  f.mutable.individual = false;
  assert.throws(() => f.api.status(f.contexts.a, id), code("forbidden"));
});
test("HAB uploads: emergency stop denies every stage and the ordinary upload port exposes no maintenance", (t) => {
  const f = fixture(t),
    value = f.value(),
    id = f.api.begin(f.contexts.a, value).attachment_id;
  f.registry.emergencyStop(f.admin);
  for (const call of f.calls(id, value)) assert.throws(call, code("forbidden"));
  assert.equal("maintain" in f.api, false);
  assert.equal("read" in f.api, false);
  assert.equal(
    f.raw.prepare("SELECT state FROM attachment_uploads").get().state,
    "uploading",
  );
});
test("HAB uploads: registry lock spans upload authorization and commit so a second connection cannot revoke in the gap", (t) => {
  const f = fixture(t),
    other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  const revocation = {
    request_id: "concurrent-revoke",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: f.a.epoch,
  };
  let tried = false;
  const store = f.port({
    begin(value, authorize) {
      return f.blob.begin(value, (peer) => {
        if (peer && !tried) {
          tried = true;
          assert.throws(
            () => other.revoke(f.admin, revocation),
            code("registry_unavailable"),
          );
        }
        return authorize(peer);
      });
    },
  });
  const api = new HabAttachmentUploads(f.registry, store, options),
    receipt = api.begin(f.contexts.a, f.value());
  assert.equal(tried, true);
  assert.equal(receipt.state, "uploading");
  other.revoke(f.admin, revocation);
  assert.throws(
    () =>
      api.put(f.contexts.a, receipt.attachment_id, 0, payload.subarray(0, 4)),
    code("forbidden"),
  );
});
test("HAB uploads: captured authorization cannot escape its registry scope to write a later chunk", (t) => {
  const f = fixture(t);
  let captured;
  const store = f.port({
    begin(value, authorize) {
      captured = authorize;
      return f.blob.begin(value, authorize);
    },
  });
  const api = new HabAttachmentUploads(f.registry, store, options),
    receipt = api.begin(f.contexts.a, f.value());
  assert.throws(() => captured(), code("forbidden"));
  assert.throws(
    () =>
      f.blob.put(receipt.attachment_id, 0, payload.subarray(0, 4), captured),
    code("forbidden"),
  );
  assert.equal(
    f.api.status(f.contexts.a, receipt.attachment_id).next_offset,
    0,
  );
});
test("upload commit guard: a decision revoked during an operation rolls back its manifest before COMMIT", (t) => {
  const f = fixture(t);
  let active = true;
  const service = new AttachmentUploadService(f.blob, options, {
    authorize(context, op, peer) {
      if (!active) return undefined;
      if (peer) active = false;
      return { agent_id: f.a.agent_id };
    },
  });
  assert.throws(
    () => service.begin(f.contexts.a, f.value()),
    code("forbidden"),
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM attachment_uploads").get().n,
    0,
  );
  assert.equal(f.api.begin(f.contexts.a, f.value()).state, "uploading");
});
