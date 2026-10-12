import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncAudit } from "../src/async-audit.ts";
import { SecurityMonitor } from "../src/security.ts";
class Port extends EventEmitter {
  messages = [];
  terminated = false;
  postMessage(message) {
    this.messages.push(message);
  }
  async terminate() {
    this.terminated = true;
    return 0;
  }
}
const correlation = "11111111-1111-4111-8111-111111111111";
test("audit queue caps acknowledgements and flood summaries use no per-rejection I/O", async () => {
  const port = new Port(),
    audit = new AsyncAudit("unused", { port, maxPending: 2 });
  port.emit("message", { kind: "ready" });
  await audit.ready();
  try {
    const first = audit.record("request", correlation),
      second = audit.record("tool_started", correlation);
    await assert.rejects(audit.record("request", correlation));
    assert.equal(audit.snapshot().pending, 2);
    for (let i = 0; i < 100000; i++) audit.note("rate_limited");
    assert.equal(port.messages.length, 2);
    assert.equal(audit.snapshot().dropped, 65535);
    assert.equal(audit.snapshot().saturated, true);
    for (const message of port.messages)
      port.emit("message", { kind: "ack", id: message.id });
    await Promise.all([first, second]);
    const summary = audit.flush(10000);
    port.emit("message", { kind: "ack", id: port.messages[2].id });
    await summary;
    audit.note("rate_limited");
    await audit.flush(19999);
    assert.equal(port.messages.length, 3);
    const next = audit.flush(20000);
    port.emit("message", { kind: "ack", id: port.messages[3].id });
    await next;
    assert.equal(port.messages.length, 4);
  } finally {
    await audit.close();
  }
});
test("pre-admission rate flooding cannot trigger detail writes or writer retries", async () => {
  let writes = 0,
    noted = 0;
  const monitor = new SecurityMonitor(
    {
      record() {
        writes++;
      },
      note() {
        noted++;
      },
    },
    () => 0,
  );
  const live = await Promise.all(
    Array.from({ length: 4 }, () => monitor.enter()),
  );
  for (let i = 0; i < 10000; i++) await assert.rejects(monitor.enter());
  assert.equal(writes, 4);
  assert.equal(noted, 10000);
  live.forEach((context) => context.release());
});
test("failed or stalled writer latches unavailable and never emits secret error details", async () => {
  for (const mode of ["failure", "deadline"]) {
    const port = new Port(),
      audit = new AsyncAudit("unused", { port, timeoutMs: 5 });
    port.emit("message", { kind: "ready" });
    await audit.ready();
    const pending = audit.record("tool_started", correlation);
    if (mode === "failure")
      port.emit("message", { kind: "failed", error: "SECRET" });
    await assert.rejects(pending, /^Error: Audit unavailable$/);
    assert.throws(() => audit.check(), /^Error: Audit unavailable$/);
    for (let i = 0; i < 100; i++)
      await assert.rejects(audit.record("request", correlation));
    assert.equal(port.messages.length, 1);
    assert.equal(audit.snapshot().pending, 0);
    assert.equal(port.terminated, true);
    await audit.close();
  }
});
test("native isolated writer acknowledges category-only detail and bounded aggregate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-async-audit-")),
    audit = new AsyncAudit(dir);
  try {
    await audit.ready();
    await audit.record("tool_started", correlation);
    for (let i = 0; i < 20; i++) audit.note("rate_limited");
    await audit.flush();
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      lines.some(
        (line) =>
          line.category === "aggregate" &&
          line.summary.dropped === 20 &&
          line.summary.anomaly === true,
      ),
    );
    assert(
      lines.every((line) =>
        Object.keys(line).every((key) =>
          ["time", "category", "correlation", "summary"].includes(key),
        ),
      ),
    );
  } finally {
    await audit.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failed aggregate retains lower-bound drop counters without automatic replay", async () => {
  const port = new Port(),
    audit = new AsyncAudit("unused", { port });
  port.emit("message", { kind: "ready" });
  await audit.ready();
  audit.note("rate_limited");
  const flushing = audit.flush(10000);
  audit.note("auth_denied");
  port.emit("message", { kind: "failed" });
  await assert.rejects(flushing);
  assert.equal(audit.snapshot().dropped, 2);
  assert.deepEqual(audit.snapshot().counts, {
    auth_denied: 1,
    rate_limited: 1,
  });
  assert.equal(port.messages.length, 1);
  await audit.close();
  assert.throws(() => new AsyncAudit("unused", { port, flushMs: Number.NaN }));
  assert.throws(
    () =>
      new AsyncAudit("unused", { port, timeoutMs: Number.POSITIVE_INFINITY }),
  );
});
test("native worker rejects inherited environment even when parent loads an env file", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { default: process } = await import("node:process");
  const dir = mkdtempSync(join(tmpdir(), "hub-audit-env-"));
  try {
    const file = join(dir, "fixture.env");
    writeFileSync(file, "AUDIT_TEST_SENTINEL=DUMMY\n", { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        `--env-file=${file}`,
        "--input-type=module",
        "-e",
        `import { AsyncAudit } from './src/async-audit.ts'; const audit = new AsyncAudit(${JSON.stringify(join(dir, "logs"))}); await audit.ready(); await audit.close(); process.stdout.write('audit_ready');`,
      ],
      { env: {}, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "audit_ready");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
