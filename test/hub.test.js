import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Hub, owner, worker, submit, finish } from "./fixtures.js";
import { storeSuite } from "./store-suite.js";
test("SQLite shared store contract", async (t) => {
  const h = new Hub();
  try {
    await storeSuite(t, h);
  } finally {
    h.close();
  }
});
test("independent worker threads really contend for one SQLite claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-claim-")),
    path = join(dir, "hub.db"),
    h = new Hub(path);
  await submit(h);
  const ready = [];
  const workers = Array.from(
    { length: 4 },
    () =>
      new Worker(new URL("./claim-worker.ts", import.meta.url), {
        workerData: { path, principal: worker },
      }),
  );
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            w.once("message", resolve);
            w.once("error", reject);
          }),
      ),
    );
    const results = workers.map(
      (w) =>
        new Promise((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    );
    for (const w of workers) w.postMessage("go");
    ready.push(...(await Promise.all(results)));
    assert.equal(ready.filter(Boolean).length, 1);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    h.close();
    rmSync(dir, { recursive: true });
  }
});
test("SQLite terminal state and outbox persist across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-restart-")),
    path = join(dir, "hub.db");
  let h = new Hub(path);
  const task = await submit(h);
  const claim = await h.claim(worker);
  await finish(h, claim);
  h.close();
  h = new Hub(path);
  assert.equal((await h.get(owner, task)).state, "succeeded");
  assert.equal((await h.pending(owner)).length, 1);
  h.close();
  rmSync(dir, { recursive: true });
});
test("untracked legacy task database is preserved and refused", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "hub-legacy-")),
    path = join(dir, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('fixture-legacy')",
  );
  db.close();
  try {
    assert.throws(() => new Hub(path), /legacy_schema/);
    const check = new DatabaseSync(path);
    assert.equal(
      check.prepare("SELECT id FROM tasks").get().id,
      "fixture-legacy",
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
for (const pending of [false, true])
  test(`concurrent SQLite startup ${pending ? "pending migration" : "empty database"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-startup-"));
    const path = join(dir, "hub.db");
    if (pending) {
      const h = new Hub(path);
      h.sqlite.db.exec(
        "DROP TRIGGER tasks_insert_audit; DROP TRIGGER tasks_update_audit; DROP TRIGGER tasks_terminal_outbox; DELETE FROM hub_migrations WHERE id='0001_audit_outbox.sql'",
      );
      h.close();
    }
    const workers = Array.from(
      { length: 4 },
      () =>
        new Worker(new URL("./startup-worker.ts", import.meta.url), {
          workerData: { path },
        }),
    );
    try {
      await Promise.all(
        workers.map(
          (w) =>
            new Promise((resolve, reject) => {
              w.once("message", resolve);
              w.once("error", reject);
            }),
        ),
      );
      const opened = workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            w.once("message", resolve);
            w.once("error", reject);
          }),
      );
      workers.forEach((w) => w.postMessage("go"));
      assert.deepEqual(await Promise.all(opened), Array(4).fill("opened"));
      const h = new Hub(path);
      const task = await submit(h);
      await finish(h, await h.claim(worker));
      assert.equal((await h.get(owner, task)).state, "succeeded");
      h.close();
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
      rmSync(dir, { recursive: true });
    }
  });
for (const operation of ["heartbeat", "complete"])
  test(`${operation} checks lease at SQL application time`, async () => {
    let now = 1000;
    const h = new Hub(":memory:", () => now);
    try {
      await submit(h);
      const task = await h.claim(worker);
      now = task.lease - 1;
      const batch = h.driver.batch.bind(h.driver);
      h.driver.batch = async (statements) => {
        now = task.lease + 1;
        return batch(statements);
      };
      await assert.rejects(
        operation === "heartbeat" ? h.heartbeat(worker, task) : finish(h, task),
      );
      const persisted = await h.get(worker, task);
      assert.equal(persisted.state, "running");
      assert.equal(persisted.lease, task.lease);
    } finally {
      h.close();
    }
  });
for (const operation of ["submit", "cancel"])
  test(`${operation} audit uses SQL application clock`, async () => {
    let now = 1000;
    const h = new Hub(":memory:", () => now);
    try {
      const task = operation === "cancel" ? await submit(h) : null;
      const batch = h.driver.batch.bind(h.driver);
      h.driver.batch = async (statements) => {
        now = 2000;
        return batch(statements);
      };
      const result = task ? await h.cancel(owner, task) : await submit(h);
      assert.equal(result.at, 2000);
      assert.equal(
        h.sqlite.db
          .prepare("SELECT at FROM audit ORDER BY rowid DESC LIMIT 1")
          .get().at,
        2000,
      );
    } finally {
      h.close();
    }
  });
