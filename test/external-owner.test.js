import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startExternalOwner } from "../src/adapter-host/external-owner.ts";
import { superviseExternalOwner } from "../src/adapter-host/owner-process.ts";
import { syntheticStores, syntheticToken } from "./external-owner-fixture.js";

const directory = () => mkdtempSync(join(tmpdir(), "hab-external-owner-"));
async function connect(launch) {
  const client = new Client({ name: "synthetic-owner-driver", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(launch.mcp.url), { requestInit: { headers: launch.mcp.headers } });
  await client.connect(transport);
  return { client, transport };
}
async function fixture(t, hooks = {}) {
  const dir = directory(), stores = syntheticStores(dir);
  let owner;
  t.after(async () => {
    await owner?.stop().catch(() => {});
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const controller = new AbortController(), nativeOwner = new AbortController();
  const state = { creates: 0, verifications: 0, closes: 0, storeCloses: 0 };
  const options = {
    bearerToken: syntheticToken, serverName: "synthetic-exclusive-server", lifetimeMs: 10000,
    shutdownTimeoutMs: 100, ownerSignal: controller.signal,
    driver: {
      ownerSignal: nativeOwner.signal,
      async create(launch) {
        state.creates++; state.launch = launch;
        if (hooks.create) return hooks.create(launch, state);
        state.connection = await connect(launch);
        return state.result = Object.freeze({ syntheticCommitted: true });
      },
      async verifyCommitted(result, launch) {
        state.verifications++;
        assert.equal(result, state.result); assert.equal(launch, state.launch);
        if (hooks.verify) await hooks.verify(launch, state, stores);
        return stores.binding;
      },
      async close() {
        state.closes++;
        if (hooks.close) await hooks.close();
        await state.connection?.client.close();
      },
    },
    closeStores() { state.storeCloses++; },
    ...hooks.options,
  };
  owner = await startExternalOwner(options);
  return { owner, state, stores, controller, nativeOwner };
}

test("external owner owns loopback HTTP; discovery and committed binding stay deny-only", async t => {
  const f = await fixture(t, { verify: async (_launch, state) => {
    const tools = await state.connection.client.listTools();
    assert.equal(tools.tools.length, 6);
    assert.equal((await state.connection.client.callTool({ name: "recipient_receive", arguments: {} })).isError, true);
  } });
  const ready = await f.owner.ready;
  assert.equal(ready.phase, "bound-deny");
  assert.equal(f.state.creates, 1); assert.equal(f.state.verifications, 1);
  assert.equal(f.stores.control.snapshot().paused, true);
  for (const tool of (await f.state.connection.client.listTools()).tools)
    assert.equal((await f.state.connection.client.callTool({ name: tool.name, arguments: {} })).isError, true);
  assert.equal(f.stores.network(), 0);
  assert.deepEqual(Object.keys(f.owner).sort(), ["completion", "ready", "status", "stop"]);
  const response = await globalThis.fetch(ready.url);
  assert.equal(response.status, 401); assert.equal(response.headers.get("location"), null);
  const invalid = await globalThis.fetch(ready.url, { method: "OPTIONS", headers: f.state.launch.mcp.headers });
  assert.equal(invalid.status, 403); assert.equal(invalid.headers.get("location"), null);
  await f.owner.stop(); await f.owner.completion;
  assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 1);
  assert.equal(f.owner.status().phase, "stopped");
  await assert.rejects(globalThis.fetch(ready.url));
});

test("synchronous native owner loss during stop shares one cleanup attempt", async t => {
  const f = await fixture(t);
  const ready = await f.owner.ready;
  let reenteredStop;
  f.state.launch.signal.addEventListener("abort", () => {
    assert.equal(f.owner.status().phase, "stopping");
    f.nativeOwner.abort();
    reenteredStop = f.owner.stop();
  }, { once: true });
  const firstStop = f.owner.stop();
  assert.equal(f.state.launch.signal.aborted, true, "stop fences synchronously");
  await firstStop; await reenteredStop; await f.owner.completion;
  assert.equal(reenteredStop, firstStop);
  assert.equal(f.owner.stop(), firstStop);
  assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 1);
  assert.equal(f.owner.status().phase, "stopped");
  assert.equal(f.stores.network(), 0);
  await assert.rejects(globalThis.fetch(ready.url));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("owner loss before creation never invokes the driver and closes allocated resources", async () => {
  for (const timing of ["before-start", "while-listening"]) {
    const controller = new AbortController();
    let creates = 0, closes = 0, storeCloses = 0;
    if (timing === "before-start") controller.abort();
    const starting = startExternalOwner({
      bearerToken: syntheticToken, serverName: "synthetic-precreate", lifetimeMs: 10000,
      shutdownTimeoutMs: 100, ownerSignal: controller.signal,
      driver: { ownerSignal: new AbortController().signal,
        async create() { creates++; }, async verifyCommitted() { throw Error("unexpected_verification"); },
        async close() { closes++; } },
      closeStores() { storeCloses++; },
    });
    controller.abort();
    await assert.rejects(starting, { message: timing === "before-start" ? "invalid_external_owner" : "external_owner_start_failed" });
    assert.equal(creates, 0);
    assert.equal(closes, timing === "before-start" ? 0 : 1);
    assert.equal(storeCloses, timing === "before-start" ? 0 : 1);
  }
});

test("startup cancellation rejects readiness but preserves successful cleanup", async t => {
  for (const stage of ["create", "verify"]) for (const reason of ["stop", "owner", "native", "reentrant"]) {
    const entered = deferred(), work = deferred();
    const hook = async () => { entered.resolve(); return work.promise; };
    const f = await fixture(t, { [stage]: hook, close: async () => { work.resolve({ syntheticCommitted: true }); } });
    await entered.promise;
    if (reason === "reentrant") f.state.launch.signal.addEventListener("abort", () => f.nativeOwner.abort(), { once: true });
    if (reason === "owner") f.controller.abort();
    else if (reason === "native") f.nativeOwner.abort();
    const stopped = f.owner.stop();
    await assert.rejects(f.owner.ready);
    await stopped; await f.owner.completion;
    assert.equal(f.owner.stop(), stopped);
    assert.equal(f.owner.status().phase, "stopped");
    assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 1);
    assert.equal(f.state.verifications, stage === "create" ? 0 : 1);
    assert.equal(f.stores.network(), 0);
    await assert.rejects(globalThis.fetch(f.state.launch.mcp.url));
  }
});

test("real startup errors during stop remain failures even if named like cancellation", async t => {
  for (const stage of ["create", "verify"]) {
    const entered = deferred(), work = deferred();
    const hook = async () => { entered.resolve(); return work.promise; };
    const f = await fixture(t, { [stage]: hook, close: async () => { work.reject(Error("external_owner_stopping")); } });
    await entered.promise;
    const stopped = f.owner.stop();
    await assert.rejects(f.owner.ready, { message: "external_owner_create_or_verification_failed" });
    await stopped;
    await assert.rejects(f.owner.completion, { message: "external_owner_create_or_verification_failed" });
    assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 1);
  }
});

test("startup cancellation never masks driver or store cleanup failure", async t => {
  for (const failing of ["driver", "stores"]) {
    let storeAttempts = 0;
    const entered = deferred(), work = deferred();
    const f = await fixture(t, {
      create: async () => { entered.resolve(); return work.promise; },
      close: async () => { work.resolve({}); if (failing === "driver") throw Error(syntheticToken); },
      ...(failing === "stores" ? { options: { closeStores() { storeAttempts++; throw Error(syntheticToken); } } } : {}),
    });
    await entered.promise;
    await assert.rejects(f.owner.stop(), { message: "external_owner_cleanup_failed" });
    await assert.rejects(f.owner.completion, { message: "external_owner_cleanup_failed" });
    await assert.rejects(f.owner.ready);
    assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 0);
    assert.equal(storeAttempts, failing === "stores" ? 1 : 0);
  }
});

test("ambiguous native create is never retried or verified and its secret-bearing error is sanitized", async t => {
  const f = await fixture(t, { create: async (launch, state) => {
    state.connection = await connect(launch);
    throw Error(`uncertain native response: ${syntheticToken}`);
  } });
  await assert.rejects(f.owner.ready, { message: "external_owner_create_or_verification_failed" });
  await assert.rejects(f.owner.completion, { message: "external_owner_create_or_verification_failed" });
  assert.equal(f.state.creates, 1); assert.equal(f.state.verifications, 0);
  assert.equal(f.state.storeCloses, 1); assert.equal(f.stores.network(), 0);
  await assert.rejects(globalThis.fetch(f.state.launch.mcp.url));
});

test("native create without current MCP discovery cannot promote", async t => {
  const f = await fixture(t, { create: async () => ({ syntheticCommitted: true }) });
  await assert.rejects(f.owner.ready, /create_or_verification_failed/);
  await assert.rejects(f.owner.completion, /create_or_verification_failed/);
  assert.equal(f.state.verifications, 0); assert.equal(f.stores.network(), 0);
});

test("discovery replaced while native verification is pending cannot bind the stale receipt", async t => {
  const f = await fixture(t, { verify: async (launch, state) => {
    await state.connection.transport.terminateSession(); await state.connection.client.close();
    state.connection = await connect(launch);
  } });
  await assert.rejects(f.owner.ready, /create_or_verification_failed/);
  await assert.rejects(f.owner.completion, /create_or_verification_failed/);
  assert.equal(f.stores.network(), 0); assert.equal(f.state.storeCloses, 1);
});

test("owner loss and finite expiry close listener and never carry authority into another generation", async t => {
  for (const reason of ["owner-loss", "native-owner-loss", "expiry"]) {
    const f = await fixture(t, { options: { lifetimeMs: reason === "expiry" ? 1000 : 10000 } });
    const ready = await f.owner.ready;
    if (reason === "owner-loss") f.controller.abort();
    if (reason === "native-owner-loss") f.nativeOwner.abort();
    await f.owner.completion;
    await assert.rejects(globalThis.fetch(ready.url));
    assert.equal(f.state.closes, 1); assert.equal(f.stores.network(), 0);
  }
});

test("unsettled native create expires finitely, retains stores, and late completion never binds", async t => {
  let resolveCreate;
  const f = await fixture(t, { options: { lifetimeMs: 50, shutdownTimeoutMs: 30 },
    create: () => new Promise(resolve => { resolveCreate = resolve; }) });
  await assert.rejects(f.owner.completion, /cleanup_failed/);
  await assert.rejects(f.owner.ready, /cleanup_failed/);
  assert.equal(f.state.storeCloses, 0);
  resolveCreate({ syntheticCommitted: true }); await delay(10);
  assert.equal(f.state.verifications, 0); assert.equal(f.stores.network(), 0);
  await assert.rejects(globalThis.fetch(f.state.launch.mcp.url));
});

test("driver cleanup failure closes HTTP but retains stores and reports incomplete cleanup", async t => {
  const f = await fixture(t, { close: async () => { throw Error(syntheticToken); } });
  const ready = await f.owner.ready;
  await assert.rejects(f.owner.stop(), { message: "external_owner_cleanup_failed" });
  await assert.rejects(f.owner.completion, { message: "external_owner_cleanup_failed" });
  assert.equal(f.state.storeCloses, 0);
  await assert.rejects(globalThis.fetch(ready.url));
  await f.state.connection.client.close();
});

test("store cleanup exceptions are sanitized for both stop and completion", async t => {
  const f = await fixture(t, { options: { closeStores: () => { throw Error(syntheticToken); } } });
  await f.owner.ready;
  await assert.rejects(f.owner.stop(), { message: "external_owner_cleanup_failed" });
  await assert.rejects(f.owner.completion, { message: "external_owner_cleanup_failed" });
});

async function child(t, mode, patch = {}) {
  const cwd = directory();
  writeFileSync(join(cwd, "synthetic-config.json"), JSON.stringify({ mode }), { mode: 0o600 });
  const controller = new AbortController();
  const supervisor = superviseExternalOwner({ ownerModule: fileURLToPath(new URL("./external-owner-child.js", import.meta.url)),
    cwd, lifetimeMs: 10000, shutdownTimeoutMs: 1000, ownerSignal: controller.signal, ...patch });
  t.after(async () => {
    await supervisor.stop().catch(() => {});
    assert.equal(supervisor.status().state, "exited", "retain synthetic scratch until child exit is confirmed");
    await supervisor.exited;
    rmSync(cwd, { recursive: true, force: true });
  });
  return { supervisor, cwd, controller };
}

test("clean-env supervised owner ignores parent secrets, proxy settings and NODE_OPTIONS; confirms cleanup and exit", async t => {
  const saved = { ...process.env };
  process.env.HAB_SYNTHETIC_SECRET_CANARY = syntheticToken;
  process.env.HTTPS_PROXY = "http://synthetic-invalid.invalid";
  process.env.NODE_OPTIONS = "--this-synthetic-option-must-not-reach-the-child";
  let c;
  try { c = await child(t, "normal"); } finally { process.env = saved; }
  const ready = await c.supervisor.ready;
  assert.equal(ready.phase, "bound-deny");
  assert.equal(JSON.parse(readFileSync(join(c.cwd, "factory-started.json"))).cleanEnvironment, true);
  c.controller.abort(); await c.supervisor.completion;
  assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
  await assert.rejects(globalThis.fetch(ready.url));
});

test("independent supervisor bounds blocked factory startup and labels forced exit as failure", async t => {
  const c = await child(t, "hang-before", { lifetimeMs: 3000, shutdownTimeoutMs: 100 });
  await assert.rejects(c.supervisor.completion, /forced_stop/);
  await assert.rejects(c.supervisor.ready, /not_ready/);
  assert.equal(existsSync(join(c.cwd, "factory-started.json")), true);
  assert.equal(existsSync(join(c.cwd, "stores-closed.json")), false);
});

test("supervisor terminates an event-loop-blocked owned HTTP process, never reports graceful cleanup", async t => {
  const c = await child(t, "hang-after", { lifetimeMs: 10000, shutdownTimeoutMs: 100 });
  const ready = await c.supervisor.ready;
  await delay(100);
  void c.supervisor.stop().catch(() => {});
  await assert.rejects(c.supervisor.completion, /forced_stop/);
  assert.equal(existsSync(join(c.cwd, "stores-closed.json")), false);
  await assert.rejects(globalThis.fetch(ready.url));
});

test("supervisor suppresses raw child stdout/stderr and secret-bearing native exceptions", async t => {
  const c = await child(t, "secret-failure");
  await assert.rejects(c.supervisor.ready, { message: "owner_process_not_ready" });
  await assert.rejects(c.supervisor.completion, { message: "owner_process_unclean_exit" });
  assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
  const { url } = JSON.parse(readFileSync(join(c.cwd, "listener.json")));
  await assert.rejects(globalThis.fetch(url));
});

test("an unconfirmed kill is bounded failure, not exit evidence or a blind retry", async t => {
  for (const disconnected of [false, true]) {
    const originalKill = ChildProcess.prototype.kill, originalEmit = ChildProcess.prototype.emit;
    const ownedChildren = [], signals = [];
    ChildProcess.prototype.emit = function (event, ...args) {
      if (event === "spawn") ownedChildren.push(this);
      return originalEmit.call(this, event, ...args);
    };
    ChildProcess.prototype.kill = function (signal) {
      signals.push(signal);
      this.emit("error", Object.assign(Error(syntheticToken), { code: "EPERM" }));
      this.emit("error", Object.assign(Error(syntheticToken), { code: "EPERM" }));
      return false;
    };
    let c;
    try {
      c = await child(t, "hang-after", { lifetimeMs: 10000, shutdownTimeoutMs: 100 });
      await c.supervisor.ready; await delay(100);
      assert.equal(ownedChildren.length, 1);
      if (disconnected) ownedChildren[0].disconnect();
      void c.supervisor.stop().catch(() => {});
      await assert.rejects(c.supervisor.completion, { message: "owner_process_exit_unconfirmed" });
      await delay(150); // A failed TERM must not later escalate to KILL.
      assert.deepEqual(signals, [disconnected ? "SIGTERM" : "SIGKILL"]);
      assert.deepEqual(c.supervisor.status(), { state: "exit-unconfirmed", forced: !disconnected });
    } finally {
      ChildProcess.prototype.kill = originalKill; ChildProcess.prototype.emit = originalEmit;
      // This simulated refusal is not an OS denial. The fixture still owns this exact child.
      if (ownedChildren[0]) originalKill.call(ownedChildren[0], "SIGKILL");
      if (c) await c.supervisor.exited;
    }
    assert.equal(c.supervisor.status().state, "exited");
    await assert.rejects(c.supervisor.completion, /exit_unconfirmed/);
  }
});

test("supervised cancellation during create or verification confirms clean child exit", async t => {
  for (const stage of ["create", "verify"]) {
    const c = await child(t, `pending-${stage}`);
    for (let attempt = 0; attempt < 300 && !existsSync(join(c.cwd, "startup-pending.json")); attempt++) await delay(10);
    assert.equal(existsSync(join(c.cwd, "startup-pending.json")), true);
    await c.supervisor.stop();
    await c.supervisor.completion;
    assert.deepEqual(await c.supervisor.exited, { code: 0, signal: null });
    await assert.rejects(c.supervisor.ready, /not_ready/);
    assert.equal(c.supervisor.status().state, "exited");
    assert.equal(c.supervisor.status().forced, false);
    assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
    const { url } = JSON.parse(readFileSync(join(c.cwd, "listener.json")));
    await assert.rejects(globalThis.fetch(url));
  }
});

async function factoryPending(c) {
  for (let attempt = 0; attempt < 300 && !existsSync(join(c.cwd, "factory-pending.json")); attempt++) await delay(10);
  assert.equal(existsSync(join(c.cwd, "factory-pending.json")), true);
}
const cleanupTrace = c => readFileSync(join(c.cwd, "cleanup.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

test("late factory fulfillment on repeated IPC stop, owner loss or lifetime closes returned resources once", async t => {
  for (const trigger of ["stop", "abort", "lifetime", "native"]) {
    const c = await child(t, trigger === "native" ? "late-owner-loss" : "late-success", trigger === "lifetime" ? { lifetimeMs: 1500 } : {});
    await factoryPending(c);
    if (trigger === "stop") { void c.supervisor.stop(); void c.supervisor.stop(); }
    if (trigger === "abort") c.controller.abort();
    await c.supervisor.completion;
    assert.deepEqual(await c.supervisor.exited, { code: 0, signal: null });
    await assert.rejects(c.supervisor.ready, /not_ready/);
    assert.deepEqual(cleanupTrace(c), ["driver-close-start", "driver-close-end", "stores-close-start"]);
    assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
    assert.equal(existsSync(join(c.cwd, "listener.json")), false);
    assert.equal(c.supervisor.status().forced, false);
  }
});

test("late factory cleanup errors and timeouts remain bounded unclean exits with safe close ordering", async t => {
  for (const stage of ["driver", "store"]) for (const fault of ["failure", "timeout"]) {
    const c = await child(t, `late-${stage}-${fault}`);
    await factoryPending(c);
    await assert.rejects(c.supervisor.stop(), { message: "owner_process_unclean_exit" });
    assert.deepEqual(await c.supervisor.exited, { code: 1, signal: null });
    await assert.rejects(c.supervisor.ready, /not_ready/);
    assert.deepEqual(cleanupTrace(c), stage === "driver" ? ["driver-close-start"] : ["driver-close-start", "driver-close-end", "stores-close-start"]);
    assert.equal(existsSync(join(c.cwd, "stores-closed.json")), false);
    assert.equal(existsSync(join(c.cwd, "listener.json")), false);
    assert.equal(c.supervisor.status().forced, false);
  }
});

test("late factory rejection retains factory ownership and is never reported as graceful cancellation", async t => {
  const c = await child(t, "late-reject");
  await factoryPending(c);
  await assert.rejects(c.supervisor.stop(), /unclean_exit/);
  assert.deepEqual(await c.supervisor.exited, { code: 1, signal: null });
  assert.deepEqual(cleanupTrace(c), ["factory-rejected-cleanup"]);
});

test("late factory fulfillment after IPC disconnect or termination signal closes resources before exit", async t => {
  for (const trigger of ["disconnect", "SIGTERM", "SIGINT"]) {
    const originalEmit = ChildProcess.prototype.emit;
    const ownedChildren = [];
    ChildProcess.prototype.emit = function (event, ...args) {
      if (event === "spawn") ownedChildren.push(this);
      return originalEmit.call(this, event, ...args);
    };
    let c;
    try {
      c = await child(t, "late-success");
      await factoryPending(c);
    } finally { ChildProcess.prototype.emit = originalEmit; }
    assert.equal(ownedChildren.length, 1);
    if (trigger === "disconnect") ownedChildren[0].disconnect();
    else assert.equal(ownedChildren[0].kill(trigger), true);
    if (trigger === "disconnect") await assert.rejects(c.supervisor.completion, /unclean_exit/);
    else await c.supervisor.completion;
    assert.deepEqual(await c.supervisor.exited, { code: 0, signal: null });
    assert.deepEqual(cleanupTrace(c), ["driver-close-start", "driver-close-end", "stores-close-start"]);
    assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
    assert.equal(existsSync(join(c.cwd, "listener.json")), false);
    assert.equal(c.supervisor.status().forced, false);
  }
});


test("trusted local bound hook activates existing controls without adding a remote grant API", async t => {
  let controls, calls = 0, polls = 0;
  const f = await fixture(t, {
    verify: (_launch, _state, stores) => {
      stores.binding.hostOptions.transport = () => ({
        agentId: "synthetic-recipient", activeRequests: 0,
        async poll() { polls++; return null; },
        async ack() { throw Error("unexpected_ack"); },
        async submit() { throw Error("unexpected_submit"); },
        async status() { throw Error("unexpected_status"); },
      });
    },
    options: { onBound: async value => {
      controls = value; calls++;
      assert.equal(Object.isFrozen(controls), true);
      assert.deepEqual(Object.keys(controls).sort(), ["pause", "resume", "signal", "status", "updatePermission"]);
      assert.equal(controls.status().paused, true);
      const state = controls.updatePermission(controls.status().epoch, true);
      assert.equal(state.paused, true, "grant alone does not resume");
      controls.resume(state.epoch);
    } },
  });
  assert.equal((await f.owner.ready).phase, "bound");
  assert.equal(calls, 1); assert.equal(controls.status().paused, false);
  assert.equal(f.state.creates, 1); assert.equal(f.state.verifications, 1);
  const client = f.state.connection.client;
  assert.equal((await client.callTool({ name: "recipient_receive", arguments: {} })).isError, false);
  assert.equal(polls, 1);
  assert.equal((await client.listTools()).tools.length, 6);
  assert.deepEqual(Object.keys(f.owner).sort(), ["completion", "ready", "status", "stop"]);
  assert.equal((await client.callTool({ name: "recipient_resume", arguments: {} })).isError, true);
  const oldEpoch = controls.status().epoch;
  controls.pause(oldEpoch);
  assert.throws(() => controls.resume(oldEpoch), /epoch/);
  assert.equal((await client.callTool({ name: "recipient_receive", arguments: {} })).isError, true);
  controls.updatePermission(controls.status().epoch, false);
  controls.resume(controls.status().epoch);
  assert.equal((await client.callTool({ name: "recipient_receive", arguments: {} })).isError, true);
  assert.equal(polls, 1);
  await f.owner.stop(); await f.owner.completion;
  assert.equal(controls.signal.aborted, true);
  for (const method of ["status", "pause", "resume", "updatePermission"])
    assert.throws(() => controls[method](0, true), /external_owner_controls_unavailable/);
  assert.equal(f.state.storeCloses, 1);
});

test("bound hook is opt-in and never resumes or grants by its presence", async t => {
  let controls;
  const f = await fixture(t, { options: { onBound: value => { controls = value; } } });
  assert.equal((await f.owner.ready).phase, "bound");
  assert.equal(controls.status().paused, true);
  controls.resume(controls.status().epoch);
  assert.equal((await f.state.connection.client.callTool({ name: "recipient_receive", arguments: {} })).isError, true);
  assert.equal(f.stores.network(), 0);
  await f.owner.stop(); await f.owner.completion;
});

test("binding failure never exposes trusted local controls", async t => {
  let calls = 0;
  const f = await fixture(t, { verify: () => { throw Error("synthetic_verification_rejected"); },
    options: { onBound: () => { calls++; } } });
  await assert.rejects(f.owner.ready, /external_owner_create_or_verification_failed/);
  await assert.rejects(f.owner.completion, /external_owner_create_or_verification_failed/);
  assert.equal(calls, 0); assert.equal(f.stores.network(), 0);
});

test("bound hook failure is sanitized and fences captured controls", async t => {
  let controls;
  const f = await fixture(t, { options: { onBound: value => {
    controls = value;
    controls.updatePermission(controls.status().epoch, true);
    controls.resume(controls.status().epoch);
    throw Error("synthetic_private_callback_failure");
  } } });
  await assert.rejects(f.owner.ready, { message: "external_owner_create_or_verification_failed" });
  await assert.rejects(f.owner.completion, { message: "external_owner_create_or_verification_failed" });
  assert.equal(controls.signal.aborted, true);
  assert.throws(() => controls.resume(0), /external_owner_controls_unavailable/);
  assert.equal(f.state.closes, 1); assert.equal(f.state.storeCloses, 1);
});

test("stop during bound hook retains stores until callback settles and prevents late activation", async t => {
  const entered = deferred(), pending = deferred();
  let controls;
  const f = await fixture(t, { options: { onBound: async value => {
    controls = value; entered.resolve(); await pending.promise;
    assert.throws(() => controls.updatePermission(controls.status().epoch, true), /external_owner_controls_unavailable/);
  } } });
  await entered.promise;
  const stopping = f.owner.stop();
  assert.equal(controls.signal.aborted, true);
  await delay(10);
  assert.equal(f.state.storeCloses, 0);
  pending.resolve();
  await assert.rejects(f.owner.ready, /external_owner_stopping|stopped_before_ready/);
  await stopping; await f.owner.completion;
  assert.equal(f.state.storeCloses, 1); assert.equal(f.state.closes, 1);
  assert.equal(f.stores.network(), 0);
});

test("unsettled bound hook fails cleanup and retains stores even after late fulfillment", async t => {
  const entered = deferred(), pending = deferred();
  let controls;
  const f = await fixture(t, { options: { shutdownTimeoutMs: 20, onBound: async value => {
    controls = value; entered.resolve(); await pending.promise;
  } } });
  await entered.promise;
  await assert.rejects(f.owner.stop(), /external_owner_cleanup_failed/);
  await assert.rejects(f.owner.completion, /external_owner_cleanup_failed/);
  await assert.rejects(f.owner.ready);
  assert.equal(f.state.storeCloses, 0);
  assert.throws(() => controls.resume(0), /external_owner_controls_unavailable/);
  pending.resolve(); await delay(10);
  assert.equal(f.state.storeCloses, 0, "late settlement never retries failed cleanup");
});

test("native owner loss inside bound hook cannot return ready or regrant", async t => {
  const entered = deferred();
  let controls;
  const f = await fixture(t, { options: { onBound: async value => {
    controls = value; entered.resolve(); await delay(10);
  } } });
  await entered.promise;
  f.nativeOwner.abort();
  await assert.rejects(f.owner.ready, /external_owner_stopping|stopped_before_ready/);
  await f.owner.completion;
  assert.equal(controls.signal.aborted, true);
  assert.throws(() => controls.updatePermission(0, true), /external_owner_controls_unavailable/);
  assert.equal(f.state.storeCloses, 1); assert.equal(f.state.closes, 1);
});


test("supervised factory reports exact bound phase and refuses malformed ready metadata", async t => {
  for (const mode of ["local-controls", "local-controls-malformed"]) {
    const c = await child(t, mode);
    const ready = await c.supervisor.ready;
    assert.equal(ready.phase, "bound");
    assert.notEqual(ready.url, "http://127.0.0.1:1/mcp");
    assert.deepEqual(JSON.parse(readFileSync(join(c.cwd, "local-controls.json"))), { paused: false });
    await c.supervisor.stop(); await c.supervisor.completion; await c.supervisor.exited;
    assert.equal(existsSync(join(c.cwd, "stores-closed.json")), true);
    await assert.rejects(globalThis.fetch(ready.url));
  }
});
