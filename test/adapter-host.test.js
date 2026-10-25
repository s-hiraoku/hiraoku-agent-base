import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  hostFixture,
  deferred,
  HOST_LEASE_MS,
} from "./adapter-host-fixtures.js";
import { code, worker, RESPONSE } from "./task-bridge-fixtures.js";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function question(f) {
  const source = f.submit();
  assert.equal((await f.step({ op: "receive" })).state, "done");
  return source;
}
test("Adapter host: fresh gate is paused; missing authority cannot resume or use a mailbox", async (t) => {
  const f = hostFixture(t);
  assert.equal(f.host.status(f.context).paused, true);
  await assert.rejects(f.step({ op: "receive" }), code("host_paused"));
  const denied = f.makeHost({ authorization: undefined });
  assert.throws(() => denied.status(f.context), code("host_forbidden"));
  assert.throws(
    () => denied.setPaused(f.context, false, 0),
    code("host_forbidden"),
  );
  await assert.rejects(
    denied.stepOnce(f.context, { op: "send" }),
    code("host_forbidden"),
  );
  assert.equal(f.state.tools.length, 0);
  assert.equal(f.count(), 0);
});
test("Adapter host: finite MCP question-answer-ACK path uses explicit actions without Tasks", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const { key } = await question(f);
  assert.deepEqual(f.state.tools, ["relay_poll", "relay_ack"]);
  assert.equal(f.queued().length, 0);
  assert.equal(f.count(), 0);
  const list = await f.step({ op: "inbox" });
  assert.equal(list.value[0].receipt_confirmed, true);
  assert.equal("body" in list.value[0], false);
  const message = f.answer(key);
  assert.equal(
    (await f.step({ op: "answer", source: key, message })).state,
    "done",
  );
  assert.equal((await f.step({ op: "send" })).state, "done");
  const delivery = f.service.poll(f.contexts.a);
  assert.equal(delivery.message.message_id, message.message_id);
  f.service.ack(f.contexts.a, {
    sender_id: "b",
    message_id: message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "host-answer-ack",
  });
  assert.equal(
    f.service.status(f.contexts.b, message.message_id).state,
    "acked",
  );
  await f.step({ op: "answer", source: key, message });
  await f.step({ op: "send" });
  assert.equal(f.service.poll(f.contexts.a), null);
  assert.equal(f.count(), 0);
});
test("Adapter host: stop and restart preserve state and require current epoch for resume", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.pause();
  const b = f.open();
  b.migrate();
  const restarted = f.makeHost({ control: b });
  assert.equal(restarted.status(f.context).paused, true);
  await assert.rejects(
    restarted.stepOnce(f.context, { op: "receive" }),
    code("host_paused"),
  );
  assert.throws(
    () => restarted.setPaused(f.context, false, 0),
    code("host_epoch_changed"),
  );
  f.resume(restarted);
  assert.equal(
    (await restarted.stepOnce(f.context, { op: "receive" })).state,
    "done",
  );
  assert.equal(f.audit().length, 3);
});
test("Adapter host: stopped operations do not claim queues or read new inbox entries", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const { key } = await question(f),
    message = f.answer(key);
  await f.step({ op: "answer", source: key, message });
  f.pause();
  for (const op of ["send", "receive", "inbox"])
    await assert.rejects(f.step({ op }), code("host_paused"));
  assert.equal(f.queued()[0].state, "queued");
  assert.equal(f.queued()[0].submit_attempts, 0);
});
test("Adapter host: source names and fake context never authenticate a caller", async (t) => {
  const f = hostFixture(t);
  f.resume();
  await assert.rejects(
    f.host.stepOnce({ agent_id: "b", actor_id: "operator" }, { op: "receive" }),
    code("host_forbidden"),
  );
  await assert.rejects(
    f.step({ op: "receive", agent_id: "b" }),
    code("invalid_host_command"),
  );
  assert.equal(f.state.tools.length, 0);
});
test("Adapter host: decorated promises cannot act as synchronous authority", async (t) => {
  const f = hostFixture(t);
  const host = f.makeHost({
    authorization: () =>
      Object.assign(Promise.resolve(), { agent_id: "b", actor_id: "operator" }),
  });
  assert.throws(
    () => host.setPaused(f.context, false, 0),
    code("host_forbidden"),
  );
  assert.equal(f.control.snapshot().epoch, 0);
});
test("Adapter host: operation permissions remain separate", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.state.denied.add("receive");
  await assert.rejects(f.step({ op: "receive" }), code("host_forbidden"));
  assert.equal((await f.step({ op: "inbox" })).state, "done");
  f.state.denied.add("control");
  assert.throws(() => f.pause(), code("host_forbidden"));
});
test("Adapter host: a stop during poll discards late delivery and sends no ACK", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.submit();
  f.state.afterNetwork = async (tool) => {
    if (tool === "relay_poll") f.pause();
  };
  const result = await f.step({ op: "receive" });
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "host_epoch_changed");
  assert.deepEqual(f.state.tools, ["relay_poll"]);
  assert.equal(f.inbox.inbox().length, 0);
});
test("Adapter host: a stop after remote ACK preserves the exact local ACK request for recovery", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const { key } = f.submit();
  f.state.afterNetwork = async (tool) => {
    if (tool === "relay_ack") f.pause();
  };
  assert.equal((await f.step({ op: "receive" })).reason, "host_epoch_changed");
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
  const request = f.inboxRaw
    .prepare("SELECT request_id FROM relay_receiver_acks")
    .get().request_id;
  f.state.afterNetwork = null;
  f.resume();
  f.inboxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
  assert.equal((await f.step({ op: "receive" })).state, "done");
  assert.equal(f.inbox.inbox()[0].receipt_confirmed, true);
  assert.equal(
    f.inboxRaw.prepare("SELECT request_id FROM relay_receiver_acks").get()
      .request_id,
    request,
  );
});
test("Adapter host: a stop after remote submit retains sending lease and same reply ID", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const { key } = await question(f),
    message = f.answer(key);
  await f.step({ op: "answer", source: key, message });
  f.state.afterNetwork = async (tool) => {
    if (tool === "relay_submit") f.pause();
  };
  assert.equal((await f.step({ op: "send" })).reason, "host_epoch_changed");
  assert.equal(f.queued()[0].state, "sending");
  assert.equal(
    f.service.status(f.contexts.b, message.message_id).state,
    "pending",
  );
  f.state.afterNetwork = null;
  f.resume();
  await sleep(HOST_LEASE_MS + 50);
  assert.equal((await f.step({ op: "send" })).state, "done");
  assert.equal(f.queued().length, 1);
  assert.equal(f.queued()[0].message_id, message.message_id);
  assert.equal(f.queued()[0].state, "accepted");
  assert.equal(f.count(), 0);
});
test("Adapter host: same-instance concurrent commands are refused while RPC is pending", async (t) => {
  const f = hostFixture(t),
    wait = deferred(),
    started = deferred();
  f.resume();
  f.state.credential = () => {
    started.resolve();
    return wait.promise;
  };
  const pending = f.step({ op: "receive" });
  await started.promise;
  await assert.rejects(f.step({ op: "send" }), code("host_busy"));
  assert.equal(f.host.status(f.context).running, true);
  wait.resolve("Bearer fixture-b");
  assert.equal((await pending).state, "done");
});
test("Adapter host: timed-out credential work retains admission until the provider settles", async (t) => {
  const f = hostFixture(t),
    wait = deferred();
  f.resume();
  f.state.timeout_ms = 30;
  f.state.credential = () => wait.promise;
  assert.equal((await f.step({ op: "receive" })).state, "incomplete");
  assert.equal(f.host.status(f.context).draining, 1);
  await assert.rejects(f.step({ op: "receive" }), code("host_busy"));
  f.pause();
  f.resume();
  wait.resolve("Bearer fixture-b");
  await sleep(10);
  assert.equal(f.state.tools.length, 0);
  f.state.credential = () => "Bearer fixture-b";
  f.state.timeout_ms = 1000;
  assert.equal((await f.step({ op: "receive" })).state, "done");
});
test("Adapter host: stopped credential resolution cannot start a late network request after resume", async (t) => {
  const f = hostFixture(t),
    wait = deferred(),
    started = deferred();
  f.resume();
  f.state.credential = () => {
    started.resolve();
    return wait.promise;
  };
  const pending = f.step({ op: "receive" });
  await started.promise;
  f.pause();
  f.resume();
  wait.resolve("Bearer fixture-b");
  assert.equal((await pending).reason, "host_epoch_changed");
  assert.equal(f.state.tools.length, 0);
  f.state.credential = () => "Bearer fixture-b";
  assert.equal((await f.step({ op: "receive" })).state, "done");
});
test("Adapter host: timed-out fetch work retains admission without dropping old epoch fences", async (t) => {
  const f = hostFixture(t),
    wait = deferred();
  f.resume();
  f.state.timeout_ms = 30;
  f.state.afterNetwork = () => wait.promise;
  assert.equal((await f.step({ op: "receive" })).state, "incomplete");
  assert.equal(f.host.status(f.context).draining, 1);
  await assert.rejects(f.step({ op: "send" }), code("host_busy"));
  f.pause();
  f.resume();
  wait.resolve();
  await sleep(10);
  f.state.afterNetwork = null;
  assert.equal((await f.step({ op: "receive" })).state, "done");
});
test("Adapter host: authorization revoked during RPC stops later save and ACK", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.submit();
  f.state.afterNetwork = async () => {
    f.state.enabled = false;
  };
  const result = await f.step({ op: "receive" });
  assert.equal(result.reason, "host_forbidden");
  assert.equal(f.inbox.inbox().length, 0);
  assert.deepEqual(f.state.tools, ["relay_poll"]);
});
test("Adapter host: actor change during RPC cannot borrow the original actor's admission", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.submit();
  f.state.afterNetwork = async () => {
    f.state.actor = "another-operator";
  };
  assert.equal((await f.step({ op: "receive" })).reason, "host_forbidden");
  assert.equal(f.inbox.inbox().length, 0);
});
test("Adapter host: Task delivery does not execute until separate explicit accept and submit", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const { key } = f.submit("execution_request", {
    body: {
      parts: [
        {
          type: "data",
          schema_id: "task.execution_request",
          schema_version: 1,
          value: { task_type: "connectivity_check" },
        },
      ],
    },
  });
  await f.step({ op: "receive" });
  assert.equal(f.count(), 0);
  assert.equal(
    (await f.step({ op: "task_accept", source: key })).state,
    "done",
  );
  assert.equal(f.count(), 0);
  f.state.denied.add("task_submit");
  await assert.rejects(
    f.step({ op: "task_submit", source: key }),
    code("host_forbidden"),
  );
  assert.equal(f.count(), 0);
  f.state.denied.delete("task_submit");
  const linked = await f.step({ op: "task_submit", source: key });
  assert.equal(linked.value.task.state, "queued");
  assert.equal(f.count(), 1);
  await f.step({
    op: "task_reply_prepare",
    source: key,
    kind: "execution_accepted",
  });
  await f.step({
    op: "task_reply_enqueue",
    source: key,
    kind: "execution_accepted",
  });
  await f.step({ op: "send" });
  const delivery = f.service.poll(f.contexts.a);
  assert.equal(delivery.message.kind, "execution_accepted");
  f.service.ack(f.contexts.a, {
    sender_id: "b",
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "task-accepted-ack",
  });
  const task = await f.hub.claim(worker, {});
  await f.hub.complete(worker, {
    id: task.id,
    fence: task.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  await f.step({ op: "task_observe", source: key });
  await f.step({
    op: "task_reply_prepare",
    source: key,
    kind: "execution_result",
  });
  await f.step({
    op: "task_reply_enqueue",
    source: key,
    kind: "execution_result",
  });
  await f.step({ op: "send" });
  assert.equal(f.service.poll(f.contexts.a).message.kind, "execution_result");
  assert.equal(f.count(), 1);
});
test("Adapter host: Task RPC stop keeps unknown submission for same-key restart reconciliation", async (t) => {
  const f = hostFixture(t),
    wait = deferred(),
    started = deferred();
  f.resume();
  const { key } = f.submit("execution_request", {
    body: {
      parts: [
        {
          type: "data",
          schema_id: "task.execution_request",
          schema_version: 1,
          value: { task_type: "connectivity_check" },
        },
      ],
    },
  });
  await f.step({ op: "receive" });
  await f.step({ op: "task_accept", source: key });
  const original = f.journal.get(key).request_key;
  const host = f.makeHost({
    task: {
      journal: f.journal,
      tasks: {
        binding: f.binding,
        submit: async (requestKey) => {
          const task = await f.tasks.submit(requestKey);
          started.resolve();
          await wait.promise;
          return task;
        },
        get: f.tasks.get.bind(f.tasks),
      },
    },
  });
  const pending = host.stepOnce(f.context, { op: "task_submit", source: key });
  await started.promise;
  f.pause();
  f.resume();
  wait.resolve();
  assert.equal((await pending).reason, "host_epoch_changed");
  assert.equal(f.journal.get(key).state, "submitting");
  assert.equal(f.count(), 1);
  await sleep(HOST_LEASE_MS + 50);
  const result = await f.step({
    op: "task_submit",
    source: key,
    reconcile: true,
  });
  assert.equal(result.value.state, "linked");
  assert.equal(result.value.request_key, original);
  assert.equal(f.count(), 1);
});
test("Adapter host: missing Task binding refuses explicit Task commands", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const host = f.makeHost({ task: undefined });
  assert.equal(
    (
      await host.stepOnce(f.context, {
        op: "task_accept",
        source: { sender_id: "a", message_id: "missing" },
      })
    ).reason,
    "host_task_unconfigured",
  );
  assert.equal(f.count(), 0);
});
test("Adapter host: unknown failure text is redacted and never becomes a reply", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const host = f.makeHost({
    transport: () => {
      throw Error("synthetic private detail");
    },
  });
  const result = await host.stepOnce(f.context, { op: "receive" });
  assert.equal(result.reason, "host_step_unavailable");
  assert.equal(JSON.stringify(result).includes("private detail"), false);
  assert.equal(f.queued().length, 0);
});
test("Adapter host: a different bound transport is refused before network IO", async (t) => {
  const f = hostFixture(t);
  f.resume();
  const host = f.makeHost({
    transport: () => ({
      agentId: "c",
      activeRequests: 0,
      submit() {},
      status() {},
      poll() {},
      ack() {},
    }),
  });
  assert.equal(
    (await host.stepOnce(f.context, { op: "receive" })).reason,
    "invalid_host_composition",
  );
  assert.equal(f.state.tools.length, 0);
});
test("Adapter host: control audit reserves a stop slot when history capacity is reached", async (t) => {
  const f = hostFixture(t, { max_audit_records: 2 });
  f.resume();
  f.pause();
  assert.equal(f.audit().length, 2);
  assert.throws(() => f.resume(), code("host_control_capacity_exceeded"));
  assert.equal(f.host.status(f.context).paused, true);
  await assert.rejects(f.step({ op: "receive" }), code("host_paused"));
});
test("Adapter host: failed pause persistence is not success and latches the local gate unavailable", async (t) => {
  const f = hostFixture(t);
  f.resume();
  f.controlRaw.exec(
    "CREATE TRIGGER fail_pause BEFORE INSERT ON adapter_host_audit BEGIN SELECT RAISE(ABORT,'synthetic');END",
  );
  assert.throws(() => f.pause(), code("host_store_unavailable"));
  await assert.rejects(f.step({ op: "send" }), code("host_not_migrated"));
  assert.equal(f.state.tools.length, 0);
  f.controlRaw.exec("DROP TRIGGER fail_pause");
  f.control.migrate();
  assert.equal(f.host.status(f.context).paused, false);
  f.pause();
  assert.equal(f.host.status(f.context).paused, true);
});
test("Adapter host: metadata or audit tampering rejects further work", async (t) => {
  for (const which of ["meta", "audit"]) {
    const f = hostFixture(t);
    f.resume();
    if (which === "meta")
      f.controlRaw.exec("UPDATE adapter_host_meta SET data='{}'");
    else
      f.controlRaw.exec(
        "DROP TRIGGER adapter_host_audit_retain; DELETE FROM adapter_host_audit",
      );
    await assert.rejects(
      f.step({ op: "receive" }),
      code("host_integrity_failed"),
    );
    assert.equal(f.state.tools.length, 0);
  }
});
test("Adapter host: private control files, binding and immutable audit schema are required", (t) => {
  const f = hostFixture(t);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const patch of [
    { agent_id: "c" },
    { fingerprint_key: new Uint8Array(32).fill(99) },
    { max_audit_records: 30 },
  ]) {
    const s = f.open(patch);
    assert.throws(() => s.migrate(), code("host_integrity_failed"));
  }
  const link = join(f.dir, "host-link");
  symlinkSync(f.path, link);
  assert.throws(() => f.open({}, link), code("host_store_unavailable"));
  chmodSync(f.path, 0o644);
  assert.throws(() => f.open(), code("host_store_unavailable"));
  chmodSync(f.path, 0o600);
  f.controlRaw.exec("DROP TRIGGER adapter_host_audit_identity");
  const s = f.open();
  assert.throws(() => s.migrate(), code("unsupported_host_schema"));
});
test("Adapter host: a denied or changed control actor cannot commit a resume", (t) => {
  const f = hostFixture(t);
  let n = 0;
  const host = f.makeHost({
    authorization: () => ({
      agent_id: "b",
      actor_id: ++n === 1 ? "operator-1" : "operator-2",
    }),
  });
  assert.throws(
    () => host.setPaused(f.context, false, 0),
    code("host_forbidden"),
  );
  assert.equal(f.control.snapshot().paused, true);
  assert.equal(f.audit().length, 0);
});
test("Adapter host: native control writers cannot both win the same resume epoch", async (t) => {
  const f = hostFixture(t);
  const moduleUrl = new URL(
    "../src/adapter-host/sqlite-control.ts",
    import.meta.url,
  ).href;
  const source = `
    const { parentPort,workerData:d } = require("node:worker_threads");
    (async()=>{const { SQLiteHostControl }=await import(d.moduleUrl);
      const s=new SQLiteHostControl(d.path,d.options);
      try {s.migrate();try{s.setPaused(false,0,"operator",()=>{});parentPort.postMessage("resumed");}
        catch(e){parentPort.postMessage(e.code);}}finally{s.close();}
    })().catch(e=>{throw e;});
  `;
  const outcomes = await Promise.all(
    [1, 2].map(
      () =>
        new Promise((resolve, reject) => {
          const w = new Worker(source, {
            eval: true,
            workerData: { moduleUrl, path: f.path, options: f.controlOptions },
          });
          let value;
          w.once("message", (x) => {
            value = x;
          });
          w.once("error", reject);
          w.once("exit", (n) =>
            n === 0 && value ? resolve(value) : reject(Error("worker exit")),
          );
        }),
    ),
  );
  assert.deepEqual(outcomes.sort(), ["host_epoch_changed", "resumed"]);
  assert.equal(f.control.snapshot().epoch, 1);
});
test("Adapter host: real loopback HTTP MCP receives and sends through the fixed client", async (t) => {
  const f = hostFixture(t),
    server = createServer();
  let handle;
  server.on("request", (req, res) => {
    void handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/mcp";
  handle = createRelayNodeHandler(f.gateway({ resource_url: url }));
  f.state.resource_url = url;
  const host = f.makeHost({ network: globalThis.fetch });
  f.resume(host);
  try {
    const { key } = f.submit();
    assert.equal(
      (await host.stepOnce(f.context, { op: "receive" })).state,
      "done",
    );
    const message = f.answer(key);
    await host.stepOnce(f.context, { op: "answer", source: key, message });
    assert.equal(
      (await host.stepOnce(f.context, { op: "send" })).state,
      "done",
    );
    assert.equal(
      f.service.poll(f.contexts.a).message.message_id,
      message.message_id,
    );
    assert.equal(f.count(), 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("Adapter host: a completed command cannot reuse its captured fetch admission", async (t) => {
  const f = hostFixture(t);
  f.resume();
  assert.equal((await f.step({ op: "receive" })).state, "done");
  const fetch = f.state.fetchPorts[0],
    before = f.state.tools.length;
  await assert.rejects(
    async () => fetch(f.state.resource_url),
    code("host_session_closed"),
  );
  assert.equal(f.state.tools.length, before);
});

test("Adapter host: a request abandoned by a failed gate guard retains its network slot", async (t) => {
  const f = hostFixture(t),
    wait = deferred();
  f.resume();
  const host = f.makeHost({
    network: () => {
      f.state.enabled = false;
      return wait.promise;
    },
  });
  assert.equal(
    (await host.stepOnce(f.context, { op: "receive" })).reason,
    "host_forbidden",
  );
  f.state.enabled = true;
  assert.equal(host.status(f.context).draining, 1);
  await assert.rejects(
    host.stepOnce(f.context, { op: "send" }),
    code("host_busy"),
  );
  const response = new Response("synthetic abandoned response");
  wait.resolve(response);
  await sleep(10);
  assert.equal(host.status(f.context).draining, 0);
  assert.equal(response.bodyUsed, true);
  assert.equal(f.queued().length, 0);
});
