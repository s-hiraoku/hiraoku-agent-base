// ガーデンの対象固有ハーネス: AC-001（ツールチェーンと依存の準備）
// 終了コード: 0 = 準備完了, 75 = 環境不備（INCONCLUSIVE）
// v2（介入 20261123T114220Z-a75b）: 環境不備の原因を toolchain-diagnostic.json に証拠として残す。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToolchainPin } from "../../scripts/lib/toolchain.mjs";

const evidenceDir = process.env.GARDEN_EVIDENCE_DIR ?? ".";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.error ? 127 : r.status ?? 1;
}

function npmVersion() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function inconclusive(reason, remedy) {
  const pin = (() => {
    try {
      return readToolchainPin(".");
    } catch (error) {
      return { error: error.message };
    }
  })();
  const diagnostic = {
    ready: false,
    reason,
    required: pin,
    actual: { node: process.versions.node, node_path: process.execPath, npm: npmVersion() },
    remedy,
  };
  writeFileSync(join(evidenceDir, "toolchain-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
  console.error(`${reason}: required node ${pin.node ?? "?"} / npm ${pin.npm ?? "?"}, ` +
    `actual node ${diagnostic.actual.node} / npm ${diagnostic.actual.npm ?? "missing"}`);
  process.exit(75);
}

if (run("node", ["scripts/check-toolchain.mjs"]) !== 0) {
  inconclusive("toolchain_mismatch",
    "Install the Node.js version in .node-version and the npm version in package.json packageManager (CI: actions/setup-node with node-version-file).");
}
if (!existsSync("node_modules") && run("npm", ["ci", "--no-audit", "--no-fund"]) !== 0) {
  inconclusive("dependency_install_failed", "Check network access to the npm registry and package-lock.json.");
}
writeFileSync(join(evidenceDir, "toolchain-diagnostic.json"),
  JSON.stringify({ ready: true, actual: { node: process.versions.node, npm: npmVersion() } }, null, 2));
console.log("toolchain ready");
