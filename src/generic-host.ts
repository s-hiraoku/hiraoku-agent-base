import type { IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { GenericTextJobs } from "./generic-jobs.ts";
import { createGenericTextMCPHTTP } from "./generic-mcp.ts";
import { createGenericTextA2aGateway } from "./a2a/generic-http.ts";
import { createA2aNodeHandler } from "./a2a/http-node.ts";

export function createGenericTextHost(options: {
  baseUrl: string;
  jobs: GenericTextJobs<Request>;
}) {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw Error("invalid_generic_host_endpoint");
  const a2aEndpoint = new URL("/a2a", base).href;
  const a2a = createA2aNodeHandler(
    a2aEndpoint,
    createGenericTextA2aGateway({
      endpoint: a2aEndpoint,
      jobs: options.jobs,
    }),
  );
  const mcp = createGenericTextMCPHTTP({
    endpoint: new URL("/mcp", base).href,
    jobs: options.jobs,
  });
  const mcpNode = toNodeHandler(mcp, { maxRequestBodySize: 262144 });
  let closed = false;
  return {
    async handler(request: IncomingMessage, response: ServerResponse) {
      const reject = (status: number) => {
        response.writeHead(status, { "Cache-Control": "no-store" });
        response.end();
      };
      if (closed) return reject(503);
      const seen = new Set<string>();
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index].toLowerCase();
        if (seen.has(name)) return reject(400);
        seen.add(name);
      }
      if (
        request.headers.host !== base.host ||
        request.headers.origin !== undefined
      )
        return reject(403);
      const timer = setTimeout(() => {
        request.destroy();
        response.destroy();
      }, 12000);
      const clear = () => clearTimeout(timer);
      response.once("close", clear);
      response.once("finish", clear);
      try {
        if (
          request.url === "/a2a" ||
          request.url === "/.well-known/agent-card.json"
        )
          await a2a(request, response);
        else if (request.url === "/mcp") await mcpNode(request, response);
        else reject(404);
      } catch {
        if (!response.headersSent) reject(503);
        else response.destroy();
      }
    },
    async close() {
      closed = true;
      await mcp.close();
    },
  };
}
