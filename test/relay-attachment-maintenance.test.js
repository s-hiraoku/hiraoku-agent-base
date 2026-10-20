import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { randomUUID } from "node:crypto";
import { fixture as habFixture } from "./hab-attachment-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { deletionPolicy } from "./relay-attachment-deletion-fixtures.js";
import { code } from "./relay-attachment-fixtures.js";
import { AttachmentMaintenanceCycle } from "../src/relay/attachment-maintenance.ts";
import { HabRelayService } from "../src/hab/relay.ts";
const policy = { relay_limit: 2, upload_limit: 2, deletion: deletionPolicy };
function fixture(t) {
  const f = habFixture(t, true, true),
    operator = Symbol("synthetic-operator");
  const state = { active: true, owner: "synthetic-operator" },
    calls = [];
  const auth = {
    authorize(ctx, op) {
      return ctx === operator && op === "maintenance" && state.active
        ? { agent_id: state.owner }
        : undefined;
    },
  };
  const relay = (patch = {}) => ({
    ...Object.fromEntries(
      [
        "maintain",
        "claimAttachmentDeletion",
        "withAttachmentDeletion",
        "completeAttachmentDeletion",
        "failAttachmentDeletion",
      ].map((k) => [
        k,
        (...args) => {
          calls.push(k);
          return f.relay[k](...args);
        },
      ]),
    ),
    ...patch,
  });
  const uploads = (patch = {}) => ({
    maintain(...args) {
      calls.push("uploads");
      return f.blob.maintain(...args);
    },
    deleteBound(...args) {
      calls.push("deleteBound");
      return f.blob.deleteBound(...args);
    },
    ...patch,
  });
  const cycle = (r = relay(), b = uploads(), a = auth, p = policy) =>
    new AttachmentMaintenanceCycle(r, b, p, a);
  const service = new HabRelayService(f.registry, f.relay, limits);
  const send = () => {
    const m = f.upload();
    f.api().submit(f.contexts.a, m);
    return m;
  };
  const ack = () => {
    const d = service.poll(f.contexts.b);
    service.ack(f.contexts.b, {
      sender_id: f.a.agent_id,
      message_id: d.message.message_id,
      generation: d.generation,
      lease_token: d.lease_token,
      request_id: randomUUID(),
    });
  };
  return {
    ...f,
    operator,
    state,
    calls,
    auth,
    relayPort: relay,
    uploadPort: uploads,
    cycle,
    service,
    send,
    ack,
  };
}
test("maintenance cycle: one server ACK deletion and bounded upload sweep in fixed order", (t) => {
  const f = fixture(t),
    m = f.send();
  f.ack();
  const result = f.cycle().workOnce(f.operator);
  assert.equal(result.state, "done");
  assert.equal(result.completed_stages, 3);
  assert.equal(result.deletion, "done");
  assert.deepEqual(f.calls, [
    "maintain",
    "claimAttachmentDeletion",
    "withAttachmentDeletion",
    "deleteBound",
    "completeAttachmentDeletion",
    "uploads",
  ]);
  assert.equal(
    f.raw
      .prepare("SELECT state FROM relay_messages WHERE message_id=?")
      .get(m.message_id).state,
    "acked",
  );
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.equal(f.cycle().workOnce(f.operator).deletion, "idle");
});
test("maintenance cycle: live unreceived attachment is retained by repeated empty sweeps", (t) => {
  const f = fixture(t);
  f.send();
  for (let n = 0; n < 3; n++)
    assert.equal(f.cycle().workOnce(f.operator).state, "done");
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    3,
  );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_attachment_deletions").get().n,
    0,
  );
});
test("maintenance cycle: caller labels, receive context and absent authority cannot start IO", (t) => {
  const f = fixture(t);
  for (const context of [
    undefined,
    "synthetic-operator",
    { agent_id: "synthetic-operator" },
    f.contexts.a,
  ])
    assert.throws(() => f.cycle().workOnce(context), code("forbidden"));
  assert.throws(
    () => f.cycle(undefined, undefined, null).workOnce(f.operator),
    code("forbidden"),
  );
  assert.equal(f.calls.length, 0);
});
test("maintenance cycle: async or throwing authority denies before any store call", async (t) => {
  const f = fixture(t);
  for (const authorize of [
    () => Promise.reject(Error("synthetic private")),
    () => {
      throw Error("synthetic private");
    },
  ])
    assert.throws(
      () => f.cycle(undefined, undefined, { authorize }).workOnce(f.operator),
      code("forbidden"),
    );
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.length, 0);
});
test("maintenance cycle: authority loss during Relay transaction rolls back maintenance totals", (t) => {
  const f = fixture(t);
  let checks = 0;
  const result = f
    .cycle(undefined, undefined, {
      authorize(ctx, op) {
        if (ctx !== f.operator || op !== "maintenance") return;
        return ++checks < 3 ? { agent_id: "synthetic-operator" } : undefined;
      },
    })
    .workOnce(f.operator);
  assert.equal(result.state, "partial");
  assert.equal(result.reason, "forbidden");
  assert.equal(result.completed_stages, 0);
  assert.deepEqual(f.calls, ["maintain"]);
  assert.equal(
    f.raw.prepare("SELECT last_at FROM relay_maintenance_totals").get().last_at,
    0,
  );
});
test("maintenance cycle: postcommit revocation reports partial completion and stops later stores", (t) => {
  const f = fixture(t);
  const result = f
    .cycle(
      f.relayPort({
        maintain(a, n) {
          const r = f.relay.maintain(a, n);
          f.state.active = false;
          return r;
        },
      }),
    )
    .workOnce(f.operator);
  assert.equal(result.state, "partial");
  assert.equal(result.completed_stages, 1);
  assert.equal(result.reason, "forbidden");
  assert.equal(result.uploads, null);
  assert.equal(f.calls.length, 0);
});
test("maintenance cycle: principal substitution cannot continue another operator's cycle", (t) => {
  const f = fixture(t);
  const result = f
    .cycle(
      f.relayPort({
        maintain(a, n) {
          const r = f.relay.maintain(a, n);
          f.state.owner = "other-operator";
          return r;
        },
      }),
    )
    .workOnce(f.operator);
  assert.equal(result.reason, "forbidden");
  assert.equal(result.completed_stages, 1);
});
test("maintenance cycle: deletion failure preserves bytes and skips later stages", (t) => {
  const f = fixture(t);
  f.send();
  f.ack();
  const result = f
    .cycle(
      undefined,
      f.uploadPort({
        deleteBound() {
          throw Error("synthetic private");
        },
      }),
    )
    .workOnce(f.operator);
  assert.equal(result.state, "partial");
  assert.equal(result.reason, "deletion_deferred");
  assert.equal(result.failed_stage, "deletion");
  assert.equal(result.uploads, null);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    3,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_attachment_deletions").get().state,
    "pending",
  );
});
test("maintenance cycle: uncertain store completion stays partial with no inferred rollback", (t) => {
  const f = fixture(t);
  const result = f
    .cycle(
      undefined,
      f.uploadPort({
        maintain(a, n) {
          f.blob.maintain(a, n);
          throw Error("synthetic private");
        },
      }),
    )
    .workOnce(f.operator);
  assert.equal(result.state, "partial");
  assert.equal(result.completed_stages, 2);
  assert.equal(result.failed_stage, "uploads");
  assert.equal(result.reason, "unavailable");
  assert.equal(JSON.stringify(result).includes("synthetic private"), false);
});
test("maintenance cycle: only one deletion per call even with multiple terminal messages", (t) => {
  const f = fixture(t);
  f.send();
  f.ack();
  f.send();
  f.ack();
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM relay_attachment_deletions WHERE state='pending'",
      )
      .get().n,
    2,
  );
  assert.equal(f.cycle().workOnce(f.operator).deletion, "done");
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM relay_attachment_deletions WHERE state='pending'",
      )
      .get().n,
    1,
  );
});
test("maintenance cycle: escaped store authorization expires when work returns", (t) => {
  const f = fixture(t);
  let escaped;
  assert.equal(
    f
      .cycle(
        undefined,
        f.uploadPort({
          maintain(a, n) {
            escaped = a;
            return f.blob.maintain(a, n);
          },
        }),
      )
      .workOnce(f.operator).state,
    "done",
  );
  assert.throws(() => escaped(), code("forbidden"));
});
test("maintenance cycle: asynchronous store or implausible counters fail closed", async (t) => {
  const f = fixture(t);
  for (const maintain of [
    () => Promise.resolve({}),
    () => ({ expired: 3, purged: 0, threads: 0, safety_held: 0 }),
  ]) {
    const result = f.cycle(f.relayPort({ maintain })).workOnce(f.operator);
    assert.equal(result.state, "partial");
    assert.equal(result.failed_stage, "relay");
    assert.equal(result.uploads, null);
  }
  await new Promise((r) => setImmediate(r));
});
test("maintenance cycle: reentry is refused without starting a second sweep", (t) => {
  const f = fixture(t);
  let cycle;
  cycle = f.cycle(
    f.relayPort({
      maintain(a, n) {
        assert.throws(
          () => cycle.workOnce(f.operator),
          code("maintenance_cycle_busy"),
        );
        return f.relay.maintain(a, n);
      },
    }),
  );
  assert.equal(cycle.workOnce(f.operator).state, "done");
});
test("maintenance cycle: invalid limits and deletion policy refuse before store access", (t) => {
  const f = fixture(t);
  for (const p of [
    { ...policy, relay_limit: 0 },
    { ...policy, upload_limit: 101 },
    { ...policy, deletion: { ...deletionPolicy, max_attempts: Infinity } },
  ])
    assert.throws(
      () => f.cycle(undefined, undefined, undefined, p),
      code("invalid_maintenance_cycle_options"),
    );
  assert.equal(f.calls.length, 0);
});
test("maintenance cycle: raw Relay maintenance rejects async authorization and rolls back", async (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.relay.maintain(() => Promise.reject(Error("synthetic private")), 1),
    code("forbidden"),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(
    f.raw.prepare("SELECT last_at FROM relay_maintenance_totals").get().last_at,
    0,
  );
});
test("maintenance cycle: original TTL collects both accepted and orphan finalized uploads", (t) => {
  const f = fixture(t),
    expiry = Date.now() + 1500;
  const input = (at) => ({
    first_sent_at: new Date(at - 3600000).toISOString(),
    expires_at: new Date(at).toISOString(),
  });
  const m = f.upload(input(expiry));
  f.api().submit(f.contexts.a, m);
  f.upload(input(expiry - 20));
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, expiry - Date.now() + 20),
  );
  const result = f.cycle().workOnce(f.operator);
  assert.equal(result.state, "done");
  assert.equal(result.relay.expired, 1);
  assert.equal(result.deletion, "done");
  assert.equal(result.uploads.expired, 1);
  assert.equal(
    f.blobRaw.prepare("SELECT count(*) n FROM attachment_chunks").get().n,
    0,
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "expired",
  );
});
