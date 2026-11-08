/** Optional cross-language check of the recipient entry, not a product/native-agent test. */
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { startLocalBroker } from "./lib/nats-broker.mjs";

const [python, ...extra] = process.argv.slice(2);
if (!python || !isAbsolute(python) || extra.length)
  throw Error("Provide one absolute Python interpreter with the official mcp SDK already installed");
if (process.platform === "win32") throw Error("Owned POSIX process-group check required");
/** Signal only a process group created by this run or recorded by its private fixture. */
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
/** Bound teardown and refuse to erase evidence if an owned group survives. */
async function closeGroup(pid) {
  if (!pid || !signalGroup(pid, 0)) return;
  signalGroup(pid, "SIGTERM");
  await delay(500);
  if (signalGroup(pid, 0)) signalGroup(pid, "SIGKILL");
  for (let n = 0; n < 100 && signalGroup(pid, 0); n++) await delay(20);
  assert.equal(signalGroup(pid, 0), false, "owned_group_still_running");
}
const directory = mkdtempSync(join(tmpdir(), "hab-python-mcp-"));
let broker, cleanupConfirmed = true;
try {
  broker = await startLocalBroker(join(directory, "broker"), { keepAlive: true });
  const descriptor = join(directory, "broker.json");
  writeFileSync(descriptor, JSON.stringify({ server: broker.server, user: broker.user,
    password: broker.password }), { mode: 0o600 });
  for (const mode of ["paused", "roundtrip", "revoked"]) {
    const pidFile = join(directory, `${mode}.pid`);
    const child = spawn(python, ["-I", "-B", fileURLToPath(new URL("../test/compatibility/recipient-python-mcp.py", import.meta.url)),
      process.execPath, fileURLToPath(new URL("../test/recipient-host-stdio-fixture.js", import.meta.url)), mode], {
      // Do not inherit product credentials, Python paths, profiles or the user's home.
      env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory,
        HAB_TEST_BROKER_FILE: descriptor, HAB_TEST_COMPATIBILITY_PID_FILE: pidFile }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, overflow = false, force;
    const terminate = () => {
      if (!child.pid) return;
      signalGroup(child.pid, "SIGTERM");
      force ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), 500);
    };
    child.stdout.on("data", (b) => {
      if (Buffer.byteLength(stdout) + b.length > 65536) { overflow = true; terminate(); }
      else stdout += b;
    });
    child.stderr.on("data", (b) => {
      if (Buffer.byteLength(stderr) + b.length > 1048576) { overflow = true; terminate(); }
      else stderr += b;
    });
    const exited = new Promise((resolve) => {
      child.once("error", () => resolve([1, "spawn_error"]));
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 35000);
    let finalDeadline;
    try {
      const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
        finalDeadline = setTimeout(() => reject(Error("python_exit_unconfirmed")), 40000);
      })]);
      assert.equal(timedOut, false, "Python deadline exceeded");
      assert.equal(overflow, false, "Python output exceeded budget");
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
      assert.match(stderr, /RECIPIENT_STDIO_CLEANUP_OK/);
      assert.doesNotMatch(stderr, /RECIPIENT_STDIO_CLEANUP_FAILED/);
      if (mode === "roundtrip") assert.match(stderr, /RECIPIENT_PYTHON_REPLY_VERIFIED/);
      const proof = JSON.parse(stdout.trim());
      assert.equal(proof.mode, mode); assert.equal(proof.passed, true);
      process.stdout.write(`${JSON.stringify(proof)}\n`);
    } finally {
      clearTimeout(timer); clearTimeout(force); clearTimeout(finalDeadline);
      // The SDK starts the fixture in its own session, not the Python group.
      cleanupConfirmed = false;
      await closeGroup(child.pid);
      // Absence cannot prove that an SDK child was never started.
      assert.equal(existsSync(pidFile), true, "fixture_group_identity_unconfirmed");
      const raw = readFileSync(pidFile, "utf8");
      assert.match(raw, /^[1-9][0-9]*$/);
      await closeGroup(Number(raw));
      cleanupConfirmed = true;
    }
  }
} finally {
  await broker?.stop();
  if (cleanupConfirmed) rmSync(directory, { recursive: true, force: true });
  else process.stderr.write(`Unconfirmed fixture cleanup; synthetic evidence retained: ${directory}\n`);
}
process.stdout.write("RECIPIENT_PYTHON_PARENT_CLEANUP_OK\n");
