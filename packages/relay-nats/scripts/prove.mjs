import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "./test-environment.mjs";
import { createServer } from "node:net";
import {
  prepareSharedContracts,
  terminateTimedOutGroup,
} from "./shared-contracts.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const args = process.argv.slice(2);
let binary = process.env.HAB_NATS_SERVER,
  contracts,
  adapter;
let full = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--full") full = true;
  else if (args[index] === "--server" && args[index + 1])
    binary = resolve(args[++index]);
  else if (args[index] === "--contracts" && args[index + 1])
    contracts = resolve(args[++index]);
  else if (args[index] === "--adapter" && args[index + 1])
    adapter = resolve(args[++index]);
  else
    throw Error(
      "usage: prove.mjs [--server binary] [--contracts file] [--adapter file] [--full]",
    );
}
if (!binary)
  throw Error(
    "a verified pinned NATS binary is required through --server or HAB_NATS_SERVER",
  );
const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
}).trim();
if (version !== "nats-server: v2.15.2") throw Error("server version mismatch");
mkdirSync(join(repo, ".runtime"), { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(repo, ".runtime/proof-"));
const temporary = join(evidence, "tmp");
mkdirSync(temporary, { mode: 0o700 });
const environment = testEnvironment(binary, temporary);
const groups = [];
function run(name, arguments_, cwd = repo, timeout = 120000) {
  const child = spawnSync(process.execPath, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
    detached: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  terminateTimedOutGroup(child);
  const output = (child.stdout ?? "") + (child.stderr ?? "");
  writeFileSync(join(evidence, name + ".log"), output, { mode: 0o600 });
  const count = (key) =>
    Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(output)?.[1] ?? 0);
  const group = {
    name,
    status: child.status,
    signal: child.signal,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skipped"),
  };
  groups.push(group);
  console.log(JSON.stringify(group));
  return { output, group };
}
const packageTests = readdirSync(join(packageRoot, "test"))
  .filter((file) => file.endsWith(".test.js"))
  .sort();
run(
  "jetstream-and-hab",
  [
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=2",
    ...packageTests.map((file) => "test/" + file),
  ],
  packageRoot,
);
run(
  "package-types",
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"],
  packageRoot,
);
run("root-types", ["node_modules/typescript/bin/tsc", "--noEmit"]);
run("lint", [
  "node_modules/eslint/bin/eslint.js",
  "src",
  "db",
  "test",
  "packages/relay-nats/src",
  "packages/relay-nats/test",
  "packages/relay-nats/scripts",
]);
run("build", ["scripts/build.mjs"]);
run("relay-regression", [
  "--test",
  "--test-reporter=tap",
  ...["contract", "delivery", "receiver", "sender", "store"].map(
    (name) => `test/relay-${name}.test.js`,
  ),
]);
let shared;
if (contracts) {
  shared = prepareSharedContracts(
    contracts,
    adapter ?? join(packageRoot, "test/hab-lab-adapter.js"),
    evidence,
  );
  const result = run(
    "shared-contracts",
    ["--test", "--test-reporter=tap", shared.entry],
    evidence,
  );
  shared.status = result.group.status;
}
if (full) {
  const listener = createServer();
  let portAvailable = false;
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(8789, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    portAvailable = true;
  } catch {
    groups.push({
      name: "full-root-preflight",
      status: 1,
      signal: null,
      passed: 0,
      failed: 0,
      skipped: 0,
      reason: "fixed_test_port_unavailable",
    });
  }
  if (portAvailable) {
    const tests = readdirSync(join(repo, "test"))
      .filter((file) => file.endsWith(".test.js"))
      .sort();
    run(
      "full-root-regression",
      [
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=1",
        ...tests.map((file) => "test/" + file),
      ],
      repo,
      900000,
    );
  }
}
const hashes = {};
for (const dir of ["src", "test", "scripts"]) {
  for (const file of readdirSync(join(packageRoot, dir)).sort()) {
    const path = `${dir}/${file}`;
    hashes[path] = createHash("sha256")
      .update(readFileSync(join(packageRoot, path)))
      .digest("hex");
  }
}
for (const path of [
  "src/host/server.ts",
  "src/host/config.ts",
  "src/host/start.ts",
  "src/host/delivery.ts",
  "src/host/hab-delivery-service.ts",
])
  hashes["repo/" + path] = createHash("sha256")
    .update(readFileSync(join(repo, path)))
    .digest("hex");
let liveBrokers = null;
try {
  const processes = execFileSync("ps", ["-axo", "args="], {
    encoding: "utf8",
    env: environment,
  });
  liveBrokers = processes
    .split("\n")
    .filter((line) => line.trim().startsWith(binary + " ")).length;
} catch {}
const report = {
  schema: 2,
  at: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.versions.node,
  sqlite: process.versions.sqlite,
  server: version,
  server_binary_sha256: createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex"),
  package_lock_sha256: createHash("sha256")
    .update(readFileSync(join(packageRoot, "package-lock.json")))
    .digest("hex"),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
  }).trim(),
  groups,
  shared_contract: shared ?? null,
  source_sha256: hashes,
  live_task_brokers: liveBrokers,
  adoption_gate:
    "P7 A2A Task integration, independent restore and production deployment remain separate",
  power_faults: "not run",
  application_effect_exactly_once: "not guaranteed",
};
writeFileSync(
  join(evidence, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(`Evidence ${evidence}`);
if (
  groups.some((group) => group.status !== 0) ||
  (liveBrokers !== null && liveBrokers !== 0)
)
  process.exitCode = 1;
