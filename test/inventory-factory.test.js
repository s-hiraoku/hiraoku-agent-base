import { test } from "node:test";
import process from "node:process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { InventoryLaunchPlan } from "../src/inventory-launch-plan.ts";
import {
  prepareInventoryArtifacts,
  InventoryChild,
  runInventoryOnce,
} from "../src/inventory-factory.ts";
import { Hub } from "./fixtures.js";
import {
  MockInventoryRuns,
  inventoryOwner,
  inventoryWorker,
} from "./inventory-suite.js";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const syntheticKey = "09".repeat(32);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-factory-")));
  const profile = join(root, ".hermes/profiles/hub-inventory-once");
  mkdirSync(join(profile, "empty-workdir"), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, "config.yaml"), "synthetic-fixture\n", {
    mode: 0o600,
  });
  const sourceRoot = join(root, "source"),
    dependencyRoot = join(root, "dependencies"),
    wrapperPath = join(root, "guard/serve_inventory.py"),
    pythonPath = join(root, "python");
  const reviewed = {
    manifestPath: join(profile, "inventory-manifest.json"),
    endpoint: "http://127.0.0.1:8645/",
    namespaceLabel: "synthetic-factory",
    profileRoot: profile,
    sourceRoot,
    dependencyRoot,
    wrapperPath,
    pythonPath,
    pythonIsolation: "isolated-no-site-v1",
    codeTrees: [
      { root: sourceRoot, sha256: "a".repeat(64) },
      { root: join(root, "guard"), sha256: "b".repeat(64) },
      { root: pythonPath, sha256: "c".repeat(64), systemRuntime: true },
      { root: dependencyRoot, sha256: "d".repeat(64), fixedDependencies: true },
    ],
    pythonSHA256: "e".repeat(64),
    wrapperSHA256: "f".repeat(64),
    configSHA256: sha("synthetic-fixture\n"),
    sourceCommit: "f97608f178d1ffeca59860195ab7da295f7c8e5f",
    storeRelativePath: "runs_idempotency.db",
  };
  const h = new Hub();
  const state = { stops: 0, launches: 0, connections: 0 };
  const options = {
    reviewed,
    worker: async (runnerScope) => ({
      hub: h,
      principal: { ...inventoryWorker, runnerScope },
    }),
  };
  const dependencies = {
    checkPreparation: async () => {}, // Synthetic missing code, never live evidence.
    entropy: () => Buffer.alloc(32, 9),
    child: (launch) => {
      state.launches++;
      assert.deepEqual(launch.args, ["-I", "-S", wrapperPath]);
      assert.equal(launch.env.API_SERVER_KEY, syntheticKey);
      assert.deepEqual(
        Object.keys(launch.env).sort(),
        [
          "API_SERVER_KEY",
          "HUB_INVENTORY_MANIFEST_SHA256",
          "PATH",
          "PYTHONDONTWRITEBYTECODE",
        ].sort(),
      );
      writeFileSync(join(profile, "inventory.pid"), "12345", { mode: 0o600 });
      return {
        exited: false,
        started: async () => 12345,
        stop: async () => {
          state.stops++;
        },
      };
    },
    connect: async ({ inspector, apiKey }) => {
      state.connections++;
      assert.equal(apiKey, syntheticKey);
      const runs = new MockInventoryRuns();
      runs.boundaryId = `${inspector.endpoint}|${inspector.scopeId}`;
      state.runs = runs;
      return runs;
    },
  };
  return {
    root,
    profile,
    reviewed,
    h,
    state,
    options,
    dependencies,
    cleanup() {
      h.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("default preparation rejection precedes entropy/artifact/child/worker/connector effects", async () => {
  const f = fixture();
  try {
    let entropy = 0,
      workers = 0;
    const before = readdirSync(f.profile).sort();
    const deps = {
      ...f.dependencies,
      entropy: () => {
        entropy++;
        return Buffer.alloc(32, 9);
      },
    };
    delete deps.checkPreparation;
    await assert.rejects(
      runInventoryOnce(
        {
          ...f.options,
          worker: async () => {
            workers++;
            throw Error("must not call");
          },
        },
        deps,
      ),
    );
    assert.equal(entropy, 0);
    assert.equal(workers, 0);
    assert.equal(f.state.launches, 0);
    assert.equal(f.state.connections, 0);
    assert.deepEqual(readdirSync(f.profile).sort(), before);
  } finally {
    f.cleanup();
  }
});

test("preparation refusal propagates before provision for EPERM, drift and existing artifacts", async () => {
  for (const code of [
    "EPERM",
    "inventory_integrity_rejected",
    "inventory_existing_artifact_requires_reconciliation",
  ]) {
    const f = fixture();
    try {
      let entropy = 0;
      const before = readdirSync(f.profile).sort();
      await assert.rejects(
        runInventoryOnce(f.options, {
          ...f.dependencies,
          checkPreparation: async () => {
            throw Object.assign(Error("dummy preparation failure"), { code });
          },
          entropy: () => {
            entropy++;
            return Buffer.alloc(32, 9);
          },
        }),
        { code },
      );
      assert.equal(entropy, 0);
      assert.equal(f.state.launches, 0);
      assert.equal(f.state.connections, 0);
      assert.deepEqual(readdirSync(f.profile).sort(), before);
    } finally {
      f.cleanup();
    }
  }
});
test("exclusive artifact writer creates private SQLite stores and digest-only files", async () => {
  const f = fixture();
  try {
    const plan = new InventoryLaunchPlan(f.reviewed, sha(syntheticKey));
    const policy = await prepareInventoryArtifacts(plan);
    assert.equal(
      policy.store.ino,
      statSync(join(f.profile, "runs_idempotency.db")).ino,
    );
    assert.equal(policy.credential.size, 65);
    for (const name of readdirSync(f.profile).filter(
      (x) => x !== "empty-workdir",
    )) {
      assert.equal(statSync(join(f.profile, name)).mode & 0o077, 0);
      assert.equal(
        readFileSync(join(f.profile, name)).includes(syntheticKey),
        false,
      );
    }
    const db = new DatabaseSync(join(f.profile, "runs_idempotency.db"));
    db.exec("CREATE TABLE fixture(id INTEGER)");
    db.close();
    assert.equal(
      policy.store.ino,
      statSync(join(f.profile, "runs_idempotency.db")).ino,
    );
    await assert.rejects(prepareInventoryArtifacts(plan), /existing_artifact/);
  } finally {
    f.cleanup();
  }
});
test("existing symlink refuses preparation without touching its target", async () => {
  const f = fixture();
  try {
    const target = join(f.root, "untouched");
    writeFileSync(target, "keep");
    symlinkSync(target, join(f.profile, "credential.scope"));
    await assert.rejects(
      prepareInventoryArtifacts(
        new InventoryLaunchPlan(f.reviewed, sha(syntheticKey)),
      ),
      /existing_artifact/,
    );
    assert.equal(readFileSync(target, "utf8"), "keep");
    assert.equal(readdirSync(f.profile).includes("runs_idempotency.db"), false);
  } finally {
    f.cleanup();
  }
});
test("preexisting SQLite sidecar refuses preparation before writes", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.profile, "inventory-worker.sqlite-wal"), "keep", {
      mode: 0o600,
    });
    await assert.rejects(
      prepareInventoryArtifacts(
        new InventoryLaunchPlan(f.reviewed, sha(syntheticKey)),
      ),
      /existing_artifact/,
    );
    assert.equal(readdirSync(f.profile).includes("runs_idempotency.db"), false);
  } finally {
    f.cleanup();
  }
});

test("one-shot uses actual files, durable journal, Adapter and Hub with synthetic child/runs", async () => {
  const f = fixture();
  try {
    const t = await f.h.submit(inventoryOwner, {
      task_type: "shift_log_inventory",
      request_key: "factory-one",
    });
    assert.equal(await runInventoryOnce(f.options, f.dependencies), t.id);
    assert.equal((await f.h.get(inventoryOwner, t)).state, "succeeded");
    assert.equal(f.state.runs.calls, 1);
    assert.equal(f.state.stops, 1);
    const record = JSON.parse(
      readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
    );
    assert.equal(record.state, "revoked");
    assert.equal(record.fingerprint, sha(syntheticKey));
    const db = new DatabaseSync(join(f.profile, "inventory-worker.sqlite"));
    assert.equal(db.prepare("SELECT count(*) n FROM journal").get().n, 0);
    db.close();
  } finally {
    f.cleanup();
  }
});
test("default real connector denies synthetic missing Inspector evidence and stops child", async () => {
  const f = fixture();
  try {
    const deps = { ...f.dependencies };
    delete deps.connect;
    await assert.rejects(
      runInventoryOnce(f.options, deps),
      /requires_reconciliation/,
    );
    assert.equal(f.state.stops, 1);
    assert.equal(f.state.connections, 0);
  } finally {
    f.cleanup();
  }
});
test("mismatched child PID fails before any connector or claim", async () => {
  const f = fixture();
  try {
    const create = f.dependencies.child;
    f.dependencies.child = (launch) => ({
      ...create(launch),
      started: async () => 54321,
    });
    await assert.rejects(
      runInventoryOnce(f.options, f.dependencies),
      /requires_reconciliation/,
    );
    assert.equal(f.state.connections, 0);
    assert.equal(f.state.stops, 1);
  } finally {
    f.cleanup();
  }
});
test(
  "late worker resolution cannot create journal after expired cleanup",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = new Promise((resolve) => {
      entered = resolve;
    });
    try {
      const worker = f.options.worker;
      f.options.worker = async (scope) => {
        entered();
        await gate;
        return worker(scope);
      };
      const running = runInventoryOnce(f.options, {
        ...f.dependencies,
        ttlMs: 1500,
      });
      const failed = assert.rejects(running, /stop_failed/);
      await seen;
      await failed;
      assert.equal(
        JSON.parse(
          readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
        ).state,
        "stop_failed",
      );
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const db = new DatabaseSync(join(f.profile, "inventory-worker.sqlite"));
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM sqlite_master WHERE name='journal'")
          .get().n,
        0,
      );
      db.close();
      assert.equal(f.state.stops, 1);
    } finally {
      release?.();
      f.cleanup();
    }
  },
);
test(
  "late claim preserves its receipt in retained journal after uncertain stop",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = new Promise((resolve) => {
      entered = resolve;
    });
    try {
      const t = await f.h.submit(inventoryOwner, {
        task_type: "shift_log_inventory",
        request_key: "late-claim",
      });
      const claim = f.h.claim.bind(f.h);
      f.h.claim = async (...args) => {
        entered();
        await gate;
        return claim(...args);
      };
      const running = runInventoryOnce(f.options, {
        ...f.dependencies,
        ttlMs: 1500,
      });
      const failed = assert.rejects(running, /stop_failed/);
      await seen;
      await failed;
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const db = new DatabaseSync(join(f.profile, "inventory-worker.sqlite"));
      const receipt = JSON.parse(
        db.prepare("SELECT entry FROM journal WHERE id=1").get().entry,
      );
      db.close();
      assert.equal(receipt.id, t.id);
      assert.equal(f.state.runs.calls, 0);
      assert.equal(
        JSON.parse(
          readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
        ).state,
        "stop_failed",
      );
    } finally {
      release?.();
      f.cleanup();
    }
  },
);
test("owned mock child really starts and terminates with ignored output and isolated env", async () => {
  const child = new InventoryChild({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: realpathSync(tmpdir()),
    env: { PATH: "/usr/bin:/bin", API_SERVER_KEY: syntheticKey },
  });
  try {
    assert.ok(await child.started());
    assert.equal(child.process.stdout, null);
    assert.equal(child.process.stdin, null);
  } finally {
    await child.stop();
  }
  assert.equal(child.exited, true);
});
test("child stop failure is recorded as uncertain rather than revoked", async () => {
  const f = fixture();
  try {
    const create = f.dependencies.child;
    f.dependencies.child = (launch) => ({
      ...create(launch),
      stop: async () => {
        throw Error("synthetic_stop_failure");
      },
    });
    await assert.rejects(
      runInventoryOnce(f.options, f.dependencies),
      /hermes_stop_failed/,
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
      ).state,
      "stop_failed",
    );
  } finally {
    f.cleanup();
  }
});

test("spawn failure is sanitized and cleanup is safe", async () => {
  const child = new InventoryChild({
    executable: "/nonexistent/public-fixture-python",
    args: [],
    cwd: realpathSync(tmpdir()),
    env: { API_SERVER_KEY: syntheticKey },
  });
  await assert.rejects(
    child.started(),
    /^Error: inventory_child_spawn_failed$/,
  );
  await child.stop();
});
