import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNatsServer } from "./lib/nats-input.mjs";
import { labEnvironment, tapTotals } from "./lib/delivery-lab.mjs";
import { executeOwnedNode, successfulExecution } from "./lib/p7-worker.mjs";
import { genericNatsCases } from "../test/generic-nats/case-names.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--nats-server" ||
  !isAbsolute(args[1]) ||
  args[1].includes("\0")
) {
  console.error("Expected --nats-server VERIFIED_ABSOLUTE_BINARY_PATH");
  process.exitCode = 1;
} else {
  mkdirSync(join(root, ".lab"), { recursive: true, mode: 0o700 });
  const run = mkdtempSync(join(root, ".lab/generic-nats-"));
  const scratch = join(run, "tmp");
  mkdirSync(scratch, { mode: 0o700 });
  const report = {
    schema: "hab-generic-nats-proof-v1",
    node: process.versions.node,
    verdict: "FAIL",
    authentication: "synthetic verified host identities",
    runtime: "two synthetic recipients with independent effect ledgers",
    production_changed: false,
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let prepared;
  try {
    report.commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    report.working_tree = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    prepared = prepareNatsServer(args[1], scratch);
    report.binary = prepared.evidence;
    report.execution = await executeOwnedNode({
      cwd: scratch,
      env: labEnvironment(process.env, scratch, prepared),
      log: join(run, "tests.tap"),
      args: [
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=1",
        "--test-timeout=120000",
        join(root, "test/generic-nats/integration.test.js"),
      ],
      timeout_ms: 300000,
      signal: controller.signal,
    });
    const output = readFileSync(join(run, "tests.tap"), "utf8");
    report.totals = tapTotals(output);
    const observed = [...output.matchAll(/^# Subtest: (.+)$/gm)].map(
      (match) => match[1],
    );
    const casesMatch =
      observed.length === genericNatsCases.length &&
      genericNatsCases.every(
        (name) => observed.filter((value) => value === name).length === 1,
      );
    report.cases_match = casesMatch;
    report.cases = observed;
    const diagnostics = output
      .split("\n")
      .filter((line) => line.startsWith("# {"))
      .map((line) => JSON.parse(line.slice(2)));
    const cleanup = diagnostics.filter(
      (item) => item.event === "owned_process_cleanup",
    );
    report.case_cleanup = cleanup;
    const cleanupMatch =
      cleanup.length === genericNatsCases.length &&
      cleanup.every(
        (item) =>
          item.broker_exited === true &&
          item.receivers === 0 &&
          item.live_gateways === 0,
      );
    report.case_cleanup_match = cleanupMatch;
    if (
      successfulExecution(report.execution) &&
      casesMatch &&
      cleanupMatch &&
      report.totals.tests === genericNatsCases.length &&
      report.totals.pass === genericNatsCases.length &&
      ["fail", "skipped", "cancelled", "todo"].every(
        (key) => report.totals[key] === 0,
      )
    )
      report.verdict = "PASS";
  } catch (error) {
    report.error =
      error instanceof Error ? error.message : "generic_nats_proof_failed";
  } finally {
    try {
      if (prepared) {
        const lines = execFileSync("ps", ["-axo", "args="], {
          env: labEnvironment(process.env, scratch),
          encoding: "utf8",
        }).split("\n");
        report.live_staged_brokers = lines.filter((line) =>
          line.trim().startsWith(prepared.stagedPath + " "),
        ).length;
        if (report.live_staged_brokers)
          throw Error("owned_generic_nats_broker_remains");
      }
      rmSync(scratch, { recursive: true, force: true });
      report.scratch_removed = !existsSync(scratch);
    } catch (error) {
      report.cleanup_error =
        error instanceof Error ? error.message : "generic_nats_cleanup_failed";
      report.verdict = "FAIL";
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    writeFileSync(
      join(run, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        verdict: report.verdict,
        report: join(run, "report.json"),
        tests: report.totals?.tests,
        pass: report.totals?.pass,
        live_staged_brokers: report.live_staged_brokers,
        scratch_removed: report.scratch_removed,
      }),
    );
    if (report.verdict !== "PASS") process.exitCode = 1;
  }
}
