import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  InventoryInspector,
  measureCodeTree,
} from "../src/inventory-inspector.ts";
import { inventoryPolicyFixture } from "./inventory-policy-fixture.js";
import { skipAsRoot } from "./non-root.js";
const endpoint = "http://127.0.0.1:8645/";
function pythonAccepts(manifest) {
  const code = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard',${JSON.stringify(resolve("hermes_bridge/serve_inventory.py"))})
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
m=json.load(sys.stdin)
try:
 guard.validate_manifest(m,profile=Path(m['profileRoot']),wrapper=Path(m['wrapperPath']),python=Path(m['pythonPath']),credential_digest='a'*64)
 print('accepted')
except (ValueError,TypeError,KeyError):
 print('rejected')`;
  return (
    execFileSync("python3", ["-I", "-S", "-c", code], {
      input: JSON.stringify(manifest),
      encoding: "utf8",
    }).trim() === "accepted"
  );
}
test("TS inspector and Python guard agree on isolated fixed-dependency contract", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint);
  try {
    const lib = join(p.root, "lib");
    const tree = {
      root: lib,
      sha256: "c".repeat(64),
      systemRuntime: true,
      excludedSystemSitePackages: "python3.11/site-packages",
      maxBytes: 1024,
    };
    const validPolicy = {
      ...p.policy,
      codeTrees: [...p.policy.codeTrees, tree],
    };
    const validManifest = { ...p.manifest, codeTrees: validPolicy.codeTrees };
    new InventoryInspector(validPolicy, p.options);
    assert.equal(pythonAccepts(validManifest), true);
    const defects = [
      { pythonIsolation: "isolated-only" },
      {
        dependencyRoot: p.policy.sourceRoot,
        codeTrees: validPolicy.codeTrees
          .filter((t) => !t.fixedDependencies)
          .map((t) =>
            t.root === p.policy.sourceRoot
              ? { ...t, fixedDependencies: true }
              : t,
          ),
      },
      { dependencyRoot: join(p.policy.sourceRoot, "dependencies") },
      { dependencyRoot: join(lib, "python3.11/site-packages") },
      { dependencyRoot: join(p.root, "unmeasured") },
      {
        codeTrees: validPolicy.codeTrees.map((t) =>
          t.fixedDependencies ? { ...t, fixedDependencies: false } : t,
        ),
      },
      { codeTrees: [...p.policy.codeTrees, { ...tree, systemRuntime: false }] },
      { codeTrees: [...p.policy.codeTrees, { ...tree, maxBytes: 1073741825 }] },
      {
        codeTrees: [
          ...p.policy.codeTrees,
          {
            ...tree,
            aliases: { alias: join(lib, "python3.11/site-packages/injected") },
          },
        ],
      },
      {
        codeTrees: [
          ...validPolicy.codeTrees,
          {
            root: join(lib, "python3.11/site-packages"),
            sha256: "d".repeat(64),
            maxBytes: 1,
          },
        ],
      },
      { codeTrees: [...validPolicy.codeTrees, tree] },
    ];
    for (const defect of defects) {
      assert.throws(
        () => new InventoryInspector({ ...validPolicy, ...defect }, p.options),
      );
      assert.equal(pythonAccepts({ ...validManifest, ...defect }), false);
    }
  } finally {
    await p.cleanup();
  }
});
test("inventory process must use -I -S, never merely -I", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint);
  try {
    assert.ok(await p.inspector.inspect());
    p.observation.command = `${p.policy.pythonPath} -I ${p.policy.wrapperPath}`;
    assert.equal(await p.inspector.inspect(), null);
  } finally {
    await p.cleanup();
  }
});
test("fixed dependency trees reject executable loaders including nested metadata", async (t) => {
  if (skipAsRoot(t)) return;
  for (const name of [
    "inject.pth",
    "inject.egg-link",
    "__editable__.finder.py",
    "package.dist-info/direct_url.json",
  ]) {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "hub-fixed-deps-")),
    );
    const path = join(root, name);
    await fs.mkdir(join(root, "package.dist-info"), { mode: 0o500 });
    // Temporarily allow fixture creation, then freeze before measuring.
    await fs.chmod(join(root, "package.dist-info"), 0o700);
    await fs.writeFile(path, "public fixture only", { mode: 0o400 });
    await fs.chmod(join(root, "package.dist-info"), 0o500);
    await fs.chmod(root, 0o500);
    try {
      await assert.rejects(
        measureCodeTree(root, Infinity, { fixedDependencies: true }),
        /inventory_dependency_loader_rejected/,
      );
    } finally {
      await fs.chmod(root, 0o700);
      await fs.chmod(join(root, "package.dist-info"), 0o700);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
test("excluded shared packages are not hashed but cannot return as approved imports; EPERM stays blocked", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "hub-inventory-system-")),
  );
  const lib = join(root, "lib"),
    global = join(lib, "python3.11/site-packages");
  await fs.mkdir(global, { recursive: true });
  await fs.writeFile(join(global, "fixture.py"), "excluded fixture");
  const lstat = fs.lstat;
  try {
    mock.method(fs, "lstat", async (p) => {
      const result = await lstat(p);
      result.uid = 0;
      return result;
    });
    mock.method(fs, "access", async () => {
      throw Object.assign(Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    const options = {
      systemRuntime: true,
      excludedSystemSitePackages: "python3.11/site-packages",
    };
    const digest = await measureCodeTree(lib, Infinity, options);
    await fs.writeFile(join(global, "fixture.py"), "excluded changed fixture");
    assert.equal(await measureCodeTree(lib, Infinity, options), digest);
    mock.method(fs, "access", async () => {
      throw Object.assign(Error("inconclusive"), { code: "EPERM" });
    });
    syncBuiltinESMExports();
    await assert.rejects(measureCodeTree(lib, Infinity, options), {
      code: "EPERM",
    });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
