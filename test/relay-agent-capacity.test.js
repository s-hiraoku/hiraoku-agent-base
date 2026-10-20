import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fixture, limits } from "./relay-agent-capacity-fixtures.js";
import { code } from "./relay-attachment-fixtures.js";
test("agent capacity: a hot sender cannot consume another sender's reserved pending slots", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 4; n++) f.send("a");
  assert.throws(() => f.send("c"), code("capacity_exceeded"));
  f.send("b");
  f.send("b");
  assert.equal(f.usage("a").pending, 4);
  assert.equal(f.usage("b").pending, 2);
});
test("agent capacity: each sender ceiling applies even with unused global space", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 4; n++) f.send("a");
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    4,
  );
});
test("agent capacity: unused byte floors are protected independently of pending count", (t) => {
  const seed = fixture(t),
    m = seed.message("a"),
    bytes = seed.size(m);
  const f = fixture(
    t,
    { max_body_bytes: 2 * bytes },
    {
      max_body_bytes_per_sender: 2 * bytes,
      max_body_bytes_per_recipient: 2 * bytes,
      reservations: [
        { sender_id: "b", pending: 1, body_bytes: bytes, records: 1 },
      ],
    },
  );
  f.send("a", m);
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  f.send("b");
  assert.equal(f.usage("b").pending, 1);
});
test("agent capacity: retained acceptance records cannot fill a protected sender's metadata floor", (t) => {
  const f = fixture(
    t,
    { max_records: 4 },
    {
      max_pending_per_sender: 2,
      max_records_per_sender: 4,
      max_records_per_recipient: 4,
      reservations: [
        { sender_id: "b", pending: 1, body_bytes: 1000, records: 2 },
      ],
    },
  );
  const one = f.message("a");
  f.send("a", one);
  f.ack();
  f.send("a");
  f.ack();
  assert.throws(() => f.send("c"), code("capacity_exceeded"));
  assert.equal(f.send("a", one).state, "acked");
  f.send("b");
  assert.equal(f.usage("b").records, 1);
});
test("agent capacity: ACK frees body and pending budget but not the sender's retained record quota", (t) => {
  const f = fixture(
    t,
    {},
    { max_pending_per_sender: 2, max_records_per_sender: 2 },
  );
  f.send("a");
  f.ack();
  f.send("a");
  f.ack();
  assert.equal(f.usage("a").pending, 0);
  assert.equal(f.usage("a").body_bytes, 0);
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  f.send("b");
});
test("agent capacity: current recipient bytes and records are independently bounded", (t) => {
  const f = fixture(
    t,
    {},
    { max_body_bytes_per_recipient: 500, max_records_per_recipient: 2 },
  );
  f.send("a");
  assert.throws(() => f.send("b"), code("capacity_exceeded"));
  f.ack();
  f.send("b");
  f.ack();
  assert.throws(() => f.send("c"), code("capacity_exceeded"));
  assert.equal(f.send("c", f.message("c", "other")).state, "pending");
});
test("agent capacity: leased and quarantined messages still consume the sender's live allowance", (t) => {
  const f = fixture(t, {}, { max_pending_per_sender: 2 });
  f.send("a");
  f.send("a");
  assert.ok(f.service.poll(f.contexts.sink));
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  f.raw.exec(
    "UPDATE relay_messages SET state='quarantined';UPDATE relay_deliveries SET state='quarantined'",
  );
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  f.send("b");
});
test("agent capacity: exact replay and conflicts are resolved before admission budget checks", (t) => {
  const f = fixture(t),
    m = f.message("a"),
    receipt = f.send("a", m);
  for (let n = 0; n < 3; n++) f.send("a");
  assert.deepEqual(f.send("a", m), receipt);
  const changed = structuredClone(m);
  changed.body.parts[0].text = "changed";
  assert.throws(() => f.send("a", changed), code("idempotency_conflict"));
  assert.equal(f.usage("a").records, 4);
});
test("agent capacity: original expiry frees pending allowance while preserving record identity", (t) => {
  const f = fixture(t, {}, { max_pending_per_sender: 1, reservations: [] }),
    expires = Date.now() + 1500;
  const m = f.message(
    "a",
    "sink",
    "Synthetic message",
    new Date(expires - 3600000).toISOString(),
  );
  f.send("a", m);
  assert.throws(() => f.send("a"), code("capacity_exceeded"));
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, expires - Date.now() + 20),
  );
  f.service.maintain(f.contexts.operator, 10);
  assert.equal(f.send("a").state, "pending");
  assert.equal(f.send("a", m).state, "expired");
  assert.equal(f.usage("a").records, 2);
});
test("agent capacity: supplied policy is copied and lower limits after reopen preserve prior receipts", (t) => {
  const f = fixture(t),
    m = f.message("a");
  f.send("a", m);
  f.send("a");
  f.options.agent_capacity.max_pending_per_sender = 1;
  f.options.agent_capacity.reservations[0].pending = 0;
  f.send("a"); // Original live store still uses the copied policy.
  const capacity = {
    ...f.options.agent_capacity,
    reservations: [],
    max_pending_per_sender: 1,
  };
  const s = f.open({ agent_capacity: capacity }),
    api = f.serviceFor(s);
  assert.equal(api.submit(f.contexts.a, m).message_id, m.message_id);
  assert.throws(
    () => api.submit(f.contexts.a, f.message("a")),
    code("capacity_exceeded"),
  );
  assert.equal(f.usage("a").pending, 3);
});
test("agent capacity: reservation membership grants no authentication or identity override", (t) => {
  const f = fixture(t),
    m = f.message("b");
  assert.throws(
    () => f.service.submit({ agent_id: "b" }, m),
    code("forbidden"),
  );
  assert.throws(() => f.service.submit(f.contexts.a, { ...m, sender_id: "b" }));
  f.active.delete("b");
  assert.throws(() => f.service.submit(f.contexts.b, m), code("forbidden"));
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    0,
  );
});
test("agent capacity: failed audit insert rolls back both message and its consumed allowance", (t) => {
  const f = fixture(t);
  f.raw.exec(
    "CREATE TRIGGER fail_capacity_audit BEFORE INSERT ON relay_delivery_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  assert.throws(() => f.send("b"));
  assert.equal(f.usage("b").records, 0);
  f.raw.exec("DROP TRIGGER fail_capacity_audit");
  assert.equal(f.send("b").state, "pending");
});
test("agent capacity: missing optional policy retains the existing global admission behavior", (t) => {
  const f = fixture(t),
    s = f.open({ agent_capacity: undefined }),
    api = f.serviceFor(s);
  for (let n = 0; n < 6; n++) api.submit(f.contexts.a, f.message("a"));
  assert.throws(
    () => api.submit(f.contexts.b, f.message("b")),
    code("capacity_exceeded"),
  );
});
test("agent capacity: invalid duplicate, oversized or infeasible reservations fail before DB mutation", (t) => {
  const f = fixture(t),
    p = f.options.agent_capacity;
  for (const capacity of [
    null,
    { ...p, max_records_per_sender: 0 },
    { ...p, reservations: [...p.reservations, p.reservations[0]] },
    {
      ...p,
      reservations: [{ sender_id: "b", pending: 7, body_bytes: 1, records: 7 }],
    },
    {
      ...p,
      reservations: [{ sender_id: "b", pending: 2, body_bytes: 1, records: 1 }],
    },
    {
      ...p,
      reservations: [
        { sender_id: "b", pending: 1, body_bytes: 6000, records: 1 },
        { sender_id: "c", pending: 1, body_bytes: 6000, records: 1 },
      ],
    },
  ])
    assert.throws(
      () => f.open({ agent_capacity: capacity }),
      code("invalid_agent_capacity_policy"),
    );
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n,
    0,
  );
});
test("agent capacity: concurrent native writers cannot spend the same last unreserved slot", async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 3; n++) f.send("a");
  const source = new URL("../src/relay/sqlite-store.ts", import.meta.url).href;
  const service = new URL("../src/relay/service.ts", import.meta.url).href;
  const run = (message) =>
    new Promise((resolve, reject) => {
      const w = new Worker(
        `
      const { parentPort, workerData: d } = require("node:worker_threads");
      (async () => {
        const { SQLiteRelayStore } = await import(d.source);
        const { RelayService } = await import(d.service);
        const s = new SQLiteRelayStore(d.path, d.options);
        try {
          s.migrate(); const api = new RelayService(s, d.limits, { authorize: () => ({ agent_id: "a" }) });
          api.submit(null, d.message); parentPort.postMessage("accepted");
        } catch (e) { parentPort.postMessage(e.code); }
        finally { s.close(); }
      })().catch(() => parentPort.postMessage("worker_failed"));
    `,
        {
          eval: true,
          workerData: {
            source,
            service,
            path: f.path,
            options: f.options,
            limits,
            message,
          },
        },
      );
      t.after(() => w.terminate());
      w.once("message", resolve);
      w.once("error", reject);
    });
  const results = await Promise.all([run(f.message("a")), run(f.message("a"))]);
  assert.deepEqual(results.sort(), ["accepted", "capacity_exceeded"]);
  assert.equal(f.usage("a").pending, 4);
  f.send("b");
  f.send("b");
});
