import {
  mkdtemp,
  mkdir,
  writeFile,
  lstat,
  realpath,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { PilotInspector, measureCodeTree } from "../src/pilot-inspector.ts";
import { HERMES_COMMIT } from "../src/hermes-runs.ts";
import { hermesFixture } from "./hermes-fixture.js";
export async function policyFixture(endpoint) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-inspector-")));
  try {
    return await buildPolicy(root, endpoint);
  } catch (error) {
    // A failed build must not leave the read-only source tree behind.
    await chmod(join(root, "source"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
/** Closes the Hermes stub when the policy cannot be built, so the test fails instead of hanging. */
export async function pilotFixtures() {
  const fixture = await hermesFixture(true);
  try {
    return { fixture, policy: await policyFixture(fixture.options.endpoint) };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
async function buildPolicy(root, endpoint) {
  const profileRoot = join(root, "profile"),
    sourceRoot = join(root, "source"),
    wrapperPath = join(root, "reviewed-guard.py");
  await mkdir(profileRoot, { mode: 0o700 });
  await mkdir(sourceRoot, { mode: 0o700 });
  // Non-executable public dummy policy/files; process observation is injected, never launched.
  const guard = "fixture reviewed guard";
  const config = "fixture reviewed nonsecret config";
  await writeFile(wrapperPath, guard, { mode: 0o600 });
  await writeFile(join(profileRoot, "config.yaml"), config, { mode: 0o600 });
  await writeFile(join(profileRoot, ".env"), "fixture metadata marker only", {
    mode: 0o600,
  });
  await writeFile(
    join(profileRoot, "idempotency.db"),
    "fixture store identity only",
    { mode: 0o600 },
  );
  await writeFile(join(profileRoot, "pilot.pid"), "12345\n", { mode: 0o600 });
  const pythonPath = join(sourceRoot, "python");
  const python = "fixture interpreter";
  await writeFile(pythonPath, python, { mode: 0o600 });
  await writeFile(join(sourceRoot, "agent.py"), "fixture reviewed agent", {
    mode: 0o600,
  });
  await chmod(pythonPath, 0o400);
  await chmod(join(sourceRoot, "agent.py"), 0o400);
  await chmod(sourceRoot, 0o500);
  const key = await lstat(join(profileRoot, ".env"));
  const store = await lstat(join(profileRoot, "idempotency.db"));
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const policy = {
    endpoint,
    namespaceLabel: "fixture-pilot-generation",
    profileRoot,
    sourceRoot,
    wrapperPath,
    pythonPath,
    pythonSHA256: sha(python),
    codeTrees: [
      {
        root: sourceRoot,
        sha256: await measureCodeTree(sourceRoot),
      },
    ],
    wrapperSHA256: sha(guard),
    configSHA256: sha(config),
    sourceCommit: HERMES_COMMIT,
    credential: {
      dev: key.dev,
      ino: key.ino,
      size: key.size,
      mtimeMs: key.mtimeMs,
      ctimeMs: key.ctimeMs,
    },
    storeRelativePath: "idempotency.db",
    store: { dev: store.dev, ino: store.ino },
  };
  const startedAt = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  let now = startedAt + 1000;
  const observation = {
    pid: 12345,
    uid: process.getuid(),
    startedAt,
    command: `${policy.pythonPath} ${wrapperPath}`,
    listeners: [`127.0.0.1:${new URL(endpoint).port}`],
    sourceCommit: HERMES_COMMIT,
  };
  const options = {
    probe: async () => structuredClone(observation),
    now: () => now,
  };
  const inspector = new PilotInspector(policy, options);
  return {
    root,
    policy,
    observation,
    options,
    inspector,
    now: options.now,
    advance: (ms) => {
      now += ms;
    },
    cleanup: async () => {
      await chmod(sourceRoot, 0o700);
      await rm(root, { recursive: true, force: true });
    },
  };
}
