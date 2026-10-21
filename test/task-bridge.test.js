import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  fixture,
  code,
  owner,
  worker,
  RESPONSE,
} from "./task-bridge-fixtures.js";
import { TaskBridge } from "../src/task-bridge/bridge.ts";
import { SQLiteTaskBridgeJournal } from "../src/task-bridge/sqlite-journal.ts";
import { ConnectivityTaskPort } from "../src/task-bridge/task-port.ts";
import { closedTask } from "../src/task-bridge/contract.ts";

test("Task bridge: delivery and confirmed ACK alone do not accept or create a Task", (t) => {
  const f = fixture(t),
    key = f.receive();
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  assert.throws(() => f.journal.get(key), code("bridge_not_found"));
  assert.equal(f.count(), 0);
  const accepted = f.bridge.accept(f.context, key);
  assert.equal(accepted.state, "prepared");
  assert.equal(f.count(), 0);
  assert.deepEqual(f.audit(), ["accepted"]);
});
test("Task bridge: explicit acceptance and fixed Task submission preserve distinct states", async (t) => {
  const f = fixture(t),
    key = f.receive(),
    accepted = f.bridge.accept(f.context, key);
  const linked = await f.bridge.submitOnce(f.context, key);
  assert.equal(linked.state, "linked");
  assert.equal(linked.task.state, "queued");
  assert.equal(linked.task.request_key, accepted.request_key);
  assert.equal(closedTask(linked.task), false);
  assert.equal(f.count(), 1);
  assert.equal(f.calls[0].op, "submit");
  assert.deepEqual(f.audit(), ["accepted", "attempted", "linked"]);
});
test("Task bridge: caller names cannot replace current explicit local authorization", async (t) => {
  const f = fixture(t),
    key = f.receive();
  assert.throws(
    () => f.bridge.accept({ receiver_id: "b", actor_id: "operator" }, key),
    code("bridge_forbidden"),
  );
  const denied = new TaskBridge(f.journal, f.inbox, f.tasks);
  assert.throws(() => denied.accept(f.context, key), code("bridge_forbidden"));
  f.bridge.accept(f.context, key);
  f.state.enabled = false;
  await assert.rejects(
    f.bridge.submitOnce(f.context, key),
    code("bridge_forbidden"),
  );
  assert.equal(f.count(), 0);
});
test("Task bridge: unconfirmed delivery cannot be explicitly accepted", (t) => {
  const f = fixture(t),
    key = f.receive({}, false);
  assert.throws(
    () => f.bridge.accept(f.context, key),
    code("bridge_invalid_request"),
  );
  assert.equal(f.count(), 0);
});
test("Task bridge: ordinary replies, free text, attachments and arbitrary task arguments cannot execute", (t) => {
  const f = fixture(t);
  for (const patch of [
    { kind: "answer" },
    { kind: "execution_result" },
    { body: { parts: [{ type: "text", text: "run a shell" }] } },
    {
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 1,
            value: { task_type: "shift_log_inventory" },
          },
        ],
      },
    },
    {
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 1,
            value: { task_type: "connectivity_check", prompt: "arbitrary" },
          },
        ],
      },
    },
    {
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 1,
            value: { task_type: "connectivity_check", request_key: "chosen" },
          },
        ],
      },
    },
    {
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 2,
            value: { task_type: "connectivity_check" },
          },
        ],
      },
    },
  ]) {
    const key = f.receive(patch);
    assert.throws(
      () => f.bridge.accept(f.context, key),
      code("bridge_invalid_request"),
    );
  }
  assert.equal(f.count(), 0);
});
test("Task bridge: inbox handoff validates durable content and cannot accept released bodies", (t) => {
  const f = fixture(t),
    key = f.receive();
  f.inbox.releaseBody(key.sender_id, key.message_id);
  assert.throws(() => f.bridge.accept(f.context, key), code("not_found"));
  const next = f.receive();
  const row = f.inbox
    .inbox()
    .find((e) => e.message.message_id === next.message_id);
  row.message.thread_id = "mutated";
  // Caller copies cannot mutate the durable source.
  assert.equal(f.bridge.accept(f.context, next).thread_id, "thread-ab");
  f.raw.exec(
    "CREATE TRIGGER fail_unused BEFORE INSERT ON task_bridge_audit BEGIN SELECT RAISE(ABORT,'synthetic');END",
  );
  const last = f.receive();
  assert.throws(
    () => f.bridge.accept(f.context, last),
    code("bridge_store_unavailable"),
  );
  assert.throws(() => f.journal.get(last), code("bridge_not_found"));
});
test("Task bridge: source handoff rejects runtime body tampering before journal admission", (t) => {
  const f = fixture(t),
    key = f.receive();
  const raw = new f.raw.constructor(join(f.dir, "bridge-inbox.sqlite"));
  t.after(() => raw.close());
  const row = raw
      .prepare("SELECT body FROM relay_inbox WHERE message_id=?")
      .get(key.message_id),
    body = JSON.parse(row.body);
  body.thread_id = "changed";
  raw
    .prepare("UPDATE relay_inbox SET body=? WHERE message_id=?")
    .run(JSON.stringify(body), key.message_id);
  assert.throws(
    () => f.bridge.accept(f.context, key),
    code("inbox_content_conflict"),
  );
  assert.equal(f.count(), 0);
});
test("Task bridge: exact acceptance replay survives full capacity, response loss and reopen", (t) => {
  const f = fixture(t, { max_records: 1 }),
    key = f.receive(),
    first = f.bridge.accept(f.context, key);
  assert.deepEqual(f.bridge.accept(f.context, key), first);
  const second = f.receive();
  assert.throws(
    () => f.bridge.accept(f.context, second),
    code("bridge_capacity_exceeded"),
  );
  f.close(f.journal);
  const s = f.open();
  s.migrate();
  assert.equal(
    f.makeBridge({}, s).accept(f.context, key).request_key,
    first.request_key,
  );
});
test("Task bridge: losing a committed Task response reuses the same owner and submit key", async (t) => {
  const f = fixture(t),
    key = f.receive(),
    accepted = f.bridge.accept(f.context, key);
  const lost = f.makeBridge({
    submit: async (request) => {
      await f.tasks.submit(request);
      throw Error("private transport detail");
    },
  });
  assert.equal((await lost.submitOnce(f.context, key)).state, "uncertain");
  assert.equal(f.count(), 1);
  await assert.rejects(
    f.bridge.submitOnce(f.context, key),
    code("bridge_reconciliation_required"),
  );
  f.close(f.journal);
  const s = f.open();
  s.migrate();
  const recovered = await f.makeBridge({}, s).submitOnce(f.context, key, true);
  assert.equal(recovered.task.request_key, accepted.request_key);
  assert.equal(f.count(), 1);
  assert.equal(await f.hub.claim(worker, {}).then(Boolean), true);
});
test("Task bridge: release after durable acceptance does not lose the Task link", async (t) => {
  const f = fixture(t),
    key = f.receive(),
    accepted = f.bridge.accept(f.context, key);
  f.inbox.releaseBody(key.sender_id, key.message_id);
  const linked = await f.bridge.submitOnce(f.context, key);
  assert.equal(linked.request_key, accepted.request_key);
  assert.equal(f.count(), 1);
});
test("Task bridge: an unresolved outcome holds the one submission slot for other source messages", async (t) => {
  const f = fixture(t),
    one = f.receive(),
    two = f.receive();
  f.bridge.accept(f.context, one);
  f.bridge.accept(f.context, two);
  const lost = f.makeBridge({
    submit: async () => {
      throw Error("unknown");
    },
  });
  await lost.submitOnce(f.context, one);
  await assert.rejects(
    f.bridge.submitOnce(f.context, two),
    code("bridge_busy"),
  );
  await f.bridge.submitOnce(f.context, one, true);
  await f.bridge.submitOnce(f.context, two);
  assert.equal(f.count(), 2);
});
test("Task bridge: finite failed reconciliations enter waiting approval without key rotation", async (t) => {
  const f = fixture(t, { max_submit_attempts: 2 }),
    key = f.receive(),
    accepted = f.bridge.accept(f.context, key);
  const bad = f.makeBridge({
    submit: async () => {
      throw Error("unknown");
    },
  });
  await bad.submitOnce(f.context, key);
  await bad.submitOnce(f.context, key, true);
  const manual = await bad.submitOnce(f.context, key, true);
  assert.equal(manual.state, "waiting_approval");
  assert.equal(manual.attempts, 2);
  assert.equal(manual.request_key, accepted.request_key);
  assert.equal(f.count(), 0);
  assert.equal((await bad.submitOnce(f.context, key, true)).attempts, 2);
});
test("Task bridge: a late original response cannot overwrite a newer reconciliation fence", async (t) => {
  const f = fixture(t, { lease_ms: 500 }),
    key = f.receive();
  f.bridge.accept(f.context, key);
  const old = f.journal.begin(key, false, () => {}),
    task = await f.tasks.submit(old.request_key);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 520);
  const newer = f.journal.begin(key, true, () => {});
  assert.throws(
    () => f.journal.confirm(old, task, () => {}),
    code("stale_bridge_attempt"),
  );
  f.journal.confirm(newer, task, () => {});
  f.journal.uncertain(old);
  assert.equal(f.journal.get(key).task.id, task.id);
  assert.equal(f.count(), 1);
});
test("Task bridge: crash while submitting requires same-key reconciliation after the finite lease", async (t) => {
  const f = fixture(t, { lease_ms: 500 }),
    key = f.receive();
  f.bridge.accept(f.context, key);
  const job = f.journal.begin(key, false, () => {});
  await f.tasks.submit(job.request_key);
  f.close(f.journal);
  const s = f.open();
  s.migrate();
  const bridge = f.makeBridge({}, s);
  await assert.rejects(
    bridge.submitOnce(f.context, key, true),
    code("bridge_busy"),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 520);
  assert.equal(
    (await bridge.submitOnce(f.context, key, true)).task.request_key,
    job.request_key,
  );
  assert.equal(f.count(), 1);
});
test("Task bridge: invalid Task evidence is never linked as a successful acceptance", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  const wrong = f.makeBridge({
    submit: async (request) => ({
      ...(await f.tasks.submit(request)),
      owner: "foreign",
    }),
  });
  assert.equal((await wrong.submitOnce(f.context, key)).state, "uncertain");
  assert.equal(f.count(), 1);
  assert.equal(
    (await f.bridge.submitOnce(f.context, key, true)).state,
    "linked",
  );
});
test("Task bridge: current Task principal and durable Task stop are independent authorization gates", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  f.state.task_enabled = false;
  assert.equal((await f.bridge.submitOnce(f.context, key)).state, "uncertain");
  assert.equal(f.count(), 0);
  f.state.task_enabled = true;
  await f.hub.authorization.setStopped(
    { kind: "global", id: "*" },
    true,
    await f.hub.authorization.epoch(),
    "synthetic-operator",
  );
  assert.equal(
    (await f.bridge.submitOnce(f.context, key, true)).state,
    "uncertain",
  );
  assert.equal(f.count(), 0);
});
test("Task bridge: completion evidence comes from the Task engine and repeated observation does not resubmit", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  await f.bridge.submitOnce(f.context, key);
  const running = await f.hub.claim(worker, {});
  assert.equal(
    (await f.bridge.observeOnce(f.context, key)).task.state,
    "running",
  );
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const done = await f.bridge.observeOnce(f.context, key);
  assert.equal(closedTask(done.task), true);
  assert.equal(done.task.result, RESPONSE);
  const count = f.audit().length;
  await f.bridge.observeOnce(f.context, key);
  await f.bridge.submitOnce(f.context, key);
  assert.equal(f.audit().length, count);
  assert.equal(f.count(), 1);
});
test("Task bridge: cancelling an active Task is not completion and does not release the execution gate", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  await f.bridge.submitOnce(f.context, key);
  const running = await f.hub.claim(worker, {});
  await f.hub.cancel(owner, { id: running.id });
  const view = await f.bridge.observeOnce(f.context, key);
  assert.equal(view.task.state, "cancelled");
  assert.equal(view.task.execution_open, 1);
  assert.equal(closedTask(view.task), false);
  assert.equal(await f.hub.claim(worker, {}), null);
});
test("Task bridge: audit failure rolls back the link while preserving the stable pre-submit journal", async (t) => {
  const f = fixture(t),
    key = f.receive(),
    accepted = f.bridge.accept(f.context, key);
  f.raw.exec(
    "CREATE TRIGGER fail_bridge_link BEFORE INSERT ON task_bridge_audit WHEN NEW.event='linked' BEGIN SELECT RAISE(ABORT,'synthetic');END",
  );
  const view = await f.bridge.submitOnce(f.context, key);
  assert.equal(view.state, "uncertain");
  assert.equal(f.count(), 1);
  f.raw.exec("DROP TRIGGER fail_bridge_link");
  assert.equal(
    (await f.bridge.submitOnce(f.context, key, true)).request_key,
    accepted.request_key,
  );
  assert.equal(f.count(), 1);
});
test("Task bridge: changed acceptance authority before commit leaves no durable approval", (t) => {
  const f = fixture(t),
    key = f.receive();
  let n = 0;
  const bridge = f.makeBridge({}, f.journal, () =>
    ++n === 1 ? { receiver_id: "b", actor_id: "operator" } : undefined,
  );
  assert.throws(() => bridge.accept(f.context, key), code("bridge_forbidden"));
  assert.throws(() => f.journal.get(key), code("bridge_not_found"));
  assert.equal(f.count(), 0);
});
test("Task bridge: changed authority during Task submit retains an unresolved key instead of false success", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  const bridge = f.makeBridge({
    submit: async (request) => {
      const task = await f.tasks.submit(request);
      f.state.enabled = false;
      return task;
    },
  });
  const result = await bridge.submitOnce(f.context, key);
  assert.equal(result.state, "uncertain");
  assert.equal(result.task, null);
  assert.equal(f.count(), 1);
});
test("Task bridge: HMAC or indexed-state tampering fails closed", (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  f.raw
    .prepare(
      "UPDATE task_bridge_links SET state='uncertain' WHERE message_id=?",
    )
    .run(key.message_id);
  assert.throws(() => f.journal.get(key), code("bridge_integrity_failed"));
});
test("Task bridge: private files, migration and fixed engine binding are required", (t) => {
  const f = fixture(t);
  assert.equal(statSync(f.path).mode & 0o077, 0);
  for (const patch of [
    { receiver_id: "c" },
    { binding: { ...f.binding, engine_id: "foreign" } },
    { fingerprint_key: new Uint8Array(32).fill(119) },
  ]) {
    const s = f.open(patch);
    assert.throws(() => s.migrate(), code("bridge_binding_mismatch"));
  }
  const bad = join(f.dir, "invalid.sqlite");
  assert.throws(
    () => new SQLiteTaskBridgeJournal(bad, { ...f.options, max_records: 0 }),
    code("invalid_bridge_options"),
  );
  assert.equal(existsSync(bad), false);
  const insecure = join(f.dir, "insecure.sqlite");
  writeFileSync(insecure, "");
  chmodSync(insecure, 0o644);
  assert.throws(
    () => new SQLiteTaskBridgeJournal(insecure, f.options),
    code("bridge_store_unavailable"),
  );
  const link = join(f.dir, "symlink.sqlite");
  symlinkSync(f.path, link);
  assert.throws(
    () => new SQLiteTaskBridgeJournal(link, f.options),
    code("bridge_store_unavailable"),
  );
});
test("Task bridge: missing schema objects do not auto-repair and audit capacity fails before Task IO", async (t) => {
  const f = fixture(t, { max_audit_records: 1 }),
    key = f.receive();
  f.bridge.accept(f.context, key);
  await assert.rejects(
    f.bridge.submitOnce(f.context, key),
    code("bridge_capacity_exceeded"),
  );
  assert.equal(f.calls.length, 0);
  f.raw.exec("DROP INDEX task_bridge_one_unresolved");
  const s = f.open();
  assert.throws(() => s.migrate(), code("unsupported_bridge_schema"));
});
test("Task bridge: task principal aliases and task-type permissions cannot change engine binding", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  for (const p of [
    { ...owner, subject: "foreign" },
    { ...owner, clientId: "foreign" },
    { ...owner, destination: "other" },
    { ...owner, operations: [] },
    { ...owner, taskTypes: ["shift_log_inventory"] },
  ]) {
    const tasks = new ConnectivityTaskPort(f.hub, f.binding, () => p);
    await assert.rejects(tasks.submit("br_test"), code("bridge_forbidden"));
  }
  assert.equal(f.count(), 0);
});
test("Task bridge: competing native journal connections claim only one attempt fence", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  const source = new URL(
    "../src/task-bridge/sqlite-journal.ts",
    import.meta.url,
  ).href;
  const run = () =>
    new Promise((resolve, reject) => {
      const w = new Worker(
        `
      const {parentPort,workerData:d}=require("node:worker_threads");
      import(d.source).then(({SQLiteTaskBridgeJournal})=>{
        const journal=new SQLiteTaskBridgeJournal(d.path,d.options);
        try{journal.migrate();parentPort.postMessage({job:journal.begin(d.key,false,()=>{})});}
        finally{journal.close();}
      }).catch(e=>parentPort.postMessage({error:e.code??"unknown"}));
    `,
        {
          eval: true,
          workerData: { source, path: f.path, options: f.options, key },
        },
      );
      t.after(() => w.terminate());
      w.once("message", resolve);
      w.once("error", reject);
    });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((r) => r.job).length, 1, JSON.stringify(results));
  assert.equal(
    results.filter((r) => r.error === "bridge_busy").length,
    1,
    JSON.stringify(results),
  );
  assert.equal(f.count(), 0);
});
test("Task bridge: asynchronous approval ports and commit guards fail closed", async (t) => {
  const f = fixture(t),
    key = f.receive();
  const bridge = f.makeBridge({}, f.journal, () =>
    Promise.reject(Error("synthetic")),
  );
  assert.throws(() => bridge.accept(f.context, key), code("bridge_forbidden"));
  const entry = f.inbox.inbox()[0];
  assert.throws(
    () => f.journal.prepare(entry, "operator", () => Promise.resolve()),
    code("bridge_forbidden"),
  );
  assert.throws(() => f.journal.get(key), code("bridge_not_found"));
  assert.equal(f.count(), 0);
});
test("Task bridge: terminal evidence cannot regress or be replaced by another Task ID", async (t) => {
  const f = fixture(t),
    key = f.receive();
  f.bridge.accept(f.context, key);
  await f.bridge.submitOnce(f.context, key);
  const running = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: running.id,
    fence: running.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const done = await f.bridge.observeOnce(f.context, key);
  assert.throws(
    () =>
      f.journal.observe(key, { ...done.task, id: "another-task" }, () => {}),
    code("bridge_task_regressed"),
  );
  assert.throws(
    () =>
      f.journal.observe(
        key,
        { ...done.task, state: "running", execution_open: 1, result: null },
        () => {},
      ),
    code("bridge_task_regressed"),
  );
  assert.equal(f.journal.get(key).task.state, "succeeded");
});
test("Task bridge: transaction-level rollback fails closed until explicit migration and keeps no approval", (t) => {
  const f = fixture(t),
    key = f.receive();
  f.raw.exec(
    "CREATE TRIGGER rollback_bridge BEFORE INSERT ON task_bridge_audit BEGIN SELECT RAISE(ROLLBACK,'synthetic');END",
  );
  assert.throws(
    () => f.bridge.accept(f.context, key),
    code("bridge_store_unavailable"),
  );
  assert.throws(() => f.journal.get(key), code("bridge_not_migrated"));
  f.raw.exec("DROP TRIGGER rollback_bridge");
  f.journal.migrate();
  assert.throws(() => f.journal.get(key), code("bridge_not_found"));
  assert.equal(f.count(), 0);
});
test("Task bridge: composed inbox and Task methods are captured before caller mutation", async (t) => {
  const f = fixture(t),
    key = f.receive();
  const service = {
    submit: f.hub.submit.bind(f.hub),
    get: f.hub.get.bind(f.hub),
  };
  const tasks = new ConnectivityTaskPort(service, f.binding, () => owner);
  const source = { withEntry: f.inbox.withEntry.bind(f.inbox) };
  const mutable = {
    binding: f.binding,
    submit: tasks.submit.bind(tasks),
    get: tasks.get.bind(tasks),
  };
  const bridge = new TaskBridge(f.journal, source, mutable, f.authorize);
  service.submit = () => assert.fail();
  mutable.submit = () => assert.fail();
  source.withEntry = () => assert.fail();
  bridge.accept(f.context, key);
  assert.equal((await bridge.submitOnce(f.context, key)).state, "linked");
  assert.equal(f.count(), 1);
});
