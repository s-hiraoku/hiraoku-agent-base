import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { Buffer } from "node:buffer";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { sourceKey } from "../../src/adapter-policy/contract.ts";

const named = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      v.trim().length > 0 &&
      !/placeholder|unknown|unconfirmed|replace|<|>|\r|\n/i.test(v),
  );
const absolute = z.string().refine((v) => isAbsolute(v) && resolve(v) === v);
const artifact = z.strictObject({
  path: absolute,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const plan = z.strictObject({
  mode: z.literal("offline_native_trial_preflight"),
  hermes: z.strictObject({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    binary: artifact,
    root: absolute,
    existingProfilesRoot: absolute,
    cwd: absolute,
    yolo: z.literal(false),
    resume: z.literal(false),
    gatewayUrl: z.null(),
    plugins: z.array(z.never()).length(0),
  }),
  mcp: z.tuple([
    z.strictObject({
      transport: z.literal("stdio"),
      trust: z.literal("untrusted"),
      command: artifact,
      entrypoint: artifact,
      cwd: absolute,
      packageRunner: z.literal(false),
    }),
  ]),
  model: z.strictObject({
    provider: named,
    id: named,
    fallback: z.literal(false),
  }),
  authorization: z.strictObject({
    method: z.enum(["existing_native_login", "temporary_credential"]),
    approvalReference: named,
    source: sourceKey,
    recipient: named,
    exactRequest: z.string().min(1).max(1024),
    exactReply: z.string().min(1).max(1024),
  }),
  limits: z.strictObject({
    currency: z.literal("USD"),
    totalCost: z.number().finite().nonnegative(),
    seconds: z.number().int().positive().max(900),
    modelCalls: z.number().int().positive().max(4),
    roundTrips: z.literal(1),
  }),
  cleanup: z.strictObject({
    target: z.literal("only_owned_trial_process_group"),
    deadlineSeconds: z.number().int().positive().max(30),
    onUncertainExit: z.literal("retain_evidence_and_fail"),
    evidenceDirectory: absolute,
    retentionHours: z.number().int().positive(),
    revokeTemporaryAccess: z.literal(true),
  }),
});

function below(path, parent) {
  const r = relative(parent, path);
  return (
    r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))
  );
}

// No realpath traversal: reject symlinks, including intermediate components.
function inspectPath(path, directory, privateDirectory = false) {
  for (let p = path; ; p = dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) throw Error("symlink_path");
    if (p === dirname(p)) break;
  }
  const st = lstatSync(path);
  if (directory ? !st.isDirectory() : !st.isFile())
    throw Error("wrong_path_kind");
  if (
    privateDirectory &&
    ((st.mode & 0o077) !== 0 || st.uid !== process.getuid())
  )
    throw Error("nonprivate_directory");
  return st;
}

/**
 * Read-only approval-plan lint, not a launcher or authentication decision.
 * Reads caller-selected artifact bytes/metadata; callers must select reviewed,
 * non-secret artifacts. Content is not classified for secrets. Never imports
 * product code, starts processes, or certifies effective native isolation.
 * An offline-valid plan still cannot launch: user approval, effective settings,
 * binary-to-revision provenance, budgets, and runtime ownership remain unproven.
 */
export function preflightNativeTrial(input) {
  const parsed = plan.safeParse(input);
  const result = { launchAllowed: false, offlineValid: false, errors: [] };
  if (!parsed.success)
    return { ...result, errors: ["invalid_or_incomplete_trial_plan"] };
  const p = parsed.data;
  try {
    const root = p.hermes.root;
    if (below(root, p.hermes.existingProfilesRoot))
      throw Error("existing_profile_root");
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      if (basename(ancestor) === "profiles")
        throw Error("existing_profile_root");
      if (ancestor === dirname(ancestor)) break;
    }
    inspectPath(root, true, true);
    // Stronger than checking known descriptor filenames: a fresh root has none.
    if (readdirSync(root).length) throw Error("root_not_empty");
    const evidence = p.cleanup.evidenceDirectory;
    if (below(root, evidence) || below(evidence, root))
      throw Error("overlapping_trial_paths");
    inspectPath(evidence, true, true);
    if (readdirSync(evidence).length) throw Error("evidence_not_empty");
    for (const cwd of [p.hermes.cwd, p.mcp[0].cwd]) inspectPath(cwd, true);
    for (const [a, executable] of [
      [p.hermes.binary, true],
      [p.mcp[0].command, true],
      [p.mcp[0].entrypoint, false],
    ]) {
      const st = inspectPath(a.path, false);
      if (st.size > 128 * 1024 * 1024) throw Error("artifact_too_large");
      if (executable && !(st.mode & 0o111))
        throw Error("artifact_not_executable");
      if (
        /^(npx|npm|pnpm|yarn|uvx|uv|pipx|bash|sh|zsh)(\.[^/]*)?$/.test(
          basename(a.path),
        )
      )
        throw Error("indirect_runner");
      if (
        createHash("sha256").update(readFileSync(a.path)).digest("hex") !==
        a.sha256
      )
        throw Error("artifact_digest_mismatch");
    }
    return {
      ...result,
      offlineValid: true,
      errors: [],
      pending: [
        "explicit_action_time_approval",
        "effective_native_configuration_and_session_isolation",
        "binary_revision_provenance",
        "credential_and_source_authorization",
        "enforced_cost_time_and_owned_cleanup",
        "environment_and_tool_catalog_review",
      ],
    };
  } catch (error) {
    const known = new Set([
      "symlink_path",
      "wrong_path_kind",
      "nonprivate_directory",
      "existing_profile_root",
      "root_not_empty",
      "overlapping_trial_paths",
      "evidence_not_empty",
      "artifact_too_large",
      "artifact_not_executable",
      "indirect_runner",
      "artifact_digest_mismatch",
    ]);
    return {
      ...result,
      errors: [known.has(error.message) ? error.message : "path_unavailable"],
    };
  }
}

/** Read at most 64 KiB from one regular, non-symlink manifest descriptor. */
export function readNativeTrialPlan(path) {
  const limit = 64 * 1024;
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limit) throw Error("invalid_manifest_file");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw Error("manifest_too_large");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
