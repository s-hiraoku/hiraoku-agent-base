import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Pinned Node and npm versions for local and CI test runs. */
export function readToolchainPin(repoRoot) {
  const node = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
  if (!node) {
    const error = Error("missing .node-version pin");
    error.code = "TOOLCHAIN_PIN_MISSING_NODE";
    throw error;
  }
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const packageManager = packageJson.packageManager;
  if (typeof packageManager !== "string" || !packageManager.startsWith("npm@")) {
    const error = Error("package.json packageManager must be npm@<version>");
    error.code = "TOOLCHAIN_PIN_MISSING_NPM";
    throw error;
  }
  const npm = packageManager.slice("npm@".length).trim();
  if (!npm) {
    const error = Error("package.json packageManager must be npm@<version>");
    error.code = "TOOLCHAIN_PIN_MISSING_NPM";
    throw error;
  }
  return Object.freeze({ node, npm });
}

export function assertNodePin(pin, actualNode, execPath) {
  if (actualNode === pin.node) return;
  const error = Error(
    `toolchain requires Node ${pin.node}; current ${actualNode} (${execPath})`,
  );
  error.code = "TOOLCHAIN_NODE_MISMATCH";
  throw error;
}

export function assertNpmPin(pin, actualNpm) {
  if (actualNpm === pin.npm) return;
  const error = Error(
    `toolchain requires npm ${pin.npm}; current ${actualNpm}`,
  );
  error.code = "TOOLCHAIN_NPM_MISMATCH";
  throw error;
}

export function readNpmVersion(run = execFileSync) {
  return run("npm", ["--version"], { encoding: "utf8" }).trim();
}

/** Fail closed when the active Node or npm differs from the repo pins. */
export function assertCurrentToolchain(
  pin,
  {
    node = process.versions.node,
    execPath = process.execPath,
    npm = readNpmVersion(),
  } = {},
) {
  assertNodePin(pin, node, execPath);
  assertNpmPin(pin, npm);
}
