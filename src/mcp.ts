import {
  guardedResponse,
  SecurityMonitor,
  type SecurityContext,
} from "./security.ts";
import type { PingService } from "./ping.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventAPI } from "./subscriptions.ts";
import type { TaskService } from "./store.ts";
import type { Principal } from "./types.ts";
import { fetchMCP } from "./mcp-core.ts";
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
  limits = { bodyMs: 5000, responseMs: 30000 },
) {
  if (
    !Number.isSafeInteger(limits.bodyMs) ||
    limits.bodyMs < 1 ||
    limits.bodyMs > 5000 ||
    !Number.isSafeInteger(limits.responseMs) ||
    limits.responseMs < 1 ||
    limits.responseMs > 30000
  )
    throw new Error("Invalid limit");
  return async (req: IncomingMessage, res: ServerResponse) => {
    let security: SecurityContext & { release(): void };
    try {
      security = await monitor.enter((release) => {
        res.once("finish", release);
        res.once("close", release);
        if (res.destroyed || req.aborted) release();
      });
    } catch {
      if (!res.destroyed) {
        res.writeHead(503);
        res.end();
      }
      return;
    }
    if (res.destroyed || req.aborted) {
      security.release();
      return;
    }
    res.setHeader("X-Request-ID", security.correlation);
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
        await security.record("auth_denied");
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
    }, limits.bodyMs);
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
        await security.record(
          bytes > 32768 ? "resource_rejected" : "transport_error",
        );
      } catch {
        /* No unsafe logging. */
      }
      if (!res.headersSent) res.writeHead(413);
      res.end();
      return;
    } finally {
      clearTimeout(timeout);
    }
    const headers = new Headers();
    for (const name of [
      "content-type",
      "accept",
      "mcp-method",
      "mcp-name",
      "mcp-protocol-version",
    ]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    try {
      const response = await fetchMCP(
        hub,
        new Request(oauth?.resource ?? "http://mcp.internal/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        async () => p,
        events,
        oauth,
        ping,
        security,
        limits.responseMs,
      );
      const bounded = guardedResponse(response, security, limits.responseMs);
      const bytes = await bounded.arrayBuffer();
      res.writeHead(bounded.status, Object.fromEntries(bounded.headers));
      res.setTimeout(5000, () => res.destroy());
      res.end(Buffer.from(bytes));
    } catch {
      try {
        await security.record("transport_error");
      } catch {
        /* Admission stays closed. */
      }
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  };
}
