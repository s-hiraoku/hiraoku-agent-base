import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCurrentToolchain,
  assertNodePin,
  assertNpmPin,
  readToolchainPin,
} from "../scripts/lib/toolchain.mjs";

test("readToolchainPin reads .node-version and packageManager", () => {
  const root = mkdtempSync(join(tmpdir(), "hab-toolchain-"));
  try {
    writeFileSync(join(root, ".node-version"), "26.13.1\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.20.0" }),
    );
    assert.deepEqual(readToolchainPin(root), {
      node: "26.13.1",
      npm: "11.20.0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertNodePin refuses a shadowed older Node", () => {
  const pin = { node: "26.13.1", npm: "11.20.0" };
  assert.throws(
    () => assertNodePin(pin, "22.23.4", "/exec-daemon/node"),
    (error) =>
      error.code === "TOOLCHAIN_NODE_MISMATCH" &&
      /requires Node 26\.13\.1/.test(error.message) &&
      /\/exec-daemon\/node/.test(error.message),
  );
});

test("assertNpmPin refuses packageManager drift", () => {
  const pin = { node: "26.13.1", npm: "11.20.0" };
  assert.throws(
    () => assertNpmPin(pin, "11.21.2"),
    (error) =>
      error.code === "TOOLCHAIN_NPM_MISMATCH" &&
      /requires npm 11\.20\.0/.test(error.message),
  );
});

test("readToolchainPin refuses an empty .node-version", () => {
  const root = mkdtempSync(join(tmpdir(), "hab-toolchain-"));
  try {
    writeFileSync(join(root, ".node-version"), "\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@11.20.0" }),
    );
    assert.throws(
      () => readToolchainPin(root),
      (error) => error.code === "TOOLCHAIN_PIN_MISSING_NODE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching pins pass without throwing", () => {
  const pin = { node: "26.13.1", npm: "11.20.0" };
  assertNodePin(pin, "26.13.1", "/home/ubuntu/.nvm/versions/node/v26.13.1/bin/node");
  assertNpmPin(pin, "11.20.0");
});

test("assertCurrentToolchain refuses npm drift with a matching Node", () => {
  const pin = { node: "26.13.1", npm: "11.20.0" };
  assert.throws(
    () =>
      assertCurrentToolchain(pin, {
        node: "26.13.1",
        execPath: "/home/ubuntu/.nvm/versions/node/v26.13.1/bin/node",
        npm: "11.21.2",
      }),
    (error) => error.code === "TOOLCHAIN_NPM_MISMATCH",
  );
});

test("assertCurrentToolchain accepts matching Node and npm", () => {
  const pin = { node: "26.13.1", npm: "11.20.0" };
  assertCurrentToolchain(pin, {
    node: "26.13.1",
    execPath: "/home/ubuntu/.nvm/versions/node/v26.13.1/bin/node",
    npm: "11.20.0",
  });
});
