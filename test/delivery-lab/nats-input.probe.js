import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { selectNatsPin } from "../../scripts/lib/nats-input.mjs";

test("verified NATS input reaches only the private observation child without execution", () => {
  const pin = selectNatsPin();
  const path = process.env.HAB_NATS_SERVER;
  assert.equal(path, join(process.cwd(), "bin", "nats-server"));
  assert.equal(lstatSync(path).isFile(), true);
  assert.equal(statSync(process.cwd()).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o500);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, pin.binary_bytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    pin.binary_sha256,
  );
  assert.equal(process.env.HAB_DELIVERY_LAB, "synthetic-only");
  assert.equal(
    process.env.NODE_OPTIONS,
    "--disable-warning=ExperimentalWarning",
  );
  for (const name of [
    "HOME",
    "HAB_RUNTIME_CONFIG",
    "HAB_NATS_URL",
    "NATS_URL",
    "NATS_CREDS",
    "NATS_PASSWORD",
    "AUTH0_TOKEN",
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
  ])
    assert.equal(Object.hasOwn(process.env, name), false, name);
});
