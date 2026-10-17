import test from "node:test";
import assert from "node:assert/strict";
import { HabRelayService } from "../src/hab/relay.ts";
import { fixture } from "./hab-attachment-fixtures.js";
import { code } from "./hab-registry-fixtures.js";
import { limits } from "./relay-http-fixtures.js";

test("HAB attachment acceptance: verified identity owns prepared refs and exact retry recovers one receipt", (t) => {
  const f = fixture(t),
    m = f.upload(),
    r = f.api().submit(f.contexts.a, m);
  assert.equal(r.sender_id, f.a.agent_id);
  assert.equal(r.recipient_id, f.b.agent_id);
  assert.equal(f.blob.binding(m.message_id, f.owner).state, "accepted");
  assert.deepEqual(f.api().submit(f.contexts.a, m), r);
  assert.deepEqual(f.api().status(f.contexts.a, m.message_id), r);
  assert.equal(f.count(), 1);
});
test("HAB attachment acceptance: management, claimed names and unbound contexts cannot create a reservation", (t) => {
  const f = fixture(t, false),
    m = f.upload();
  for (const ctx of [
    f.admin,
    null,
    {},
    { agent_id: f.a.agent_id },
    f.contexts.c,
  ])
    assert.throws(() => f.api().submit(ctx, m), code("forbidden"));
  assert.equal(f.count(), 0);
  assert.equal(f.pinCount(), 0);
});
test("HAB attachment acceptance: submit and status are separate current grants", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.change(f.a, "active", ["submit"]);
  const r = f.api().submit(f.contexts.a, m);
  assert.deepEqual(f.api().submit(f.contexts.a, m), r);
  assert.throws(
    () => f.api().status(f.contexts.a, m.message_id),
    code("forbidden"),
  );
  f.change(f.a, "active", ["status"]);
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  assert.deepEqual(f.api().status(f.contexts.a, m.message_id), r);
});
test("HAB attachment acceptance: another active individual cannot reuse owned refs or inspect foreign receipts", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.api().submit(f.contexts.a, m);
  assert.throws(
    () => f.api().submit(f.contexts.c, m),
    code("upload_not_found"),
  );
  for (const id of [m.message_id, "unknown-message"])
    assert.throws(() => f.api().status(f.contexts.c, id), code("not_found"));
  assert.equal(f.count(), 1);
  assert.equal(f.pinCount(), 1);
});
test("HAB attachment acceptance: stopped owner or recipient denies retry without dropping bytes or receipt", (t) => {
  const f = fixture(t),
    m = f.upload(),
    r = f.api().submit(f.contexts.a, m);
  for (const who of [f.a, f.b]) {
    f.change(who, "stopped");
    assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
    if (who === f.b)
      assert.deepEqual(f.api().status(f.contexts.a, m.message_id), r);
    else
      assert.throws(
        () => f.api().status(f.contexts.a, m.message_id),
        code("forbidden"),
      );
    f.change(who, "active");
    assert.deepEqual(f.api().submit(f.contexts.a, m), r);
  }
  assert.equal(f.count(), 1);
  assert.equal(f.blob.binding(m.message_id, f.owner).state, "accepted");
});
test("HAB attachment acceptance: directional block applies before prepare and to exact accepted retry", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.block(true, "block-before-prepare");
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  assert.equal(f.pinCount(), 0);
  f.block(false, "unblock-before-prepare");
  const r = f.api().submit(f.contexts.a, m);
  f.block(true, "block-after-accept");
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  f.block(false, "unblock-after-accept");
  assert.deepEqual(f.api().submit(f.contexts.a, m), r);
  assert.equal(f.count(), 1);
});
test("HAB attachment acceptance: an unconfigured kind cannot pin finalized bytes", (t) => {
  const f = fixture(t),
    m = f.upload();
  m.kind = "execute-shell";
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  assert.equal(f.count(), 0);
  assert.equal(f.pinCount(), 0);
});
test("HAB attachment acceptance: revoked connection cannot reconcile or inspect its retained acceptance", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.api().submit(f.contexts.a, m);
  f.registry.revoke(f.admin, {
    request_id: "revoke-attached-owner",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: f.a.epoch,
  });
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  assert.throws(
    () => f.api().status(f.contexts.a, m.message_id),
    code("forbidden"),
  );
  assert.equal(f.count(), 1);
  assert.equal(f.pinCount(), 1);
});
test("HAB attachment acceptance: missing or expired host identity denies both submission and status", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.api().submit(f.contexts.a, m);
  for (const stamp of [Date.now() - 1, Date.now() + 120000]) {
    f.mutable.expires_at = new Date(stamp).toISOString();
    assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
    assert.throws(
      () => f.api().status(f.contexts.a, m.message_id),
      code("forbidden"),
    );
  }
  f.mutable.expires_at = null;
  f.mutable.individual = false;
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
});
test("HAB attachment acceptance: emergency stop holds data and adds no poll, ACK, download or maintenance authority", (t) => {
  const f = fixture(t),
    m = f.upload(),
    api = f.api();
  api.submit(f.contexts.a, m);
  assert.equal(
    new HabRelayService(f.registry, f.relay, limits).poll(f.contexts.b),
    null,
  );
  for (const key of ["poll", "ack", "read", "maintain", "prepare", "confirm"])
    assert.equal(key in api, false);
  f.registry.emergencyStop(f.admin);
  assert.throws(() => api.submit(f.contexts.a, m), code("forbidden"));
  assert.throws(
    () => api.status(f.contexts.a, m.message_id),
    code("forbidden"),
  );
  assert.equal(f.count(), 1);
  assert.equal(f.pinCount(), 1);
});
test("HAB attachment acceptance: one registry guard spans prepare, actual Relay commit and receipt confirmation", (t) => {
  const f = fixture(t),
    m = f.upload(),
    other = f.open({ busy_timeout_ms: 1 });
  other.migrate();
  const revocation = {
    request_id: "competing-attachment-revoke",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: f.a.epoch,
  };
  const stages = [],
    attempt = (stage) => {
      stages.push(stage);
      assert.throws(
        () => other.revoke(f.admin, revocation),
        code("registry_unavailable"),
      );
    };
  const refs = f.bindingPort({
    prepare(...args) {
      attempt("prepare");
      return f.blob.prepare(...args);
    },
    confirm(...args) {
      attempt("confirm");
      return f.blob.confirm(...args);
    },
  });
  const relay = {
    status: f.relay.status.bind(f.relay),
    accept(resolve) {
      attempt("accept");
      return f.relay.accept(resolve);
    },
  };
  f.api(relay, refs).submit(f.contexts.a, m);
  assert.deepEqual(stages, ["prepare", "accept", "confirm"]);
  assert.equal(f.count(), 1);
  other.revoke(f.admin, revocation);
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
});
test("HAB attachment acceptance: captured prepare authorization and Relay resolver expire on scope exit", (t) => {
  const f = fixture(t),
    m = f.upload();
  let auth, resolve;
  const refs = f.bindingPort({
    prepare(message, limits, authorize) {
      auth = authorize;
      return f.blob.prepare(message, limits, authorize);
    },
  });
  const relay = {
    status: f.relay.status.bind(f.relay),
    accept(callback) {
      resolve = callback;
      return f.relay.accept(callback);
    },
  };
  f.api(relay, refs).submit(f.contexts.a, m);
  assert.throws(() => auth(), code("forbidden"));
  assert.throws(() => resolve(), code("forbidden"));
  assert.throws(
    () =>
      f.blob.confirm(
        m.message_id,
        f.api().status(f.contexts.a, m.message_id),
        auth,
      ),
    code("forbidden"),
  );
});
test("HAB attachment acceptance: context expiry after Relay commit retains pins and reconciles with fresh authority", (t) => {
  const f = fixture(t),
    m = f.upload();
  const expiry = Date.now() + 1500;
  f.mutable.expires_at = new Date(expiry).toISOString();
  const refs = f.bindingPort({
    confirm(...args) {
      // Scope keeps the original verified expiry; wait for that actual deadline, not a changed resolver.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(1, expiry - Date.now() + 20),
      );
      return f.blob.confirm(...args);
    },
  });
  assert.throws(
    () => f.api(f.relay, refs).submit(f.contexts.a, m),
    code("forbidden"),
  );
  assert.equal(f.count(), 1);
  assert.equal(f.blob.binding(m.message_id, f.owner).state, "prepared");
  f.mutable.expires_at = null;
  const original = f.api().status(f.contexts.a, m.message_id);
  assert.deepEqual(f.api().submit(f.contexts.a, m), original);
  assert.equal(f.blob.binding(m.message_id, f.owner).state, "accepted");
  assert.equal(f.count(), 1);
});
test("HAB attachment acceptance: Relay failure rolls back neither durable pins nor current-policy checks on recovery", (t) => {
  const f = fixture(t),
    m = f.upload();
  f.raw.exec(
    "CREATE TRIGGER fail_attached_accept BEFORE INSERT ON relay_messages BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END;",
  );
  assert.throws(
    () => f.api().submit(f.contexts.a, m),
    code("attachment_acceptance_failed"),
  );
  assert.equal(f.count(), 0);
  assert.equal(f.blob.binding(m.message_id, f.owner).state, "prepared");
  f.raw.exec("DROP TRIGGER fail_attached_accept");
  f.change(f.a, "stopped");
  assert.throws(() => f.api().submit(f.contexts.a, m), code("forbidden"));
  f.change(f.a, "active");
  assert.equal(f.api().submit(f.contexts.a, m).state, "pending");
  assert.equal(f.count(), 1);
});
