import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { Task } from "@a2a-js/sdk";
import { openA2aTaskStore } from "../src/a2a/store.ts";

const context = (name, tenant) =>
  new ServerCallContext({
    requestedVersion: "1.0",
    tenant,
    user: { isAuthenticated: true, userName: name },
  });
test("SDK DatabaseTaskStore survives a separate process and isolates owners and tenants", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const source = openA2aTaskStore(path);
  const task = Task.fromJSON({
    id: "task-1",
    contextId: "context-1",
    status: {
      state: "TASK_STATE_COMPLETED",
      timestamp: "2026-11-01T00:00:00.000Z",
    },
    artifacts: [
      { artifactId: "result", parts: [{ text: "confirmed result" }] },
    ],
  });
  await source.store.save(task, context("caller", "group-a"));
  assert.equal(
    await source.store.load(task.id, context("other", "group-a")),
    undefined,
  );
  assert.equal(
    await source.store.load(task.id, context("caller", "group-b")),
    undefined,
  );
  await source.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {openA2aTaskStore} from './src/a2a/store.ts';
    import {ServerCallContext} from '@a2a-js/sdk/server';
    const opened = openA2aTaskStore(process.argv[1]);
    const task = await opened.store.load('task-1', new ServerCallContext({requestedVersion:'1.0',tenant:'group-a',user:{isAuthenticated:true,userName:'caller'}}));
    process.stdout.write(JSON.stringify(task));
    await opened.close();
  `,
      path,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const durable = JSON.parse(child.stdout);
  assert.equal(durable.id, task.id);
  assert.equal(durable.contextId, task.contextId);
  assert.equal(durable.status.state, task.status.state);
  assert.equal(durable.artifacts[0].parts[0].content.value, "confirmed result");
});

test("A2A store refuses an existing engine database and public file permissions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "engine.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY)");
  raw.close();
  chmodSync(path, 0o600);
  assert.throws(() => openA2aTaskStore(path), /dedicated database/);
  const check = new DatabaseSync(path);
  assert.equal(
    check
      .prepare("SELECT name FROM sqlite_master WHERE name='hab_a2a_tasks'")
      .get(),
    undefined,
  );
  check.close();
  chmodSync(path, 0o644);
  assert.throws(() => openA2aTaskStore(path), /private regular file/);
});

test("closing an unused A2A store closes its eager SQLite connection before a reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-store-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const unused = openA2aTaskStore(path);
  // These host maintenance reads bypass Kysely; no SDK load/save has initialized it.
  assert.equal(unused.findBySource("absent"), undefined);
  assert.deepEqual(unused.overdue("9999-01-01T00:00:00.000Z", 100), []);
  await unused.close();
  assert.throws(
    () => unused.findBySource("absent"),
    /not open|closed|finalized/,
  );
  await unused.close();

  const reopened = openA2aTaskStore(path);
  assert.equal(
    await reopened.store.load("absent", context("caller", "group")),
    undefined,
  );
  await reopened.close();
  assert.throws(
    () => reopened.findBySource("absent"),
    /not open|closed|finalized/,
  );
  await reopened.close();
});

test("overdue Task pages advance past retrying rows using the complete stable Task key", async () => {
  const opened = openA2aTaskStore(":memory:");
  const cutoff = "2026-11-01T00:00:00.000Z";
  try {
    for (let i = 0; i < 102; i++) {
      const task = Task.fromJSON({
        id: `task-${String(i % 100).padStart(3, "0")}`,
        contextId: "context",
        status: { state: "TASK_STATE_WORKING", timestamp: cutoff },
        metadata: { hab_relay: { source: { expires_at: cutoff } } },
      });
      await opened.store.save(task, context(i < 100 ? "a" : "b", "tenant"));
    }
    const first = opened.overdue(cutoff, 100);
    assert.equal(first.length, 100);
    // Model a failed apply of each row: do not mutate/remove any of the first page.
    const second = opened.overdue(cutoff, 100, first.at(-1));
    assert.deepEqual(second, [
      { tenant: "tenant", owner: "b", id: "task-000" },
      { tenant: "tenant", owner: "b", id: "task-001" },
    ]);
    assert.deepEqual(opened.overdue(cutoff, 100, second.at(-1)), []);
    assert.deepEqual(
      opened.overdue(cutoff, 100),
      first,
      "a new pass retries the failed rows",
    );
  } finally {
    await opened.close();
  }
});

test("the node:sqlite Task store overwrites a saved Task and lists caller pages through the SDK", async () => {
  const opened = openA2aTaskStore(":memory:");
  const caller = context("caller", "tenant");
  const save = (id, state, timestamp) =>
    opened.store.save(
      Task.fromJSON({
        id,
        contextId: "context",
        status: { state, timestamp },
      }),
      caller,
    );
  try {
    await save("task-a", "TASK_STATE_WORKING", "2026-11-01T00:00:00.000Z");
    await save("task-a", "TASK_STATE_COMPLETED", "2026-11-01T00:00:03.000Z");
    await save("task-b", "TASK_STATE_WORKING", "2026-11-01T00:00:02.000Z");
    await save("task-c", "TASK_STATE_WORKING", "2026-11-01T00:00:01.000Z");
    await opened.store.save(
      Task.fromJSON({ id: "task-x", contextId: "context" }),
      context("other", "tenant"),
    );
    const loaded = await opened.store.load("task-a", caller);
    assert.equal(loaded.status.timestamp, "2026-11-01T00:00:03.000Z");
    const first = await opened.store.list({ pageSize: 2 }, caller);
    assert.equal(first.totalSize, 3);
    assert.deepEqual(
      first.tasks.map((task) => task.id),
      ["task-a", "task-b"],
    );
    assert.ok(first.nextPageToken);
    const second = await opened.store.list(
      { pageSize: 2, pageToken: first.nextPageToken },
      caller,
    );
    assert.deepEqual(
      second.tasks.map((task) => task.id),
      ["task-c"],
    );
    assert.equal(second.nextPageToken, "");
  } finally {
    await opened.close();
  }
});
