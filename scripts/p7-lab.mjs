import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNatsServer } from "./lib/nats-input.mjs";
import {
  labEnvironment,
  tapTotals,
  assertLoopbackPortFree,
} from "./lib/delivery-lab.mjs";
import { executeOwnedNode, successfulExecution } from "./lib/p7-worker.mjs";
import { parseP7Options } from "./lib/p7-options.mjs";
import { verifyP7Source, sha256 } from "./lib/p7-provenance.mjs";
import { assessP7, observedCases } from "./lib/p7-gate.mjs";
import {
  groups,
  blockers,
  historicalDisposition,
} from "../test/p7/manifest.js";
import { prepareSharedContracts } from "../packages/relay-nats/scripts/shared-contracts.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let options;
try {
  options = parseP7Options(process.argv.slice(2));
} catch {
  process.stderr.write("P7 arguments rejected\n");
  process.exit(2);
}
if (
  process.versions.node !==
  readFileSync(join(repo, ".node-version"), "utf8").trim()
)
  throw Error("P7 requires the pinned Node version");
mkdirSync(join(repo, ".lab"), { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(repo, ".lab/p7-run-")),
  scratch = join(run, "tmp");
mkdirSync(scratch, { mode: 0o700 });
const env = labEnvironment(process.env, scratch),
  definitions = [...groups];
if (options.full)
  definitions.push({
    id: "full-regression",
    files: readdirSync(join(repo, "test"))
      .filter((p) => p.endsWith(".test.js"))
      .sort()
      .map((p) => `test/${p}`),
    count: 1375,
  });
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const report = {
  schema: "hab-p7-local-v1",
  started_at: new Date().toISOString(),
  node: process.versions.node,
  sqlite: process.versions.sqlite,
  platform: process.platform,
  architecture: process.arch,
  full_requested: options.full,
  groups: [],
  expected_groups: definitions.map((d) => d.id),
  blockers,
  historical_disposition: historicalDisposition,
  input_preparation: { state: "not-prepared" },
  actual_backend_execution: { state: "unverified" },
};
let sources, prepared;
function snapshot() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repo, env, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  return Object.fromEntries(
    files.map((p) => [p, sha256(readFileSync(join(repo, p)))]),
  );
}
console.log(`P7 evidence: ${run}`);
try {
  report.commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  report.working_tree = execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  sources = snapshot();
  writeFileSync(
    join(run, "sources.json"),
    JSON.stringify(sources, null, 2) + "\n",
    { mode: 0o600 },
  );
  report.source_sha256 = sha256(JSON.stringify(sources));
  report.provenance_before = verifyP7Source(repo);
  report.lock_sha256 = sha256(readFileSync(join(repo, "package-lock.json")));
  report.nats_lock_sha256 = sha256(
    readFileSync(join(repo, "packages/relay-nats/package-lock.json")),
  );
  try {
    prepared = prepareNatsServer(options.natsServer, scratch);
  } catch (error) {
    report.input_preparation = { state: "rejected", reason: error.code };
    throw error;
  }
  const input = { ...prepared.evidence };
  delete input.backend_executed;
  report.input_preparation = input;
  report.shared_contract = prepareSharedContracts(
    join(repo, "test/delivery-lab/contracts.test.js"),
    join(repo, "test/p7/backends.js"),
    scratch,
  );
  if (
    report.shared_contract.contract_sha256 !==
    report.provenance_before.common_contract_sha256
  )
    throw Error("P7 shared contract digest mismatch");
  report.shared_contract.generated_sha256 = sha256(
    readFileSync(report.shared_contract.entry),
  );
  if (options.full) {
    try {
      await assertLoopbackPortFree(8789);
    } catch (error) {
      report.environment_blocker = `legacy loopback8789 unavailable (${error.code}); no request or stop sent`;
      throw error;
    }
    report.build = await executeOwnedNode({
      cwd: repo,
      env,
      args: ["scripts/build.ts"],
      log: join(run, "build.log"),
      timeout_ms: 120000,
      signal: abort.signal,
    });
    if (!successfulExecution(report.build)) throw Error("P7 build failed");
  }
  for (const definition of definitions) {
    if (abort.signal.aborted) throw Error("P7 interrupted");
    const cwd = join(scratch, definition.id);
    mkdirSync(cwd, { mode: 0o700 });
    const brokerGroup = [
      "nats-producer",
      "broker-startup",
      "p7-acceptance",
      "shared-real-backends",
    ].includes(definition.id);
    const childEnv = labEnvironment(
      process.env,
      cwd,
      brokerGroup ? prepared : undefined,
    );
    if (definition.id === "p7-acceptance")
      childEnv.P7_EVIDENCE = join(run, "cases");
    const files = definition.generated_common
      ? [report.shared_contract.entry]
      : definition.files.map((p) => join(repo, p));
    const log = join(run, `${definition.id}.tap`);
    console.log(`Running ${definition.id}`);
    const execution = await executeOwnedNode({
      cwd: definition.id === "full-regression" ? repo : cwd,
      env: childEnv,
      args: [
        "--test",
        "--test-reporter=tap",
        `--test-concurrency=${definition.id === "full-regression" ? 1 : 2}`,
        "--test-timeout=120000",
        ...files,
      ],
      log,
      timeout_ms: definition.id === "full-regression" ? 900000 : 300000,
      signal: abort.signal,
    });
    const output = readFileSync(log, "utf8");
    let totals, parse_error;
    try {
      totals = tapTotals(output);
    } catch (error) {
      parse_error = error.message;
    }
    report.groups.push({
      id: definition.id,
      ...execution,
      totals,
      parse_error,
      cases: observedCases(output),
      evidence: log,
    });
    console.log(
      `${definition.id}: ${JSON.stringify({ ...execution, totals })}`,
    );
  }
  const p7 = report.groups.find((g) => g.id === "p7-acceptance");
  if (p7?.exit_code === 0 && p7.totals?.pass === 5 && p7.totals.skipped === 0) {
    const facts = Object.fromEntries(
      ["P7-01", "P7-02", "P7-03", "P7-04", "P7-05"].map((id) => [
        id,
        JSON.parse(readFileSync(join(run, "cases", `${id}.json`), "utf8")),
      ]),
    );
    const first = facts["P7-01"];
    if (
      first.broker_witnesses.length !== 3 ||
      new Set(first.broker_witnesses.map((w) => w.kind)).size !== 3 ||
      first.broker_witnesses.some(
        (w) => !(w.sequence > 0) || sha256(JSON.stringify(w.body)) !== w.sha256,
      ) ||
      first.independent_pre_ack_reads !== 1 ||
      first.engine_tasks !== 1 ||
      first.artifacts !== 1 ||
      !facts["P7-02"].broker_verified_before_application_resume ||
      facts["P7-02"].repeated_engine_rpc !== 0
    )
      throw Error("P7 semantic evidence mismatch");
    report.case_observations = facts;
    report.actual_backend_execution = {
      state: "observed",
      evidence: "P7-01 official stream body witnesses",
      kinds: first.broker_witnesses.map((w) => w.kind),
      finite_engine_tasks: first.engine_tasks,
      finite_artifacts: first.artifacts,
    };
  }
} catch (error) {
  report.runner_error = error.code ?? error.message;
} finally {
  try {
    report.provenance_after = verifyP7Source(repo);
    report.sources_unchanged =
      sources !== undefined &&
      JSON.stringify(snapshot()) === JSON.stringify(sources);
  } catch (error) {
    report.source_error = error.message;
    report.sources_unchanged = false;
  }
  try {
    if (prepared) {
      const lines = execFileSync("ps", ["-axo", "args="], {
        env,
        encoding: "utf8",
      }).split("\n");
      report.live_staged_brokers = lines.filter((line) =>
        line.trim().startsWith(prepared.stagedPath + " "),
      ).length;
      if (report.live_staged_brokers)
        throw Error("P7 owned broker remains live");
    }
    rmSync(scratch, { recursive: true, force: true });
    report.scratch_removed = !existsSync(scratch);
  } catch (error) {
    report.cleanup_error = error.message;
  }
  report.local_verdict = report.environment_blocker
    ? "BLOCKED"
    : report.runner_error ||
        !report.sources_unchanged ||
        report.cleanup_error ||
        abort.signal.aborted ||
        report.actual_backend_execution.state !== "observed" ||
        !assessP7(report.groups, definitions)
      ? "FAIL"
      : "P7_LOGICAL_PASS";
  report.adoption_verdict = "BLOCKED";
  report.finished_at = new Date().toISOString();
  writeFileSync(
    join(run, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
console.log(`${report.local_verdict}: ${join(run, "report.json")}`);
process.exitCode = report.local_verdict === "P7_LOGICAL_PASS" ? 0 : 1;
