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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const binary = process.env.HAB_NATS_SERVER;
if (!binary)
  throw Error("HAB_NATS_SERVER must point to the verified pinned binary");
const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
}).trim();
if (version !== "nats-server: v2.15.2") throw Error("server version mismatch");
mkdirSync(join(repo, ".runtime"), { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(repo, ".runtime/proof-"));
const groups = [];
function run(name, args, cwd = repo) {
  const child = spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 120000,
  });
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
  return child.status === 0;
}
run(
  "jetstream",
  ["--test", "--test-reporter=tap", "test/backend.test.js"],
  packageRoot,
);
run(
  "types",
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"],
  packageRoot,
);
run("relay-regression", [
  "--test",
  "--test-reporter=tap",
  ...["contract", "delivery", "receiver", "sender", "store"].map(
    (name) => `test/relay-${name}.test.js`,
  ),
]);
const hashes = {};
for (const dir of ["src", "test", "scripts"]) {
  for (const file of readdirSync(join(packageRoot, dir)).sort()) {
    const path = `${dir}/${file}`;
    hashes[path] = createHash("sha256")
      .update(readFileSync(join(packageRoot, path)))
      .digest("hex");
  }
}
const report = {
  schema: 1,
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
  }).trim(),
  groups,
  source_sha256: hashes,
  adoption_gate:
    "pending real HAB Registry/host integration, A2A Task proof, independent restore and Linux testing",
  power_faults: "not run",
  linux: "not run",
  application_effect_exactly_once: "not guaranteed",
};
writeFileSync(
  join(evidence, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(`Evidence ${evidence}`);
if (groups.some((group) => group.status !== 0)) process.exitCode = 1;
