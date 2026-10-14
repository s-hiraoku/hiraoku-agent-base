import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { inventoryPolicyFixture } from "./inventory-policy-fixture.js";
import { InventoryInspector } from "../src/inventory-inspector.ts";

test("real read-only preparation checks do not read runtime markers or produce live evidence", async () => {
  const f = await inventoryPolicyFixture("http://127.0.0.1:8645/");
  try {
    await fs.mkdir(join(f.policy.profileRoot, "empty-workdir"), {
      mode: 0o700,
    });
    const open = fs.open;
    mock.method(fs, "open", async (path, ...args) => {
      assert.notEqual(path, join(f.policy.profileRoot, "credential.scope"));
      assert.notEqual(path, f.policy.manifestPath);
      return open(path, ...args);
    });
    syncBuiltinESMExports();
    let probes = 0;
    const inspector = new InventoryInspector(f.policy, {
      probe: async () => {
        probes++;
        throw Error("no live process");
      },
    });
    assert.equal(await inspector.inspectPreparation(), undefined);
    assert.equal(probes, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test("preparation retains EPERM rejection rather than accepting it as denied writes", async () => {
  const f = await inventoryPolicyFixture("http://127.0.0.1:8645/");
  try {
    await fs.mkdir(join(f.policy.profileRoot, "empty-workdir"), {
      mode: 0o700,
    });
    mock.method(fs, "access", async () => {
      throw Object.assign(Error("synthetic inconclusive"), { code: "EPERM" });
    });
    syncBuiltinESMExports();
    await assert.rejects(
      new InventoryInspector(f.policy).inspectPreparation(),
      { code: "EPERM" },
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test("preparation rejects config drift and nonempty private cwd", async () => {
  const f = await inventoryPolicyFixture("http://127.0.0.1:8645/");
  try {
    const cwd = join(f.policy.profileRoot, "empty-workdir");
    await fs.mkdir(cwd, { mode: 0o700 });
    await fs.writeFile(join(cwd, "dummy.txt"), "dummy", { mode: 0o600 });
    await assert.rejects(
      new InventoryInspector(f.policy).inspectPreparation(),
      /workdir_rejected/,
    );
    await fs.unlink(join(cwd, "dummy.txt"));
    await fs.writeFile(join(f.policy.profileRoot, "config.yaml"), "drift", {
      mode: 0o600,
    });
    await assert.rejects(
      new InventoryInspector(f.policy).inspectPreparation(),
      /integrity_rejected/,
    );
  } finally {
    await f.cleanup();
  }
});
