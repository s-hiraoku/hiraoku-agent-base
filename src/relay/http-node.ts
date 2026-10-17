/** Node callback only: the host owns listener/headers/socket policy and explicit activation. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { RelayHttpGateway } from "./http.ts";
const forwarded = [
  "host",
  "origin",
  "authorization",
  "content-type",
  "content-length",
  "content-encoding",
  "accept",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
];
export function createRelayNodeHandler(gateway: RelayHttpGateway) {
  let active = 0;
  const resource = new URL(gateway.policy.resource_url);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reject = (status: number) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end();
    };
    if (active >= gateway.policy.max_active_requests) {
      reject(503);
      return;
    }
    active++;
    const abort = new AbortController();
    let released = false;
    let closeInput: (() => void) | undefined;
    const timer = setTimeout(() => {
      abort.abort();
      reject(504);
    }, gateway.policy.timeout_ms);
    const release = () => {
      if (released) return;
      released = true;
      active--;
      clearTimeout(timer);
      abort.abort();
      req.removeListener("aborted", disconnected);
      res.removeListener("finish", release);
      res.removeListener("close", release);
      closeInput?.();
      if (!req.complete) req.destroy();
    };
    const disconnected = () => {
      abort.abort();
    };
    req.once("aborted", disconnected);
    res.once("finish", release);
    res.once("close", release);
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
        reject(400);
        return;
      }
      if (req.url !== resource.pathname) {
        // Check the raw target before URL normalization can hide a path alias.
        reject(405);
        return;
      }
      const seen = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (!forwarded.includes(name)) continue;
        if (seen.has(name)) {
          reject(400);
          return;
        }
        seen.add(name);
      }
      const headers = new Headers();
      for (const name of forwarded) {
        const value = req.headers[name];
        if (Array.isArray(value)) {
          reject(400);
          return;
        }
        if (value !== undefined) headers.set(name, value);
      }
      if (headers.get("host")?.toLowerCase() !== resource.host) {
        reject(403);
        return;
      }
      if (req.aborted || res.destroyed) {
        abort.abort();
        return;
      }
      const url = new URL(req.url, resource);
      let input: ReadableStream<Uint8Array> | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const reader = (
          Readable.toWeb(req) as ReadableStream<Uint8Array>
        ).getReader();
        let stopped = false;
        closeInput = () => {
          stopped = true;
          void reader.cancel().catch(() => {});
        };
        input = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const item = await reader.read();
                if (stopped) return;
                if (item.done) controller.close();
                else controller.enqueue(item.value);
              } catch {
                if (!stopped) controller.error(Error("Relay input closed"));
              }
            },
            // Cancelling an unread IncomingMessage destroys its socket. Defer that
            // until the refusal response has flushed, so 401/413 remain deliverable.
            cancel() {
              stopped = true;
            },
          },
          { highWaterMark: 0 },
        );
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        signal: abort.signal,
        ...(input ? { body: input, duplex: "half" } : {}),
      } as RequestInit & { duplex?: "half" });
      const response = await gateway.fetch(request);
      if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
      const body = new Uint8Array(await response.arrayBuffer());
      if (abort.signal.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        Connection: "close",
      });
      res.end(body);
    } catch {
      reject(503);
    }
    // Network admission is held until finish/close, including a blocked response write.
  };
}
