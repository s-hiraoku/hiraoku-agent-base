import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCurrentToolchain,
  readToolchainPin,
} from "./lib/toolchain.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  assertCurrentToolchain(readToolchainPin(repo));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
