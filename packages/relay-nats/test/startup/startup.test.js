import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { fixture } from "./fixture.js";
import { startupCases } from "./startup-cases.js";
import { prepareNatsServer } from "../../../scripts/lib/nats-input.mjs";

const sentinel = "synthetic-startup-private-marker";
const diagnosticKeys = [
  "attempts",
  "elapsed_ms",
  "exit_code",
  "generation",
  "last_connection_code",
  "pid",
  "reason",
  "signal",
  "spawn_error_code",
  "stderr_bytes",
];
function diagnostic(error, { config, binary }) {
  assert.ok(error instanceof Error);
  assert.ok(error.message.startsWith("broker startup "));
  assert.ok(Buffer.byteLength(error.message) < 2048);
  assert.equal(error.message.includes(sentinel), false);
  assert.equal(error.message.includes(config), false);
  assert.equal(error.message.includes(binary), false);
  const password = /user: backend, password: "([^"]+)"/.exec(
    readFileSync(config, "utf8"),
  )[1];
  assert.equal(error.message.includes(password), false);
  const record = JSON.parse(error.message.slice("broker startup ".length));
  assert.deepEqual(Object.keys(record).sort(), diagnosticKeys);
  assert.equal(record.generation, 1);
  assert.ok(Number.isInteger(record.attempts) && record.attempts >= 0);
  assert.ok(Number.isFinite(record.elapsed_ms) && record.elapsed_ms >= 0);
  assert.ok(Number.isInteger(record.stderr_bytes) && record.stderr_bytes >= 0);
  assert.deepEqual(
    JSON.parse(readFileSync(join(dirname(config), "broker-startup.json"))),
    record,
  );
  return record;
}
async function controlled(t, mode, check) {
  if (!process.env.HAB_NATS_SERVER)
    throw Error("startup proof requires a verifier-staged HAB_NATS_SERVER");
  const runtime = resolve(".runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(runtime, "startup-proof-"));
  const prepared = prepareNatsServer(process.env.HAB_NATS_SERVER, scratch);
  const originalSpawn = childProcess.spawn;
  const hooks = [];
  const events = [];
  let child,
    config,
    closed,
    resume,
    spawnCount = 0,
    stderr = "";
  const mocked = t.mock.method(
    childProcess,
    "spawn",
    (binary, args, options) => {
      if (binary !== prepared.stagedPath)
        return originalSpawn(binary, args, options);
      spawnCount++;
      assert.equal(spawnCount, 1);
      config = args[1];
      if (mode === "spawn-failure") unlinkSync(binary);
      if (mode === "nonzero-exit")
        writeFileSync(
          config,
          readFileSync(config, "utf8") + `\n"${sentinel}": true\n`,
        );
      child = originalSpawn(binary, args, options);
      closed = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          events.push({ event: "close", code, signal });
          resolve({ code, signal });
        }),
      );
      child.once("exit", (code, signal) => {
        events.push({ event: "exit", code, signal });
      });
      child.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes.toString()).slice(-65536);
      });
      if (mode === "signal-exit") assert.equal(child.kill("SIGKILL"), true);
      if (mode === "delayed-ready" || mode === "deadline") {
        assert.equal(child.kill("SIGSTOP"), true);
        events.push({ event: "paused" });
        if (mode === "delayed-ready")
          resume = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              assert.equal(child.kill("SIGCONT"), true);
              events.push({ event: "resumed" });
            }
          }, 3000);
      }
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    let value, error;
    try {
      value = await fixture(
        { after: (hook) => hooks.push(hook) },
        {},
        prepared.stagedPath,
      );
    } catch (caught) {
      error = caught;
    }
    await check({
      value,
      error,
      events,
      child,
      config,
      binary: prepared.stagedPath,
      stderr,
      spawnCount,
    });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    clearTimeout(resume);
    if (
      (mode === "delayed-ready" || mode === "deadline") &&
      child?.exitCode === null &&
      child.signalCode === null
    )
      child.kill("SIGCONT");
    const force = setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 2000);
    let closeDeadline;
    try {
      for (const hook of hooks.reverse()) await hook();
      if (closed)
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            closeDeadline = setTimeout(
              () => reject(Error("owned startup child did not close")),
              4000,
            );
          }),
        ]);
      assert.equal(
        !!child?.pid && child.exitCode === null && child.signalCode === null,
        false,
      );
      assert.equal(spawnCount, 1);
      const closure = JSON.parse(
        readFileSync(join(dirname(config), "closed.json")),
      );
      assert.equal(closure.live_gateways, 0);
      assert.equal(closure.live_inboxes, 0);
      assert.ok(closure.exit_code !== null || closure.signal !== null);
      t.diagnostic(
        JSON.stringify({
          event: "startup_owned_cleanup",
          mode,
          spawn_count: spawnCount,
          child_closed: events.some((entry) => entry.event === "close"),
          live_child: false,
          live_gateways: closure.live_gateways,
          live_inboxes: closure.live_inboxes,
        }),
      );
    } finally {
      clearTimeout(force);
      clearTimeout(closeDeadline);
      if (config) rmSync(dirname(config), { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
const cases = [
  [
    "signal-exit",
    async (result) => {
      assert.equal(result.value, undefined);
      const record = diagnostic(result.error, result);
      assert.equal(record.reason, "exited");
      assert.equal(record.exit_code, null);
      assert.equal(record.signal, "SIGKILL");
      assert.equal(result.child.signalCode, "SIGKILL");
      assert.equal(result.spawnCount, 1);
    },
  ],
  [
    "delayed-ready",
    async (result) => {
      assert.ifError(result.error);
      assert.ok(result.events.some((event) => event.event === "resumed"));
      assert.equal(result.child.exitCode, null);
      assert.equal(result.child.signalCode, null);
      const message = result.value.message();
      assert.equal(
        (await result.value.backend.submit("a", message)).state,
        "pending",
      );
      const info = await result.value.manager.streams.info("HAB");
      assert.equal(info.config.storage, "file");
      assert.equal(info.state.messages, 1);
    },
  ],
  [
    "deadline",
    async (result) => {
      assert.equal(result.value, undefined);
      const record = diagnostic(result.error, result);
      assert.equal(record.reason, "deadline_exceeded");
      assert.ok(record.elapsed_ms >= 10000);
      assert.ok(record.attempts > 0);
      assert.ok(record.last_connection_code);
      assert.equal(record.exit_code, null);
      assert.equal(record.signal, null);
      assert.equal(result.child.exitCode, null);
      assert.equal(result.child.signalCode, null);
    },
  ],
  [
    "spawn-failure",
    async (result) => {
      assert.equal(result.value, undefined);
      const record = diagnostic(result.error, result);
      assert.equal(record.reason, "spawn_failed");
      assert.equal(record.spawn_error_code, "ENOENT");
      assert.equal(result.child.pid, undefined);
    },
  ],
  [
    "nonzero-exit",
    async (result) => {
      assert.equal(result.value, undefined);
      const record = diagnostic(result.error, result);
      assert.equal(record.reason, "exited");
      assert.ok(Number.isInteger(record.exit_code) && record.exit_code !== 0);
      assert.equal(record.signal, null);
      assert.ok(result.stderr.includes(sentinel));
      assert.equal(record.stderr_bytes, Buffer.byteLength(result.stderr));
    },
  ],
];
for (const [index, [mode, check]] of cases.entries())
  test(startupCases[index], { timeout: 30000 }, (t) =>
    controlled(t, mode, check),
  );
