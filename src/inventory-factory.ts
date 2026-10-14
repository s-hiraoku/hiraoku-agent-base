import { constants } from "node:fs";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { InventoryLaunchPlan } from "./inventory-launch-plan.ts";
import {
  InventoryInspector,
  observeInventory,
  type InventoryPolicy,
  type ProcessProbe,
} from "./inventory-inspector.ts";
import { HermesAgentInventoryRuns } from "./hermes-agent-inventory-runs.ts";
import { LocalHermesKey, type KeyRecord } from "./local-hermes-key.ts";
import { Adapter } from "./adapter.ts";
import { Journal } from "./journal.ts";
import type { HubClient, Principal, Runs } from "./types.ts";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (s: { dev: number; ino: number }) => ({
  dev: s.dev,
  ino: s.ino,
});
async function privateDirectory(path: string) {
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    throw Error("inventory_private_directory_required");
  return identity(s);
}
async function exclusiveFile(path: string, bytes: string) {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read-only artifact freshness and real Inspector input checks before provision.
 * A successful return is not a live worker grant or isolation attestation. */
export async function checkInventoryPreparation(plan: InventoryLaunchPlan) {
  await plan.inspectPreparation();
  const artifacts = plan.artifacts();
  const manifest = JSON.parse(artifacts.manifestBytes);
  const profile = manifest.profileRoot;
  const stores = [
    manifest.runStorePath,
    manifest.evidencePath,
    join(profile, "inventory-worker.sqlite"),
  ];
  const paths = [
    artifacts.manifestPath,
    artifacts.scopePath,
    ...stores,
    join(profile, "inventory-key-record.json"),
    join(profile, "inventory.pid"),
    ...stores.flatMap((path) =>
      ["-wal", "-shm", "-journal"].map((s) => path + s),
    ),
  ];
  for (const path of paths) {
    try {
      await lstat(path);
      throw Error("inventory_existing_artifact_requires_reconciliation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
/** Local filesystem implementation, never an MCP tool or automatic entrypoint.
 * Refuses existing artifacts. Partial failure leaves evidence for reconciliation.
 */
export async function prepareInventoryArtifacts(plan: InventoryLaunchPlan) {
  const artifacts = plan.artifacts();
  const manifest = JSON.parse(artifacts.manifestBytes);
  const profile: string = manifest.profileRoot;
  const before = await privateDirectory(profile);
  await privateDirectory(join(profile, "empty-workdir"));
  const stores = [
    manifest.runStorePath,
    manifest.evidencePath,
    join(profile, "inventory-worker.sqlite"),
  ];
  const paths = [
    artifacts.manifestPath,
    artifacts.scopePath,
    manifest.runStorePath,
    manifest.evidencePath,
    join(profile, "inventory-worker.sqlite"),
    join(profile, "inventory-key-record.json"),
    join(profile, "inventory.pid"),
    ...stores.flatMap((path) =>
      ["-wal", "-shm", "-journal"].map((suffix) => path + suffix),
    ),
  ];
  for (const path of paths) {
    if (dirname(path) !== profile)
      throw Error("inventory_artifact_path_rejected");
    try {
      await lstat(path);
      throw Error("inventory_existing_artifact_requires_reconciliation");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  for (const path of stores) {
    await exclusiveFile(path, "");
    const before = identity(await lstat(path));
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=0");
    } finally {
      db.close();
    }
    if (JSON.stringify(before) !== JSON.stringify(identity(await lstat(path))))
      throw Error("inventory_artifact_replaced");
  }
  await exclusiveFile(artifacts.scopePath, artifacts.scopeBytes);
  await exclusiveFile(artifacts.manifestPath, artifacts.manifestBytes);
  const marker = await lstat(artifacts.scopePath);
  const policy = plan.policy({
    credential: {
      ...identity(marker),
      size: marker.size,
      mtimeMs: marker.mtimeMs,
      ctimeMs: marker.ctimeMs,
    },
    store: identity(await lstat(manifest.runStorePath)),
    evidenceStore: identity(await lstat(manifest.evidencePath)),
  });
  if (
    JSON.stringify(before) !== JSON.stringify(await privateDirectory(profile))
  )
    throw Error("inventory_profile_replaced");
  if (
    hash(await readFile(join(profile, "config.yaml"))) !== policy.configSHA256
  )
    throw Error("inventory_config_drift");
  return policy;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Owns only its direct child. No shell, inherited environment, output logs or process-group kill. */
export class InventoryChild {
  readonly process: ChildProcess;
  #exited = false;
  #spawned: Promise<void>;
  constructor(launch: ReturnType<InventoryLaunchPlan["launch"]>) {
    this.process = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      stdio: "ignore",
    });
    this.process.once("exit", () => {
      this.#exited = true;
    });
    this.#spawned = new Promise((resolve, reject) => {
      this.process.once("spawn", resolve);
      this.process.once("error", () => {
        this.#exited = true;
        reject(Error("inventory_child_spawn_failed"));
      });
    });
    // Provisioning may fail before a readiness caller consumes this promise.
    void this.#spawned.catch(() => {});
  }
  async started() {
    await this.#spawned;
    if (this.#exited || !this.process.pid)
      throw Error("inventory_child_exited");
    return this.process.pid;
  }
  get exited() {
    return this.#exited;
  }
  async stop() {
    await this.#spawned.catch(() => {});
    if (this.#exited) return;
    this.process.kill("SIGTERM");
    for (let i = 0; i < 10 && !this.#exited; i++) await pause(20);
    if (!this.#exited) this.process.kill("SIGKILL");
    for (let i = 0; i < 20 && !this.#exited; i++) await pause(20);
    if (!this.#exited) throw Error("inventory_child_stop_unconfirmed");
  }
}

export type InventoryFactoryOptions = {
  reviewed: ConstructorParameters<typeof InventoryLaunchPlan>[0];
  signal?: AbortSignal;
  /** Trusted enrollment boundary supplies an already authenticated Hub client.
   * It must bind this fresh runner scope; no credential issuance or auth bypass here.
   */
  worker: (
    runnerScope: string,
  ) => Promise<{ hub: HubClient; principal: Principal }>;
};
type Dependencies = {
  // Trusted in-process fixture seam; never serialized config/request arguments.
  checkPreparation?: typeof checkInventoryPreparation;
  entropy?: (size: number) => Buffer;
  ttlMs?: number;
  child?: (launch: ReturnType<InventoryLaunchPlan["launch"]>) => InventoryChild;
  connect?: (
    options: Parameters<typeof HermesAgentInventoryRuns.connect>[0],
  ) => Promise<Runs>;
  probe?: ProcessProbe;
};
/** Opt-in one-shot composition. Calling this is a live action requiring separate
 * approval. Test dependencies are trusted in-process seams, never request arguments.
 */
export async function runInventoryOnce(
  options: InventoryFactoryOptions,
  dependencies: Dependencies = {},
) {
  options.signal?.throwIfAborted();
  const preparationPlan = new InventoryLaunchPlan(
    options.reviewed,
    "0".repeat(64),
  );
  await (dependencies.checkPreparation ?? checkInventoryPreparation)(
    preparationPlan,
  );
  options.signal?.throwIfAborted();
  const lifetime = new LocalHermesKey();
  const controller = new AbortController();
  options.signal?.throwIfAborted();
  const externalStop = () => {
    controller.abort();
    void lifetime.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", externalStop, { once: true });
  let plan: InventoryLaunchPlan, policy: InventoryPolicy, child: InventoryChild;
  let journal: Journal | undefined;
  let task: Promise<string | null> | undefined;
  let taskSettled = false;
  let recordIdentity: { dev: number; ino: number } | undefined;
  let recordPath: string;
  const stopAdapter = async () => {
    controller.abort();
    if (task) {
      const stopped = await Promise.race([
        task.then(
          () => true,
          () => true,
        ),
        pause(200).then(() => false),
      ]);
      if (!stopped) throw Error("inventory_adapter_stop_unconfirmed");
    }
  };
  try {
    await lifetime.provision({
      ttlMs: dependencies.ttlMs ?? 120000,
      ...(dependencies.entropy ? { entropy: dependencies.entropy } : {}),
      persist: async (record: KeyRecord) => {
        if (record.state === "issued") {
          plan = new InventoryLaunchPlan(options.reviewed, record.fingerprint);
          policy = await prepareInventoryArtifacts(plan);
          recordPath = join(policy.profileRoot, "inventory-key-record.json");
          await exclusiveFile(recordPath, `${JSON.stringify(record)}\n`);
          recordIdentity = identity(await lstat(recordPath));
          // ps reports seconds, not filesystem subsecond times. All pinned files
          // must predate the earliest observable process-start instant.
          await pause(1050 - (Date.now() % 1000));
          return;
        }
        if (!recordIdentity) return; // No live boundaries exist after failed preparation.
        const handle = await open(
          recordPath,
          constants.O_WRONLY | constants.O_NOFOLLOW,
        );
        try {
          const s = await handle.stat();
          if (
            s.uid !== process.getuid?.() ||
            s.mode & 0o077 ||
            s.nlink !== 1 ||
            JSON.stringify(identity(s)) !== JSON.stringify(recordIdentity)
          )
            throw Error("inventory_record_replaced");
          await handle.truncate(0);
          await handle.writeFile(`${JSON.stringify(record)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      launch: (apiKey) => {
        child = (
          dependencies.child ?? ((launch) => new InventoryChild(launch))
        )(plan.launch(apiKey));
        return child;
      },
      adapter: (apiKey) => {
        task = (async () => {
          const pid = await child.started();
          // Wait only for this child's PID marker; never contact an existing listener.
          const until = Date.now() + 15000;
          for (;;) {
            controller.signal.throwIfAborted();
            if (child.exited) throw Error("inventory_child_exited");
            try {
              const marker = await lstat(
                join(policy.profileRoot, "inventory.pid"),
              );
              if (
                marker.isSymbolicLink() ||
                !marker.isFile() ||
                marker.uid !== process.getuid?.() ||
                marker.mode & 0o077 ||
                marker.size > 20
              )
                throw Error("inventory_pid_marker_rejected");
              if (
                (
                  await readFile(
                    join(policy.profileRoot, "inventory.pid"),
                    "utf8",
                  )
                ).trim() !== String(pid)
              )
                throw Error("inventory_child_pid_mismatch");
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            if (Date.now() >= until) throw Error("inventory_startup_timeout");
            await pause(50);
          }
          const inspector = new InventoryInspector(policy, {
            probe: async (observedPid, source) => {
              if (observedPid !== pid || child.exited)
                throw Error("inventory_child_pid_mismatch");
              return (dependencies.probe ?? observeInventory)(
                observedPid,
                source,
              );
            },
          });
          const runs = await (
            dependencies.connect ?? HermesAgentInventoryRuns.connect
          )({
            endpoint: inspector.endpoint,
            scopeId: inspector.scopeId,
            apiKey,
            inspector,
          });
          controller.signal.throwIfAborted();
          if (runs.boundaryId !== `${inspector.endpoint}|${inspector.scopeId}`)
            throw Error("inventory_runs_binding_rejected");
          const binding = await options.worker(runs.boundaryId!);
          controller.signal.throwIfAborted();
          if (
            binding.principal.worker !== "hermes" ||
            binding.principal.runnerScope !== runs.boundaryId ||
            binding.principal.taskTypes?.length !== 1 ||
            binding.principal.taskTypes[0] !== "shift_log_inventory"
          )
            throw Error("inventory_worker_binding_rejected");
          journal = new Journal(
            join(policy.profileRoot, "inventory-worker.sqlite"),
          );
          return await new Adapter(
            binding.hub,
            binding.principal,
            runs,
            journal,
          ).run(controller.signal);
        })();
        void task.then(
          () => {
            taskSettled = true;
          },
          () => {
            taskSettled = true;
          },
        );
        return { stop: stopAdapter };
      },
    });
    return await Promise.race([
      task!,
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(Error("inventory_lifetime_ended_requires_reconciliation")),
          { once: true },
        ),
      ),
    ]);
  } catch {
    throw Error("inventory_one_shot_failed_requires_reconciliation");
  } finally {
    options.signal?.removeEventListener("abort", externalStop);
    try {
      await lifetime.close();
    } finally {
      if (taskSettled || !task) journal?.close();
      else
        void task
          .then(
            () => journal?.close(),
            () => journal?.close(),
          )
          .catch(() => {});
    }
  }
}
