// ガーデンの対象固有のハーネス: AC-002（ローカルMVPの送受信を一通り確認）
// 終了コード: 0 = 仕様どおり, 1 = 挙動不一致（UNSATISFIED）, 75 = 環境不備（INCONCLUSIVE）
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const evidenceDir = process.env.GARDEN_EVIDENCE_DIR ?? ".";
const failureReportPath = join(evidenceDir, "hab-mvp-failure.json");
const r = spawnSync("node", ["scripts/hab-mvp-demo.mjs", "--simulate"], {
  encoding: "utf8",
  timeout: 120_000,
  env: {
    ...process.env,
    HAB_MVP_FAILURE_REPORT_PATH: failureReportPath,
  },
});
writeFileSync(join(evidenceDir, "hab-mvp-stdout.txt"), r.stdout ?? "");
writeFileSync(join(evidenceDir, "hab-mvp-stderr.txt"), r.stderr ?? "");

if (r.error?.code === "ETIMEDOUT") {
  // The demo started but did not finish (it has its own 30 s deadline): a hang is a behavior failure.
  writeFileSync(
    join(evidenceDir, "hab-mvp-result.json"),
    JSON.stringify({ status: "failed", reason: "timeout_120s", exit_code: null }, null, 2) + "\n",
  );
  console.error("demo did not finish within 120 s");
  process.exit(1);
}
if (r.error) {
  console.error(`demo could not start: ${r.error.message}`);
  process.exit(75);
}
// Only a missing installed package is an environment problem; a missing repository
// source module ("Cannot find module '/...'") is a code regression and stays UNSATISFIED.
if (/Cannot find package '[^']+' imported from/.test(r.stderr ?? "")) {
  console.error("dependencies are not installed");
  process.exit(75);
}

let result;
try {
  result = JSON.parse(r.stdout);
} catch {
  let failureReport = null;
  if (existsSync(failureReportPath)) {
    try {
      failureReport = JSON.parse(readFileSync(failureReportPath, "utf8"));
    } catch {
      failureReport = null;
    }
  }
  const structuredFailure = {
    status: "failed",
    exit_code: r.status,
    production_connected: false,
    passed_stages: failureReport?.passed_stages ?? [],
    failed_stage: failureReport?.failed_stage ?? null,
    total_stages: failureReport?.total_stages ?? 13,
    error_name: failureReport?.error_name ?? null,
    error_code: failureReport?.error_code ?? null,
  };
  writeFileSync(
    join(evidenceDir, "hab-mvp-result.json"),
    JSON.stringify(structuredFailure, null, 2) + "\n",
  );
  const stageHint = structuredFailure.failed_stage
    ? ` at stage '${structuredFailure.failed_stage}' (${structuredFailure.passed_stages.length}/${structuredFailure.total_stages} stages passed)`
    : "";
  console.error(`demo exited ${r.status} without JSON output${stageHint}`);
  process.exit(1);
}
writeFileSync(join(evidenceDir, "hab-mvp-result.json"), JSON.stringify(result, null, 2));

const problems = [];
if (r.status !== 0) problems.push(`exit code ${r.status}`);
if (result.production_connected !== false) problems.push("production_connected is not false");
for (const s of result.stages ?? []) if (s.status !== "passed") problems.push(`stage ${s.id}: ${s.status}`);
if ((result.stages ?? []).length !== 13) problems.push(`expected 13 stages, got ${(result.stages ?? []).length}`);
const c = result.counters ?? {};
if (!(c.deliveries === 4 && c.acked === 4 && c.ack_receipts === 4)) problems.push(`counters ${JSON.stringify(c)}`);
if (!(result.cleanup?.server_closed && result.cleanup?.temporary_state_removed)) problems.push("cleanup incomplete");

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("relay ok: 13 stages passed, 4/4 deliveries acked");
