import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { constants } from "node:fs";
import { lstat, realpath, readdir, open, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Hub } from "./sqlite.ts";
import { AsyncAudit } from "./async-audit.ts";
import { OAuthResource, ApprovedSubjects } from "./oauth.ts";
import { createRuntime } from "./runtime.ts";
import type { AuditSink } from "./security.ts";

export const PING_OPERATIONS = Object.freeze([
  "ping_submit",
  "ping_get",
  "ping_reply",
  "ping_pending",
] as const);
export const PING_SCOPES = Object.freeze([
  "hub:ping_submit",
  "hub:ping_get",
  "hub:ping_reply",
  "hub:ping_pending",
] as const);
const confirmed = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !/REPLACE|placeholder|<|>/i.test(v));
const peer = z.object({ subject: confirmed, clientId: confirmed }).strict();
const schema = z
  .object({
    version: z.literal(1),
    mode: z.literal("manual-ping-only"),
    enabled: z.literal(true),
    lifetimeMs: z.number().int().min(1000).max(900000),
    oauth: z.object({ issuer: confirmed, resource: confirmed }).strict(),
    peers: z
      .object({ dots: peer, grok: peer })
      .strict()
      .refine((p) => p.dots.clientId !== p.grok.clientId),
  })
  .strict();
export function pingRunnerSettings(input: unknown) {
  const config = schema.parse(input);
  const oauth = new OAuthResource({ ...config.oauth, userScopes: PING_SCOPES });
  if (oauth.mcpPath !== "/hab/mcp")
    throw Error("ping_runner_resource_rejected");
  const runtimeConfig = {
    version: 1,
    mode: "auth0",
    enabled: true,
    oauth: { ...config.oauth, scopes: PING_SCOPES },
    subjects: [config.peers.dots, config.peers.grok].map((p) => ({
      ...p,
      kind: "user",
      operations: [...PING_OPERATIONS],
    })),
    ping: config.peers,
  };
  new ApprovedSubjects(runtimeConfig.subjects, { enabled: true });
  return { config, runtimeConfig };
}
type Audit = AuditSink & { ready(): Promise<void>; close(): Promise<void> };
type Dependencies = {
  createHTTP?: (
    handle: (req: IncomingMessage, res: ServerResponse) => void,
  ) => Server;
  createAudit?: (directory: string) => Audit;
  createHub?: (database: string) => Hub;
  fetch?: typeof fetch;
};
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("ping_runner_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Manual only. No credential lookup, transport, route publication or worker. */
export async function startPingRunner(
  input: unknown,
  directory: string,
  dependencies: Dependencies = {},
) {
  const { config, runtimeConfig } = pingRunnerSettings(input);
  if (resolve(directory) !== directory)
    throw Error("ping_runner_directory_rejected");
  const before = await lstat(directory);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    before.mode & 0o077 ||
    (await realpath(directory)) !== directory ||
    (await readdir(directory)).length
  )
    throw Error("ping_runner_directory_rejected");
  let hub: Hub | undefined,
    audit: Audit | undefined,
    server: Server | undefined;
  let closing = false,
    closePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (e: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  const active = new Set<Promise<void>>();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    closePromise = (async () => {
      let uncertain = false;
      if (server) {
        try {
          const stopped = new Promise<void>((resolve, reject) => {
            server!.close((error) =>
              error &&
              (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
                ? reject(error)
                : resolve(),
            );
            server!.closeAllConnections();
          });
          await bounded(stopped, 1000);
        } catch {
          uncertain = true;
        }
      }
      try {
        await bounded(Promise.allSettled([...active]), 1000);
      } catch {
        uncertain = true;
      }
      try {
        hub?.close();
      } catch {
        uncertain = true;
      }
      if (audit) {
        try {
          await bounded(audit.close(), 1000);
        } catch {
          uncertain = true;
        }
      }
      if (uncertain) throw Error("ping_runner_stop_uncertain");
    })();
    void closePromise.then(resolveClosed, () =>
      rejectClosed(Error("ping_runner_stop_uncertain")),
    );
    return closePromise;
  };
  try {
    const database = join(directory, "ping-hub.sqlite");
    const file = await open(
      database,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await file.close();
    const after = await lstat(directory);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      (await realpath(directory)) !== directory
    )
      throw Error("ping_runner_directory_replaced");
    hub = (dependencies.createHub ?? ((path) => new Hub(path)))(database);
    const auditPath = join(directory, "audit");
    await mkdir(auditPath, { mode: 0o700 });
    audit = (dependencies.createAudit ?? ((path) => new AsyncAudit(path)))(
      auditPath,
    );
    await bounded(audit.ready(), 5000);
    const runtime = createRuntime(hub, runtimeConfig, {
      audit,
      pingOnly: true,
      fetch: dependencies.fetch,
    });
    server = (
      dependencies.createHTTP ??
      ((handle) =>
        createServer(
          {
            requestTimeout: 10000,
            headersTimeout: 5000,
            maxHeaderSize: 16384,
          },
          handle,
        ))
    )((req, res) => {
      if (closing) {
        res.writeHead(503);
        res.end();
        return;
      }
      const work = runtime.handle(req, res).catch(() => {
        if (res.destroyed || res.writableEnded) return;
        try {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        } catch {
          res.destroy();
        }
      });
      active.add(work);
      void work.finally(() => active.delete(work));
    });
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 60;
    server.keepAliveTimeout = 5000;
    server.on("error", () => {
      void close().catch(() => {});
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(8789, "127.0.0.1", resolve);
    });
    timer = setTimeout(() => {
      void close().catch(() => {});
    }, config.lifetimeMs);
    return {
      close,
      closed,
      fetch: (request: Request) =>
        closing
          ? Promise.resolve(new Response(null, { status: 503 }))
          : runtime.fetch(request),
    };
  } catch {
    try {
      await close();
    } catch {
      throw Error("ping_runner_stop_uncertain");
    }
    throw Error("ping_runner_start_rejected");
  }
}
