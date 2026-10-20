import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  fixture as capacityFixture,
  limits,
} from "./relay-agent-capacity-fixtures.js";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { RelayError } from "../src/relay/service.ts";
import { code } from "./relay-attachment-fixtures.js";
const legacy =
  "DROP TRIGGER relay_poll_positions_terminal;DROP TABLE relay_poll_senders;DROP TABLE relay_poll_cursors;UPDATE relay_schema SET version=4";
const fixture = (t, changes = {}) =>
  capacityFixture(
    t,
    {
      fair_poll: true,
      max_pending: 30,
      max_records: 100,
      max_pending_per_recipient: 30,
      max_body_bytes: 100000,
      ...changes,
    },
    {
      max_pending_per_sender: 30,
      max_records_per_sender: 100,
      max_body_bytes_per_sender: 100000,
      max_body_bytes_per_recipient: 100000,
      reservations: [],
    },
  );
const request = (d) => ({
  sender_id: d.message.sender_id,
  message_id: d.message.message_id,
  generation: d.generation,
  lease_token: d.lease_token,
  request_id: randomUUID(),
});
const acknowledge = (f, d, api = f.service, who = "sink") =>
  api.ack(f.contexts[who], request(d));
const cursorCount = (f) =>
  f.raw.prepare("SELECT count(*) n FROM relay_poll_cursors").get().n;
function attachmentPort(t, f, check, configured = true) {
  const s = new SQLiteRelayStore(
    f.path,
    f.options,
    { check() {} },
    configured ? { limits, check } : undefined,
  );
  t.after(() => s.close());
  s.migrate();
  const api = f.serviceFor(s),
    m = f.message("a");
  m.body.parts.push({
    type: "attachment",
    attachment_id: "synthetic-file",
    media_type: "text/plain",
    size_bytes: 1,
    sha256: "0".repeat(64),
  });
  api.submit(f.contexts.a, m);
  f.send("b");
  return { s, api, m };
}
test("fair poll: eligible senders alternate despite one sender having an older backlog", (t) => {
  const f = fixture(t);
  for (const who of ["a", "a", "a", "b", "b", "b", "c", "c", "c"]) f.send(who);
  const order = [];
  for (let n = 0; n < 9; n++) order.push(f.ack().message.sender_id);
  assert.deepEqual(order, ["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
  assert.equal(cursorCount(f), 0);
});
test("fair poll: reopening between successful leases retains the next sender", (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("a");
  f.send("b");
  f.send("b");
  assert.equal(f.ack().message.sender_id, "a");
  f.close(f.store);
  const api = f.serviceFor(f.open());
  assert.equal(f.ack("sink", api).message.sender_id, "b");
  assert.equal(f.ack("sink", api).message.sender_id, "a");
});
test("fair poll: one denied candidate cannot monopolize a one-sender scan budget", (t) => {
  const f = fixture(t, { poll_scan_limit: 1 });
  f.send("a");
  f.send("a");
  f.send("b");
  f.state.blocked.add("a");
  assert.equal(f.service.poll(f.contexts.sink), null);
  assert.equal(
    f.raw
      .prepare(
        "SELECT sum(attempts) n FROM relay_deliveries WHERE sender_id='a'",
      )
      .get().n,
    0,
  );
  f.send("a"); // A replenishing backlog still cannot jump ahead of B's turn.
  assert.equal(f.ack().message.sender_id, "b");
});
test("fair poll: denied messages within a sender advance durably to another allowed kind", (t) => {
  const f = fixture(t, { poll_scan_limit: 1 }),
    denied = f.message("a"),
    allowed = f.message("a");
  denied.kind = "notice";
  f.send("a", denied);
  f.send("a", allowed);
  const base = f.authorization.authorize;
  f.authorization.authorize = (ctx, op, peer, kind) =>
    op === "poll" && kind === "notice" ? undefined : base(ctx, op, peer, kind);
  assert.equal(f.service.poll(f.contexts.sink), null);
  f.close(f.store);
  const api = f.serviceFor(f.open());
  const d = api.poll(f.contexts.sink);
  assert.equal(d.message.message_id, allowed.message_id);
  acknowledge(f, d, api);
  f.authorization.authorize = base;
  assert.equal(api.poll(f.contexts.sink).message.message_id, denied.message_id);
});
test("fair poll: all denied senders consume at most the configured number of candidate checks", (t) => {
  const f = fixture(t, { poll_scan_limit: 2 });
  for (const who of ["a", "b", "c", "d"]) f.send(who);
  let checks = [];
  const base = f.authorization.authorize;
  f.authorization.authorize = (ctx, op, peer, kind) => {
    if (op === "poll" && peer) {
      checks.push(peer);
      return undefined;
    }
    return base(ctx, op, peer, kind);
  };
  assert.equal(f.service.poll(f.contexts.sink), null);
  assert.deepEqual(checks, ["a", "b"]);
  checks = [];
  assert.equal(f.service.poll(f.contexts.sink), null);
  assert.deepEqual(checks, ["c", "d"]);
  assert.equal(
    f.raw.prepare("SELECT sum(attempts) n FROM relay_deliveries").get().n,
    0,
  );
});
test("fair poll: missing attachment delivery composition withholds it and advances to text", (t) => {
  const f = fixture(t, { poll_scan_limit: 1 }),
    { api } = attachmentPort(t, f, () => {}, false);
  assert.equal(api.poll(f.contexts.sink), null);
  assert.equal(api.poll(f.contexts.sink).message.sender_id, "b");
  assert.equal(
    f.raw
      .prepare("SELECT attempts FROM relay_deliveries WHERE sender_id='a'")
      .get().attempts,
    0,
  );
});
test("fair poll: unconfirmed attachment readiness does not starve a different sender", (t) => {
  const f = fixture(t, { poll_scan_limit: 1 }),
    { api } = attachmentPort(t, f, () => {
      throw new RelayError("attachment_binding_unavailable");
    });
  assert.equal(api.poll(f.contexts.sink), null);
  assert.equal(api.poll(f.contexts.sink).message.sender_id, "b");
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages WHERE sender_id='a'").get()
      .state,
    "pending",
  );
});
test("fair poll: unexpected attachment failures roll back both cursor and attempts", (t) => {
  const f = fixture(t),
    { api } = attachmentPort(t, f, () => {
      throw Error("synthetic storage failure");
    });
  assert.throws(() => api.poll(f.contexts.sink), /synthetic storage failure/);
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT sum(attempts) n FROM relay_deliveries").get().n,
    0,
  );
});
test("fair poll: current receiver revocation during a scan rolls back persisted progress", (t) => {
  const f = fixture(t);
  f.send("a");
  const base = f.authorization.authorize;
  f.authorization.authorize = (ctx, op, peer, kind) => {
    if (op === "poll" && peer) {
      f.active.delete("sink");
      return undefined;
    }
    return base(ctx, op, peer, kind);
  };
  assert.throws(() => f.service.poll(f.contexts.sink), code("forbidden"));
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_poll_senders").get().n,
    0,
  );
});
test("fair poll: active receiver lease keeps the existing single-flight rule and cursor", (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("b");
  const d = f.service.poll(f.contexts.sink),
    before = f.raw.prepare("SELECT * FROM relay_poll_cursors").get();
  assert.equal(f.service.poll(f.contexts.sink), null);
  assert.deepEqual(
    f.raw.prepare("SELECT * FROM relay_poll_cursors").get(),
    before,
  );
  acknowledge(f, d);
  assert.equal(f.service.poll(f.contexts.sink).message.sender_id, "b");
});
test("fair poll: expired lease rotates to another sender while stale ACK cannot alter progress", (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("a");
  f.send("b");
  const old = f.service.poll(f.contexts.sink);
  f.raw.exec(
    "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0 WHERE state='leased'",
  );
  const next = f.service.poll(f.contexts.sink);
  assert.equal(next.message.sender_id, "b");
  const before = f.raw.prepare("SELECT * FROM relay_poll_cursors").get();
  assert.throws(() => acknowledge(f, old), code("invalid_ack"));
  assert.deepEqual(
    f.raw.prepare("SELECT * FROM relay_poll_cursors").get(),
    before,
  );
});
test("fair poll: retry backoff and quarantine remain authoritative over sender rotation", (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("b");
  f.service.poll(f.contexts.sink);
  f.raw.exec(
    "UPDATE relay_deliveries SET lease_until=0,next_visible_at=0,attempts=3 WHERE sender_id='a'",
  );
  assert.equal(f.service.poll(f.contexts.sink).message.sender_id, "b");
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages WHERE sender_id='a'").get()
      .state,
    "quarantined",
  );
});
test("fair poll: recipient cursors are independent and empty inbox polling allocates no state", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 4; n++)
    assert.equal(f.service.poll(f.contexts.sink), null);
  assert.equal(cursorCount(f), 0);
  f.send("a");
  f.send("b");
  f.send("a", f.message("a", "other"));
  f.send("b", f.message("b", "other"));
  assert.equal(f.ack().message.sender_id, "a");
  assert.equal(f.ack("other").message.sender_id, "a");
  assert.equal(f.ack().message.sender_id, "b");
  assert.equal(f.ack("other").message.sender_id, "b");
  assert.equal(cursorCount(f), 0);
});
for (const table of ["relay_poll_cursors", "relay_poll_senders"]) {
  test(
    "fair poll: tampered " + table + " is rejected before any new lease",
    (t) => {
      const f = fixture(t);
      f.send("a");
      f.send("a");
      f.send("b");
      f.ack();
      f.raw.exec("UPDATE " + table + " SET updated_at=updated_at+1");
      assert.throws(
        () => f.service.poll(f.contexts.sink),
        code("poll_cursor_integrity"),
      );
      assert.equal(
        f.raw
          .prepare(
            "SELECT count(*) n FROM relay_deliveries WHERE state='leased'",
          )
          .get().n,
        0,
      );
    },
  );
}
test("fair poll: failed ACK audit restores body and cursor; successful ACK collects empty positions", (t) => {
  const f = fixture(t);
  f.send("a");
  const d = f.service.poll(f.contexts.sink),
    ack = request(d);
  f.raw.exec(
    "CREATE TRIGGER fail_fair_ack BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='acked' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  assert.throws(() => f.service.ack(f.contexts.sink, ack));
  assert.equal(cursorCount(f), 1);
  assert.ok(f.raw.prepare("SELECT body FROM relay_messages").get().body);
  f.raw.exec("DROP TRIGGER fail_fair_ack");
  f.service.ack(f.contexts.sink, ack);
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_poll_senders").get().n,
    0,
  );
});
test("fair poll: failed lease audit does not advance either cursor", (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("b");
  f.raw.exec(
    "CREATE TRIGGER fail_fair_lease BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='leased' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  assert.throws(() => f.service.poll(f.contexts.sink));
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT sum(attempts) n FROM relay_deliveries").get().n,
    0,
  );
  f.raw.exec("DROP TRIGGER fail_fair_lease");
  assert.equal(f.service.poll(f.contexts.sink).message.sender_id, "a");
});
test("fair poll: schema4 migration is explicit, atomic and preserves old receipt identity", (t) => {
  const f = fixture(t),
    m = f.message("a"),
    receipt = f.send("a", m);
  f.close(f.store);
  f.raw.exec(legacy);
  f.raw.exec(
    "CREATE TRIGGER fail_fair_upgrade BEFORE UPDATE ON relay_schema WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'synthetic upgrade failure'); END",
  );
  assert.throws(() => f.open(), /synthetic upgrade failure/);
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_schema").get().version,
    4,
  );
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name IN ('relay_poll_senders','relay_poll_cursors')",
      )
      .get().n,
    0,
  );
  f.raw.exec("DROP TRIGGER fail_fair_upgrade");
  const s = f.open();
  assert.equal(
    f.raw.prepare("SELECT version FROM relay_schema").get().version,
    5,
  );
  assert.equal(
    f.serviceFor(s).submit(f.contexts.a, m).receipt_id,
    receipt.receipt_id,
  );
});
test("fair poll: malformed configuration and missing schema5 table never auto-enable or repair", (t) => {
  const f = fixture(t);
  for (const fair_poll of [null, 1, "true"])
    assert.throws(() => f.open({ fair_poll }), code("invalid_store_options"));
  f.raw.exec("DROP TRIGGER relay_poll_positions_terminal");
  assert.throws(() => f.open(), code("poll_cursor_schema_unavailable"));
  f.raw.exec("DROP TABLE relay_poll_senders");
  assert.throws(() => f.open());
  assert.equal(
    f.raw
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='relay_poll_senders'",
      )
      .get().n,
    0,
  );
});
test("fair poll: current context still decides ownership and cannot choose another inbox", (t) => {
  const f = fixture(t);
  f.send("a");
  assert.throws(() => f.service.poll({ agent_id: "sink" }), code("forbidden"));
  assert.equal(f.service.poll(f.contexts.other), null);
  assert.equal(cursorCount(f), 0);
});
test("fair poll: native competing workers still lease only one receiver delivery", async (t) => {
  const f = fixture(t);
  f.send("a");
  f.send("a");
  f.send("b");
  f.send("b");
  const source = new URL("../src/relay/sqlite-store.ts", import.meta.url).href,
    service = new URL("../src/relay/service.ts", import.meta.url).href;
  const run = () =>
    new Promise((resolve, reject) => {
      const w = new Worker(
        `
      const { parentPort, workerData: d } = require("node:worker_threads");
      (async () => {
        const { SQLiteRelayStore } = await import(d.source);
        const { RelayService } = await import(d.service);
        const s = new SQLiteRelayStore(d.path,d.options);
        try { s.migrate(); const api = new RelayService(s,d.limits,{authorize:()=>({agent_id:"sink"})});
          parentPort.postMessage(api.poll(null)?.message.sender_id ?? null); }
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
          },
        },
      );
      t.after(() => w.terminate());
      w.once("message", resolve);
      w.once("error", reject);
    });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((v) => v === "a").length, 1);
  assert.equal(results.filter((v) => v === null).length, 1);
  assert.equal(
    f.raw.prepare("SELECT sum(attempts) n FROM relay_deliveries").get().n,
    1,
  );
});
test("fair poll: opt-out keeps existing arrival order without writing cursors", (t) => {
  const f = fixture(t, { fair_poll: false });
  f.send("a");
  f.send("a");
  f.send("b");
  assert.equal(f.ack().message.sender_id, "a");
  assert.equal(f.ack().message.sender_id, "a");
  assert.equal(cursorCount(f), 0);
});
test("fair poll: original TTL maintenance collects both cursor levels atomically", (t) => {
  const f = fixture(t),
    expiry = Date.now() + 1500;
  const m = f.message(
    "a",
    "sink",
    "Synthetic message",
    new Date(expiry - 3600000).toISOString(),
  );
  f.send("a", m);
  f.service.poll(f.contexts.sink);
  assert.equal(cursorCount(f), 1);
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, expiry - Date.now() + 20),
  );
  f.service.maintain(f.contexts.operator, 10);
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT count(*) n FROM relay_poll_senders").get().n,
    0,
  );
  assert.equal(f.service.poll(f.contexts.sink), null);
});
test("fair poll: delayed lease SQL cannot commit an expired text delivery lease or cursor", (t) => {
  const f = fixture(t, { lease_ms: 20 });
  f.send("a");
  f.raw.exec(
    "CREATE TRIGGER delay_fair_lease BEFORE INSERT ON relay_delivery_audit WHEN NEW.event='leased' BEGIN SELECT sum(n) FROM (WITH RECURSIVE delay(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM delay WHERE n<1000000) SELECT n FROM delay); END",
  );
  assert.throws(
    () => f.service.poll(f.contexts.sink),
    code("expired_before_acceptance"),
  );
  assert.equal(cursorCount(f), 0);
  assert.equal(
    f.raw.prepare("SELECT sum(attempts) n FROM relay_deliveries").get().n,
    0,
  );
});
