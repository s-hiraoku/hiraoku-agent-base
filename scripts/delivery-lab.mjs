import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  labEnvironment,
  tapTotals,
  gateVerdict,
  executeNode,
  assertLoopbackPortFree,
} from "./lib/delivery-lab.mjs";
import { a2aAcceptance } from "../test/delivery-lab/a2a-acceptance.js";
import {
  verifyA2aSource,
  observedCases,
  assessA2aAcceptance,
} from "./lib/a2a-acceptance.mjs";
import { parseLabOptions, prepareNatsServer } from "./lib/nats-input.mjs";
import {
  pendingBackends,
  pendingMigrationRequirements,
} from "../test/delivery-lab/manifest.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let options;
try {
  options = parseLabOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`delivery_lab_rejected ${error.code}\n`);
  process.exit(2);
}
const { release, full } = options;
const pinnedNode = readFileSync(join(repo, ".node-version"), "utf8").trim();
if (process.versions.node !== pinnedNode)
  throw Error(
    `delivery lab requires Node ${pinnedNode}; current ${process.versions.node}`,
  );
const root = join(repo, ".lab");
mkdirSync(root, { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(root, "run-"));
const scratch = join(run, "tmp");
mkdirSync(scratch, { mode: 0o700 });
const env = labEnvironment(process.env, scratch);
const pending = [
  ...pendingBackends.map(({ id, reason }) => `${id}: ${reason}`),
  ...pendingMigrationRequirements,
];
const regressionFiles = [
  "relay-contract",
  "relay-receiver",
  "relay-sender",
  "hab-enrollment-delivery",
  "hab-auth-groups",
  "hab-discovery",
  "receive-supervisor",
  "relay-inbox-maintenance",
  "relay-outbox-maintenance",
  "task-bridge",
  "task-bridge-replies",
].map((name) => `test/${name}.test.js`);
const definitions = [
  ...a2aAcceptance.groups,
  { id: "shared-contracts", files: ["test/delivery-lab/contracts.test.js"] },
  {
    id: "storage-and-harness",
    files: [
      "test/delivery-lab/sqlite-failures.test.js",
      "test/delivery-lab/harness.test.js",
      "test/delivery-lab/nats-input.test.js",
      "test/delivery-lab/a2a-harness.test.js",
    ],
  },
  { id: "relay-regressions", files: regressionFiles },
];
if (full)
  definitions.push({
    id: "full-regression",
    files: readdirSync(join(repo, "test"))
      .filter((file) => file.endsWith(".test.js"))
      .sort()
      .map((file) => `test/${file}`),
  });
const groups = [];
const controller = new AbortController();
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  controller.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  schema: 1,
  started_at: new Date().toISOString(),
  node: process.versions.node,
  sqlite: process.versions.sqlite,
  seed: "fixed message entropy, synthetic identities; wall-clock timestamps and crypto lease tokens vary",
  release_requested: release,
  pending,
  groups,
  nats_input: { state: "not-requested", backend_executed: false },
};
const snapshot = () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repo, env, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(repo, file)))
        .digest("hex"),
    ]),
  );
};
let sourceHashes;
console.log(`Delivery lab evidence: ${run}`);
try {
  report.commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  report.lock_sha256 = createHash("sha256")
    .update(readFileSync(join(repo, "package-lock.json")))
    .digest("hex");
  sourceHashes = snapshot();
  writeFileSync(
    join(run, "sources.json"),
    JSON.stringify(sourceHashes, null, 2) + "\n",
    { mode: 0o600 },
  );
  report.source_sha256 = createHash("sha256")
    .update(JSON.stringify(sourceHashes))
    .digest("hex");
  report.working_tree = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  report.a2a_provenance = verifyA2aSource(repo);
  if (options.natsServer) {
    let prepared;
    try {
      prepared = prepareNatsServer(options.natsServer, scratch);
    } catch (error) {
      report.nats_input = {
        state: "rejected",
        code: error.code,
        backend_executed: false,
      };
      throw error;
    }
    report.nats_input = { ...prepared.evidence, handoff: "pending" };
    definitions.unshift({
      id: "nats-input-handoff",
      files: [join(repo, "test/delivery-lab/nats-input.probe.js")],
      cwd: prepared.fixtureCwd,
      env: labEnvironment(process.env, scratch, prepared),
    });
  }
  report.expected_groups = definitions.map(({ id }) => id);
  if (full) {
    try {
      await assertLoopbackPortFree(8789);
      report.legacy_port_preflight =
        "127.0.0.1:8789 was available; legacy group runs serially";
    } catch (error) {
      report.environment_blocker = `legacy loopback port 8789 unavailable (${error.code}); no request sent and no occupant stopped`;
      throw Error("legacy port preflight blocked");
    }
    report.build = await executeNode({
      cwd: repo,
      env,
      log: join(run, "build.log"),
      args: ["scripts/build.ts"],
      signal: controller.signal,
      timeout_ms: 120000,
    });
    if (report.build.exit_code !== 0)
      throw Error("worker build failed; see build.log");
  }
  for (const definition of definitions) {
    if (interrupted) throw Error("delivery lab interrupted");
    console.log(`Running ${definition.id}`);
    const started = Date.now();
    const log = join(run, `${definition.id}.tap`);
    const execution = await executeNode({
      cwd: definition.cwd ?? repo,
      env: definition.env ?? env,
      log,
      args: [
        "--test",
        "--test-reporter=tap",
        `--test-concurrency=${definition.id === "full-regression" ? 1 : 2}`,
        "--test-timeout=120000",
        ...definition.files,
      ],
      signal: controller.signal,
    });
    let totals;
    let parse_error;
    try {
      totals = tapTotals(readFileSync(log, "utf8"));
    } catch (error) {
      parse_error = error.message;
    }
    if (definition.id === "nats-input-handoff")
      report.nats_input.handoff =
        execution.exit_code === 0 && totals?.pass === 1 && totals?.fail === 0
          ? "observed"
          : "failed";
    groups.push({
      id: definition.id,
      ...execution,
      totals,
      cases: observedCases(readFileSync(log, "utf8")),
      parse_error,
      elapsed_ms: Date.now() - started,
      evidence: log,
    });
    console.log(
      `${definition.id}: exit=${execution.exit_code} ${JSON.stringify(totals ?? { parse_error })}`,
    );
  }
} catch (error) {
  report.runner_error = error.message;
} finally {
  report.finished_at = new Date().toISOString();
  report.a2a = assessA2aAcceptance(groups);
  report.verdict = report.environment_blocker
    ? "BLOCKED"
    : interrupted || report.runner_error
      ? "FAIL"
      : gateVerdict(
          groups,
          pending,
          report.release_requested,
          definitions.map(({ id }) => id),
        );
  if (!report.environment_blocker && report.a2a.state !== "passed")
    report.verdict = "FAIL";
  try {
    report.a2a_provenance_after = verifyA2aSource(repo);
    report.sources_unchanged =
      sourceHashes !== undefined &&
      JSON.stringify(snapshot()) === JSON.stringify(sourceHashes);
    if (!report.sources_unchanged) {
      report.runner_error ??= "source changed during run";
      report.verdict = "FAIL";
    }
  } catch (error) {
    report.source_check_error = error.message;
    report.runner_error ??= "source check failed";
    report.verdict = "FAIL";
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
    report.teardown =
      "scratch removed after direct child close; logs retained; detached descendants are not managed";
  } catch (error) {
    report.cleanup_error = error.message;
    report.verdict = "FAIL";
  }
  writeFileSync(
    join(run, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
console.log(`${report.verdict}: ${join(run, "report.json")}`);
process.exitCode = ["BASELINE_PASS", "RELEASE_PASS"].includes(report.verdict)
  ? 0
  : 1;
