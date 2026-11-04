import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pin from "./source-pin.json" with { type: "json" };
import { sourceFixture, fixtureBytes } from "./source-fixtures.js";
import successor from "./successor-source-pin.json" with { type: "json" };
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { groups, runnerCases } from "./manifest.js";
import {
  verifyP7Source,
  validateOrigins,
  validateSuccessor,
  p7ExpectedInputs,
} from "../../scripts/lib/p7-provenance.mjs";
import { verifyA2aSource } from "../../scripts/lib/a2a-acceptance.mjs";
import { parseP7Options } from "../../scripts/lib/p7-options.mjs";
import { prepareNatsServer } from "../../scripts/lib/nats-input.mjs";
import { assessP7 } from "../../scripts/lib/p7-gate.mjs";
import {
  executeOwnedNode,
  successfulExecution,
} from "../../scripts/lib/p7-worker.mjs";
import { labEnvironment } from "../../scripts/lib/delivery-lab.mjs";
import {
  coldBackup,
  restoreImage,
  validateImage,
  sealOracle,
  requiredFiles,
} from "./backup.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function temporary(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function validGroups() {
  return groups.map((d) => {
    const n = d.cases?.length ?? d.count;
    return {
      id: d.id,
      exit_code: 0,
      owned_group_closed: true,
      totals: { tests: n, pass: n, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
      cases: d.cases ? [...d.cases] : [],
    };
  });
}

test(runnerCases[0], (t) => {
  const root = sourceFixture(t);
  const result = verifyP7Source(root, "historical");
  assert.equal(result.inputs, 218);
  assert.equal(result.ancestry_required, false);
  assert.equal(existsSync(join(root, ".git")), false);
  const current = sourceFixture(t, "current");
  assert.equal(verifyP7Source(current).source_profile, "current");
  assert.equal(verifyP7Source(repo).contents_match, true);
  assert.throws(() => p7ExpectedInputs("unknown"), /profile/);
  assert.deepEqual(validateSuccessor(successor), successor);
  const wrong = structuredClone(successor);
  wrong.source_ref = "0".repeat(40);
  assert.throws(() => validateSuccessor(wrong), /manifest/);
  const generator = temporary(t, "p7-successor-generator-");
  execFileSync("git", ["clone", "--no-hardlinks", "--quiet", repo, generator]);
  const run = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Synthetic test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      { cwd: generator },
    );
  const script = join(generator, "scripts/pin-p7-successor.mjs");
  writeFileSync(
    script,
    readFileSync(join(repo, "scripts/pin-p7-successor.mjs")),
  );
  writeFileSync(
    join(generator, "test/p7/successor-source-pin.json"),
    JSON.stringify(successor),
  );
  const changed = "src/types.ts",
    extra = "src/synthetic-successor.ts";
  writeFileSync(
    join(generator, changed),
    Buffer.concat([readFileSync(join(generator, changed)), Buffer.from("\n")]),
  );
  writeFileSync(join(generator, extra), "export const synthetic = true;\n");
  run("add", changed, extra);
  run(
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "synthetic provenance fixture",
  );
  const source = run("rev-parse", "HEAD").toString().trim();
  execFileSync(process.execPath, [script, "--source-ref", source, "--write"], {
    cwd: generator,
  });
  const generated = JSON.parse(
    readFileSync(join(generator, "test/p7/successor-source-pin.json"), "utf8"),
  );
  assert.equal(generated.source_ref, source);
  assert.equal(
    generated.inputs[changed].previous_sha256,
    pin.inputs[changed].sha256,
  );
  assert.equal(generated.inputs[extra].previous_sha256, null);
  const archived = JSON.parse(
    readFileSync(
      join(generator, "test/p7/predecessor-source-fixtures.json"),
      "utf8",
    ),
  );
  assert.ok(archived.blobs[pin.inputs[changed].sha256]);
  assert.deepEqual(
    readFileSync(join(generator, "test/p7/source-pin.json")),
    readFileSync(join(repo, "test/p7/source-pin.json")),
  );
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [script, "--source-ref", "HEAD", "--write"],
      { cwd: generator, stdio: "pipe" },
    ),
  );
  const shallow = temporary(t, "p7-successor-shallow-");
  execFileSync("git", [
    "clone",
    "--quiet",
    "--depth",
    "1",
    pathToFileURL(generator).href,
    shallow,
  ]);
  const shallowScript = join(shallow, "scripts/pin-p7-successor.mjs");
  writeFileSync(shallowScript, readFileSync(script));
  const outputPaths = [
    "test/p7/successor-source-pin.json",
    "test/p7/predecessor-source-fixtures.json",
  ];
  const before = outputPaths.map((path) => readFileSync(join(shallow, path)));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [shallowScript, "--source-ref", source, "--write"],
        { cwd: shallow, stdio: "pipe" },
      ),
    (error) =>
      error.status === 1 &&
      error.stderr.toString().includes("Historical P7 baseline unavailable"),
  );
  assert.deepEqual(
    outputPaths.map((path) => readFileSync(join(shallow, path))),
    before,
  );
  execFileSync("git", ["fetch", "--quiet", "--unshallow"], { cwd: shallow });
  execFileSync(
    process.execPath,
    [shallowScript, "--source-ref", source, "--write"],
    { cwd: shallow },
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(shallow, "test/p7/successor-source-pin.json"), "utf8"),
    ).source_ref,
    source,
  );
});
test(runnerCases[1], (t) => {
  for (const fault of [
    "missing",
    "modified",
    "added",
    "hidden-source",
    "nested-source",
    "symlink",
    "migration",
    "dependency",
  ]) {
    const root = sourceFixture(t),
      file = join(root, "src/a2a/adapter.ts");
    if (fault === "missing") unlinkSync(file);
    if (fault === "modified") writeFileSync(file, "modified");
    if (fault === "added")
      writeFileSync(join(root, "src/unpinned.ts"), "extra");
    if (fault === "hidden-source" || fault === "nested-source") {
      const path = join(
        root,
        "src",
        fault === "hidden-source" ? ".runtime" : "a2a/node_modules",
      );
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "unexpected.ts"), "extra");
    }
    if (fault === "symlink") {
      unlinkSync(file);
      symlinkSync(join(repo, "src/a2a/adapter.ts"), file);
    }
    if (fault === "migration")
      writeFileSync(join(root, "drizzle/9999_unpinned.sql"), "never executed");
    if (fault === "dependency") {
      const path = join(root, "package.json"),
        pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.dependencies["@a2a-js/sdk"] = "unreviewed";
      writeFileSync(path, JSON.stringify(pkg));
    }
    assert.throws(() => verifyP7Source(root, "historical"), undefined, fault);
  }
  const historicalFile = "src/types.ts",
    expected = pin.inputs[historicalFile];
  const bytes = fixtureBytes(historicalFile, expected);
  const archive = {
    blobs: {
      [expected.sha256]: { gzip_base64: gzipSync(bytes).toString("base64") },
    },
  };
  assert.deepEqual(fixtureBytes("absent-fixture", expected, archive), bytes);
  archive.blobs[expected.sha256].gzip_base64 = gzipSync(
    Buffer.from("corrupt"),
  ).toString("base64");
  assert.throws(() => fixtureBytes("absent-fixture", expected, archive));
  const current = sourceFixture(t, "current");
  writeFileSync(join(current, "src/.unexpected"), "extra");
  assert.throws(() => verifyP7Source(current), /inventory/);
  const wrong = structuredClone(pin);
  wrong.inputs["src/hab/sqlite-registry.ts"].origin = "nats";
  assert.throws(() => validateOrigins(wrong), /origin/);
  const ref = structuredClone(pin);
  ref.refs.a2a = "wrong";
  assert.throws(() => validateOrigins(ref), /refs/);
});
test(runnerCases[2], () => {
  assert.throws(() => verifyA2aSource(repo), /A2A pinned source/);
});
test(runnerCases[3], () => {
  assert.equal(assessP7(validGroups()), true);
  assert.equal(assessP7([], []), false);
  assert.equal(
    assessP7(
      validGroups(),
      groups.map((d, i) => (i === 1 ? groups[0] : d)),
    ),
    false,
  );
  const empty = { id: "empty", count: 0 };
  assert.equal(
    assessP7(
      [
        {
          id: "empty",
          exit_code: 0,
          owned_group_closed: true,
          totals: {
            tests: 0,
            pass: 0,
            fail: 0,
            skipped: 0,
            cancelled: 0,
            todo: 0,
          },
        },
      ],
      [empty],
    ),
    false,
  );
  const mutations = [
    (g) => g.pop(),
    (g) => g.push(g[0]),
    (g) => {
      g[0].exit_code = 1;
    },
    (g) => {
      g[0].owned_group_closed = false;
    },
    (g) => {
      g[0].error = "failed";
    },
    (g) => {
      g[0].parse_error = "bad";
    },
    (g) => {
      delete g[0].totals;
    },
    (g) => {
      g[0].totals.tests = 0;
    },
    (g) => {
      g[0].cases[0] = "unexpected";
    },
    (g) => {
      g[0].cases[0] = g[0].cases[1];
    },
    ...["skipped", "cancelled", "todo", "fail"].map((field) => (g) => {
      g[1].totals[field] = 1;
    }),
  ];
  for (const mutate of mutations) {
    const current = validGroups();
    mutate(current);
    assert.equal(assessP7(current), false);
  }
});
test(runnerCases[4], async (t) => {
  assert.deepEqual(parseP7Options(["--nats-server", "/official", "--full"]), {
    natsServer: "/official",
    full: true,
  });
  for (const args of [
    [],
    ["--nats-server", "relative"],
    ["--nats-server", "https://remote"],
    ["--nats-server", "/ok", "--adapter", "/bad"],
    ["--nats-server", "/ok", "--full", "--full"],
    ["--nats-server", "/ok", "--release"],
  ])
    assert.throws(() => parseP7Options(args));
  const root = temporary(t, "p7-binary-negative-"),
    marker = join(root, "executed"),
    binary = join(root, "unverified");
  writeFileSync(binary, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o700 });
  assert.throws(
    () => prepareNatsServer(binary, root),
    (e) => e.code === "nats_binary_size_mismatch",
  );
  const log = join(root, "negative.log");
  const result = await executeOwnedNode({
    cwd: root,
    env: labEnvironment(process.env, root),
    log,
    args: [join(repo, "scripts/p7-lab.mjs"), "--nats-server", binary],
    timeout_ms: 10000,
  });
  assert.equal(result.exit_code, 1);
  assert.equal(result.owned_group_closed, true);
  assert.equal(existsSync(marker), false);
  const output = readFileSync(log, "utf8"),
    path = /^P7 evidence: (.+)$/m.exec(output)?.[1];
  assert.ok(path);
  const report = JSON.parse(readFileSync(join(path, "report.json"), "utf8"));
  assert.equal(report.input_preparation.reason, "nats_binary_size_mismatch");
  assert.equal(report.groups.length, 0);
  assert.equal(report.local_verdict, "FAIL");
  assert.equal(report.scratch_removed, true);
});
test(runnerCases[5], (t) => {
  const root = temporary(t, "p7-image-guards-"),
    source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  for (const file of [...requiredFiles, "broker/store/messages/1.blk"]) {
    mkdirSync(dirname(join(source, file)), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, file), "synthetic image bytes", { mode: 0o600 });
  }
  const closed = {
    phase: "closed",
    root: source,
    closure: {
      stores_closed: true,
      brokers: [{ exited: true }],
      http_ports: [{ closed: true }],
    },
  };
  assert.throws(
    () => coldBackup(closed, join(source, "..backup")),
    /independent/,
  );
  assert.throws(
    () => sealOracle(join(source, "..oracle.json"), {}, [source]),
    /external/,
  );
  const image = coldBackup(closed, join(root, "backup"));
  assert.throws(
    () => restoreImage(image, join(image.root, "inside")),
    /independent/,
  );
  assert.equal(existsSync(join(image.root, "inside")), false);
  for (const path of [
    "../escape",
    "/absolute",
    "app/../escape",
    "app\\escape",
  ]) {
    const bad = structuredClone(image.manifest);
    bad.files[0].path = path;
    assert.throws(() => validateImage(image.root, bad), /unsafe/);
  }
  const duplicate = structuredClone(image.manifest);
  duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateImage(image.root, duplicate), /incomplete/);
  const link = join(root, "image-link");
  symlinkSync(image.root, link);
  assert.throws(() => validateImage(link, image.manifest), /regular directory/);
  const target = join(image.root, "app/engine.sqlite"),
    bytes = readFileSync(target);
  unlinkSync(target);
  symlinkSync(join(source, "app/engine.sqlite"), target);
  assert.throws(() => validateImage(image.root, image.manifest), /symlink/);
  unlinkSync(target);
  writeFileSync(target, bytes, { mode: 0o600 });
  writeFileSync(target, "changed");
  assert.throws(() => validateImage(image.root, image.manifest), /bytes/);
  writeFileSync(target, bytes);
  chmodSync(join(image.root, "host"), 0o755);
  assert.throws(() => validateImage(image.root, image.manifest), /mode/);
});
test(runnerCases[6], async (t) => {
  const root = temporary(t, "p7-worker-tree-"),
    script = join(root, "tree.mjs"),
    pidFile = join(root, "descendant.pid");
  writeFileSync(
    script,
    `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[2],String(c.pid));setInterval(()=>{},1000);`,
  );
  const result = await executeOwnedNode({
    cwd: root,
    env: labEnvironment(process.env, root),
    log: join(root, "tree.log"),
    args: [script, pidFile],
    timeout_ms: 500,
    grace_ms: 100,
  });
  assert.equal(result.timed_out, true);
  assert.equal(result.owned_group_closed, true);
  assert.ok(existsSync(pidFile));
  const zero = join(root, "zero-on-timeout.mjs");
  writeFileSync(
    zero,
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);",
  );
  const timedZero = await executeOwnedNode({
    cwd: root,
    env: labEnvironment(process.env, root),
    log: join(root, "zero.log"),
    args: [zero],
    timeout_ms: 300,
  });
  assert.equal(timedZero.exit_code, 0);
  assert.equal(timedZero.timed_out, true);
  assert.equal(successfulExecution(timedZero), false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === "ESRCH",
  );
});
