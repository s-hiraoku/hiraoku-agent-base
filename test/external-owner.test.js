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
        if (hooks.verify) await hooks.verify(launch, state);
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
