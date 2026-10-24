import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PilotInspector, measureCodeTree } from "../src/pilot-inspector.ts";
import { policyFixture } from "./pilot-policy-fixture.js";
import { skipAsRoot } from "./non-root.js";

test("system policy requires root ownership and denies effective-user write including ACL grants", async (t) => {
  if (skipAsRoot(t)) return;
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "hub-system-fixture-")),
  );
  await fs.writeFile(join(root, "library"), "reviewed library");
  const lstat = fs.lstat;
  let writable = false;
  try {
    await assert.rejects(
      measureCodeTree(root),
      /pilot_code_integrity_rejected/,
    );
    await assert.rejects(
      measureCodeTree(root, Infinity, { systemRuntime: true }),
      /pilot_system_runtime_rejected/,
    );
    mock.method(fs, "lstat", async (p) => {
      const s = await lstat(p);
      s.uid = 0;
      return s;
    });
    mock.method(fs, "access", async () => {
      if (!writable)
        throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    const digest = await measureCodeTree(root, Infinity, {
      systemRuntime: true,
    });
    assert.match(digest, /^[a-f0-9]{64}$/);
    writable = true;
    await assert.rejects(
      measureCodeTree(root, Infinity, { systemRuntime: true }),
      /pilot_system_runtime_writable/,
    );
    writable = false;
    await assert.rejects(
      measureCodeTree(root, Infinity, { systemRuntime: true, maxBytes: 1 }),
      /pilot_code_integrity_rejected/,
    );
    await assert.rejects(
      measureCodeTree(root, Infinity, {
        systemRuntime: true,
        maxBytes: 1073741825,
      }),
    );
    await fs.symlink("library", join(root, "alias"));
    await assert.rejects(
      measureCodeTree(root, Infinity, { systemRuntime: true }),
      /pilot_code_integrity_rejected/,
    );
    await measureCodeTree(root, Infinity, {
      systemRuntime: true,
      aliases: { alias: join(root, "library") },
    });
    await assert.rejects(
      measureCodeTree(root, Infinity, {
        systemRuntime: true,
        aliases: { alias: join(root, "wrong") },
      }),
      /pilot_code_integrity_rejected/,
    );
    await assert.rejects(
      measureCodeTree(root, 0, { systemRuntime: true }),
      /pilot_code_integrity_rejected/,
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("policy binds system alias targets to measured system roots and bounds total declared scan size", async (t) => {
  if (skipAsRoot(t)) return;
  const fixture = await policyFixture("http://127.0.0.1:10001/");
  try {
    const p = fixture.policy;
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: [{ ...p.codeTrees[0], aliases: { alias: "/unmeasured" } }],
        }),
      /pilot_policy_rejected/,
    );
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: [
            {
              ...p.codeTrees[0],
              systemRuntime: true,
              aliases: { alias: "/unmeasured" },
            },
          ],
        }),
      /pilot_policy_rejected/,
    );
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: Array.from({ length: 7 }, () => ({
            ...p.codeTrees[0],
            maxBytes: 1,
          })),
        }),
    );
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: Array.from({ length: 3 }, () => ({
            ...p.codeTrees[0],
            maxBytes: 1073741824,
          })),
        }),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("default trees reject ACL write and only explicitly reviewed package resources bypass the name gate", async (t) => {
  if (skipAsRoot(t)) return;
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "hub-resource-fixture-")),
  );
  await fs.mkdir(join(root, "logs"));
  await fs.writeFile(join(root, "logs", "api-schema.json"), '{"fixture":true}');
  await fs.chmod(join(root, "logs", "api-schema.json"), 0o400);
  await fs.chmod(join(root, "logs"), 0o500);
  await fs.chmod(root, 0o500);
  try {
    await assert.rejects(
      measureCodeTree(root),
      /pilot_code_root_contains_private_data/,
    );
    await measureCodeTree(root, Infinity, { reviewedResources: ["logs"] });
    mock.method(fs, "access", async () => {});
    syncBuiltinESMExports();
    await assert.rejects(
      measureCodeTree(root, Infinity, { reviewedResources: ["logs"] }),
      /pilot_code_integrity_rejected/,
    );
    mock.restoreAll();
    syncBuiltinESMExports();
    await assert.rejects(
      measureCodeTree(root, Infinity, { reviewedResources: ["../logs"] }),
    );
    await assert.rejects(
      measureCodeTree(root, Infinity, { reviewedResources: [".env"] }),
    );
    await fs.chmod(root, 0o700);
    await fs.writeFile(join(root, ".env"), "fixture marker", { mode: 0o400 });
    await fs.chmod(root, 0o500);
    await assert.rejects(
      measureCodeTree(root, Infinity, { reviewedResources: ["logs"] }),
      /pilot_code_root_contains_private_data/,
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.chmod(root, 0o700);
    await fs.chmod(join(root, "logs"), 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only declared disabled system site-packages can be omitted; aliases cannot reintroduce them", async (t) => {
  if (skipAsRoot(t)) return;
  const fixture = await policyFixture("http://127.0.0.1:10001/");
  const lib = join(fixture.root, "lib");
  const global = join(lib, "python3.11", "site-packages");
  const lstat = fs.lstat;
  try {
    await fs.mkdir(global, { recursive: true });
    await fs.writeFile(
      join(global, "unapproved.py"),
      "fixture excluded package",
    );
    await fs.chmod(join(lib, "python3.11"), 0o500);
    await fs.chmod(lib, 0o500);
    mock.method(fs, "lstat", async (p) => {
      const s = await lstat(p);
      s.uid = 0;
      return s;
    });
    mock.method(fs, "access", async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    const options = {
      systemRuntime: true,
      excludedSystemSitePackages: "python3.11/site-packages",
    };
    const digest = await measureCodeTree(lib, Infinity, options);
    await fs.writeFile(
      join(global, "unapproved.py"),
      "changed excluded fixture",
    );
    assert.equal(await measureCodeTree(lib, Infinity, options), digest);
    await assert.rejects(
      measureCodeTree(lib, Infinity, {
        ...options,
        excludedSystemSitePackages: "../site-packages",
      }),
    );
    const p = fixture.policy;
    const tree = { root: lib, sha256: digest, ...options, maxBytes: 1 };
    new PilotInspector({ ...p, codeTrees: [...p.codeTrees, tree] });
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: [...p.codeTrees, { ...tree, systemRuntime: false }],
        }),
      /pilot_policy_rejected/,
    );
    assert.throws(
      () =>
        new PilotInspector({
          ...p,
          codeTrees: [
            ...p.codeTrees,
            { ...tree, aliases: { alias: join(global, "unapproved.py") } },
          ],
        }),
      /pilot_policy_rejected/,
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await fs.chmod(lib, 0o700);
    await fs.chmod(join(lib, "python3.11"), 0o700);
    await fixture.cleanup();
  }
});

test("process interpreter must be an exact separately measured system runtime", async (t) => {
  if (skipAsRoot(t)) return;
  const fixture = await policyFixture("http://127.0.0.1:10001/");
  try {
    const p = fixture.policy;
    const target = join(fixture.root, "native-launcher");
    const tree = {
      root: target,
      sha256: "a".repeat(64),
      systemRuntime: true,
      maxBytes: 1,
    };
    new PilotInspector({
      ...p,
      processInterpreterPath: target,
      codeTrees: [...p.codeTrees, tree],
    });
    for (const codeTrees of [
      p.codeTrees,
      [...p.codeTrees, { ...tree, systemRuntime: false }],
      [...p.codeTrees, { ...tree, root: fixture.root }],
    ]) {
      assert.throws(
        () =>
          new PilotInspector({
            ...p,
            processInterpreterPath: target,
            codeTrees,
          }),
        /pilot_policy_rejected/,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});
