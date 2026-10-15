import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { OAuthResource } from "./oauth.ts";
import { SecurityMonitor, boundedBody } from "./security.ts";

const scopes = [
  "hub:ping_submit",
  "hub:ping_get",
  "hub:ping_reply",
  "hub:ping_pending",
] as const;
const settings = z
  .object({
    version: z.literal(1),
    mode: z.literal("ping-discovery"),
    enabled: z.literal(false),
    lifetimeMs: z.number().int().min(1000).max(900000),
    oauth: z.object({ issuer: z.string(), resource: z.string() }).strict(),
  })
  .strict();
export function pingDiscoverySettings(input: unknown) {
  try {
    const config = settings.parse(input);
    const oauth = new OAuthResource({ ...config.oauth, userScopes: scopes });
    if (oauth.mcpPath !== "/hab/mcp") throw Error();
    return { config, oauth };
  } catch {
    throw Error("ping_discovery_config_rejected");
  }
}
/** No database, peer registry, verifier, MCP server, credentials or model.
 * This separate mode cannot promote itself to an operational runner. */
export function createPingDiscovery(input: unknown) {
  const { config, oauth } = pingDiscoverySettings(input);
  const authority = new URL(oauth.resource);
  const monitor = new SecurityMonitor();
  let stopped = false;
  const admissible = (host?: string | null, origin?: string | null) =>
    host === authority.host && (origin == null || origin === authority.origin);
  const response = (path: string, method: string) => {
    const metadata = oauth.response(path, method);
    if (metadata) return metadata;
    if (path === oauth.mcpPath)
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": oauth.challenge(),
          "Cache-Control": "no-store",
        },
      });
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const duplicate = ["host", "origin", "authorization"].some(
      (name) =>
        req.rawHeaders.filter(
          (value, i) => i % 2 === 0 && value.toLowerCase() === name,
        ).length > 1,
    );
    const finish = async (reply: Response) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      res.end(await reply.text());
    };
    if (stopped) return finish(new Response(null, { status: 503 }));
    if (duplicate || !admissible(req.headers.host, req.headers.origin))
      return finish(new Response(null, { status: 403 }));
    let context;
    try {
      context = await monitor.enter();
    } catch {
      return finish(new Response(null, { status: 503 }));
    }
    const timeout = setTimeout(() => req.destroy(), 5000);
    try {
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 32768) {
          await finish(new Response(null, { status: 413 }));
          req.destroy();
          return;
        }
      }
      if (stopped) return finish(new Response(null, { status: 503 }));
      await finish(response(req.url ?? "", req.method ?? ""));
    } finally {
      clearTimeout(timeout);
      context.release();
    }
  };
  return Object.freeze({
    config,
    handle,
    stop: () => {
      stopped = true;
    },
    async fetch(request: Request) {
      if (stopped) return new Response(null, { status: 503 });
      const url = new URL(request.url);
      if (
        !admissible(
          request.headers.get("host") ?? url.host,
          request.headers.get("origin"),
        )
      )
        return new Response(null, { status: 403 });
      let context;
      try {
        context = await monitor.enter();
      } catch {
        return new Response(null, { status: 503 });
      }
      try {
        try {
          await boundedBody(request, 5000);
        } catch {
          return new Response(null, { status: 413 });
        }
        if (stopped) return new Response(null, { status: 503 });
        return response(url.pathname + url.search + url.hash, request.method);
      } finally {
        context.release();
      }
    },
  });
}
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("ping_discovery_timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function startPingDiscovery(
  input: unknown,
  dependencies: {
    createHTTP?: (
      handle: (req: IncomingMessage, res: ServerResponse) => void,
    ) => Server;
  } = {},
) {
  const app = createPingDiscovery(input);
  const lifetimeMs = app.config.lifetimeMs;
  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closure: Promise<void> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  const active = new Set<Promise<void>>();
  const close = () => {
    if (closure) return closure;
    app.stop();
    clearTimeout(timer);
    closure = (async () => {
      let uncertain = false;
      if (server) {
        try {
          await bounded(
            new Promise<void>((resolve, reject) => {
              server!.close((error) =>
                error &&
                (error as NodeJS.ErrnoException).code !==
                  "ERR_SERVER_NOT_RUNNING"
                  ? reject(error)
                  : resolve(),
              );
              server!.closeAllConnections();
            }),
            1000,
          );
        } catch {
          uncertain = true;
        }
      }
      try {
        await bounded(Promise.allSettled([...active]), 1000);
      } catch {
        uncertain = true;
      }
      if (uncertain) throw Error("ping_discovery_stop_uncertain");
    })();
    void closure.then(resolveClosed, () =>
      rejectClosed(Error("ping_discovery_stop_uncertain")),
    );
    return closure;
  };
  try {
    server = (
      dependencies.createHTTP ??
      ((handle) =>
        createServer(
          { requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 },
          handle,
        ))
    )((req, res) => {
      const work = app.handle(req, res).catch(() => {
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
    server.keepAliveTimeout = 1000;
    server.on("error", () => {
      void close().catch(() => {});
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(8789, "127.0.0.1", resolve);
    });
    timer = setTimeout(() => {
      void close().catch(() => {});
    }, lifetimeMs);
    return Object.freeze({ close, closed, fetch: app.fetch });
  } catch {
    try {
      await close();
    } catch {
      throw Error("ping_discovery_stop_uncertain");
    }
    throw Error("ping_discovery_start_rejected");
  }
}
