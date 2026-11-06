import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { labEnvironment, tapTotals } from "./lib/delivery-lab.mjs";
import { prepareNatsServer } from "./lib/nats-input.mjs";
import { executeOwnedNode, successfulExecution } from "./lib/p7-worker.mjs";

const stages = {
  p4: { files: ["backend.test.js"], count: 21 },
  p5: {
    files: ["backend.test.js", "guarded-commits.test.js"],
    count: 34,
  },
  p6: {
    files: [
      "backend.test.js",
      "configured-host.test.js",
      "delivery-semantics.test.js",
      "guarded-commits.test.js",
      "hab-integration.test.js",
    ],
    count: 60,
    shared: true,
  },
};
let options;
try {
  const parsed = parseArgs({
    options: {
      stage: { type: "string" },
      "nats-server": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const names = parsed.tokens.map((token) => token.name);
  if (
    names.length !== 2 ||
    new Set(names).size !== 2 ||
    !Object.hasOwn(stages, parsed.values.stage) ||
    !isAbsolute(parsed.values["nats-server"] ?? "")
  )
    throw Error("invalid arguments");
  options = {
    stage: parsed.values.stage,
    binary: parsed.values["nats-server"],
  };
} catch {
  process.stderr.write(
    "usage: ci-nats.mjs --stage p4|p5|p6 --nats-server /absolute/official/binary\n",
  );
  process.exit(2);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repo, "packages/relay-nats");
const definition = stages[options.stage];
if (
  process.versions.node !==
  readFileSync(join(repo, ".node-version"), "utf8").trim()
)
  throw Error("NATS CI requires the pinned Node version");
const actualFiles = readdirSync(join(packageRoot, "test"))
  .filter((file) => file.endsWith(".test.js"))
  .sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(definition.files))
  throw Error("NATS CI stage test inventory mismatch");

mkdirSync(join(repo, ".runtime"), { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(repo, ".runtime/ci-nats-"));
const scratch = join(run, "tmp");
mkdirSync(scratch, { mode: 0o700 });
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  schema: "hab-nats-ci-v1",
  stage: options.stage,
  node: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  expected_test_files: definition.files,
  expected_test_count: definition.count,
  shared_scope: definition.shared
    ? "8 real HAB compatibility contracts on the JetStream-only host"
    : "not part of this stage",
  groups: [],
  input: { state: "not-prepared", backend_executed: false },
};
let prepared;
async function runTests(id, files, count) {
  const log = join(run, `${id}.tap`);
  const execution = await executeOwnedNode({
    cwd: scratch,
    env: labEnvironment(process.env, scratch, prepared),
    log,
    args: [
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=2",
      "--test-timeout=120000",
      ...files,
    ],
    timeout_ms: 300000,
    signal: controller.signal,
  });
  let totals, parseError;
  try {
    totals = tapTotals(readFileSync(log, "utf8"));
  } catch (error) {
    parseError = error.message;
  }
  const passed =
    !parseError &&
    successfulExecution(execution) &&
    totals.tests === count &&
    totals.pass === count &&
    totals.fail === 0 &&
    totals.cancelled === 0 &&
    totals.skipped === 0 &&
    totals.todo === 0;
  report.groups.push({
    id,
    ...execution,
    totals,
    parse_error: parseError,
    passed,
  });
  if (id === "jetstream" && totals?.pass > 0)
    report.input.backend_executed = true;
  console.log(JSON.stringify(report.groups.at(-1)));
  if (!passed) throw Error(`NATS CI group failed: ${id}`);
}
try {
  prepared = prepareNatsServer(options.binary, scratch);
  report.input = { ...prepared.evidence };
  report.source_sha256 = Object.fromEntries(
    [
      "scripts/ci-nats.mjs",
      "scripts/lib/p7-worker.mjs",
      "scripts/lib/delivery-lab.mjs",
      "scripts/lib/nats-input.mjs",
      "scripts/lib/nats-server-pins.json",
      "packages/relay-nats/package-lock.json",
      ...definition.files.map((file) => `packages/relay-nats/test/${file}`),
    ].map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(repo, path)))
        .digest("hex"),
    ]),
  );
  await runTests(
    "jetstream",
    definition.files.map((file) => join(packageRoot, "test", file)),
    definition.count,
  );
  report.input.backend_executed = true;
  if (definition.shared) {
    const { prepareSharedContracts } =
      await import("../packages/relay-nats/scripts/shared-contracts.mjs");
    const shared = prepareSharedContracts(
      join(repo, "test/delivery-lab/contracts.test.js"),
      join(packageRoot, "test/hab-lab-adapter.js"),
      scratch,
    );
    report.shared = shared;
    await runTests("shared-contracts", [shared.entry], 8);
  }
  report.passed =
    !controller.signal.aborted &&
    report.groups.length === (definition.shared ? 2 : 1);
} catch (error) {
  report.error = error.code ?? error.message;
  if (!prepared)
    report.input = {
      state: "rejected",
      reason: report.error,
      backend_executed: false,
    };
  report.passed = false;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  try {
    rmSync(scratch, { recursive: true, force: true });
    report.private_state_removed = !existsSync(scratch);
  } catch (error) {
    report.cleanup_error = error.code;
    report.passed = false;
  }
  writeFileSync(
    join(run, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}
console.log(`${report.passed ? "PASS" : "FAIL"}: ${join(run, "report.json")}`);
process.exitCode = report.passed ? 0 : 1;
