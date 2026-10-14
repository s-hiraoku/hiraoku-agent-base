import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readFile,
  realpath,
  readdir,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { IsolationEvidence } from "./hermes-agent-inventory-runs.ts";
const exec = promisify(execFile);
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
};
const stableJSON = (value: unknown) => JSON.stringify(normalized(value));
// Hash every regular file, including ignored archives/custom-loader formats.
// Code roots must be reviewed immutable trees without secrets or runtime data.
// The approved roots must cover the entire reviewed Python import/runtime closure.
const treeOptions = z
  .object({
    systemRuntime: z.boolean().optional(),
    fixedDependencies: z.boolean().optional(),
    maxBytes: z.number().int().positive().max(1073741824).optional(),
    aliases: z.record(z.string(), z.string()).optional(),
    reviewedResources: z
      .array(
        z
          .string()
          .refine(
            (p) =>
              p.length > 0 &&
              !p.startsWith("/") &&
              !p.split("/").includes("..") &&
              ["logs", "runtime", "secrets"].includes(p.split("/").at(-1)!),
          ),
      )
      .max(8)
      .optional(),
    excludedSystemSitePackages: z
      .string()
      .regex(/^python3\.\d+\/site-packages$/)
      .optional(),
  })
  .strict();
type TreeOptions = z.infer<typeof treeOptions>;
export async function measureCodeTree(
  root: string,
  before = Infinity,
  options: TreeOptions = {},
) {
  const settings = treeOptions.parse(options);
  const entries: string[][] = [];
  let count = 0,
    total = 0;
  async function walk(path: string, relative: string) {
    const stat = await lstat(path);
    const alias =
      settings.systemRuntime &&
      stat.isSymbolicLink() &&
      settings.aliases?.[relative];
    if (settings.systemRuntime) {
      if (stat.uid !== 0) throw new Error("inventory_system_runtime_rejected");
    }
    try {
      await access(path, constants.W_OK);
      throw new Error(
        settings.systemRuntime
          ? "inventory_system_runtime_writable"
          : "inventory_code_integrity_rejected",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
    if (
      ++count > 100000 ||
      (stat.isSymbolicLink() && !alias) ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      (!settings.systemRuntime && stat.mode & 0o222) ||
      stat.ctimeMs > before ||
      (await realpath(path)) !== (alias || path)
    )
      throw new Error("inventory_code_integrity_rejected");
    if (alias) {
      entries.push([relative, "approved-system-alias", alias]);
      const after = await lstat(path);
      if (after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino)
        throw new Error("inventory_code_integrity_rejected");
    } else if (stat.isDirectory()) {
      entries.push([relative, "directory"]);
      for (const name of (await readdir(path)).sort()) {
        if (name === ".git") continue; // Git metadata must never be part of the import closure.
        if (
          (name.startsWith(".env") && name !== ".env.example") ||
          (["secrets", "runtime", "logs"].includes(name) &&
            !settings.reviewedResources?.includes(
              relative ? `${relative}/${name}` : name,
            ))
        )
          throw new Error("inventory_code_root_contains_private_data");
        if (
          settings.fixedDependencies &&
          (name.endsWith(".pth") ||
            name.endsWith(".egg-link") ||
            name.startsWith("__editable__") ||
            name === "direct_url.json")
        )
          throw new Error("inventory_dependency_loader_rejected");
        const child = join(path, name),
          sub = relative ? `${relative}/${name}` : name;
        if (
          settings.systemRuntime &&
          sub === settings.excludedSystemSitePackages
        ) {
          entries.push([sub, "excluded-disabled-system-site-packages"]);
          continue;
        }
        await walk(child, sub);
      }
      const after = await lstat(path);
      if (after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino)
        throw new Error("inventory_code_integrity_rejected");
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > (settings.maxBytes ?? 536870912) || stat.size > 67108864)
        throw new Error("inventory_code_integrity_rejected");
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino)
        throw new Error("inventory_code_integrity_rejected");
      entries.push([relative, digest(bytes)]);
    } else throw new Error("inventory_code_integrity_rejected");
  }
  await walk(root, "");
  return digest(JSON.stringify(entries));
}
const identity = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
  })
  .strict();
const policySchema = z
  .object({
    manifestPath: z.string(),
    credentialSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    manifestSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: z.string(),
    namespaceLabel: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    profileRoot: z.string(),
    sourceRoot: z.string(),
    dependencyRoot: z.string(),
    pythonIsolation: z.literal("isolated-no-site-v1"),
    wrapperPath: z.string(),
    pythonPath: z.string(),
    processInterpreterPath: z.string().optional(),
    codeTrees: z
      .array(
        treeOptions
          .extend({
            root: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(6)
      .refine(
        (trees) =>
          trees.reduce((sum, t) => sum + (t.maxBytes ?? 536870912), 0) <=
          2147483648,
      ),
    pythonSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    wrapperSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.literal("f97608f178d1ffeca59860195ab7da295f7c8e5f"),
    credential: identity
      .extend({
        size: z.number().int().positive(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
      })
      .strict(),
    storeRelativePath: z.string(),
    store: identity,
    evidenceStore: identity,
  })
  .strict();
export type InventoryPolicy = z.infer<typeof policySchema>;
// Shared structural contract for offline launch preparation; validation is not live evidence.
export { policySchema as inventoryPolicySchema };
export interface InventoryProcess {
  pid: number;
  uid: number;
  startedAt: number;
  command: string;
  listeners: string[];
  sourceCommit: string;
}
export type ProcessProbe = (
  pid: number,
  sourceRoot: string,
) => Promise<InventoryProcess>;
// Fixed read-only executables, no shell, no credential/config contents in process arguments.
export const observeInventory: ProcessProbe = async (pid, sourceRoot) => {
  const opts = {
    timeout: 1500,
    maxBuffer: 32768,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
      TZ: "UTC",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
  const [uid, start, args, sockets, commit] = await Promise.all([
    exec("/bin/ps", ["-p", String(pid), "-o", "uid="], opts),
    exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], opts),
    exec("/bin/ps", ["-p", String(pid), "-o", "args="], opts),
    exec(
      "/usr/sbin/lsof",
      ["-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      opts,
    ),
    exec(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "-C",
        sourceRoot,
        "rev-parse",
        "HEAD",
      ],
      opts,
    ),
  ]);
  return {
    pid,
    uid: Number(uid.stdout.trim()),
    startedAt: Date.parse(`${start.stdout.trim()} UTC`),
    command: args.stdout.trim(),
    listeners: sockets.stdout
      .split("\n")
      .filter((l) => l.startsWith("n"))
      .map((l) => l.slice(1)),
    sourceCommit: commit.stdout.trim(),
  };
};
/** Read-only local inspector. Approved hashes must refer to independently reviewed safe code/config. */
export class InventoryInspector {
  #policy: InventoryPolicy;
  #probe: ProcessProbe;
  #now: () => number;
  readonly endpoint: string;
  readonly scopeId: string;
  constructor(
    policy: InventoryPolicy,
    options: { probe?: ProcessProbe; now?: () => number } = {},
  ) {
    this.#policy = policySchema.parse(structuredClone(policy));
    const url = new URL(policy.endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("inventory_policy_rejected");
    for (const path of [
      policy.manifestPath,
      policy.profileRoot,
      policy.sourceRoot,
      policy.wrapperPath,
      policy.pythonPath,
      ...(policy.processInterpreterPath ? [policy.processInterpreterPath] : []),
    ])
      if (resolve(path) !== path) throw new Error("inventory_policy_rejected");
    if (
      resolve(policy.profileRoot, policy.storeRelativePath) !==
        join(policy.profileRoot, policy.storeRelativePath) ||
      resolve(policy.profileRoot, policy.storeRelativePath) ===
        policy.profileRoot ||
      !resolve(policy.profileRoot, policy.storeRelativePath).startsWith(
        `${policy.profileRoot}/`,
      )
    )
      throw new Error("inventory_policy_rejected");
    if (
      !policy.codeTrees.some((tree) => tree.root === policy.sourceRoot) ||
      !policy.codeTrees.some(
        (tree) => tree.root === dirname(policy.wrapperPath),
      ) ||
      !policy.codeTrees.some(
        (tree) =>
          policy.pythonPath === tree.root ||
          policy.pythonPath.startsWith(`${tree.root}/`),
      ) ||
      (policy.processInterpreterPath !== undefined &&
        !policy.codeTrees.some(
          (tree) =>
            tree.systemRuntime && tree.root === policy.processInterpreterPath,
        )) ||
      policy.codeTrees.some((tree) => resolve(tree.root) !== tree.root)
    )
      throw new Error("inventory_policy_rejected");
    if (
      new Set(policy.codeTrees.map((tree) => tree.root)).size !==
        policy.codeTrees.length ||
      resolve(policy.dependencyRoot) !== policy.dependencyRoot ||
      [policy.sourceRoot, dirname(policy.wrapperPath)].some(
        (root) =>
          policy.dependencyRoot === root ||
          policy.dependencyRoot.startsWith(`${root}/`) ||
          root.startsWith(`${policy.dependencyRoot}/`),
      ) ||
      policy.dependencyRoot.split("/").includes("site-packages") ||
      !policy.codeTrees.some(
        (tree) =>
          tree.root === policy.dependencyRoot &&
          tree.fixedDependencies === true &&
          !tree.systemRuntime,
      ) ||
      policy.codeTrees.some(
        (tree) =>
          (tree.fixedDependencies &&
            (tree.root !== policy.dependencyRoot || tree.systemRuntime)) ||
          (tree.root !== policy.dependencyRoot &&
            (policy.dependencyRoot.startsWith(`${tree.root}/`) ||
              tree.root.startsWith(`${policy.dependencyRoot}/`))),
      )
    )
      throw Error("inventory_dependency_policy_rejected");
    const excludedRoots = policy.codeTrees
      .filter((tree) => tree.excludedSystemSitePackages)
      .map((tree) => join(tree.root, tree.excludedSystemSitePackages!));
    if (
      policy.codeTrees.some((tree) =>
        excludedRoots.some(
          (root) => tree.root === root || tree.root.startsWith(`${root}/`),
        ),
      )
    )
      throw Error("inventory_policy_rejected");
    for (const tree of policy.codeTrees) {
      if (tree.aliases && !tree.systemRuntime)
        throw new Error("inventory_policy_rejected");
      if (
        tree.excludedSystemSitePackages &&
        (!tree.systemRuntime || !tree.root.endsWith("/lib"))
      )
        throw new Error("inventory_policy_rejected");
      for (const [relative, target] of Object.entries(tree.aliases ?? {})) {
        if (
          !relative ||
          relative.startsWith("/") ||
          relative.split("/").includes("..") ||
          resolve(target) !== target ||
          !policy.codeTrees.some(
            (t) =>
              t.systemRuntime &&
              (target === t.root || target.startsWith(`${t.root}/`)) &&
              (!t.excludedSystemSitePackages ||
                !(
                  target === join(t.root, t.excludedSystemSitePackages) ||
                  target.startsWith(
                    `${join(t.root, t.excludedSystemSitePackages)}/`,
                  )
                )),
          )
        )
          throw new Error("inventory_policy_rejected");
      }
    }
    this.endpoint = url.href;
    this.scopeId = `inventory-${digest(JSON.stringify({ ...this.#policy, endpoint: this.endpoint }))}`;
    this.#probe = options.probe ?? observeInventory;
    this.#now = options.now ?? Date.now;
  }
  private async owned(
    path: string,
    directory = false,
    secret = false,
    system = false,
  ) {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (!directory && !stat.isFile()) ||
      (directory && !stat.isDirectory()) ||
      stat.uid !== (system ? 0 : process.getuid?.()) ||
      stat.mode & 0o022 ||
      (secret && stat.mode & 0o077) ||
      (await realpath(path)) !== path
    )
      throw new Error("inventory_file_boundary_rejected");
    return stat;
  }
  private async ownedBytes(path: string, maxBytes = 1048576, system = false) {
    const before = await this.owned(path, false, false, system);
    if (before.size > maxBytes) throw Error("inventory_file_boundary_rejected");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        opened.ctimeMs !== before.ctimeMs ||
        opened.size > maxBytes
      )
        throw Error("inventory_integrity_rejected");
      const bytes = await handle.readFile();
      const after = await this.owned(path, false, false, system);
      if (
        bytes.length > maxBytes ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.ctimeMs !== after.ctimeMs
      )
        throw Error("inventory_integrity_rejected");
      return Object.assign(after, { bytes });
    } finally {
      await handle.close();
    }
  }
  private async pinnedFile(
    path: string,
    sha: string,
    maxBytes = 1048576,
    system = false,
  ) {
    const result = await this.ownedBytes(path, maxBytes, system);
    if (digest(result.bytes) !== sha)
      throw Error("inventory_integrity_rejected");
    return result;
  }
  /** Read-only checks of existing inputs; never runtime isolation evidence.
   * PID, key/store identities and pre-process timestamps still require inspect(). */
  async inspectPreparation(): Promise<void> {
    const p = this.#policy;
    const snapshot = async () => {
      const profile = await this.owned(p.profileRoot, true, true);
      const workdir = await this.owned(
        join(p.profileRoot, "empty-workdir"),
        true,
        true,
      );
      if ((await readdir(join(p.profileRoot, "empty-workdir"))).length)
        throw Error("inventory_preparation_workdir_rejected");
      await this.owned(p.sourceRoot, true);
      const wrapper = await this.pinnedFile(p.wrapperPath, p.wrapperSHA256);
      const config = await this.pinnedFile(
        join(p.profileRoot, "config.yaml"),
        p.configSHA256,
      );
      await this.owned(join(p.profileRoot, "config.yaml"), false, true);
      const python = await this.pinnedFile(
        p.pythonPath,
        p.pythonSHA256,
        1048576,
        p.codeTrees.some(
          (t) =>
            t.systemRuntime &&
            (p.pythonPath === t.root || p.pythonPath.startsWith(`${t.root}/`)),
        ),
      );
      for (const tree of p.codeTrees) {
        const { root, sha256, ...options } = tree;
        if ((await measureCodeTree(root, Infinity, options)) !== sha256)
          throw Error("inventory_code_integrity_rejected");
      }
      return [profile, workdir, wrapper, config, python].map((s) => [
        s.dev,
        s.ino,
        s.ctimeMs,
        s.mode,
      ]);
    };
    const first = await snapshot(),
      second = await snapshot();
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw Error("inventory_preparation_changed");
  }
  private async snapshot() {
    const p = this.#policy;
    const manifestStat = await this.pinnedFile(
      p.manifestPath,
      p.manifestSHA256,
    );
    const manifestBytes = new TextDecoder().decode(manifestStat.bytes);
    const credentialMarker = await this.pinnedFile(
      join(p.profileRoot, "credential.scope"),
      p.credentialSHA256,
      65,
    );
    const apiKeyDigest = new TextDecoder()
      .decode(credentialMarker.bytes)
      .trim();
    if (!/^[a-f0-9]{64}$/.test(apiKeyDigest))
      throw Error("inventory_scope_marker_rejected");
    if (digest(manifestBytes) !== p.manifestSHA256)
      throw Error("inventory_manifest_rejected");
    const manifest = JSON.parse(manifestBytes);
    if (
      stableJSON(manifest) !==
      stableJSON({
        contract: "hermes-agent-inventory-v1",
        endpoint: this.endpoint,
        profileRoot: p.profileRoot,
        sourceRoot: p.sourceRoot,
        dependencyRoot: p.dependencyRoot,
        pythonIsolation: p.pythonIsolation,
        wrapperPath: p.wrapperPath,
        pythonPath: p.pythonPath,
        model: "gpt-6.1-sol",
        provider: "openai-codex",
        tools: ["hub_shift_log_inventory"],
        maxIterations: 3,
        maxTokens: 256,
        runBudgetSeconds: 60,
        concurrency: 1,
        evidencePath: join(p.profileRoot, "inventory-evidence.sqlite"),
        runStorePath: join(p.profileRoot, p.storeRelativePath),
        memory: false,
        history: false,
        fallback: false,
        startup: "manual-one-shot",
        maxTasks: 1,
        apiKeyDigest,
        sourceCommit: p.sourceCommit,
        codeTrees: p.codeTrees,
      })
    )
      throw Error("inventory_manifest_rejected");
    await this.owned(p.profileRoot, true, true);
    await this.owned(p.sourceRoot, true);
    const [wrapper, config, key, store, pidfile, evidenceStore] =
      await Promise.all([
        this.pinnedFile(p.wrapperPath, p.wrapperSHA256),
        this.pinnedFile(join(p.profileRoot, "config.yaml"), p.configSHA256),
        this.owned(join(p.profileRoot, "credential.scope"), false, true),
        this.owned(join(p.profileRoot, p.storeRelativePath)),
        this.owned(join(p.profileRoot, "inventory.pid")),
        this.owned(join(p.profileRoot, "inventory-evidence.sqlite")),
      ]);
    // Nonsecret scope fingerprint metadata; API bearer is never read from a file.
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
      if (key[field] !== p.credential[field])
        throw new Error("inventory_credential_scope_changed");
    if (
      evidenceStore.dev !== p.evidenceStore.dev ||
      evidenceStore.ino !== p.evidenceStore.ino
    )
      throw Error("inventory_evidence_scope_changed");
    if (store.dev !== p.store.dev || store.ino !== p.store.ino)
      throw new Error("inventory_store_scope_changed");
    if (pidfile.size > 32) throw new Error("inventory_pid_rejected");
    const pidText = new TextDecoder()
      .decode(
        (await this.ownedBytes(join(p.profileRoot, "inventory.pid"), 32)).bytes,
      )
      .trim();
    if (!/^[1-9][0-9]{0,9}$/.test(pidText))
      throw new Error("inventory_pid_rejected");
    const pid = Number(pidText);
    const observed = await this.#probe(pid, p.sourceRoot);
    const url = new URL(this.endpoint);
    if (
      observed.pid !== pid ||
      observed.uid !== process.getuid?.() ||
      !Number.isFinite(observed.startedAt) ||
      observed.startedAt > this.#now() ||
      observed.command !==
        `${p.processInterpreterPath ?? p.pythonPath} -I -S ${p.wrapperPath}` ||
      observed.sourceCommit !== p.sourceCommit ||
      observed.listeners.length !== 1 ||
      observed.listeners[0] !== `127.0.0.1:${url.port}`
    )
      throw new Error("inventory_process_boundary_rejected");
    const python = await this.pinnedFile(
      p.pythonPath,
      p.pythonSHA256,
      1048576,
      p.codeTrees.some(
        (tree) =>
          tree.systemRuntime &&
          (p.pythonPath === tree.root ||
            p.pythonPath.startsWith(`${tree.root}/`)),
      ),
    );
    for (const tree of p.codeTrees)
      if (
        (await measureCodeTree(tree.root, observed.startedAt, {
          systemRuntime: tree.systemRuntime,
          fixedDependencies: tree.fixedDependencies,
          maxBytes: tree.maxBytes,
          aliases: tree.aliases,
          reviewedResources: tree.reviewedResources,
          excludedSystemSitePackages: tree.excludedSystemSitePackages,
        })) !== tree.sha256
      )
        throw new Error("inventory_code_integrity_rejected");
    // ps has one-second precision. Files must predate the process's earliest start instant.
    if (
      Math.max(
        wrapper.ctimeMs,
        config.ctimeMs,
        key.ctimeMs,
        python.ctimeMs,
        manifestStat.ctimeMs,
      ) > observed.startedAt
    )
      throw new Error("inventory_startup_integrity_unverified");
    return {
      pid,
      start: observed.startedAt,
      command: observed.command,
      key: JSON.stringify(p.credential),
      store: JSON.stringify(p.store),
      evidenceStore: JSON.stringify(p.evidenceStore),
    };
  }
  async inspect(): Promise<IsolationEvidence | null> {
    try {
      const first = await this.snapshot();
      const second = await this.snapshot();
      if (JSON.stringify(first) !== JSON.stringify(second)) return null;
      return {
        endpoint: this.endpoint,
        scopeId: this.scopeId,
        sourceCommit: this.#policy.sourceCommit,
        expiresAt: this.#now() + 30000,
        dedicatedProfile: true,
        credentialScopeIsolated: true,
        effectiveToolCount: 1,
        contract: "hermes-agent-inventory-v1",
        memoryDisabled: true,
        historyIsolated: true,
        modelProviderLocked: true,
        fallbackDisabled: true,
      };
    } catch {
      return null;
    }
  }
}
