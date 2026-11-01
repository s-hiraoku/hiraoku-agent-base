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
