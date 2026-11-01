import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function createA2aNodeHandler(
  endpoint: string,
  gateway: (request: Request) => Promise<Response>,
) {
  const origin = new URL(endpoint).origin;
  const host = new URL(endpoint).host;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const timer = setTimeout(() => {
      response.destroy();
      request.destroy();
    }, 10000);
    response.once("close", () => clearTimeout(timer));
    response.once("finish", () => request.destroy());
    try {
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i].toLowerCase();
        if (seen.has(name)) throw Error("Duplicate header");
        seen.add(name);
      }
      if (
        request.headers.host !== host ||
        !request.url?.startsWith("/") ||
        request.url.startsWith("//")
      ) {
        response.writeHead(403).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) throw Error("Duplicate header");
        if (value !== undefined) headers.set(name, value);
      }
      const result = await gateway(
        new Request(origin + request.url, {
          method: request.method,
          headers,
          ...(request.method !== "GET" && request.method !== "HEAD"
            ? {
                body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
                duplex: "half",
              }
            : {}),
        }),
      );
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        Connection: "close",
      });
      response.end(new Uint8Array(await result.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  };
}
