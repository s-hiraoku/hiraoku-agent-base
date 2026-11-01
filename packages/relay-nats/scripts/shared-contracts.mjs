import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "./test-environment.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function prepareSharedContracts(
  sourcePath,
  adapterPath = join(packageRoot, "test/lab-adapter.js"),
  runtime = resolve(".runtime"),
) {
  const source = readFileSync(resolve(sourcePath), "utf8");
  const original = 'from "./backends.js"';
  if (source.split(original).length !== 2)
    throw Error(
      "shared contract import changed; inspect the runner before adapting",
    );
  const digest = createHash("sha256").update(source).digest("hex");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const entry = join(runtime, `shared-${digest}.test.mjs`);
  writeFileSync(
    entry,
    source.replace(
      original,
      `from ${JSON.stringify(pathToFileURL(resolve(adapterPath)).href)}`,
    ),
    { mode: 0o600 },
  );
  return {
    entry,
    contract_source: resolve(sourcePath),
    contract_sha256: digest,
    adapter: resolve(adapterPath),
  };
}
export function terminateTimedOutGroup(result) {
  if (result.pid && (result.signal || result.error)) {
    try {
      process.kill(-result.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2])
    throw Error("usage: shared-contracts.mjs <contracts.test.js> [adapter.js]");
  const runtime = resolve(".runtime");
  const prepared = prepareSharedContracts(
    process.argv[2],
    process.argv[3],
    runtime,
  );
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", prepared.entry],
    {
      encoding: "utf8",
      timeout: 120000,
      detached: true,
      env: testEnvironment(
        process.env.HAB_NATS_SERVER,
        process.env.TMPDIR ?? runtime,
      ),
    },
  );
  terminateTimedOutGroup(result);
  writeFileSync(
    join(runtime, "shared-contracts.tap"),
    (result.stdout ?? "") + (result.stderr ?? ""),
    { mode: 0o600 },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.log(JSON.stringify({ ...prepared, status: result.status }));
  process.exitCode = result.status ?? 1;
}
