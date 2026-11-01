import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const sourcePath = process.argv[2];
if (!sourcePath)
  throw Error(
    "usage: node scripts/shared-contracts.mjs <delivery-lab/contracts.test.js>",
  );
const source = readFileSync(resolve(sourcePath), "utf8");
const original = 'from "./backends.js"';
if (source.split(original).length !== 2)
  throw Error(
    "shared contract import changed; inspect the runner before adapting",
  );
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = createHash("sha256").update(source).digest("hex");
const runtime = resolve(".runtime");
mkdirSync(runtime, { recursive: true, mode: 0o700 });
const entry = join(runtime, `shared-${digest}.test.mjs`);
const adapter = pathToFileURL(join(packageRoot, "test/lab-adapter.js")).href;
writeFileSync(
  entry,
  source.replace(original, `from ${JSON.stringify(adapter)}`),
  { mode: 0o600 },
);
const result = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", entry],
  { encoding: "utf8", timeout: 120000 },
);
writeFileSync(
  join(runtime, "shared-contracts.tap"),
  result.stdout + result.stderr,
  { mode: 0o600 },
);
console.log(result.stdout);
console.error(result.stderr);
console.log(
  JSON.stringify({
    contract_source: resolve(sourcePath),
    contract_sha256: digest,
    status: result.status,
  }),
);
process.exitCode = result.status ?? 1;
