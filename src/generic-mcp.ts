import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GenericTextJobs, TextJobError } from "./generic-jobs.ts";
import { textInputSchema, textListSchema } from "./text-task.ts";

const requestLimit = 262144;
const responseLimit = 524288;
const metadata = z.record(z.string(), z.unknown()).optional();
const empty = z.strictObject({ _meta: metadata });
const schemas = {
  text_submit: textInputSchema,
  text_get: z.strictObject({ id: z.string().uuid() }),
  text_list: textListSchema,
  text_cancel: z.strictObject({ id: z.string().uuid() }),
};
const methods = {
  initialize: z.strictObject({
    protocolVersion: z.string().min(1).max(100),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z
      .object({ name: z.string(), version: z.string() })
      .passthrough(),
    _meta: metadata,
  }),
  "notifications/initialized": empty,
  "server/discover": empty,
  ping: empty,
  "tools/list": empty,
  "tools/call": z.strictObject({
    name: z.enum(["text_submit", "text_get", "text_list", "text_cancel"]),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: metadata,
  }),
};
const methodNames = [
  "initialize",
  "notifications/initialized",
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
] as const;
const envelope = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite()]).optional(),
  method: z.enum(methodNames),
  params: z.unknown().optional(),
});
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let rejectRead: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const abort = () => rejectRead(Error("body_aborted"));
  const timer = setTimeout(() => rejectRead(Error("body_timeout")), 10000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      length += value.length;
      if (length > limit) throw Error("body_limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
const rejected = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export function createGenericTextMCPHTTP(options: {
  endpoint: string;
  jobs: GenericTextJobs<Request>;
}): {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
} {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/mcp" ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error("invalid_generic_mcp_endpoint");
  let closed = false;
  const active = new Set<Promise<Response>>();
  const exchange = async (request: Request): Promise<Response> => {
    const target = new URL(request.url);
    if (
      target.href !== endpoint.href ||
      request.headers.get("host") !== endpoint.host ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== endpoint.origin)
    )
      return rejected(403);
    if (request.method !== "POST") return rejected(405);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return rejected(415);
    if (request.headers.has("mcp-session-id")) return rejected(400);
    let capabilities: Awaited<
      ReturnType<GenericTextJobs<Request>["capabilities"]>
    >;
    try {
      capabilities = await options.jobs.capabilities(request);
    } catch {
      return rejected(401);
    }
    if (!Object.values(capabilities).some(Boolean)) return rejected(401);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(request.body, requestLimit, request.signal);
    } catch {
      return rejected(413);
    }
    let message: z.infer<typeof envelope>;
    try {
      message = envelope.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      methods[message.method].parse(message.params ?? {});
      if (
        (message.method === "notifications/initialized") !==
        (message.id === undefined)
      )
        return rejected(400);
      if (message.method === "tools/call") {
        const call = methods["tools/call"].parse(message.params);
        schemas[call.name].parse(call.arguments ?? {});
        const nameHeader = request.headers.get("mcp-name");
        if (nameHeader !== null && nameHeader !== call.name)
          return rejected(400);
      }
      const methodHeader = request.headers.get("mcp-method");
      if (methodHeader !== null && methodHeader !== message.method)
        return rejected(400);
    } catch {
      return rejected(400);
    }
    if (message.method === "tools/call") {
      const call = methods["tools/call"].parse(message.params);
      const operation = call.name.slice(5) as
        "submit" | "get" | "list" | "cancel";
      if (!capabilities[operation])
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: "forbidden",
                    message: "Operation rejected",
                  }),
                },
              ],
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
    }
    const servers: McpServer[] = [];
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({
          name: "hab-generic-text",
          version: "1.0.0",
        });
        servers.push(server);
        server.server.registerCapabilities({ tools: { listChanged: false } });
        for (const [name, schema] of Object.entries(schemas)) {
          const operation = name.slice(5) as
            "submit" | "get" | "list" | "cancel";
          if (!capabilities[operation]) continue;
          server.registerTool(
            name,
            {
              description: `Generic asynchronous text job ${operation}`,
              inputSchema: schema,
            },
            async (args: unknown) => {
              try {
                const value =
                  operation === "submit"
                    ? await options.jobs.submit(request, args)
                    : operation === "list"
                      ? await options.jobs.list(
                          request,
                          schemas.text_list.parse(args),
                        )
                      : await options.jobs[operation](
                          request,
                          schemas.text_get.parse(args),
                        );
                return {
                  content: [
                    { type: "text" as const, text: JSON.stringify(value) },
                  ],
                };
              } catch (error) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        error:
                          error instanceof TextJobError
                            ? error.code
                            : "unavailable",
                        message: "Operation rejected",
                      }),
                    },
                  ],
                };
              }
            },
          );
        }
        return server;
      },
      { maxRequestBodySize: requestLimit, keepAliveMs: 0 },
    );
    try {
      const response = await handler.fetch(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: new Uint8Array(bytes).buffer,
        }),
      );
      const body = await readBounded(
        response.body,
        responseLimit,
        request.signal,
      );
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.delete("content-length");
      return new Response(body.length ? body : null, {
        status: response.status,
        headers,
      });
    } catch {
      return rejected(503);
    } finally {
      await Promise.allSettled([
        handler.close(),
        ...servers.map((server) => server.close()),
      ]);
    }
  };
  return {
    fetch(request) {
      if (closed) return Promise.resolve(rejected(503));
      const pending = exchange(request);
      active.add(pending);
      void pending.finally(() => active.delete(pending)).catch(() => {});
      return pending;
    },
    async close() {
      closed = true;
      await Promise.allSettled(active);
    },
  };
}
