import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNodePin,
  assertNpmPin,
  readToolchainPin,
} from "./lib/toolchain.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = readToolchainPin(repo);

try {
  assertNodePin(pin, process.versions.node, process.execPath);
  const npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
  }).trim();
  assertNpmPin(pin, npmVersion);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
