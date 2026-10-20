import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fixture as registryFixture } from "./hab-registry-fixtures.js";
import {
  options as uploadOptions,
  intent,
} from "./relay-attachment-fixtures.js";
import { HabAttachmentUploads } from "../src/hab/attachment-uploads.ts";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SQLiteAttachmentStore } from "../src/relay/sqlite-attachment-store.ts";
import {
  fixture,
  payload,
  limits,
} from "./relay-attachment-capacity-fixtures.js";
import { code } from "./relay-attachment-fixtures.js";
const empty = new Uint8Array();

test("blob capacity: other senders cannot use the protected owner's open slots", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.start("a");
  assert.throws(() => f.start("c"), code("upload_capacity_exceeded"));
  f.start("b");
  f.start("b");
  assert.equal(f.usage("a").open_uploads, 4);
  assert.equal(f.usage("b").open_uploads, 2);
});
test("blob capacity: full declared bytes are reserved before the first chunk", (t) => {
  const f = fixture(t);
  f.start("a", new Uint8Array(40));
  assert.equal(f.count("attachment_chunks"), 0);
  assert.throws(
    () => f.start("c", new Uint8Array(1)),
    code("upload_capacity_exceeded"),
  );
  f.start("b", new Uint8Array(20));
  assert.equal(f.usage("b").live_bytes, 20);
});
test("blob capacity: chunks and finalize do not release or double-charge live reservations", (t) => {
  const f = fixture(t, { max_open_per_owner: 1 }, { reservations: [] });
  const u = f.start();
  f.api.put(f.contexts.a, u.receipt.attachment_id, 0, payload.subarray(0, 4));
  assert.deepEqual(f.usage("a"), {
    records: 1,
    open_uploads: 1,
    live_bytes: 10,
    bindings: 0,
  });
  f.finish("a", u);
  assert.throws(() => f.start(), code("upload_capacity_exceeded"));
  f.api.cancel(f.contexts.a, u.receipt.attachment_id);
  assert.deepEqual(f.usage("a"), {
    records: 1,
    open_uploads: 0,
    live_bytes: 0,
    bindings: 0,
  });
  f.start();
});
test("blob capacity: cancelled and rejected records cannot consume protected metadata floors", (t) => {
  const f = fixture(
    t,
    { max_records: 4 },
    {
      reservations: [
        {
          owner_id: "b",
          open_uploads: 1,
          live_bytes: 0,
          records: 2,
          bindings: 0,
        },
      ],
    },
  );
  const one = f.start("a");
  f.api.cancel(f.contexts.a, one.receipt.attachment_id);
  const two = f.start("a", empty, {
    attachment: {
      media_type: "application/octet-stream",
      size_bytes: 0,
      sha256: "0".repeat(64),
    },
  });
  assert.equal(f.finish("a", two).state, "rejected");
  assert.throws(() => f.start("c", empty), code("upload_capacity_exceeded"));
  f.start("b", empty);
  f.start("b", empty);
  assert.equal(f.usage("b").records, 2);
});
test("blob capacity: per-owner retained-record ceiling applies even to empty cancelled files", (t) => {
  const f = fixture(t, {}, { max_records_per_owner: 2, reservations: [] });
  for (let i = 0; i < 2; i++) {
    const u = f.start("a", empty);
    f.api.cancel(f.contexts.a, u.receipt.attachment_id);
  }
  assert.throws(() => f.start("a", empty), code("upload_capacity_exceeded"));
  f.start("b", empty);
});
test("blob capacity: binding reservations protect their separate retained table", (t) => {
  const f = fixture(
    t,
    { max_records: 4 },
    {
      reservations: [
        {
          owner_id: "b",
          open_uploads: 0,
          live_bytes: 0,
          records: 1,
          bindings: 2,
        },
      ],
    },
  );
  const a = [f.start("a", empty), f.start("a", empty), f.start("a", empty)],
    b = f.start("b", empty);
  for (const u of a) f.finish("a", u);
  f.finish("b", b);
  f.bind("a", a[0]);
  f.bind("a", a[1]);
  assert.throws(() => f.bind("a", a[2]), code("upload_capacity_exceeded"));
  assert.equal(f.bind("b", b).owner_id, "b");
  assert.equal(f.usage("a").bindings, 2);
  assert.equal(f.usage("b").bindings, 1);
});
test("blob capacity: bound physical deletion frees live bytes but keeps both metadata quotas", (t) => {
  const f = fixture(
    t,
    {},
    { max_records_per_owner: 2, max_bindings_per_owner: 1, reservations: [] },
  );
  const one = f.start();
  f.finish("a", one);
  f.bind("a", one);
  const two = f.start();
  f.finish("a", two);
  assert.throws(() => f.bind("a", two), code("upload_capacity_exceeded"));
  assert.deepEqual(f.remove("a", one), { deleted: 1 });
  assert.deepEqual(f.usage("a"), {
    records: 2,
    open_uploads: 1,
    live_bytes: 10,
    bindings: 1,
  });
  assert.throws(() => f.start("a", empty), code("upload_capacity_exceeded"));
  assert.throws(() => f.bind("a", two), code("upload_capacity_exceeded"));
  assert.equal(f.bind("a", one).receipt.state, "acked");
});
test("blob capacity: multiple attachment refs consume one binding and one reservation per upload", (t) => {
  const f = fixture(t, {}, { max_bindings_per_owner: 1, reservations: [] });
  const one = f.start(),
    two = f.start("a", payload, {
      message_id: one.value.message_id,
      first_sent_at: one.value.first_sent_at,
      expires_at: one.value.expires_at,
    });
  f.finish("a", one);
  f.finish("a", two);
  const m = f.message(one);
  m.body.parts.push(f.message(two).body.parts[0]);
  f.store.prepare(m, limits, f.authorize("a"));
  assert.equal(f.usage("a").bindings, 1);
  assert.equal(f.usage("a").open_uploads, 2);
  assert.equal(f.count("attachment_refs"), 2);
});
test("blob capacity: exact begin replay and conflict precede admission at full capacity", (t) => {
  const f = fixture(t, {}, { max_records_per_owner: 1, reservations: [] });
  const u = f.start();
  assert.deepEqual(f.api.begin(f.contexts.a, u.value), u.receipt);
  assert.throws(() => f.start(), code("upload_capacity_exceeded"));
  const changed = structuredClone(u.value);
  changed.attachment.filename = "other.bin";
  assert.throws(
    () => f.api.begin(f.contexts.a, changed),
    code("upload_idempotency_conflict"),
  );
  f.api.cancel(f.contexts.a, u.receipt.attachment_id);
  assert.equal(f.api.begin(f.contexts.a, u.value).state, "cancelled");
  assert.equal(f.usage("a").records, 1);
});
test("blob capacity: existing binding replay and conflict precede a full owner quota", (t) => {
  const f = fixture(t, {}, { max_bindings_per_owner: 1, reservations: [] });
  const u = f.start();
  f.finish("a", u);
  const receipt = f.bind("a", u);
  assert.deepEqual(f.bind("a", u), receipt);
  const changed = f.message(u);
  changed.thread_id = "changed";
  assert.throws(
    () => f.store.prepare(changed, limits, f.authorize("a")),
    code("attachment_binding_conflict"),
  );
});
test("blob capacity: policy is copied and smaller reopen limits preserve progress and receipts", (t) => {
  const f = fixture(t);
  const one = f.start();
  f.options.owner_capacity.max_records_per_owner = 1;
  f.options.owner_capacity.reservations[0].records = 0;
  const two = f.start();
  const store = f.open({
    owner_capacity: {
      max_records_per_owner: 1,
      max_bindings_per_owner: 1,
      reservations: [],
    },
  });
  store.migrate();
  const api = f.service(store);
  assert.equal(
    api.begin(f.contexts.a, one.value).attachment_id,
    one.receipt.attachment_id,
  );
  f.finish("a", one, api);
  f.finish("a", two, api);
  assert.equal(
    api.status(f.contexts.a, two.receipt.attachment_id).state,
    "finalized",
  );
  assert.throws(
    () => f.start("a", empty, {}, api),
    code("upload_capacity_exceeded"),
  );
  f.bind("a", one, store);
  assert.deepEqual(f.bind("a", one, store).attachment_ids, [
    one.receipt.attachment_id,
  ]);
  assert.throws(
    () => f.bind("a", two, store),
    code("upload_capacity_exceeded"),
  );
});
test("blob capacity: absent policy keeps prior global and owner limits without reservations", (t) => {
  const f = fixture(t, { owner_capacity: undefined });
  for (let i = 0; i < 6; i++) f.start("a");
  assert.throws(() => f.start("b"), code("upload_capacity_exceeded"));
  assert.equal(f.usage("a").open_uploads, 6);
});
test("blob capacity: invalid policy fails before creating any database", (t) => {
  const f = fixture(t),
    p = f.options.owner_capacity;
  for (const [i, policy] of [
    null,
    { ...p, max_records_per_owner: 0 },
    { ...p, max_bindings_per_owner: 9 },
    { ...p, reservations: [p.reservations[0], p.reservations[0]] },
    {
      ...p,
      reservations: [
        {
          owner_id: "b\n",
          open_uploads: 1,
          live_bytes: 0,
          records: 1,
          bindings: 0,
        },
      ],
    },
    {
      ...p,
      reservations: [
        {
          owner_id: "b",
          open_uploads: 2,
          live_bytes: 0,
          records: 1,
          bindings: 0,
        },
      ],
    },
    {
      ...p,
      reservations: [
        {
          owner_id: "b",
          open_uploads: 1,
          live_bytes: -1,
          records: 1,
          bindings: 0,
        },
      ],
    },
    {
      ...p,
      reservations: [
        {
          owner_id: "b",
          open_uploads: 1,
          live_bytes: 0,
          records: 1,
          bindings: 9,
        },
      ],
    },
    {
      ...p,
      reservations: ["b", "c"].map((owner_id) => ({
        owner_id,
        open_uploads: 4,
        live_bytes: 40,
        records: 4,
        bindings: 4,
      })),
    },
    {
      ...p,
      reservations: Array.from({ length: 257 }, (_, n) => ({
        owner_id: "a" + n,
        open_uploads: 0,
        live_bytes: 0,
        records: 0,
        bindings: 0,
      })),
    },
  ].entries()) {
    const path = join(f.dir, "invalid-" + i + ".sqlite");
    assert.throws(
      () =>
        new SQLiteAttachmentStore(path, {
          ...f.options,
          owner_capacity: policy,
        }),
      code("invalid_attachment_capacity_policy"),
    );
    assert.equal(existsSync(path), false);
  }
});
test("blob capacity: reservation names cannot authenticate, impersonate or bypass current revocation", (t) => {
  const f = fixture(t),
    v = f.value();
  assert.throws(() => f.api.begin({ agent_id: "b" }, v), code("forbidden"));
  assert.throws(
    () => f.api.begin(f.contexts.a, { ...v, owner_id: "b" }),
    code("invalid_upload_request"),
  );
  const u = f.start("b");
  assert.throws(
    () => f.api.status(f.contexts.a, u.receipt.attachment_id),
    code("upload_not_found"),
  );
  f.mutable.active = false;
  assert.throws(() => f.api.begin(f.contexts.b, u.value), code("forbidden"));
  assert.throws(() => f.start("b"), code("forbidden"));
});
test("blob capacity: failed upload insert rolls back the last available allowance", (t) => {
  const f = fixture(t, {}, { max_records_per_owner: 1, reservations: [] });
  f.raw.exec(
    "CREATE TRIGGER fail_capacity_upload BEFORE INSERT ON attachment_uploads BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  assert.throws(() => f.start(), code("attachment_store_unavailable"));
  assert.equal(f.usage("a").records, 0);
  f.raw.exec("DROP TRIGGER fail_capacity_upload");
  f.start();
});
test("blob capacity: failed reference insert rolls back binding quota without discarding the upload", (t) => {
  const f = fixture(t, {}, { max_bindings_per_owner: 1, reservations: [] });
  const u = f.start();
  f.finish("a", u);
  f.raw.exec(
    "CREATE TRIGGER fail_capacity_ref BEFORE INSERT ON attachment_refs BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  assert.throws(() => f.bind("a", u), code("attachment_store_unavailable"));
  assert.equal(f.usage("a").bindings, 0);
  assert.equal(f.usage("a").records, 1);
  f.raw.exec("DROP TRIGGER fail_capacity_ref");
  f.bind("a", u);
});
test("blob capacity: a changed verified owner before commit rolls back admission", (t) => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(
    () => f.store.begin(f.value(), () => (++calls === 1 ? "a" : "b")),
    code("forbidden"),
  );
  assert.equal(f.usage("a").records, 0);
});
test("blob capacity: expiry frees open and byte budgets but retains original receipt records", (t) => {
  const f = fixture(
    t,
    { upload_ttl_ms: 500, max_open_per_owner: 1 },
    { reservations: [] },
  );
  const u = f.start();
  assert.throws(() => f.start(), code("upload_capacity_exceeded"));
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, Date.parse(u.receipt.upload_expires_at) - Date.now() + 20),
  );
  assert.equal(f.api.maintain(f.contexts.admin, 10).expired, 1);
  assert.deepEqual(f.usage("a"), {
    records: 1,
    open_uploads: 0,
    live_bytes: 0,
    bindings: 0,
  });
  f.start();
  assert.equal(f.api.begin(f.contexts.a, u.value).state, "expired");
});
test("blob capacity: prepared uploads stay charged until their binding deadline or terminal deletion", (t) => {
  const f = fixture(
    t,
    { upload_ttl_ms: 1000, max_open_per_owner: 1 },
    { reservations: [] },
  );
  const u = f.start();
  f.finish("a", u);
  f.bind("a", u);
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, Date.parse(u.receipt.upload_expires_at) - Date.now() + 20),
  );
  assert.equal(f.api.maintain(f.contexts.admin, 10).expired, 0);
  assert.throws(() => f.start(), code("upload_capacity_exceeded"));
  assert.throws(
    () => f.api.cancel(f.contexts.a, u.receipt.attachment_id),
    code("upload_bound"),
  );
  f.remove("a", u);
  f.start();
});

async function competing(t, f, tasks) {
  const source = new URL(
    "../src/relay/sqlite-attachment-store.ts",
    import.meta.url,
  ).href;
  const runs = tasks.map((task) => {
    let ready, result;
    const imported = new Promise((resolve) => {
      ready = resolve;
    });
    const completed = new Promise((resolve, reject) => {
      result = resolve;
      const w = new Worker(
        `
        const { parentPort, workerData: d } = require("node:worker_threads");
        import(d.source).then(({ SQLiteAttachmentStore }) => {
          const store = new SQLiteAttachmentStore(d.path, d.options); store.migrate();
          parentPort.once("message", () => {
            try {
              const receipt = d.task.op === "begin"
                ? store.begin(d.task.value, () => d.task.owner)
                : store.prepare(d.task.value, d.limits, () => d.task.owner);
              parentPort.postMessage({ state: "ok", owner: receipt.owner_id });
            } catch (e) { parentPort.postMessage({ state: "failed", code: e.code ?? "unknown" }); }
            finally { store.close(); }
          });
          parentPort.postMessage({ state: "ready" });
        }).catch(e => parentPort.postMessage({ state: "failed", code: e.code ?? "unknown" }));
      `,
        {
          eval: true,
          workerData: {
            source,
            path: f.path,
            options: f.options,
            task,
            limits,
          },
        },
      );
      t.after(() => w.terminate());
      w.on("message", (m) => {
        ready(w);
        if (m.state !== "ready") result(m);
      });
      w.once("error", (e) => {
        ready();
        reject(e);
      });
    });
    return { imported, completed };
  });
  const workers = await Promise.all(runs.map((r) => r.imported));
  for (const w of workers) w?.postMessage("run");
  return Promise.all(runs.map((r) => r.completed));
}
test("blob capacity: competing native owners cannot spend the same last unreserved upload slot", async (t) => {
  const f = fixture(
    t,
    { max_open_uploads: 2 },
    {
      reservations: [
        {
          owner_id: "b",
          open_uploads: 1,
          live_bytes: 10,
          records: 1,
          bindings: 0,
        },
      ],
    },
  );
  const results = await competing(
    t,
    f,
    ["a", "c"].map((owner) => ({ op: "begin", owner, value: f.value() })),
  );
  assert.equal(
    results.filter((r) => r.state === "ok").length,
    1,
    JSON.stringify(results),
  );
  assert.equal(
    results.filter((r) => r.code === "upload_capacity_exceeded").length,
    1,
    JSON.stringify(results),
  );
  f.start("b");
  assert.equal(f.count("attachment_uploads"), 2);
});
test("blob capacity: competing native prepares cannot overspend one owner's last binding slot", async (t) => {
  const f = fixture(t, {}, { max_bindings_per_owner: 1, reservations: [] });
  const a = f.start(),
    b = f.start();
  f.finish("a", a);
  f.finish("a", b);
  const results = await competing(
    t,
    f,
    [a, b].map((u) => ({ op: "prepare", owner: "a", value: f.message(u) })),
  );
  assert.equal(
    results.filter((r) => r.state === "ok").length,
    1,
    JSON.stringify(results),
  );
  assert.equal(
    results.filter((r) => r.code === "upload_capacity_exceeded").length,
    1,
    JSON.stringify(results),
  );
  assert.equal(f.count("attachment_bindings"), 1);
  assert.equal(f.count("attachment_refs"), 1);
});
test("blob capacity: a slow admission insert cannot commit after its upload deadline", (t) => {
  const f = fixture(t, { upload_ttl_ms: 20 }, { reservations: [] });
  f.raw.exec(
    "CREATE TRIGGER delay_capacity_upload BEFORE INSERT ON attachment_uploads BEGIN SELECT sum(n) FROM (WITH RECURSIVE delay(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM delay WHERE n<1000000) SELECT n FROM delay); END",
  );
  assert.throws(() => f.start(), code("expired_before_acceptance"));
  assert.equal(f.usage("a").records, 0);
  f.raw.exec("DROP TRIGGER delay_capacity_upload");
});
test("blob capacity: startup honors configured finite busy timeout before initialization pragmas", async (t) => {
  const f = fixture(t),
    source = new URL("../src/relay/sqlite-attachment-store.ts", import.meta.url)
      .href;
  let ready, result;
  const imported = new Promise((resolve) => {
    ready = resolve;
  });
  const completed = new Promise((resolve, reject) => {
    result = resolve;
    const w = new Worker(
      `
      const { parentPort, workerData: d } = require("node:worker_threads");
      import(d.source).then(({ SQLiteAttachmentStore }) => {
        parentPort.once("message", () => {
          let store;
          try { store = new SQLiteAttachmentStore(d.path, d.options); parentPort.postMessage({ state: "opened" }); }
          catch (e) { parentPort.postMessage({ state: "failed", code: e.code ?? "unknown" }); }
          finally { store?.close(); }
        });
        parentPort.postMessage({ state: "ready" });
      }).catch(e => parentPort.postMessage({ state: "failed", code: e.code ?? "unknown" }));
    `,
      { eval: true, workerData: { source, path: f.path, options: f.options } },
    );
    t.after(() => w.terminate());
    w.on("message", (m) => {
      ready(w);
      if (m.state !== "ready") result(m);
    });
    w.once("error", (e) => {
      ready();
      reject(e);
    });
  });
  const w = await imported;
  f.raw.exec("BEGIN EXCLUSIVE");
  const released = new Promise((resolve) =>
    setTimeout(() => {
      f.raw.exec("ROLLBACK");
      resolve();
    }, 150),
  );
  w?.postMessage("open");
  const outcome = await completed;
  await released;
  assert.deepEqual(outcome, { state: "opened" });
});
test("blob capacity: HAB registration bindings determine reserved owners and current block still wins", (t) => {
  const f = registryFixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  f.enroll("c");
  const options = {
    ...uploadOptions,
    max_open_uploads: 3,
    max_open_per_owner: 3,
    owner_capacity: {
      max_records_per_owner: 20,
      max_bindings_per_owner: 20,
      reservations: [
        {
          owner_id: b.agent_id,
          open_uploads: 1,
          live_bytes: 10,
          records: 1,
          bindings: 1,
        },
      ],
    },
  };
  const store = new SQLiteAttachmentStore(
    join(f.dir, "capacity-uploads.sqlite"),
    options,
  );
  t.after(() => store.close());
  store.migrate();
  const api = new HabAttachmentUploads(f.registry, store, options);
  const make = () =>
    intent(payload, { request_id: randomUUID(), recipient_id: a.agent_id });
  const one = api.begin(f.contexts.a, make());
  api.begin(f.contexts.a, make());
  assert.throws(
    () => api.begin(f.contexts.c, make()),
    code("upload_capacity_exceeded"),
  );
  assert.throws(
    () => api.begin({ agent_id: b.agent_id }, make()),
    code("forbidden"),
  );
  assert.throws(
    () => api.begin(f.contexts.b, { ...make(), owner_id: b.agent_id }),
    code("invalid_upload_request"),
  );
  const v = make(),
    receipt = api.begin(f.contexts.b, v);
  assert.equal(receipt.owner_id, b.agent_id);
  assert.equal(one.owner_id, a.agent_id);
  const aa = f.registry.inspect(f.admin, a.agent_id),
    bb = f.registry.inspect(f.admin, b.agent_id);
  f.registry.setBlock(f.admin, {
    request_id: "synthetic-capacity-block",
    sender_id: b.agent_id,
    recipient_id: a.agent_id,
    sender_epoch: bb.epoch,
    recipient_epoch: aa.epoch,
    blocked: true,
  });
  assert.throws(() => api.begin(f.contexts.b, v), code("forbidden"));
  assert.throws(
    () => api.status(f.contexts.b, receipt.attachment_id),
    code("forbidden"),
  );
});
