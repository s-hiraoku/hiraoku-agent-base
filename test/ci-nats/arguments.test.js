import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { labEnvironment } from "../../scripts/lib/delivery-lab.mjs";
import { selectNatsPin } from "../../scripts/lib/nats-input.mjs";
import { executeOwnedNode } from "../../scripts/lib/p7-worker.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = join(repo, ".runtime");
const catalog = {
  p4: ["backend.test.js"],
  p5: ["backend.test.js", "guarded-commits.test.js"],
  p6: [
    "backend.test.js",
    "configured-host.test.js",
    "delivery-semantics.test.js",
    "guarded-commits.test.js",
    "hab-integration.test.js",
  ],
};
const inventory = readdirSync(join(repo, "packages/relay-nats/test"))
  .filter((file) => file.endsWith(".test.js"))
  .sort();
const stage = Object.entries(catalog).find(
  ([, files]) => JSON.stringify(files) === JSON.stringify(inventory),
)?.[0];
assert.ok(stage, "a known P4, P5, or P6 package test inventory is required");
const wrongStage = stage === "p4" ? "p5" : "p4";
const pin = selectNatsPin();
const validArgs = (binary) => ["--stage", stage, "--nats-server", binary];
const cases = [
  { name: "missing stage flag", args: (binary) => ["--nats-server", binary] },
  { name: "missing server flag", args: () => ["--stage", stage] },
  {
    name: "duplicate stage flag",
    args: (binary) => [...validArgs(binary), "--stage", stage],
  },
  {
    name: "unknown stage",
    args: (binary) => ["--stage", "p9", "--nats-server", binary],
  },
  {
    name: "URL server input",
    args: () => validArgs("https://example.invalid/server"),
  },
  {
    name: "external adapter flag",
    args: (binary) => [...validArgs(binary), "--adapter", "other.js"],
  },
  {
    name: "stage catalog mismatch",
    args: (binary) => ["--stage", wrongStage, "--nats-server", binary],
    exit: 1,
    message: "NATS CI stage test inventory mismatch",
  },
  {
    name: "wrong binary size",
    args: validArgs,
    input: "short",
    error: "nats_binary_size_mismatch",
  },
  {
    name: "same-size binary with wrong SHA256",
    args: validArgs,
    input: "same-size",
    error: "nats_binary_sha256_mismatch",
  },
  {
    name: "symlink server input",
    args: validArgs,
    input: "symlink",
    error: "nats_source_unreadable",
  },
];

for (const scenario of cases) {
  test(`CI NATS refuses ${scenario.name} without executing input`, async (t) => {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(runtime, "ci-arguments-"));
    t.after(() => {
      rmSync(scratch, { recursive: true, force: true });
      assert.equal(existsSync(scratch), false);
    });
    const marker = join(scratch, "unexpected-execution");
    const binary = join(scratch, "candidate-server");
    const quotedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
    const script = Buffer.from(
      `#!/bin/sh\nprintf 'unexpected execution\\n' > ${quotedMarker}\nexit 91\n`,
    );
    if (scenario.input) {
      const bytes =
        scenario.input === "same-size"
          ? Buffer.alloc(pin.binary_bytes)
          : Buffer.alloc(script.length);
      script.copy(bytes);
      if (scenario.input === "symlink") {
        const target = join(scratch, "symlink-target");
        writeFileSync(target, bytes, { mode: 0o500 });
        symlinkSync(target, binary);
      } else writeFileSync(binary, bytes, { mode: 0o500 });
    }
    const before = new Set(readdirSync(runtime));
    const log = join(scratch, "cli.log");
    const result = await executeOwnedNode({
      cwd: scratch,
      env: labEnvironment(process.env, scratch),
      log,
      args: [join(repo, "scripts/ci-nats.mjs"), ...scenario.args(binary)],
      timeout_ms: 10000,
      signal: t.signal,
    });
    const output = readFileSync(log, "utf8");
    assert.equal(result.exit_code, scenario.exit ?? (scenario.error ? 1 : 2));
    assert.equal(result.error, undefined);
    assert.equal(result.timed_out, false);
    assert.equal(result.interrupted, false);
    assert.equal(result.owned_group_closed, true);
    assert.equal(
      existsSync(marker),
      false,
      "authored input must never execute",
    );
    if (scenario.error) {
      const reportPath = /^FAIL: (.+\/report\.json)$/m.exec(output)?.[1];
      assert.ok(reportPath, output);
      assert.equal(dirname(dirname(reportPath)), runtime);
      assert.ok(basename(dirname(reportPath)).startsWith("ci-nats-"));
      assert.equal(before.has(basename(dirname(reportPath))), false);
      assert.equal(lstatSync(reportPath).isFile(), true);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report.passed, false);
      assert.equal(report.error, scenario.error);
      assert.equal(report.input.state, "rejected");
      assert.equal(report.input.backend_executed, false);
      assert.deepEqual(report.groups, []);
      assert.equal(report.private_state_removed, true);
      assert.equal(existsSync(join(dirname(reportPath), "tmp")), false);
    } else {
      assert.equal(/^FAIL: /m.test(output), false);
      assert.ok(
        output.includes(scenario.message ?? "usage: ci-nats.mjs"),
        output,
      );
    }
  });
}
