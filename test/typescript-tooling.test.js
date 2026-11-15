import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const native = dirname(require.resolve("@typescript/native/package.json"));

test("TypeScript 7 checks types while TypeScript 6 retains the tooling API", () => {
  assert.match(require("@typescript/native/package.json").version, /^7\./);
  assert.match(ts.version, /^6\./);
  assert.equal(
    realpathSync(join(repo, "node_modules/.bin/tsc")),
    realpathSync(join(native, "bin/tsc")),
  );
  assert.deepEqual(Object.keys(require("typescript/package.json").bin), [
    "tsc6",
  ]);
  assert.deepEqual(
    Object.keys(require("@typescript/native/package.json").bin),
    ["tsc"],
  );
  const ast = ts.createSourceFile(
    "fixture.ts",
    "export const x: string = 'ok';",
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(ast.parseDiagnostics.length, 0);
  assert.ok(ts.isVariableStatement(ast.statements[0]));
  const version = spawnSync(
    process.execPath,
    [join(native, "bin/tsc"), "--version"],
    { encoding: "utf8" },
  );
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /Version 7\./);
  const root = mkdtempSync(join(tmpdir(), "hab-ts7-"));
  try {
    const file = join(root, "fixture.ts");
    writeFileSync(file, "const value: string = 42;\n");
    const invalid = spawnSync(
      process.execPath,
      [
        join(native, "bin/tsc"),
        "--noEmit",
        "--skipLibCheck",
        "--ignoreConfig",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /TS2322/);
    writeFileSync(file, "const value: string = 'ok';\n");
    const valid = spawnSync(
      process.execPath,
      [
        join(native, "bin/tsc"),
        "--noEmit",
        "--skipLibCheck",
        "--ignoreConfig",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("typescript-eslint can load its TypeScript 6 peer API", async () => {
  const { default: tseslint } = await import("typescript-eslint");
  assert.ok(tseslint.configs.recommended.length > 0);
});
