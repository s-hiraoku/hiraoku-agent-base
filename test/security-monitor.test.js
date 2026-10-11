import { ReadableStream } from "node:stream/web";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityMonitor, boundedBody } from "../src/security.ts";
import { LocalAudit, MemoryAudit } from "../src/local-audit.ts";
import { fetchMCP } from "../src/mcp-core.ts";
import { Hub, owner, submit } from "./fixtures.js";
test("bounded ingress/tool counters ignore attacker-selected identifiers and reset windows", () => {
  let time = 0;
  const audit = new MemoryAudit();
  const monitor = new SecurityMonitor(audit, () => time);
  const live = Array.from({ length: 4 }, () => monitor.enter());
  assert.throws(() => monitor.enter());
  live.forEach((c) => c.release());
  for (let i = 0; i < 60; i++) {
    const c = monitor.enter();
    c.beginTool()("tool_succeeded");
    c.release();
  }
  const blocked = monitor.enter();
  assert.throws(() => blocked.record("tool_started"));
  blocked.release();
  time = 60001;
  const next = monitor.enter();
  next.beginTool()("tool_succeeded");
  next.release();
  assert.equal(audit.counts.get("rate_limited"), 2);
});
test("bounded POST body rejects bytes before MCP parsing", async () => {
  await assert.rejects(
    boundedBody(
      new Request("https://hub.example/mcp", {
        method: "POST",
        body: "x".repeat(32769),
      }),
    ),
    /rejected/,
  );
  const small = await boundedBody(
    new Request("https://hub.example/mcp", { method: "POST", body: "{}" }),
  );
  assert.equal(await small.text(), "{}");
});
test("local audit has fixed safe fields, bounded rotation, fail-closed disk failure and symlink rejection", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-audit-"));
  const correlation = "11111111-1111-4111-8111-111111111111";
  try {
    const audit = new LocalAudit(dir, 256);
    for (let i = 0; i < 40; i++) audit.record("tool_error", correlation);
    assert(readdirSync(dir).length <= 3);
    for (const name of readdirSync(dir))
      for (const line of readFileSync(join(dir, name), "utf8")
        .trim()
        .split("\n"))
        assert.deepEqual(Object.keys(JSON.parse(line)), [
          "time",
          "category",
          "correlation",
        ]);
    assert.throws(() => audit.record("SECRET", correlation));
    assert.throws(() => audit.record("request", "raw-task-id"));
    assert.throws(
      () =>
        new LocalAudit(dir, 256, Date.now, () => {
          throw new Error("SECRET");
        }),
      /^Error: Audit unavailable$/,
    );
    const link = join(dir, "link");
    symlinkSync(dir, link);
    assert.throws(() => new LocalAudit(link));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP 200 tool rejection and successful get have separate audit outcomes without argument data", async () => {
  const hub = new Hub();
  const audit = new MemoryAudit();
  const monitor = new SecurityMonitor(audit);
  const context = monitor.enter();
  try {
    const task = await submit(hub);
    for (const id of [task.id, "11111111-1111-4111-8111-111111111111"]) {
      const response = await fetchMCP(
        hub,
        new Request("https://hub.example/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get", arguments: { id } },
          }),
        }),
        async () => owner,
        undefined,
        undefined,
        undefined,
        context,
      );
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(audit.counts.get("tool_succeeded"), 1);
    assert.equal(audit.counts.get("tool_error"), 1);
  } finally {
    context.release();
    hub.close();
  }
});
test("atomic task admission quota preserves idempotent replay and blocks the 129th active row", async () => {
  const hub = new Hub();
  try {
    const first = await submit(hub, "quota-0");
    for (let i = 1; i < 128; i++) await submit(hub, `quota-${i}`);
    assert.equal((await submit(hub, "quota-0")).id, first.id);
    await assert.rejects(submit(hub, "quota-over"));
    await hub.cancel(owner, { id: first.id });
    assert.equal((await submit(hub, "quota-after-cancel")).state, "queued");
  } finally {
    hub.close();
  }
});
test("response admission is held until a delayed response finishes and bounded by bytes", async () => {
  const { guardedResponse } = await import("../src/security.ts");
  const monitor = new SecurityMonitor();
  const active = Array.from({ length: 4 }, () => monitor.enter());
  let finish;
  const response = guardedResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          finish = () => controller.close();
        },
      }),
    ),
    active[0],
  );
  assert.throws(() => monitor.enter());
  const consumed = response.text();
  finish();
  await consumed;
  const next = monitor.enter();
  next.release();
  active.slice(1).forEach((c) => c.release());
  const capped = guardedResponse(
    new Response("x".repeat(65537)),
    monitor.enter(),
  );
  await assert.rejects(capped.text(), /rejected/);
  const after = monitor.enter();
  after.release();
});
test("audit failure prevents mutation and a retained-row cap preserves idempotency", async () => {
  const hub = new Hub();
  try {
    const response = await fetchMCP(
      hub,
      new Request("https://hub.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "submit",
            arguments: {
              task_type: "connectivity_check",
              request_key: "blocked",
            },
          },
        }),
      }),
      async () => owner,
      undefined,
      undefined,
      undefined,
      {
        correlation: "11111111-1111-4111-8111-111111111111",
        record() {
          throw new Error("SECRET disk failure");
        },
        beginTool() {
          throw new Error("SECRET disk failure");
        },
      },
    );
    assert.match(await response.text(), /isError/);
    assert.equal(
      hub.sqlite.db.prepare("SELECT count(*) AS count FROM tasks").get().count,
      0,
    );
    const first = await submit(hub, "retained-first");
    hub.sqlite.db.prepare("UPDATE tasks SET state='cancelled'").run();
    hub.sqlite.db.exec(
      "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<9999) INSERT INTO tasks(id,owner,destination,request_key,task_type,state,actor,at,mutation) SELECT 'quota-'||i,'fixture-owner','hermes','retained-'||i,'connectivity_check','cancelled','fixture-owner',0,'quota-'||i FROM seq",
    );
    assert.equal((await submit(hub, "retained-first")).id, first.id);
    await assert.rejects(submit(hub, "retained-over"));
  } finally {
    hub.close();
  }
});
test("closed response cannot free a still-running tool or admit deferred work", () => {
  const monitor = new SecurityMonitor();
  const live = Array.from({ length: 4 }, () => monitor.enter());
  const finish = live[0].beginTool();
  live[0].release();
  assert.throws(() => monitor.enter());
  finish("tool_succeeded");
  assert.throws(() => live[0].beginTool());
  const next = monitor.enter();
  next.release();
  live.slice(1).forEach((c) => c.release());
});
test("per-invocation finish rejects double release when another tool is pending", () => {
  let failed = false;
  const monitor = new SecurityMonitor({
    record(category) {
      if (failed && category === "tool_succeeded")
        throw new Error("Audit unavailable");
    },
  });
  const live = Array.from({ length: 4 }, () => monitor.enter());
  const first = live[0].beginTool(),
    second = live[0].beginTool();
  live[0].release();
  assert.throws(() => live[0].beginTool());
  live[0].record("tool_error");
  assert.throws(() => monitor.enter());
  failed = true;
  assert.throws(() => first("tool_succeeded"));
  first("tool_error");
  assert.throws(() => monitor.enter());
  failed = false;
  second("tool_succeeded");
  const next = monitor.enter();
  next.release();
  live.slice(1).forEach((c) => c.release());
});
test("startup configuration failures emit a fixed category without a stack or private path", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["src/server.ts"], {
    encoding: "utf8",
    env: {
      HAB_RUNTIME_CONFIG: "/tmp/nonexistent-private-hub-config-fixture",
      NODE_NO_WARNINGS: "1",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "startup_rejected\n");
});
