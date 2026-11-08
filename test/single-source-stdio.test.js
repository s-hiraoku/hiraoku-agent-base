import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startLocalBroker } from "../scripts/lib/nats-broker.mjs";

async function until(read, timeout = 5000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (performance.now() >= deadline) throw Error("single_source_fixture_timeout");
    await delay(10);
  }
}

/** Parent owns broker/scratch; child owns only borrowed synthetic host stores. */
async function fixture(t, { lifetimeMs = 15000, mode = "normal" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hab-single-source-stdio-"));
  let broker, transport, client, stderrDone, closed;
  let diagnostics = "";
  const closeClient = async () => {
    await client?.close();
    if (stderrDone) {
      const timeout = new AbortController();
      try {
        await Promise.race([stderrDone, delay(5000, undefined, { signal: timeout.signal })
          .then(() => { throw Error("single_source_stderr_timeout"); })]);
      } finally { timeout.abort(); }
    }
  };
  t.after(() => closed ??= (async () => {
    try { await closeClient(); }
    finally {
      await broker?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  })());
  broker = await startLocalBroker(join(directory, "broker"));
  writeFileSync(join(directory, "broker.json"), JSON.stringify({
    server: broker.server, user: broker.user, password: broker.password,
  }), { mode: 0o600 });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./single-source-stdio-child.js", import.meta.url))],
    env: { HAB_TEST_SINGLE_SOURCE_DIRECTORY: directory,
      HAB_TEST_SINGLE_SOURCE_LIFETIME_MS: String(lifetimeMs), TMPDIR: directory,
      HAB_TEST_SINGLE_SOURCE_MODE: mode,
      NODE_NO_WARNINGS: "1" },
    stderr: "pipe",
  });
  stderrDone = new Promise((resolve) => transport.stderr.once("end", resolve));
  transport.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  client = new Client({ name: "synthetic-single-source-recipient", version: "1" });
  await client.connect(transport);
  const ready = await until(() => existsSync(join(directory, "ready.json")) &&
    JSON.parse(readFileSync(join(directory, "ready.json"), "utf8")));
  let sequence = 0;
  const command = async (op) => {
    const id = ++sequence;
    const path = join(directory, "command.json");
    writeFileSync(`${path}.tmp`, JSON.stringify({ id, op }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    const response = await until(() => {
      const path = join(directory, "response.json");
      if (!existsSync(path)) return;
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value.id === id ? value : undefined;
    });
    assert.equal(response.ok, true, response.error);
    return response.value;
  };
  const proof = () => JSON.parse(readFileSync(join(directory, "cleanup.json"), "utf8"));
  return { client, transport, ready, command, closeClient, proof,
    diagnostics: () => diagnostics,
    call: (op, args = {}) => client.callTool({ name: `recipient_${op}`, arguments: args }),
    networkEntered: () => existsSync(join(directory, "network-entered.json")),
    stopFailed: () => existsSync(join(directory, "stop-failed.json")) &&
      JSON.parse(readFileSync(join(directory, "stop-failed.json"), "utf8")),
    cleanupExists: () => existsSync(join(directory, "cleanup.json")) };
}

test("single-source stdio: starts denied and paused; only the local owner can grant/resume", async (t) => {
  const f = await fixture(t);
  assert.equal(f.ready.status.paused, true);
  assert.equal(f.ready.status.owner, "held");
  assert.deepEqual((await f.client.listTools()).tools.map((tool) => tool.name), [
    "recipient_receive", "recipient_send", "recipient_inbox_read", "recipient_answer_prepare",
    "recipient_answer_inspect", "recipient_answer_enqueue",
  ]);
  assert.equal((await f.call("receive")).isError, true);
  for (const name of ["pause", "resume", "control", "updatePermission", "message_enqueue", "task_submit"])
    assert.equal((await f.call(name)).isError, true);
  assert.equal((await f.command("state")).outbox.length, 0);
  assert.equal((await f.command("state")).taskCount, 0);
  assert.equal((await f.command("grant")).paused, true);
  assert.equal((await f.call("receive")).isError, true);
  await f.command("resume");
  assert.equal((await f.call("receive")).isError, false);
  await f.closeClient();
  assert.deepEqual(f.proof(), { paused: true, running: false, draining: 0,
    ownerReleased: true, storesClosed: true });
  assert.doesNotMatch(f.diagnostics(), /SINGLE_SOURCE_SIGTERM|CLEANUP_FAILED/);
});

test("single-source stdio: exact source/reply roundtrip and revocation protect the dedicated outbox", async (t) => {
  const f = await fixture(t);
  await f.command("grant");
  await f.command("resume");
  assert.equal((await f.call("receive")).isError, false);
  const source = f.ready.source;
  const wrongSource = { ...source, message_id: "different-source" };
  assert.equal((await f.call("inbox_read", { source: wrongSource })).isError, true);
  assert.equal((await f.call("inbox_read", { source, context: {} })).isError, true);
  const read = JSON.parse((await f.call("inbox_read", { source })).content[0].text);
  assert.equal(read.origin, "external_agent");
  assert.equal(read.result.value.receipt_confirmed, true);
  assert.deepEqual(read.result.value.message, f.ready.message);
  assert.equal((await f.command("state")).outbox.length, 0);
  const body = { parts: [{ type: "text", text: "Synthetic single-source stdio answer" }] };
  assert.equal((await f.call("answer_prepare", { source, body })).isError, false);
  const prepared = JSON.parse((await f.call("answer_inspect", { source })).content[0].text);
  assert.equal((await f.call("answer_enqueue", { source })).isError, false);
  assert.equal((await f.call("answer_enqueue", { source })).isError, false);
  const before = await f.command("state");
  assert.equal(before.outbox.length, 1);
  assert.equal(before.taskCount, 0);
  await f.command("revoke");
  await f.command("resume");
  assert.equal((await f.call("send")).isError, true);
  assert.equal((await f.call("inbox_read", { source })).isError, true);
  assert.deepEqual((await f.command("state")).outbox, before.outbox);
  await f.command("grant");
  await f.command("resume");
  assert.equal((await f.call("send")).isError, false);
  const reply = await f.command("reply");
  assert.equal(reply.message_id, prepared.result.value.reply_id);
  assert.deepEqual(reply.in_reply_to, source);
  assert.deepEqual(reply.body, body);
  await f.closeClient();
  assert.equal(f.proof().ownerReleased, true);
  assert.match(f.diagnostics(), /SINGLE_SOURCE_CLEANUP_OK/);
  assert.doesNotMatch(f.diagnostics(), /SINGLE_SOURCE_SIGTERM|CLEANUP_FAILED/);
});

test("single-source stdio: finite expiry pauses and releases owner before closing caller stores", async (t) => {
  const f = await fixture(t, { lifetimeMs: 5000 });
  await f.command("grant");
  await f.command("resume");
  assert.equal((await f.command("state")).status.paused, false);
  await until(f.cleanupExists, 10000);
  await f.closeClient();
  assert.equal(f.proof().paused, true);
  assert.equal(f.proof().ownerReleased, true);
  assert.equal(f.proof().storesClosed, true);
  assert.match(f.diagnostics(), /SINGLE_SOURCE_CLEANUP_OK/);
  assert.doesNotMatch(f.diagnostics(), /SINGLE_SOURCE_SIGTERM|CLEANUP_FAILED/);
});

test("single-source stdio: client EOF triggers graceful stop before SDK termination fallback", async (t) => {
  const f = await fixture(t);
  await f.command("grant");
  await f.command("resume");
  await f.closeClient();
  assert.equal(f.cleanupExists(), true, f.diagnostics());
  assert.equal(f.proof().ownerReleased, true);
  assert.equal(f.proof().paused, true);
  assert.match(f.diagnostics(), /SINGLE_SOURCE_EOF/);
  assert.match(f.diagnostics(), /SINGLE_SOURCE_CLEANUP_OK/);
  assert.doesNotMatch(f.diagnostics(), /SINGLE_SOURCE_SIGTERM|CLEANUP_FAILED/);
});

test("single-source stdio: drain timeout retains owner/stores, fences late RPC and permits explicit stop retry", async (t) => {
  const f = await fixture(t, { mode: "drain" });
  await f.command("grant");
  await f.command("resume");
  await f.command("hold");
  const pending = f.call("receive");
  await until(f.networkEntered);
  const stopped = await f.command("stop");
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.error, "recipient_stdio_drain_timeout");
  assert.equal(stopped.status.paused, true);
  assert.equal(stopped.status.owner, "held");
  assert.equal(stopped.status.running, true);
  const failed = await until(f.stopFailed);
  assert.equal(failed.error, "recipient_stdio_drain_timeout");
  assert.equal(failed.status.owner, "held");
  assert.equal(f.cleanupExists(), false);
  await f.command("release");
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).result.state, "incomplete");
  const state = await f.command("state");
  assert.equal(state.status.paused, true);
  assert.equal(state.status.running, false);
  assert.equal(state.status.draining, 0);
  assert.equal(state.status.owner, "held");
  assert.equal(state.inboxCount, 0); // The delayed poll result never passed the pause/epoch guard.
  assert.equal(state.outbox.length, 0);
  assert.equal(state.taskCount, 0);
  assert.equal((await f.command("stop")).stopped, true);
  await until(f.cleanupExists);
  await f.closeClient();
  assert.equal(f.proof().ownerReleased, true);
  assert.equal(f.proof().storesClosed, true);
  assert.match(f.diagnostics(), /SINGLE_SOURCE_CLEANUP_OK/);
  assert.doesNotMatch(f.diagnostics(), /SINGLE_SOURCE_SIGTERM|CLEANUP_FAILED/);
});
