import { z } from "zod";
import { AgentCard } from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { HabA2aHandler } from "./hab-adapter.ts";
import type { HabA2aRoute } from "./hab-contract.ts";

const rpc = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number().int()]),
  method: z.enum(["SendMessage", "GetTask", "ListTasks", "CancelTask"]),
  params: z.unknown(),
});
const send = z.strictObject({
  message: z.strictObject({
    messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    role: z.literal("ROLE_USER"),
    parts: z.tuple([
      z.strictObject({
        text: z.string().min(1).max(4096),
        mediaType: z.literal("text/plain").optional(),
      }),
    ]),
  }),
  configuration: z
    .strictObject({
      returnImmediately: z.boolean().optional(),
      acceptedOutputModes: z.array(z.literal("text/plain")).max(1).optional(),
      historyLength: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
});
const get = z.strictObject({
  id: z.string().uuid(),
  historyLength: z.number().int().min(0).max(100).optional(),
});
const list = z.strictObject({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().max(2048).optional(),
  contextId: z.string().uuid().optional(),
  includeArtifacts: z.boolean().optional(),
  historyLength: z.number().int().min(0).max(100).optional(),
});
export function createHabA2aGateway(options: {
  endpoint: string;
  card: AgentCard;
  store: TaskStore;
  authorize: (
    request: Request,
  ) => HabA2aRoute | undefined | Promise<HabA2aRoute | undefined>;
}) {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/a2a" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw Error("HAB A2A preview requires an explicit loopback /a2a endpoint");
  const routes = new WeakMap<ServerCallContext, HabA2aRoute>();
  const handler = new HabA2aHandler(options.card, options.store, (context) => {
    const route = routes.get(context);
    if (!route) throw Error("HAB authorization missing");
    return route;
  });
  const transport = new JsonRpcTransportHandler(handler);
  const reply = (status: number, body: unknown) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "A2A-Version": "1.0" },
    });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== endpoint.origin || request.headers.has("origin"))
      return reply(403, { error: "origin_denied" });
    let route: HabA2aRoute | undefined;
    try {
      route = await options.authorize(request);
      route?.assertCurrent();
    } catch {
      return reply(403, { error: "forbidden" });
    }
    if (!route) return reply(401, { error: "unauthorized" });
    if (
      url.pathname === "/.well-known/agent-card.json" &&
      request.method === "GET" &&
      !url.search
    ) {
      route.assertCurrent();
      return reply(200, AgentCard.toJSON(options.card));
    }
    if (url.href !== endpoint.href || request.method !== "POST")
      return reply(405, { error: "method_not_allowed" });
    if (request.headers.get("a2a-version") !== "1.0")
      return reply(400, { error: "a2a_version_required" });
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      return reply(415, { error: "content_type_not_supported" });
    const reader = request.body?.getReader();
    if (!reader) return reply(400, { error: "empty_request" });
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > 16384) return reply(413, { error: "request_too_large" });
        chunks.push(item.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      const parsed = rpc.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      const params =
        parsed.method === "SendMessage"
          ? send.parse(parsed.params)
          : parsed.method === "ListTasks"
            ? list.parse(parsed.params)
            : get.parse(parsed.params);
      route.assertCurrent();
      const context = new ServerCallContext({
        requestedVersion: "1.0",
        tenant: `hab-a2a:${route.recipientId}`,
        user: { isAuthenticated: true, userName: route.ownerId },
      });
      routes.set(context, route);
      const result = await transport.handle({ ...parsed, params }, context);
      route.assertCurrent();
      if (Symbol.asyncIterator in result)
        return reply(400, { error: "streaming_unsupported" });
      return reply(200, result);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "forbidden"
      )
        return reply(403, { error: "forbidden" });
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      )
        return reply(400, { error: "invalid_request" });
      return reply(503, { error: "hab_unavailable" });
    } finally {
      reader.releaseLock();
    }
  };
}
