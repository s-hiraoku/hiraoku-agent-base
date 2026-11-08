import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightNativeTrial,
  readNativeTrialPlan,
} from "../../scripts/lib/native-trial-preflight.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "hab-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["root", "evidence", "cwd"])
    mkdirSync(join(dir, name), { mode: 0o700 });
  const path = join(dir, "synthetic-executable");
  const bytes = "synthetic file; must never be executed";
  writeFileSync(path, bytes, { mode: 0o700 });
  const artifact = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    mode: "offline_native_trial_preflight",
    hermes: {
      revision: "a".repeat(40),
      binary: { ...artifact },
      root: join(dir, "root"),
      existingProfilesRoot: join(dir, "profiles"),
      cwd: join(dir, "cwd"),
      yolo: false,
      resume: false,
      gatewayUrl: null,
      plugins: [],
    },
    mcp: [
      {
        transport: "stdio",
        trust: "untrusted",
        command: { ...artifact },
        entrypoint: { ...artifact },
        cwd: join(dir, "cwd"),
        packageRunner: false,
      },
    ],
    model: { provider: "synthetic", id: "synthetic-model", fallback: false },
    authorization: {
      method: "existing_native_login",
      approvalReference: "synthetic-reference",
      source: {
        sender_id: "synthetic-sender",
        message_id: "synthetic-message",
      },
      recipient: "synthetic-recipient",
      exactRequest: "ping",
      exactReply: "pong",
    },
    limits: {
      currency: "USD",
      totalCost: 1,
      seconds: 60,
      modelCalls: 2,
      roundTrips: 1,
    },
    cleanup: {
      target: "only_owned_trial_process_group",
      deadlineSeconds: 5,
      onUncertainExit: "retain_evidence_and_fail",
      evidenceDirectory: join(dir, "evidence"),
      retentionHours: 1,
      revokeTemporaryAccess: true,
    },
  };
}

test("static plan inspection never grants launch or proves native authorization", (t) => {
  const result = preflightNativeTrial(fixture(t));
  assert.equal(result.offlineValid, true);
  assert.equal(result.launchAllowed, false);
  assert.ok(result.pending.includes("binary_revision_provenance"));
  assert.ok(result.pending.includes("credential_and_source_authorization"));
});

test("unknown, missing, unsafe, or unbounded declarations are rejected", (t) => {
  const original = fixture(t);
  const mutations = [
    (p) => {
      delete p.model.provider;
    },
    (p) => {
      p.model.id = "unknown";
    },
    (p) => {
      p.model.fallback = true;
    },
    (p) => {
      p.hermes.yolo = true;
    },
    (p) => {
      p.hermes.resume = true;
    },
    (p) => {
      p.hermes.gatewayUrl = "http://127.0.0.1:1";
    },
    (p) => {
      p.hermes.plugins = ["plugin"];
    },
    (p) => {
      p.hermes.args = ["--yolo"];
    },
    (p) => {
      p.hermes.env = { HERMES_HOME: "/existing" };
    },
    (p) => {
      p.hermes.revision = "main";
    },
    (p) => {
      p.mcp.push(p.mcp[0]);
    },
    (p) => {
      p.mcp[0].trust = "trusted";
    },
    (p) => {
      p.mcp[0].command.path = "node";
    },
    (p) => {
      p.mcp[0].cwd = ".";
    },
    (p) => {
      p.mcp[0].packageRunner = true;
    },
    (p) => {
      p.mcp[0].args = ["--eval", "unsafe"];
    },
    (p) => {
      p.authorization.method = "unknown";
    },
    (p) => {
      delete p.authorization.source;
    },
    (p) => {
      p.authorization.exactReply = "x".repeat(1025);
    },
    (p) => {
      p.limits.totalCost = Infinity;
    },
    (p) => {
      p.limits.seconds = 0;
    },
    (p) => {
      p.limits.modelCalls = 0;
    },
    (p) => {
      delete p.cleanup.target;
    },
    (p) => {
      p.cleanup.onUncertainExit = "delete";
    },
  ];
  for (const mutate of mutations) {
    const p = structuredClone(original);
    mutate(p);
    assert.deepEqual(preflightNativeTrial(p), {
      launchAllowed: false,
      offlineValid: false,
      errors: ["invalid_or_incomplete_trial_plan"],
    });
  }
});

test("root refuses reused state, profiles ancestry, nonprivate and symlink paths", (t) => {
  const p = fixture(t);
  writeFileSync(join(p.hermes.root, "gateway.json"), "synthetic");
  assert.deepEqual(preflightNativeTrial(p).errors, ["root_not_empty"]);
  rmSync(join(p.hermes.root, "gateway.json"));
  chmodSync(p.hermes.root, 0o755);
  assert.deepEqual(preflightNativeTrial(p).errors, ["nonprivate_directory"]);
  chmodSync(p.hermes.root, 0o700);
  p.hermes.existingProfilesRoot = p.hermes.root;
  assert.deepEqual(preflightNativeTrial(p).errors, ["existing_profile_root"]);
  p.hermes.existingProfilesRoot = join(p.hermes.cwd, "profiles");
  const link = join(p.hermes.cwd, "linked-root");
  symlinkSync(p.hermes.root, link);
  p.hermes.root = link;
  assert.deepEqual(preflightNativeTrial(p).errors, ["symlink_path"]);
});

test("artifact bytes and indirect runner checks are read-only, not executable checks", (t) => {
  const p = fixture(t);
  p.hermes.binary.sha256 = "0".repeat(64);
  assert.deepEqual(preflightNativeTrial(p).errors, [
    "artifact_digest_mismatch",
  ]);
  p.hermes.binary = { ...p.mcp[0].command };
  const runner = join(p.hermes.cwd, "npx");
  writeFileSync(runner, "not executed", { mode: 0o700 });
  p.hermes.binary.path = runner;
  assert.deepEqual(preflightNativeTrial(p).errors, ["indirect_runner"]);
});

test("rejects profile ancestors, evidence reuse, missing and ancestor-symlink paths", (t) => {
  const p = fixture(t);
  const root = p.hermes.root;
  const evidence = p.cleanup.evidenceDirectory;
  p.cleanup.evidenceDirectory = root;
  assert.deepEqual(preflightNativeTrial(p).errors, ["overlapping_trial_paths"]);
  p.cleanup.evidenceDirectory = evidence;
  writeFileSync(join(evidence, "old.log"), "synthetic");
  assert.deepEqual(preflightNativeTrial(p).errors, ["evidence_not_empty"]);
  rmSync(join(evidence, "old.log"));
  const profiles = join(p.hermes.cwd, "profiles");
  mkdirSync(profiles, { mode: 0o700 });
  p.hermes.root = join(profiles, "trial");
  mkdirSync(p.hermes.root, { mode: 0o700 });
  assert.deepEqual(preflightNativeTrial(p).errors, ["existing_profile_root"]);
  p.hermes.root = root;
  const alias = join(p.hermes.cwd, "alias");
  symlinkSync(root, alias);
  writeFileSync(join(root, "artifact"), "synthetic");
  p.hermes.root = join(p.hermes.cwd, "fresh");
  mkdirSync(p.hermes.root, { mode: 0o700 });
  p.mcp[0].entrypoint.path = join(alias, "artifact");
  assert.deepEqual(preflightNativeTrial(p).errors, ["symlink_path"]);
  p.mcp[0].entrypoint.path = join(p.hermes.cwd, "missing");
  assert.deepEqual(preflightNativeTrial(p).errors, ["path_unavailable"]);
});

test("manifest reads are bounded and reject nonregular or symlink files", (t) => {
  const p = fixture(t);
  const path = join(p.hermes.cwd, "plan.json");
  writeFileSync(path, JSON.stringify(p));
  assert.deepEqual(readNativeTrialPlan(path), p);
  assert.throws(
    () => readNativeTrialPlan(p.hermes.cwd),
    /invalid_manifest_file/,
  );
  const link = join(p.hermes.cwd, "plan-link");
  symlinkSync(path, link);
  assert.throws(() => readNativeTrialPlan(link));
  writeFileSync(path, " ".repeat(65537));
  assert.throws(() => readNativeTrialPlan(path), /invalid_manifest_file/);
});

test("zero budget is valid but blank fields and dot-prefixed profile children are not", (t) => {
  const p = fixture(t);
  p.limits.totalCost = 0;
  assert.equal(preflightNativeTrial(p).offlineValid, true);
  p.model.provider = "   ";
  assert.equal(preflightNativeTrial(p).offlineValid, false);
  p.model.provider = "synthetic";
  p.hermes.existingProfilesRoot = p.hermes.cwd;
  p.hermes.root = join(p.hermes.cwd, "..trial");
  mkdirSync(p.hermes.root, { mode: 0o700 });
  assert.deepEqual(preflightNativeTrial(p).errors, ["existing_profile_root"]);
});
