import { createServer } from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ApprovedSubjects, Auth0Verifier, OAuthResource } from "./oauth.ts";
import { handler } from "./mcp.ts";
import { Hub } from "./sqlite.ts";
import { InventoryLaunchPlan } from "./inventory-launch-plan.ts";
import {
  runInventoryOnce,
  checkInventoryPreparation,
} from "./inventory-factory.ts";
import {
  INVENTORY_ONE_SHOT_KEY,
  InventoryMCPClient,
} from "./mcp-worker-client.ts";
import type { Principal, Task } from "./types.ts";
import { inventoryHTTPBoundary } from "./inventory-http.ts";

const identity = z
  .object({
    subject: z.string().min(1).max(200),
    clientId: z.string().min(1).max(200),
  })
  .strict();
const settings = z
  .object({
    version: z.literal(1),
    mode: z.literal("inventory-one-shot"),
    enabled: z.literal(true),
    oauth: z.object({ issuer: z.string(), resource: z.string() }).strict(),
    requester: identity,
    worker: identity,
    reviewed: z.unknown(),
  })
  .strict();

/** Separate, manually invoked entrypoint. No enrollment from token claims or task arguments.
 * workerAuthorization returns an already acquired token; this module never issues OAuth tokens.
 * Dependencies are trusted test seams, never serialized settings or request arguments.
 */
export async function startInventoryEntry(
  input: unknown,
  options: {
    workerAuthorization: () => Promise<string>;
  },
  dependencies: {
    fetch?: typeof fetch;
    workerFetch?: typeof fetch;
    factory?: Parameters<typeof runInventoryOnce>[1];
    lifetimeMs?: number;
  } = {},
) {
  let config: z.infer<typeof settings>,
    plan: InventoryLaunchPlan,
    oauth: OAuthResource;
  const lifetimeMs = z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .parse(dependencies.lifetimeMs ?? 120000);
  try {
    config = settings.parse(input);
    if (typeof options?.workerAuthorization !== "function") throw Error();
    if (
      config.requester.subject === config.worker.subject ||
      config.requester.clientId === config.worker.clientId
    )
      throw Error();
    plan = new InventoryLaunchPlan(config.reviewed, "0".repeat(64));
    oauth = new OAuthResource({
      ...config.oauth,
      userScopes: ["hub:submit", "hub:get"],
    });
  } catch {
    throw Error("inventory_entry_config_rejected");
  }
  await (dependencies.factory?.checkPreparation ?? checkInventoryPreparation)(
    plan,
  );
  const profile = plan.policy({
    credential: { dev: 0, ino: 0, size: 65, mtimeMs: 0, ctimeMs: 0 },
    store: { dev: 0, ino: 0 },
    evidenceStore: { dev: 0, ino: 0 },
  }).profileRoot;
  const stat = await lstat(profile);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    (await realpath(profile)) !== profile
  )
    throw Error("inventory_private_directory_required");
  const database = join(profile, "inventory-hub.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await lstat(database + suffix);
      throw Error("inventory_entry_requires_reconciliation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const file = await open(
    database,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  await file.close();
  const hub = new Hub(database);
  const requester = {
    ...config.requester,
    kind: "user" as const,
    operations: ["submit", "get"] as const,
    destination: "hermes" as const,
    taskTypes: ["shift_log_inventory"] as const,
  };
  const subjectSets: ApprovedSubjects[] = [];
  const verifierFor = (worker?: Principal) => {
    const subjects = new ApprovedSubjects(
      [
        requester,
        ...(worker
          ? [
              {
                ...config.worker,
                kind: "service",
                operations: ["claim", "get", "heartbeat", "complete"],
                worker: "hermes",
                runnerScope: worker.runnerScope,
                taskTypes: ["shift_log_inventory"],
              },
            ]
          : []),
      ],
      { enabled: true },
    );
    subjectSets.push(subjects);
    return new Auth0Verifier({
      resource: oauth,
      subjects,
      fetch: dependencies.fetch,
    });
  };
  let verifier = verifierFor();
  let stopping = false,
    retrieved = false,
    work: Promise<string | null> | undefined,
    taskId: string | undefined;
  const controller = new AbortController();
  const deadline = Date.now() + lifetimeMs;
  let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  let closure: Promise<void> | undefined;
  const server = createServer((req, res) => {
    if (stopping) {
      res.writeHead(403, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    void guardedHandler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const close = (graceful = false) => {
    if (!graceful) controller.abort();
    return (closure ??= (async () => {
      let failed = false;
      if (work) {
        try {
          await work;
        } catch {
          failed = true;
        }
      }
      stopping = true;
      clearTimeout(timer);
      controller.abort();
      for (const subjects of subjectSets) subjects.stopAll();
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 3000);
      await stopped;
      clearTimeout(force);
      // A failed factory may still have a late receipt writer. Keep the database
      // and evidence alive rather than claiming successful cleanup.
      if (failed) {
        rejectClosed(Error("inventory_entry_requires_reconciliation"));
        return;
      }
      hub.close();
      resolveClosed();
    })());
  };
  const service = Object.create(hub) as Hub;
  service.submit = async (principal, args) => {
    if (
      stopping ||
      retrieved ||
      controller.signal.aborted ||
      principal.subject !== requester.subject ||
      principal.clientId !== requester.clientId ||
      args.task_type !== "shift_log_inventory" ||
      args.request_key !== INVENTORY_ONE_SHOT_KEY ||
      Object.keys(args).length !== 2
    )
      throw Error("invalid_request");
    const task = await hub.submit(principal, args);
    if (stopping || controller.signal.aborted)
      throw Error("inventory_entry_closed");
    if (!work) {
      taskId = task.id;
      work = runInventoryOnce(
        {
          reviewed: config.reviewed,
          signal: controller.signal,
          worker: async (runnerScope) => {
            if (stopping) throw Error("inventory_entry_closed");
            const worker: Principal = {
              ...config.worker,
              operations: ["claim", "get", "heartbeat", "complete"],
              worker: "hermes",
              runnerScope,
              taskTypes: ["shift_log_inventory"],
            };
            const next = verifierFor(worker);
            for (const subjects of subjectSets.slice(0, -1)) subjects.stopAll();
            verifier = next;
            return {
              principal: worker,
              hub: new InventoryMCPClient({
                endpoint,
                authorization: options.workerAuthorization,
                fetch: dependencies.workerFetch,
              }),
            };
          },
        },
        { ...dependencies.factory, ttlMs: Math.max(1, deadline - Date.now()) },
      );
      void work.catch(() => {
        void close();
      });
    }
    return task;
  };
  service.view = async (principal, args) => {
    const task = (await hub.view(principal, args)) as Task;
    if (
      principal.subject === requester.subject &&
      task.id === taskId &&
      ["succeeded", "failed"].includes(task.state)
    ) {
      // Finish the HTTP response before closing; factory.stop must settle first.
      retrieved = true;
      setImmediate(() => {
        void close(true);
      });
    }
    return task;
  };
  const nodeHandler = handler(
    service,
    async (req) =>
      stopping ? null : verifier.verify(req.headers.authorization),
    undefined,
    oauth,
  );
  const guardedHandler = inventoryHTTPBoundary(oauth, nodeHandler);
  const endpoint = `http://127.0.0.1:8789${oauth.mcpPath}`;
  const timer = setTimeout(() => {
    void close();
  }, lifetimeMs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(8789, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    clearTimeout(timer);
    subjectSets.forEach((s) => s.stopAll());
    hub.close();
    throw Error("inventory_entry_bind_failed");
  }
  return Object.freeze({ endpoint, closed, close: () => close() });
}
