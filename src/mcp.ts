import { SecurityMonitor, type SecurityContext } from "./security.ts";
import type { PingService } from "./ping.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { EventAPI } from "./subscriptions.ts";
import type { TaskService } from "./store.ts";
import type { Principal } from "./types.ts";
import { createMCP } from "./mcp-core.ts";
import type { OAuthResource } from "./oauth.ts";
export * from "./mcp-core.ts";
export function handler(
  hub: TaskService,
  authenticate: (
    req: IncomingMessage,
  ) => Promise<Principal | null> = async () => null,
  events?: EventAPI,
  oauth?: OAuthResource,
  ping?: PingService,
  monitor = new SecurityMonitor(),
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let security: SecurityContext & { release(): void };
    try {
      security = monitor.enter();
    } catch {
      res.writeHead(503);
      res.end();
      return;
    }
    res.setHeader("X-Request-ID", security.correlation);
    res.once("finish", security.release);
    res.once("close", security.release);
    const metadata = oauth?.response(req.url ?? "/", req.method ?? "");
    if (metadata) {
      res.writeHead(metadata.status, Object.fromEntries(metadata.headers));
      res.end(await metadata.text());
      return;
    }
    let p: Principal | null = null;
    try {
      const verified = await authenticate(req);
      if (verified) p = await hub.authorization.bind(verified);
    } catch {
      /* Authentication or authoritative DB failure denies admission. */
    }
    if (!p) {
      try {
        security.record("auth_denied");
      } catch {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(
        401,
        oauth
          ? {
              "WWW-Authenticate": oauth.challenge(),
              "Cache-Control": "no-store",
            }
          : {},
      );
      res.end();
      return;
    }
    if (req.url !== (oauth?.mcpPath ?? "/mcp") || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let body: unknown;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      req.destroy();
    }, 5000);
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 32768) throw new Error("Body rejected");
        chunks.push(buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      try {
        security.record("resource_rejected");
      } catch {
        /* No unsafe logging. */
      }
      if (!res.headersSent) res.writeHead(413);
      res.end();
      return;
    } finally {
      clearTimeout(timeout);
    }
    const { toNodeHandler } = await import("@modelcontextprotocol/node");
    await toNodeHandler(
      createMcpHandler(() => createMCP(hub, p, events, ping, security)),
    )(req, res, body);
  };
}
