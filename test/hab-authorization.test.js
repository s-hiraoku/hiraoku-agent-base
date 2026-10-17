import assert from "node:assert/strict";
import { test } from "node:test";
import { HabRelayService } from "../src/hab/relay.ts";
import { RelayService } from "../src/relay/service.ts";
import {
  fixture,
  options,
  principal,
  operations,
  code,
} from "./hab-registry-fixtures.js";
import { limits, message } from "./relay-http-fixtures.js";
function submission(to, entropy = "1".repeat(32)) {
  return { ...message(entropy), recipient_id: to.agent_id };
}
function ack(delivery, requestId = "stable-ack") {
  return {
    sender_id: delivery.message.sender_id,
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: requestId,
  };
}
function access(
  f,
  agent,
  state,
  rights = [],
  requestId = `access-${state}-${agent.epoch}`,
) {
  return f.registry.setAccess(f.admin, {
    request_id: requestId,
    agent_id: agent.agent_id,
    expected_epoch: agent.epoch,
    state,
    operations: rights,
  });
}
function block(f, a, b, blocked, requestId = "block") {
  return f.registry.setBlock(f.admin, {
    request_id: requestId,
    sender_id: a.agent_id,
    recipient_id: b.agent_id,
    sender_epoch: a.epoch,
    recipient_epoch: b.epoch,
    blocked,
  });
}

test("registered active individuals resolve and communicate without per-pair allowlists", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    c = f.enroll("c");
  const resolved = f.hab.resolve(f.contexts.a, b.address);
  assert.deepEqual(resolved, {
    recipient_id: b.agent_id,
    address: b.address,
    normalization_version: 1,
  });
  const m = submission(b),
    receipt = f.hab.submit(f.contexts.a, m);
  assert.equal(receipt.sender_id, a.agent_id);
  assert.deepEqual(f.hab.submit(f.contexts.a, m), receipt);
  assert.equal(f.hab.poll(f.contexts.c), null);
  assert.throws(
    () => f.hab.status(f.contexts.c, m.message_id),
    code("not_found"),
  );
  const d = f.hab.poll(f.contexts.b);
  assert.equal(d.message.sender_id, a.agent_id);
  assert.throws(() => f.hab.ack(f.contexts.c, ack(d)), code("invalid_ack"));
  const confirmed = f.hab.ack(f.contexts.b, ack(d));
  assert.deepEqual(f.hab.ack(f.contexts.b, ack(d)), confirmed);
  assert.equal(f.hab.status(f.contexts.a, m.message_id).state, "acked");
  assert.notEqual(c.agent_id, b.agent_id);
});

test("unknown, unbound, inactive and expired contexts cannot resolve, submit, poll, ACK or status", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    m = submission(b);
  for (const ctx of [
    null,
    "a",
    a.agent_id,
    { agent_id: a.agent_id },
    f.contexts.c,
    f.admin,
  ]) {
    assert.throws(() => f.hab.submit(ctx, m), code("forbidden"));
    assert.throws(() => f.hab.status(ctx, m.message_id), code("forbidden"));
    assert.throws(() => f.hab.poll(ctx), code("forbidden"));
    assert.throws(() => f.hab.ack(ctx, {}), code("forbidden"));
    assert.throws(() => f.hab.resolve(ctx, b.address), code("forbidden"));
  }
  for (const expiresAt of [
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + options.max_context_ms + 10000).toISOString(),
    "bad",
    "2026-02-30T00:00:00.000Z",
  ]) {
    f.mutable.expires_at = expiresAt;
    assert.throws(() => f.hab.submit(f.contexts.a, m), code("forbidden"));
  }
  f.mutable.expires_at = null;
  f.mutable.individual = false;
  assert.throws(() => f.hab.submit(f.contexts.a, m), code("forbidden"));
  assert.equal(f.count(), 0);
});

test("individual proof includes issuer/audience/subject/client/connection; a shared owner never chooses a mailbox", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  for (const patch of [
    { issuer: "https://other.example/" },
    { audience: "other" },
    { subject: "other" },
    { client_id: "other" },
    { connection_id: "unknown" },
  ]) {
    const other = f.open(
      {},
      {
        ...f.authority,
        individual: () => ({
          principal: principal("a", patch),
          expires_at: new Date(Date.now() + 30000).toISOString(),
        }),
      },
    );
    other.migrate();
    assert.throws(
      () =>
        new HabRelayService(other, f.store, limits).submit(
          f.contexts.a,
          submission(b),
        ),
      code("forbidden"),
    );
  }
  assert.throws(
    () =>
      f.hab.submit(f.contexts.a, { ...submission(b), sender_id: b.agent_id }),
    code("invalid_contract"),
  );
  assert.equal(f.hab.submit(f.contexts.a, submission(b)).sender_id, a.agent_id);
});

test("operation grants and unknown kinds are checked independently of a valid binding", (t) => {
  const f = fixture(t);
  let a = f.enroll("a");
  const b = f.enroll("b");
  a = access(f, a, "active", ["status"]);
  assert.throws(
    () => f.hab.submit(f.contexts.a, submission(b)),
    code("forbidden"),
  );
  assert.throws(
    () => f.hab.resolve(f.contexts.a, b.address),
    code("forbidden"),
  );
  assert.throws(() => f.hab.poll(f.contexts.a), code("forbidden"));
  a = access(f, a, "active", ["resolve"]);
  assert.throws(
    () => f.hab.resolve(f.contexts.a, b.address),
    code("forbidden"),
  );
  a = access(f, a, "active", operations);
  assert.throws(
    () =>
      f.hab.submit(f.contexts.a, { ...submission(b), kind: "unapproved-kind" }),
    code("forbidden"),
  );
  assert.equal(f.count(), 0);
  assert.equal(a.operations.length, operations.length);
});

test("resolve hides unknown, stopped, retired and blocked destinations with the same refusal", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    c = f.enroll("c");
  access(f, b, "stopped");
  access(f, c, "retired");
  for (const address of ["unknown@grok-bot.hab", b.address, c.address])
    assert.throws(
      () => f.hab.resolve(f.contexts.a, address),
      code("forbidden"),
    );
  assert.throws(
    () => f.hab.resolve(f.contexts.a, "B@grok-bot.hab"),
    code("invalid_registry_request"),
  );
  const activeB = access(
    f,
    f.registry.inspect(f.admin, b.agent_id),
    "active",
    operations,
  );
  block(f, a, activeB, true);
  assert.throws(
    () => f.hab.resolve(f.contexts.a, b.address),
    code("forbidden"),
  );
});

test("stopped destination rejects duplicate submit while sender can inspect its own stored acceptance", (t) => {
  const f = fixture(t);
  f.enroll("a");
  const b = f.enroll("b"),
    m = submission(b);
  const receipt = f.hab.submit(f.contexts.a, m);
  access(f, b, "stopped");
  assert.throws(() => f.hab.submit(f.contexts.a, m), code("forbidden"));
  assert.deepEqual(f.hab.status(f.contexts.a, m.message_id), receipt);
  assert.equal(f.count(), 1);
  assert.notEqual(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
});

test("directional blocks affect submit, pending delivery and exact ACK retry without deleting saved delivery", (t) => {
  const f = fixture(t);
  let a = f.enroll("a"),
    b = f.enroll("b");
  const m = submission(b),
    accepted = f.hab.submit(f.contexts.a, m);
  block(f, a, b, true);
  assert.throws(() => f.hab.submit(f.contexts.a, m), code("forbidden"));
  assert.equal(f.hab.poll(f.contexts.b), null);
  assert.equal(f.hab.status(f.contexts.a, m.message_id).state, "pending");
  const reverse = submission(a, "2".repeat(32));
  assert.equal(f.hab.submit(f.contexts.b, reverse).recipient_id, a.agent_id);
  a = f.registry.inspect(f.admin, a.agent_id);
  b = f.registry.inspect(f.admin, b.agent_id);
  block(f, a, b, false, "unblock");
  const d = f.hab.poll(f.contexts.b),
    request = ack(d),
    confirmed = f.hab.ack(f.contexts.b, request);
  assert.equal(confirmed.state, "acked");
  a = f.registry.inspect(f.admin, a.agent_id);
  b = f.registry.inspect(f.admin, b.agent_id);
  block(f, a, b, true, "block-again");
  assert.throws(() => f.hab.ack(f.contexts.b, request), code("forbidden"));
  assert.equal(accepted.recipient_id, b.agent_id);
});

test("revocation immediately denies retained contexts and exact ACK/receipt retry; fresh binding requires activation", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    m = submission(b);
  f.hab.submit(f.contexts.a, m);
  const d = f.hab.poll(f.contexts.b),
    request = ack(d);
  f.hab.ack(f.contexts.b, request);
  f.registry.revoke(f.admin, {
    request_id: "revoke-b",
    binding_id: f.bindings.get("b").binding_id,
    expected_epoch: b.epoch,
  });
  assert.throws(() => f.hab.ack(f.contexts.b, request), code("forbidden"));
  assert.throws(() => f.hab.poll(f.contexts.b), code("forbidden"));
  access(f, a, "stopped");
  assert.throws(
    () => f.hab.status(f.contexts.a, m.message_id),
    code("forbidden"),
  );
});

test("scoped authorization cannot escape its transaction, change operation/context or authorize maintenance", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  let saved;
  f.registry.withRelay(f.contexts.a, "submit", (authorization) => {
    saved = authorization;
    assert.deepEqual(
      authorization.authorize(f.contexts.a, "submit", b.agent_id, "question"),
      { agent_id: a.agent_id },
    );
    assert.equal(
      authorization.authorize(f.contexts.b, "submit", b.agent_id, "question"),
      undefined,
    );
    assert.equal(authorization.authorize(f.contexts.a, "poll"), undefined);
    assert.equal(
      authorization.authorize(f.contexts.a, "maintenance"),
      undefined,
    );
    assert.throws(
      () => f.registry.inspect(f.admin, a.agent_id),
      code("registry_busy"),
    );
  });
  assert.equal(
    saved.authorize(f.contexts.a, "submit", b.agent_id, "question"),
    undefined,
  );
  const escaped = new RelayService(f.store, limits, saved);
  assert.throws(
    () => escaped.submit(f.contexts.a, submission(b)),
    code("forbidden"),
  );
  assert.throws(
    () => f.registry.withRelay(f.contexts.a, "submit", () => Promise.resolve()),
    code("async_registry_boundary"),
  );
});

test("registry write guard spans Relay commit so another connection cannot revoke in the authorization gap", (t) => {
  const f = fixture(t);
  f.enroll("a");
  const b = f.enroll("b"),
    second = f.open({ busy_timeout_ms: 1 });
  second.migrate();
  const stop = {
    request_id: "concurrent-stop",
    agent_id: b.agent_id,
    expected_epoch: b.epoch,
    state: "stopped",
    operations: [],
  };
  let checked = false;
  const composed = new HabRelayService(
    f.registry,
    {
      accept(resolve) {
        return f.store.accept(() => {
          const result = resolve();
          assert.throws(
            () => second.setAccess(f.admin, stop),
            code("registry_unavailable"),
          );
          checked = true;
          return result;
        });
      },
      status(resolve) {
        return f.store.status(resolve);
      },
    },
    limits,
  );
  const m = submission(b);
  composed.submit(f.contexts.a, m);
  assert.equal(checked, true);
  second.setAccess(f.admin, stop);
  assert.throws(() => f.hab.submit(f.contexts.a, m), code("forbidden"));
  assert.equal(f.count(), 1);
});

test("emergency stop is durable, idempotent and independent of full or failing append-only audit/ledger", (t) => {
  const f = fixture(t);
  f.enroll("a");
  const b = f.enroll("b");
  const capped = f.open({ max_requests: 1, max_audit_records: 1 });
  capped.migrate();
  f.registryRaw.exec(
    "CREATE TRIGGER failed_audit BEFORE INSERT ON hab_registry_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  assert.throws(
    () => capped.emergencyStop(f.contexts.a),
    code("registry_forbidden"),
  );
  const stopped = capped.emergencyStop(f.admin);
  assert.deepEqual(capped.emergencyStop(f.admin), stopped);
  assert.throws(() =>
    f.registryRaw.exec("UPDATE hab_registry_stop SET stopped=0"),
  );
  assert.throws(
    () => f.hab.submit(f.contexts.a, submission(b)),
    code("forbidden"),
  );
  const reopened = f.open();
  reopened.migrate();
  assert.throws(
    () => new HabRelayService(reopened, f.store, limits).poll(f.contexts.a),
    code("forbidden"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_registry_stop").get().n,
    1,
  );
});

test("missing authoritative stop state fails closed and never initializes an unlocked replacement", (t) => {
  const f = fixture(t);
  f.enroll("a");
  const b = f.enroll("b");
  f.registryRaw.exec("DELETE FROM hab_registry_stop");
  assert.throws(
    () => f.hab.submit(f.contexts.a, submission(b)),
    code("forbidden"),
  );
  assert.throws(
    () => f.registry.emergencyStop(f.admin),
    code("registry_unavailable"),
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_registry_stop").get().n,
    0,
  );
  assert.equal(f.count(), 0);
  const reopened = f.open();
  assert.throws(() => reopened.migrate(), code("registry_unavailable"));
});

test("explicit overlapping binding rotation revokes only the old verified connection without stopping the individual", (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    rotated = principal("a", { connection_id: "verified-a-rotated" });
  const added = f.registry.bind(f.admin, {
    request_id: "overlap-new",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    principal: rotated,
  });
  f.registry.revoke(f.admin, {
    request_id: "overlap-revoke-old",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: added.agent_epoch,
  });
  assert.equal(f.registry.inspect(f.admin, a.agent_id).state, "active");
  assert.throws(() => f.hab.poll(f.contexts.a), code("forbidden"));
  const current = f.open(
    {},
    {
      ...f.authority,
      individual: () => ({
        principal: rotated,
        expires_at: new Date(Date.now() + 30000).toISOString(),
      }),
    },
  );
  current.migrate();
  assert.equal(
    new HabRelayService(current, f.store, limits).poll(f.contexts.a),
    null,
  );
});
