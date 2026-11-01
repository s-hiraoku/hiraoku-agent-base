import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseLabOptions,
  prepareNatsServer,
  selectNatsPin,
  stagePinnedBytes,
} from "../../scripts/lib/nats-input.mjs";
import {
  executeNode,
  labEnvironment,
  tapTotals,
} from "../../scripts/lib/delivery-lab.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixtureBytes = Buffer.from("known inert fixture bytes\n");
const fixturePin = Object.freeze({
  version: "fixture-only",
  platform: "fixture-only",
  binary_bytes: 26,
  binary_sha256:
    "a9f169dc0d994b74eb8c0be7f0c8c7eb29445824659b80b6808222c0e049186d",
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "nats-input-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  writeFileSync(source, fixtureBytes, { mode: 0o644 });
  const scratch = join(dir, "scratch");
  mkdirSync(scratch, { mode: 0o700 });
  return { dir, source, scratch };
}
const code = (expected) => (error) =>
  error.code === expected && error.message === expected;

test("N01 strict CLI retains full/release and one explicit absolute server file", () => {
  assert.deepEqual(parseLabOptions([]), {
    full: false,
    release: false,
    natsServer: undefined,
  });
  assert.deepEqual(
    parseLabOptions(["--nats-server", "/private/input", "--release"]),
    { full: true, release: true, natsServer: "/private/input" },
  );
  assert.deepEqual(
    parseLabOptions(["--full", "--nats-server=/private/input"]),
    { full: true, release: false, natsServer: "/private/input" },
  );
});

test("N02 unknown connection/trust options, duplicate values and malformed paths cannot approve input", () => {
  for (const args of [
    ["--nats-server"],
    ["--nats-server", "--full"],
    ["--nats-server", "/a", "--nats-server", "/b"],
    ["--full", "--full"],
    ["--"],
    ["/positional"],
    ["--nats-sha256", "anything"],
    ["--nats-manifest", "/fake"],
    [
      "--nats-url",
      "nats://synthetic-user:synthetic-secret@example.invalid:4222",
    ],
    ["--nats-config", "/production"],
    ["--cwd", "/production"],
  ])
    assert.throws(() => parseLabOptions(args), code("invalid_lab_arguments"));
  for (const path of [
    "relative",
    "",
    "nats://example.invalid:4222",
    "file:///private/input",
    "/private/\0input",
  ])
    assert.throws(
      () => parseLabOptions(["--nats-server", path]),
      code("invalid_nats_server_path"),
    );
});

test("N03 official release policy has fixed identities and refuses unsupported platforms", () => {
  for (const platform of ["darwin", "linux"])
    for (const arch of ["x64", "arm64"]) {
      const pin = selectNatsPin(platform, arch);
      assert.equal(pin.version, "2.15.2");
      assert.match(
        pin.url,
        /^https:\/\/github\.com\/nats-io\/nats-server\/releases\/download\/v2\.15\.2\//,
      );
      assert.match(pin.archive_sha256, /^[a-f0-9]{64}$/);
      assert.match(pin.binary_sha256, /^[a-f0-9]{64}$/);
      assert.notEqual(pin.archive_sha256, pin.binary_sha256);
      assert.ok(pin.binary_bytes > 10_000_000 && pin.binary_bytes < 25_000_000);
    }
  assert.throws(
    () => selectNatsPin("win32", "x64"),
    code("unsupported_nats_platform"),
  );
  assert.throws(
    () => selectNatsPin("linux", "ia32"),
    code("unsupported_nats_platform"),
  );
});

test("N04 missing files, directories, leaf symlinks and FIFOs refuse before a blocking read", (t) => {
  const f = fixture(t);
  assert.throws(
    () => stagePinnedBytes(join(f.dir, "missing"), f.scratch, fixturePin),
    code("nats_source_unreadable"),
  );
  assert.throws(
    () => stagePinnedBytes(f.dir, f.scratch, fixturePin),
    code("nats_source_not_regular"),
  );
  const link = join(f.dir, "link");
  symlinkSync(f.source, link);
  assert.throws(
    () => stagePinnedBytes(link, f.scratch, fixturePin),
    code("nats_source_unreadable"),
  );
  const fifo = join(f.dir, "fifo");
  const made = spawnSync("mkfifo", [fifo], {
    env: labEnvironment(process.env, f.dir),
  });
  assert.equal(made.status, 0);
  assert.throws(
    () => stagePinnedBytes(fifo, f.scratch, fixturePin),
    code("nats_source_not_regular"),
  );
});

test("N05 wrong length and same-length corruption fail exact byte identity", (t) => {
  const f = fixture(t);
  writeFileSync(f.source, "wrong size");
  assert.throws(
    () => stagePinnedBytes(f.source, f.scratch, fixturePin),
    code("nats_binary_size_mismatch"),
  );
  writeFileSync(f.source, Buffer.alloc(fixtureBytes.length, 0x78));
  assert.throws(
    () => stagePinnedBytes(f.source, f.scratch, fixturePin),
    code("nats_binary_sha256_mismatch"),
  );
});

test("N06 verified bytes are privately copied without source changes and survive source replacement", (t) => {
  const f = fixture(t);
  const originalMode = statSync(f.source).mode;
  const staged = stagePinnedBytes(f.source, f.scratch, fixturePin);
  assert.notEqual(staged.stagedPath, f.source);
  assert.deepEqual(readFileSync(staged.stagedPath), fixtureBytes);
  assert.deepEqual(readFileSync(f.source), fixtureBytes);
  assert.equal(statSync(f.source).mode, originalMode);
  assert.equal(statSync(staged.fixtureCwd).mode & 0o777, 0o700);
  assert.equal(statSync(staged.stagedPath).mode & 0o777, 0o500);
  assert.equal(staged.evidence.backend_executed, false);
  unlinkSync(f.source);
  writeFileSync(f.source, "replacement");
  assert.deepEqual(readFileSync(staged.stagedPath), fixtureBytes);
  rmSync(staged.fixtureCwd, { recursive: true });
  assert.equal(existsSync(staged.stagedPath), false);
});

test(
  "N07 staging failure does not mutate the input",
  { skip: process.getuid?.() === 0 },
  (t) => {
    const f = fixture(t);
    chmodSync(f.scratch, 0o500);
    try {
      assert.throws(
        () => stagePinnedBytes(f.source, f.scratch, fixturePin),
        code("nats_staging_failed"),
      );
      assert.deepEqual(readFileSync(f.source), fixtureBytes);
    } finally {
      chmodSync(f.scratch, 0o700);
    }
  },
);

test("N08 inert fixture bytes and private cwd reach an actual sanitized observation child", async (t) => {
  const f = fixture(t);
  const prepared = stagePinnedBytes(f.source, f.scratch, fixturePin);
  const env = labEnvironment(
    {
      ...process.env,
      HAB_NATS_SERVER: "/unverified",
      HAB_RUNTIME_CONFIG: "/production",
      NATS_URL: "nats://synthetic-user:synthetic-secret@example.invalid:4222",
      NATS_PASSWORD: "synthetic-secret",
      NATS_CREDS: "/production/creds",
      OPENAI_API_KEY: "synthetic-secret",
      NODE_OPTIONS: "--import=/untrusted",
      HTTPS_PROXY: "http://example.invalid",
      HOME: "/production/home",
    },
    f.scratch,
    prepared,
  );
  const source = join(f.dir, "observe.mjs");
  writeFileSync(
    source,
    `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { test } from 'node:test';
    test('inert fixture handoff only', () => {
      assert.equal(process.cwd(), ${JSON.stringify(prepared.fixtureCwd)});
      assert.equal(process.env.HAB_NATS_SERVER, ${JSON.stringify(prepared.stagedPath)});
      assert.equal(readFileSync(process.env.HAB_NATS_SERVER, 'utf8'), 'known inert fixture bytes\\n');
      for (const key of ['HOME','HAB_RUNTIME_CONFIG','NATS_URL','NATS_PASSWORD','NATS_CREDS','OPENAI_API_KEY','HTTPS_PROXY']) assert.equal(Object.hasOwn(process.env, key), false);
      assert.equal(process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning');
    });
  `,
  );
  const log = join(f.dir, "probe.tap");
  const execution = await executeNode({
    cwd: prepared.fixtureCwd,
    env,
    log,
    args: ["--test", "--test-reporter=tap", source],
    timeout_ms: 5000,
  });
  assert.equal(execution.exit_code, 0, readFileSync(log, "utf8"));
  assert.equal(tapTotals(readFileSync(log, "utf8")).pass, 1);
  assert.equal(
    labEnvironment({ HAB_NATS_SERVER: "/unverified" }, f.scratch)
      .HAB_NATS_SERVER,
    undefined,
  );
});

test("N09 public CLI rejects an executable-shaped same-size sentinel without running it or any test group", async (t) => {
  const f = fixture(t);
  const marker = join(f.dir, "executed");
  const bytes = Buffer.alloc(selectNatsPin().binary_bytes, 0x20);
  Buffer.from(
    `#!/bin/sh\nprintf marker > ${JSON.stringify(marker)}\nexit 0\n`,
  ).copy(bytes);
  writeFileSync(f.source, bytes, { mode: 0o700 });
  chmodSync(f.source, 0o700);
  const before = createHash("sha256")
    .update(readFileSync(f.source))
    .digest("hex");
  const log = join(f.dir, "cli.log");
  const execution = await executeNode({
    cwd: repo,
    env: labEnvironment(process.env, f.dir),
    log,
    args: [join(repo, "scripts/delivery-lab.mjs"), "--nats-server", f.source],
    timeout_ms: 10000,
  });
  assert.equal(execution.exit_code, 1);
  assert.equal(existsSync(marker), false);
  assert.equal(
    createHash("sha256").update(readFileSync(f.source)).digest("hex"),
    before,
  );
  const output = readFileSync(log, "utf8");
  const run = /^Delivery lab evidence: (.+)$/m.exec(output)?.[1];
  assert.ok(run, output);
  const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8"));
  assert.equal(report.verdict, "FAIL");
  assert.deepEqual(report.groups, []);
  assert.deepEqual(report.nats_input, {
    state: "rejected",
    code: "nats_binary_sha256_mismatch",
    backend_executed: false,
  });
  assert.equal(existsSync(join(run, "tmp")), false);
  assert.throws(
    () => prepareNatsServer(f.source, f.scratch, fixturePin),
    code("nats_binary_sha256_mismatch"),
  );
});

test("N10 public CLI does not echo credential-shaped unknown options or accept relative input", async (t) => {
  const f = fixture(t);
  for (const args of [
    ["--nats-url=nats://synthetic-secret@example.invalid:4222"],
    ["--nats-server", "relative"],
  ]) {
    const log = join(f.dir, `argument-${args.length}.log`);
    const execution = await executeNode({
      cwd: repo,
      env: labEnvironment(process.env, f.dir),
      log,
      args: [join(repo, "scripts/delivery-lab.mjs"), ...args],
      timeout_ms: 5000,
    });
    assert.equal(execution.exit_code, 2);
    const output = readFileSync(log, "utf8");
    assert.match(
      output,
      /^delivery_lab_rejected (invalid_lab_arguments|invalid_nats_server_path)\n$/,
    );
    assert.equal(output.includes("synthetic-secret"), false);
  }
});
