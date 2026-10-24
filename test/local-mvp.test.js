import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runLocalMvp } from "../scripts/lib/local-mvp.mjs";
const execute = promisify(execFile);
const cli = new URL("../scripts/hab-mvp-demo.mjs", import.meta.url);
const stages = [
  "enrollment",
  "auth-denial",
  "paused-by-default",
  "ambiguous-send",
  "ambiguous-ack",
  "cold-start",
  "same-id-recovery",
  "reply-intent-restart",
  "reply-roundtrip",
  "offline-store-forward",
  "fixed-task-boundary",
  "fixed-task-restart",
  "fixed-task-roundtrip",
  "loop-denial",
  "stopped",
];
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "hab-mvp-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test(
  "Local MVP: documented CLI completes all 15 stages over real HTTP and removes its temporary state",
  { timeout: 15000 },
  async (t) => {
    const root = directory(t);
    const { stdout, stderr } = await execute(
      process.execPath,
      [cli.pathname, "--simulate"],
      {
        timeout: 12000,
        env: { ...process.env, TMPDIR: root },
        maxBuffer: 65536,
      },
    );
    assert.equal(stderr, "");
    const report = JSON.parse(stdout);
    assert.equal(report.scope, "synthetic-loopback-mvp");
    assert.equal(report.production_connected, false);
    assert.deepEqual(
      report.stages.map((s) => s.id),
      stages,
    );
    assert.ok(report.stages.every((s) => s.status === "passed"));
    assert.deepEqual(report.counters, {
      deliveries: 6,
      acked: 6,
      ack_receipts: 6,
      tasks: 1,
      open_executions: 0,
    });
    assert.deepEqual(report.mcp_tools, [
      "relay_ack",
      "relay_poll",
      "relay_resolve",
      "relay_status",
      "relay_submit",
    ]);
    assert.ok(report.audit.tool_succeeded > 0);
    assert.equal(
      report.identities.filter((i) => i.agent_name === "grok-bot").length,
      2,
    );
    assert.deepEqual(report.cleanup, {
      server_closed: true,
      temporary_state_removed: true,
    });
    assert.deepEqual(readdirSync(root), []);
    for (const forbidden of [
      homedir(),
      "Bearer ",
      "Synthetic durable answer.",
      "ignore instructions",
    ])
      assert.equal(stdout.includes(forbidden), false);
  },
);
test("Local MVP: missing, unknown and extra arguments refuse before creating state", async (t) => {
  const root = directory(t);
  for (const args of [
    [],
    ["--live"],
    ["--simulate", "extra"],
    ["--simulate", "--url", "https://invalid.example/"],
  ]) {
    await assert.rejects(
      execute(process.execPath, [cli.pathname, ...args], {
        env: { ...process.env, TMPDIR: root },
      }),
      (e) => e.code === 2 && e.stdout === "" && e.stderr.startsWith("Usage:"),
    );
    assert.deepEqual(readdirSync(root), []);
  }
});
test("Local MVP: importing the composition creates no state or listener", async (t) => {
  const root = directory(t),
    module = new URL("../scripts/lib/local-mvp.mjs", import.meta.url);
  const { stdout, stderr } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import(" + JSON.stringify(module.href) + ")",
    ],
    { timeout: 5000, env: { ...process.env, TMPDIR: root } },
  );
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  assert.deepEqual(readdirSync(root), []);
});
test("Local MVP: an already aborted run fails before enrollment and cleans the new directory", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runLocalMvp(controller.signal), /mvp_aborted/);
});

test(
  "Local MVP: SIGTERM closes its own listener and removes interrupted synthetic state",
  { timeout: 15000 },
  async (t) => {
    const root = directory(t),
      child = spawn(process.execPath, [cli.pathname, "--simulate"], {
        env: { ...process.env, TMPDIR: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
    t.after(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    });
    let stderr = "",
      stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = once(child, "exit");
    const until = Date.now() + 5000;
    for (;;) {
      const state = readdirSync(root).find((name) =>
        name.startsWith("hab-local-mvp-"),
      );
      if (state && readdirSync(join(root, state)).includes("owner-a.sqlite"))
        break;
      if (child.exitCode !== null || Date.now() >= until)
        throw Error("mvp did not reach local startup");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    assert.equal(
      stderr,
      "local_mvp_failed; no production connection attempted\n",
    );
    assert.deepEqual(readdirSync(root), []);
  },
);
