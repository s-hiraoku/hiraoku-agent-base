import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { testEnvironment } from "./test-environment.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const args = process.argv.slice(2);
let candidate;
const forwarded = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--nats-server" && !candidate && args[index + 1])
    candidate = args[++index];
  else if (
    ["--contracts", "--adapter"].includes(args[index]) &&
    args[index + 1]
  )
    forwarded.push(args[index], resolve(args[++index]));
  else if (args[index] === "--full") forwarded.push(args[index]);
  else
    throw Error(
      "usage: prove-verified.mjs --nats-server /absolute/official/binary [--contracts file] [--adapter file] [--full]",
    );
}
if (!candidate || !isAbsolute(candidate))
  throw Error("an absolute official NATS server file is required");
const verifierPath = join(repo, "scripts/lib/nats-input.mjs");
const pinsPath = join(repo, "scripts/lib/nats-server-pins.json");
const { prepareNatsServer } = await import(verifierPath);
mkdirSync(join(repo, ".runtime"), { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(repo, ".runtime/verified-proof-"));
const prepared = prepareNatsServer(candidate, scratch);
try {
  const result = spawnSync(
    process.execPath,
    [
      join(packageRoot, "scripts/prove.mjs"),
      "--server",
      prepared.stagedPath,
      ...forwarded,
    ],
    {
      cwd: prepared.fixtureCwd,
      env: testEnvironment(prepared.stagedPath, scratch),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(scratch, "proof.log"), output, { mode: 0o600 });
  const evidence = /^Evidence (.+)$/m.exec(result.stdout ?? "")?.[1];
  if (evidence) {
    const path = join(evidence, "report.json");
    const report = JSON.parse(readFileSync(path, "utf8"));
    report.verified_input = {
      ...prepared.evidence,
      backend_executed: report.groups.some(
        (group) =>
          group.name === "jetstream-and-hab" && group.passed + group.failed > 0,
      ),
      verifier_sha256: createHash("sha256")
        .update(readFileSync(verifierPath))
        .digest("hex"),
      pins_sha256: createHash("sha256")
        .update(readFileSync(pinsPath))
        .digest("hex"),
    };
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  process.stdout.write(output);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(prepared.fixtureCwd, { recursive: true, force: true });
}
