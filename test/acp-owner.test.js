import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAcpOwnerDriver } from "../src/owner-integrations/acp-stdio.ts";
import { startExternalOwner } from "../src/adapter-host/external-owner.ts";
import { syntheticStores, syntheticToken } from "./external-owner-fixture.js";
const executable = process.execPath;
const childPath = fileURLToPath(new URL("./acp-owner-child.js", import.meta.url));
function fixture(t, mode = "normal", patch = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hab-synthetic-acp-")), scope = new AbortController(), launchOwner = new AbortController();
  const state = { verifications: 0 }, binding = {};
  const options = { executable, args: [childPath, mode], cwd, sessionCwd: cwd,
    requestTimeoutMs: 1500, shutdownTimeoutMs: 200, lifetimeMs: 10000, scopeSignal: scope.signal,
    async verifyDeployment(commit) { state.verifications++; state.commit = commit; return binding; }, ...patch };
  const driver = createAcpOwnerDriver(options);
  const launch = Object.freeze({ generation: Object.freeze({}), signal: launchOwner.signal,
    mcp: Object.freeze({ type: "http", name: "synthetic-exclusive-acp", url: "http://127.0.0.1:1/mcp",
      headers: Object.freeze({ Authorization: `Bearer ${syntheticToken}` }) }) });
  t.after(async () => {
    await driver.close().catch(() => {});
    assert.equal(driver.status().state, "exited", "retain scratch unless this exact owned child exited");
    await driver.exited; rmSync(cwd, { recursive: true, force: true });
  });
  return { driver, launch, scope, launchOwner, state, binding, cwd,
    observations: () => JSON.parse(readFileSync(join(cwd, "synthetic-observations.json"))) };
}

test("ACP sends only initialize and one standard HTTP session/new; private receipt requires trusted scope verification", async t => {
  const f = fixture(t);
  const receipt = await f.driver.create(f.launch);
  assert.deepEqual(receipt, {}); assert.equal(Object.isFrozen(receipt), true);
  assert.equal(await f.driver.verifyCommitted(receipt, f.launch), f.binding);
  assert.equal(f.state.commit.sessionId, "synthetic-session"); assert.equal(f.state.commit.launch, f.launch);
  assert.deepEqual(f.observations().events, ["initialize", "session/new"]);
  await assert.rejects(f.driver.create(f.launch), /already_attempted/);
  assert.equal(f.state.verifications, 1);
  await f.driver.close(); assert.equal((await f.driver.exited).code, 0);
});

test("ACP split NDJSON frames and CRLF are parsed without a second create", async t => {
  const f = fixture(t, "split"); await f.driver.create(f.launch);
  assert.deepEqual(f.observations().events, ["initialize", "session/new"]);
});

for (const mode of ["version", "no-http", "malformed", "invalid-utf8", "oversize", "frame-flood", "byte-flood", "stderr-flood", "batch", "wrong-id", "duplicate", "error", "invalid-session", "permission", "filesystem", "lost-response", "partial-eof", "timeout-init"]) {
  test(`ACP fails closed for ${mode}, sanitizes errors and never retries native creation`, async t => {
    const f = fixture(t, mode);
    await assert.rejects(f.driver.create(f.launch), { message: "acp_create_failed" });
    await assert.rejects(f.driver.create(f.launch), /already_attempted/);
    await f.driver.close().catch(() => {});
    const events = f.observations().events;
    assert.ok(events.filter(value => value === "initialize").length <= 1);
    assert.ok(events.filter(value => value === "session/new").length <= 1);
    assert.equal(f.state.verifications, 0); assert.equal(f.driver.ownerSignal.aborted, true);
  });
}

test("ACP missing executable and invalid launch are sanitized and never retried", async t => {
  const missing = fixture(t, "normal", { executable: "/nonexistent/synthetic-acp" });
  await assert.rejects(missing.driver.create(missing.launch), { message: "acp_create_failed" });
  await assert.rejects(missing.driver.close(), /unclean_exit/);
  const invalid = fixture(t);
  await assert.rejects(invalid.driver.create({ ...invalid.launch, mcp: { ...invalid.launch.mcp, url: "http://localhost:1234/mcp" } }), /acp_create_failed/);
  await invalid.driver.close(); assert.equal((await invalid.driver.exited).started, false);
});

test("ACP rejects foreign receipts, another launch generation and repeated verification", async t => {
  for (const mode of ["receipt", "generation", "repeat"]) {
    const f = fixture(t), receipt = await f.driver.create(f.launch);
    if (mode === "repeat") await f.driver.verifyCommitted(receipt, f.launch);
    await assert.rejects(f.driver.verifyCommitted(mode === "receipt" ? {} : receipt,
      mode === "generation" ? { ...f.launch } : f.launch), { message: "acp_verification_failed" });
    assert.equal(f.state.verifications, mode === "repeat" ? 1 : 0);
  }
});

test("ACP scope loss, outer launch abort and protocol EOF fence native ownership", async t => {
  for (const reason of ["scope", "launch", "eof"]) {
    const f = fixture(t, reason === "eof" ? "eof-after" : "normal"), receipt = await f.driver.create(f.launch);
    if (reason === "scope") f.scope.abort();
    if (reason === "launch") f.launchOwner.abort();
    if (reason === "eof") await new Promise(resolve => f.driver.ownerSignal.addEventListener("abort", resolve, { once: true }));
    assert.equal(f.driver.ownerSignal.aborted, true);
    await assert.rejects(f.driver.verifyCommitted(receipt, f.launch), /verification_failed/);
    await f.driver.close();
  }
});

test("ACP late trusted verifier completion cannot revive an aborted owner", async t => {
  let resolveVerification;
  const f = fixture(t, "normal", { verifyDeployment: () => new Promise(resolve => { resolveVerification = resolve; }) });
  const receipt = await f.driver.create(f.launch), verification = f.driver.verifyCommitted(receipt, f.launch);
  f.scope.abort(); resolveVerification({});
  await assert.rejects(verification, /verification_failed/); await f.driver.close();
});

test("ACP does not inherit env or Node flags and discards native stderr", async t => {
  const saved = { ...process.env };
  process.env.NODE_OPTIONS = "--invalid-synthetic-option"; process.env.HAB_SYNTHETIC_SECRET_CANARY = syntheticToken;
  const f = fixture(t, "raw-output");
  try { await f.driver.create(f.launch); } finally { process.env = saved; }
  assert.equal(f.observations().cleanEnv, true); assert.deepEqual(f.observations().execArgv, []);
  assert.equal(JSON.stringify(f.driver.status()).includes(syntheticToken), false);
});

test("ACP finite shutdown only signals its owned child; forced termination is never graceful success", async t => {
  const f = fixture(t, "hang-close", { shutdownTimeoutMs: 50 }); await f.driver.create(f.launch);
  await assert.rejects(f.driver.close(), /unclean_exit/);
  assert.equal((await f.driver.exited).signal, "SIGKILL"); assert.equal(f.driver.status().forced, true);
});

test("ACP denied termination does not retry or escalate, and does not invent exit evidence", async t => {
  const f = fixture(t, "hang-close", { shutdownTimeoutMs: 50 }); await f.driver.create(f.launch);
  const original = ChildProcess.prototype.kill, attempts = [], owned = [];
  ChildProcess.prototype.kill = function (signal) {
    owned.push(this); attempts.push(signal); const error = Error("synthetic denied"); error.code = "EPERM"; throw error;
  };
  try {
    await assert.rejects(f.driver.close(), /exit_unconfirmed/); await delay(150);
    assert.deepEqual(attempts, ["SIGTERM"]); assert.equal(f.driver.status().state, "exit-unconfirmed");
  } finally {
    ChildProcess.prototype.kill = original;
    // This is test-only restoration of a synthetic denial, using the actual captured owned handle.
    original.call(owned[0], "SIGKILL"); await f.driver.exited;
  }
});

test("ACP and external owner bind only after eager discovery plus committed response; every tool stays denied", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "hab-synthetic-acp-owner-"));
  const scope = new AbortController(), stores = syntheticStores(cwd);
  let launch, owner;
  const realDriver = createAcpOwnerDriver({ executable, args: [childPath, "discover"], cwd, sessionCwd: cwd,
    requestTimeoutMs: 5000, shutdownTimeoutMs: 500, lifetimeMs: 10000, scopeSignal: scope.signal,
    async verifyDeployment(commit) { launch = commit.launch; return stores.binding; } });
  t.after(async () => {
    await owner?.stop().catch(() => {}); await realDriver.close().catch(() => {});
    assert.equal(realDriver.status().state, "exited"); await realDriver.exited; stores.close(); rmSync(cwd, { recursive: true, force: true });
  });
  owner = await startExternalOwner({ bearerToken: syntheticToken, serverName: "synthetic-exclusive-acp", lifetimeMs: 10000,
    shutdownTimeoutMs: 2000, ownerSignal: scope.signal, driver: realDriver, closeStores: () => {} });
  await owner.ready;
  const client = new Client({ name: "synthetic-post-commit", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(launch.mcp.url), { requestInit: { headers: launch.mcp.headers } }));
  for (const tool of (await client.listTools()).tools)
    assert.equal((await client.callTool({ name: tool.name, arguments: {} })).isError, true);
  assert.equal(stores.control.snapshot().paused, true); assert.equal(stores.network(), 0);
  await client.close(); await owner.stop(); await owner.completion;
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "synthetic-observations.json"))).events, ["initialize", "session/new", "discovery-denied"]);
});

test("ACP finite lifetime aborts an otherwise idle committed channel", async t => {
  const f = fixture(t, "normal", { lifetimeMs: 500 });
  await f.driver.create(f.launch);
  await f.driver.exited;
  assert.equal(f.driver.ownerSignal.aborted, true);
  await f.driver.close();
});

for (const mode of ["normal", "discovery-lost-response"]) {
  test(`ACP external owner cannot bind ${mode === "normal" ? "without current discovery" : "from discovery alone after response loss"}`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "hab-synthetic-acp-failure-")), scope = new AbortController();
    let verified = 0, closed = 0, owner;
    const driver = createAcpOwnerDriver({ executable, args: [childPath, mode], cwd, sessionCwd: cwd,
      requestTimeoutMs: 1000, shutdownTimeoutMs: 300, lifetimeMs: 10000, scopeSignal: scope.signal,
      async verifyDeployment() { verified++; throw Error("must not verify without committed discovery"); } });
    t.after(async () => {
      await owner?.stop().catch(() => {}); await driver.close().catch(() => {});
      assert.equal(driver.status().state, "exited"); await driver.exited; rmSync(cwd, { recursive: true, force: true });
    });
    owner = await startExternalOwner({ bearerToken: syntheticToken, serverName: "synthetic-exclusive-acp", lifetimeMs: 10000,
      shutdownTimeoutMs: 2000, ownerSignal: scope.signal, driver, closeStores: () => { closed++; } });
    await assert.rejects(owner.ready, /create_or_verification_failed/);
    await assert.rejects(owner.completion, /create_or_verification_failed/);
    assert.equal(verified, 0); assert.equal(closed, 1);
    const events = JSON.parse(readFileSync(join(cwd, "synthetic-observations.json"))).events;
    assert.equal(events.filter(value => value === "session/new").length, 1);
  });
}

test("ACP close shares one cleanup promise before synchronous owner-signal reentry", async t => {
  for (const start of [false, true]) {
    const f = fixture(t);
    let ends = 0;
    if (start) {
      const emit = ChildProcess.prototype.emit, children = [];
      ChildProcess.prototype.emit = function (event, ...args) {
        if (event === "spawn") children.push(this);
        return emit.call(this, event, ...args);
      };
      try { await f.driver.create(f.launch); } finally { ChildProcess.prototype.emit = emit; }
      assert.equal(children.length, 1);
      const stream = children[0].stdin, end = stream.end.bind(stream);
      stream.end = (...args) => { ends++; return end(...args); };
    }
    let nested;
    f.driver.ownerSignal.addEventListener("abort", () => { nested = f.driver.close(); }, { once: true });
    const first = f.driver.close();
    assert.equal(first, nested);
    assert.equal(f.driver.ownerSignal.aborted, true);
    await first; await nested;
    assert.equal((await f.driver.exited).started, start);
    assert.equal(ends, start ? 1 : 0);
    assert.equal(f.driver.status().forced, false);
  }
});

for (const reason of ["stop", "scope"]) {
  test(`ACP composed with current owner fences ${reason} with one shared stop and confirmed child exit before stores`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "hab-acp-main-composition-"));
    const scope = new AbortController(), stores = syntheticStores(cwd);
    let closed = 0, owner, nested;
    const driver = createAcpOwnerDriver({ executable, args: [childPath, "discover"], cwd, sessionCwd: cwd,
      requestTimeoutMs: 5000, shutdownTimeoutMs: 500, lifetimeMs: 10000, scopeSignal: scope.signal,
      async verifyDeployment() { return stores.binding; } });
    t.after(async () => {
      await owner?.stop().catch(() => {}); await driver.close().catch(() => {});
      assert.equal(driver.status().state, "exited"); await driver.exited;
      stores.close(); rmSync(cwd, { recursive: true, force: true });
    });
    owner = await startExternalOwner({ bearerToken: syntheticToken, serverName: "synthetic-acp-main",
      lifetimeMs: 10000, shutdownTimeoutMs: 2000, ownerSignal: scope.signal, driver,
      closeStores() {
        assert.equal(driver.status().state, "exited", "store release follows confirmed native exit");
        closed++;
      } });
    const ready = await owner.ready;
    driver.ownerSignal.addEventListener("abort", () => { nested = owner.stop(); }, { once: true });
    if (reason === "scope") scope.abort();
    const first = owner.stop();
    assert.equal(nested, first); assert.equal(owner.stop(), first);
    await first; await owner.completion;
    assert.equal(closed, 1); assert.equal(owner.status().phase, "stopped");
    assert.deepEqual(await driver.exited, { started: true, code: 0, signal: null });
    assert.equal(driver.status().forced, false); assert.equal(stores.network(), 0);
    assert.equal(stores.control.snapshot().paused, true);
    await assert.rejects(globalThis.fetch(ready.url));
  });
}


for (const fault of ["malformed", "unmatched", "stderr-limit", "partial-eof", "utf8-eof", "valid-no-newline"]) {
  test(`ACP post-bind ${fault} remains failure after clean child exit and retains stores`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "hab-acp-postbind-fault-"));
    const scope = new AbortController(), stores = syntheticStores(cwd);
    let closed = 0, owner;
    const driver = createAcpOwnerDriver({ executable, args: [childPath, `discover-fault-${fault}`], cwd, sessionCwd: cwd,
      requestTimeoutMs: 5000, shutdownTimeoutMs: 1000, lifetimeMs: 10000, scopeSignal: scope.signal,
      async verifyDeployment() { return stores.binding; } });
    t.after(async () => {
      await owner?.stop().catch(() => {}); await driver.close().catch(() => {});
      assert.equal(driver.status().state, "exited"); await driver.exited;
      stores.close(); rmSync(cwd, { recursive: true, force: true });
    });
    owner = await startExternalOwner({ bearerToken: syntheticToken, serverName: "synthetic-acp-fault",
      lifetimeMs: 10000, shutdownTimeoutMs: 4000, ownerSignal: scope.signal, driver,
      closeStores() { closed++; } });
    const ready = await owner.ready;
    const failure = assert.rejects(owner.completion);
    writeFileSync(join(cwd, "synthetic-release-fault"), "synthetic-only");
    await failure;
    await assert.rejects(driver.close(), { message: "acp_owner_protocol_failed" });
    await assert.rejects(owner.stop(), { message: "external_owner_cleanup_failed" });
    assert.equal(owner.status().phase, "stopping"); assert.equal(closed, 0);
    assert.deepEqual(await driver.exited, { started: true, code: 0, signal: null });
    assert.equal(driver.status().forced, false); assert.equal(stores.network(), 0);
    await assert.rejects(globalThis.fetch(ready.url));
  });
}

for (const mode of ["shutdown-malformed", "shutdown-utf8"]) {
  test(`ACP ${mode} is not hidden by graceful scope shutdown`, async t => {
    const f = fixture(t, mode);
    const receipt = await f.driver.create(f.launch);
    await f.driver.verifyCommitted(receipt, f.launch);
    f.scope.abort();
    await assert.rejects(f.driver.close(), { message: "acp_owner_protocol_failed" });
    assert.deepEqual(await f.driver.exited, { started: true, code: 0, signal: null });
    assert.equal(f.driver.status().forced, false);
  });
}

for (const tail of ["clean-eof", "partial-eof", "utf8-eof"]) {
  test(`ACP process exit before stdout drain waits for ${tail}`, async t => {
    const f = fixture(t, `tail-${tail}`);
    const emit = ChildProcess.prototype.emit, children = [];
    ChildProcess.prototype.emit = function (event, ...args) {
      if (event === "spawn") children.push(this);
      return emit.call(this, event, ...args);
    };
    try {
      const receipt = await f.driver.create(f.launch);
      await f.driver.verifyCommitted(receipt, f.launch);
    } finally { ChildProcess.prototype.emit = emit; }
    assert.equal(children.length, 1);
    const child = children[0], stdoutEmit = child.stdout.emit, childEmit = child.emit;
    const queued = [];
    // Hold only notifications on this actual owned child's streams. The real child
    // exits by itself; replay preserves their order but places exit before drain.
    child.stdout.emit = function (event, ...args) {
      if (["data", "end", "close"].includes(event)) { queued.push(() => stdoutEmit.call(this, event, ...args)); return true; }
      return stdoutEmit.call(this, event, ...args);
    };
    child.emit = function (event, ...args) {
      if (event === "close") { queued.push(() => childEmit.call(this, event, ...args)); return true; }
      return childEmit.call(this, event, ...args);
    };
    t.after(() => { child.stdout.emit = stdoutEmit; child.emit = childEmit; });
    writeFileSync(join(f.cwd, "synthetic-release-fault"), "synthetic-only");
    await f.driver.exited;
    let settled = false;
    const closing = f.driver.close();
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await delay(20);
    const settledBeforeDrain = settled;
    child.stdout.emit = stdoutEmit; child.emit = childEmit;
    for (const release of queued) release();
    if (tail === "clean-eof") await closing;
    else await assert.rejects(closing, { message: "acp_owner_protocol_failed" });
    assert.equal(settledBeforeDrain, false, "process exit is not pipe-drain evidence");
    assert.equal(f.driver.status().forced, false);
  });
}

for (const missing of ["end", "close"]) {
test(`ACP missing pipe ${missing} cannot certify successful drain`, async t => {
  const f = fixture(t);
  const emit = ChildProcess.prototype.emit, children = [];
  ChildProcess.prototype.emit = function (event, ...args) {
    if (event === "spawn") children.push(this);
    return emit.call(this, event, ...args);
  };
  try { await f.driver.create(f.launch); } finally { ChildProcess.prototype.emit = emit; }
  const stream = missing === "end" ? children[0].stdout : children[0], streamEmit = stream.emit;
  stream.emit = function (event, ...args) { return event === missing ? true : streamEmit.call(this, event, ...args); };
  try { await assert.rejects(f.driver.close(), { message: "acp_owner_drain_unconfirmed" }); }
  finally { stream.emit = streamEmit; }
  assert.deepEqual(await f.driver.exited, { started: true, code: 0, signal: null });
});

}

for (const reply of ["result", "error", "malformed", "duplicate"]) {
  test(`ACP canceled in-flight request permits only one well-formed correlated ${reply} during drain`, async t => {
    const f = fixture(t, `cancel-response-${reply}`);
    const creation = assert.rejects(f.driver.create(f.launch), { message: "acp_create_failed" });
    for (let i = 0; i < 100; i++) {
      try { if (f.observations().events.includes("session/new")) break; } catch {}
      await delay(10);
    }
    assert.ok(f.observations().events.includes("session/new"));
    f.scope.abort(); await creation;
    if (["result", "error"].includes(reply)) await f.driver.close();
    else await assert.rejects(f.driver.close(), { message: "acp_owner_protocol_failed" });
    assert.deepEqual(await f.driver.exited, { started: true, code: 0, signal: null });
    assert.equal(f.state.verifications, 0);
  });
}
