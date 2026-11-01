import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteRelayStore } from "../../src/relay/sqlite-store.ts";
import { SQLiteInbox } from "../../src/relay/sqlite-inbox.ts";
import { RelayService, DurableReceiver } from "../../src/relay/index.ts";
import { limits, message } from "../relay-http-fixtures.js";
import { ackRequest } from "./backends.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { labEnvironment } from "../../scripts/lib/delivery-lab.mjs";

const options = {
  fingerprint_key: new Uint8Array(32).fill(83),
  max_pending: 10,
  max_records: 100,
  max_pending_per_recipient: 10,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  max_attempts: 5,
  retry_base_ms: 1,
  retry_cap_ms: 10,
  poll_scan_limit: 10,
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-failure-"));
  chmodSync(dir, 0o700);
  const opened = new Set();
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const track = (store) => {
    opened.add(store);
    return store;
  };
  const path = join(dir, "relay.sqlite");
  const store = track(new SQLiteRelayStore(path, options));
  store.migrate();
  const raw = track(new DatabaseSync(path));
  const service = new RelayService(store, limits, {
    authorize: (ctx) =>
      ["a", "b", "c"].includes(ctx) ? { agent_id: ctx } : undefined,
  });
  const inboxPath = join(dir, "inbox.sqlite");
  const inboxOptions = {
    agent_id: "b",
    limits,
    fingerprint_key: new Uint8Array(32).fill(84),
    max_records: 10,
    max_body_bytes: 100000,
    max_ack_records: 30,
    ack_retry_ms: 86400000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_attempts: 5,
  };
  const openInbox = () => track(new SQLiteInbox(inboxPath, inboxOptions));
  const inbox = openInbox();
  inbox.migrate();
  return {
    dir,
    path,
    store,
    raw,
    service,
    inboxPath,
    inbox,
    openInbox,
    inboxOptions,
    closeInbox() {
      inbox.close();
      opened.delete(inbox);
    },
  };
}

function connectionHook(t, path, callback) {
  const original = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    const location = this.prepare("PRAGMA database_list").get().file;
    if (sql === "BEGIN IMMEDIATE" && location === path)
      callback(this, original);
    return original.call(this, sql);
  });
}

function pageLimit(t, path) {
  let target;
  let armed = true;
  let fullErrors = 0;
  const probe = new DatabaseSync(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  probe.close();
  const originalRun = prototype.run;
  t.mock.method(prototype, "run", function (...args) {
    try {
      return originalRun.apply(this, args);
    } catch (error) {
      if (error.errcode === 13) fullErrors++;
      throw error;
    }
  });
  connectionHook(t, path, (db, exec) => {
    if (!armed) return;
    const count = db.prepare("PRAGMA page_count").get().page_count;
    exec.call(db, `PRAGMA max_page_count=${count}`);
    target = db;
    armed = false;
  });
  return {
    fullErrors: () => fullErrors,
    recover() {
      DatabaseSync.prototype.exec.call(
        target,
        "PRAGMA max_page_count=1073741823",
      );
    },
  };
}

test("F01 real SQLITE_FULL under a per-database page cap never returns acceptance; retry succeeds", (t) => {
  const f = fixture(t);
  const fault = pageLimit(t, f.path);
  const input = message();
  input.body.parts[0].text = "x".repeat(15000);
  assert.throws(() => f.service.submit("a", input));
  assert.equal(fault.fullErrors(), 1);
  for (const table of [
    "relay_messages",
    "relay_deliveries",
    "relay_delivery_audit",
    "relay_threads",
  ])
    assert.equal(f.raw.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  fault.recover();
  const receipt = f.service.submit("a", input);
  assert.equal(receipt.state, "pending");
  assert.deepEqual(f.service.submit("a", input), receipt);
});

test("F02 full durable inbox sends zero ACKs, retains server body and recovers with one inbox entry", async (t) => {
  const f = fixture(t);
  const input = message();
  input.body.parts[0].text = "x".repeat(15000);
  f.service.submit("a", input);
  const fault = pageLimit(t, f.inboxPath);
  let acks = 0;
  const receiver = new DurableReceiver(f.inbox, {
    poll: async () => f.service.poll("b"),
    ack: async (request) => {
      acks++;
      return f.service.ack("b", request);
    },
  });
  await assert.rejects(receiver.receiveOnce());
  assert.equal(fault.fullErrors(), 1);
  assert.equal(acks, 0);
  assert.deepEqual(receiver.inbox(), []);
  assert.ok(f.raw.prepare("SELECT body FROM relay_messages").get().body);
  assert.equal(f.service.status("a", input.message_id).state, "leased");
  fault.recover();
  f.raw.exec("UPDATE relay_deliveries SET lease_until=0,next_visible_at=0");
  await receiver.receiveOnce();
  assert.equal(acks, 1);
  assert.deepEqual(
    receiver.inbox().map((entry) => entry.message),
    [input],
  );
  assert.equal(receiver.inbox()[0].receipt_confirmed, true);
  assert.equal(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
});

test("F03 exact database-clock TTL and skew boundaries fail closed without host clock changes", (t) => {
  const f = fixture(t);
  let clock = Math.floor(Date.now() / 1000) * 1000;
  connectionHook(t, f.path, (db) => {
    db.function("unixepoch", { varargs: true }, () => clock / 1000);
  });
  const at = clock;
  const input = message();
  input.first_sent_at = new Date(at).toISOString();
  input.expires_at = new Date(at + 3600000).toISOString();
  input.message_id = "ttl-boundary";
  const edge = {
    ...input,
    recipient_id: "c",
    message_id: "skew-edge",
    first_sent_at: new Date(at + 1000).toISOString(),
    expires_at: new Date(at + 3601000).toISOString(),
  };
  assert.equal(f.service.submit("a", edge).state, "pending");
  assert.throws(
    () =>
      f.service.submit("a", {
        ...edge,
        message_id: "skew-over",
        first_sent_at: new Date(at + 1001).toISOString(),
        expires_at: new Date(at + 3601001).toISOString(),
      }),
    { code: "clock_skew" },
  );
  f.service.submit("a", input);
  clock = at + 3599999;
  const delivery = f.service.poll("b");
  assert.equal(delivery.message.message_id, input.message_id);
  assert.equal(Date.parse(delivery.lease_until), at + 3600000);
  clock++;
  assert.throws(() => f.service.ack("b", ackRequest(delivery, "ttl-ack")), {
    code: "invalid_ack",
  });
  assert.equal(f.service.status("a", input.message_id).state, "expired");
  assert.equal(
    f.raw
      .prepare("SELECT body FROM relay_messages WHERE message_id=?")
      .get(input.message_id).body,
    null,
  );
  assert.throws(
    () => f.service.submit("a", { ...input, message_id: "expired-new" }),
    { code: "expired_before_acceptance" },
  );
});

test("F04 malformed SQLite file is rejected without overwriting the evidence", (t) => {
  const f = fixture(t);
  const path = join(f.dir, "corrupt.sqlite");
  const bytes = Buffer.alloc(4096, 0x78);
  writeFileSync(path, bytes, { mode: 0o600 });
  assert.throws(() => new SQLiteRelayStore(path, options));
  assert.deepEqual(readFileSync(path), bytes);
});

test(
  "F05 SIGKILL after durable save before ACK recovers the saved request with one inbox entry",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    const input = message();
    f.service.submit("a", input);
    const delivery = f.service.poll("b");
    f.closeInbox();
    const inboxModule = new URL(
      "../../src/relay/sqlite-inbox.ts",
      import.meta.url,
    ).href;
    const receiverModule = new URL(
      "../../src/relay/receiver.ts",
      import.meta.url,
    ).href;
    const options = { ...f.inboxOptions, fingerprint_key: undefined };
    const source = `
    import { SQLiteInbox } from ${JSON.stringify(inboxModule)};
    import { DurableReceiver } from ${JSON.stringify(receiverModule)};
    const inbox = new SQLiteInbox(${JSON.stringify(f.inboxPath)}, { ...${JSON.stringify(options)}, fingerprint_key: new Uint8Array(32).fill(84) });
    inbox.migrate();
    setInterval(() => {}, 1000);
    await new DurableReceiver(inbox, {
      poll: async () => (${JSON.stringify(delivery)}),
      ack: async () => { process.stdout.write('saved\\n'); return new Promise(() => {}); }
    }).receiveOnce();
  `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: labEnvironment(process.env, f.dir),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 8000,
        killSignal: "SIGKILL",
      },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr = (stderr + bytes.toString()).slice(-2048);
    });
    try {
      await Promise.race([
        once(child.stdout, "data").then(([bytes]) =>
          assert.equal(bytes.toString(), "saved\n"),
        ),
        exited.then(([code, signal]) => {
          throw Error(
            `receiver exited before save: ${code}/${signal} ${stderr}`,
          );
        }),
      ]);
      assert.equal(f.service.status("a", input.message_id).state, "leased");
      assert.equal(child.kill("SIGKILL"), true);
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL");
      const restored = f.openInbox();
      restored.migrate();
      assert.deepEqual(
        restored.inbox().map((entry) => entry.message),
        [input],
      );
      assert.equal(restored.inbox()[0].receipt_confirmed, false);
      await new DurableReceiver(restored, {
        poll: async () => f.service.poll("b"),
        ack: async (request) => f.service.ack("b", request),
      }).receiveOnce();
      assert.equal(restored.inbox().length, 1);
      assert.equal(restored.inbox()[0].receipt_confirmed, true);
      assert.equal(f.service.status("a", input.message_id).state, "acked");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  },
);
