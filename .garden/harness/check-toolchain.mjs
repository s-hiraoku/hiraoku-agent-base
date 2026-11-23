// ガーデンの対象固有ハーネス: AC-001（ツールチェーンと依存の準備）
// 終了コード: 0 = 準備完了, 75 = 環境不備（INCONCLUSIVE）
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.error ? 127 : r.status ?? 1;
}

if (run("node", ["scripts/check-toolchain.mjs"]) !== 0) {
  console.error("toolchain check failed");
  process.exit(75);
}
if (!existsSync("node_modules")) {
  if (run("npm", ["ci", "--no-audit", "--no-fund"]) !== 0) {
    console.error("npm ci failed");
    process.exit(75);
  }
}
console.log("toolchain ready");
