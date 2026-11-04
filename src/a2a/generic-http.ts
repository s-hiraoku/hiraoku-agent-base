import { z } from "zod";
import { AgentCard, Extensions } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  ExtendedAgentCardNotConfiguredError,
  ExtensionSupportRequiredError,
  PushNotificationNotSupportedError,
  UnsupportedOperationError,
  toJsonRpcError,
} from "@a2a-js/sdk/errors";
import { GENERIC_TEXT_PROFILE, type GenericTextJobs } from "../generic-jobs.ts";
import { boundedText } from "../text-task.ts";
import {
  GenericTextA2aHandler,
  genericTextAgentCard,
} from "./generic-handler.ts";
export { genericTextAgentCard } from "./generic-handler.ts";

const identifier = z.string().min(1).max(200);
const envelope = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().min(1).max(128), z.number().int().safe()]),
  method: z.string().min(1).max(100),
  params: z.unknown(),
});
const send = z.strictObject({
  message: z.strictObject({
    messageId: identifier,
    contextId: identifier,
    role: z.literal("ROLE_USER"),
    parts: z.tuple([
      z.strictObject({
        text: boundedText,
        mediaType: z.literal("text/plain").optional(),
      }),
    ]),
  }),
  configuration: z.strictObject({
    returnImmediately: z.literal(true),
    acceptedOutputModes: z.tuple([z.literal("text/plain")]).optional(),
    historyLength: z.literal(0).optional(),
  }),
  metadata: z.strictObject({
    [GENERIC_TEXT_PROFILE]: z.strictObject({
      version: z.literal(1),
      workDeadline: z.number().int().nonnegative().safe(),
    }),
  }),
});
const get = z.strictObject({
  id: identifier,
  historyLength: z.literal(0).optional(),
});
const cancel = z.strictObject({ id: identifier });
const list = z.strictObject({
  pageSize: z.number().int().min(1).max(20).optional(),
  pageToken: z.string().min(1).max(2048).optional(),
  contextId: identifier.optional(),
  includeArtifacts: z.literal(false).optional(),
  historyLength: z.literal(0).optional(),
});
const requestLimit = 256 * 1024,
  responseLimit = 512 * 1024;

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("request_timeout")), 10_000);
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      size += item.value.length;
      if (size > requestLimit) throw new Error("request_too_large");
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function createGenericTextA2aGateway(options: {
  endpoint: string;
  jobs: GenericTextJobs<Request>;
}): (request: Request) => Promise<Response> {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/a2a" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("Generic A2A requires an explicit loopback /a2a endpoint");
  const card = genericTextAgentCard(endpoint.href);
  const requests = new WeakMap<ServerCallContext, Request>();
  const transport = new JsonRpcTransportHandler(
    new GenericTextA2aHandler(card, options.jobs, (context) => {
      const request = requests.get(context);
      if (!request) throw new Error("Text job service unavailable");
      return request;
    }),
  );
  const reply = (status: number, value: unknown, activated = false) => {
    const body = JSON.stringify(value);
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "A2A-Version": "1.0",
      ...(activated ? { "A2A-Extensions": GENERIC_TEXT_PROFILE } : {}),
    };
    const withinLimit = new TextEncoder().encode(body).length <= responseLimit;
    return new Response(withinLimit ? body : '{"error":"response_too_large"}', {
      status: withinLimit ? status : 503,
      headers,
    });
  };
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== endpoint.origin || request.headers.has("origin"))
      return reply(403, { error: "origin_denied" });
    if (url.search || url.hash) return reply(400, { error: "invalid_route" });
    if (
      url.pathname !== endpoint.pathname &&
      url.pathname !== "/.well-known/agent-card.json"
    )
      return reply(404, { error: "not_found" });
    try {
      const capabilities = await options.jobs.capabilities(request);
      if (!Object.values(capabilities).some(Boolean))
        return reply(401, { error: "unauthorized" });
    } catch {
      return reply(401, { error: "unauthorized" });
    }
    if (
      url.pathname === "/.well-known/agent-card.json" &&
      request.method === "GET"
    )
      return reply(200, AgentCard.toJSON(card));
    if (url.pathname !== endpoint.pathname || request.method !== "POST")
      return reply(405, { error: "method_not_allowed" });
    if (request.headers.get("a2a-version") !== "1.0")
      return reply(400, { error: "a2a_version_required" });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      return reply(415, { error: "content_type_not_supported" });
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(JSON.parse(await readBody(request)));
    } catch (error) {
      const code =
        error instanceof Error &&
        ["request_too_large", "request_timeout"].includes(error.message)
          ? error.message
          : "invalid_request";
      return reply(
        code === "request_too_large"
          ? 413
          : code === "request_timeout"
            ? 408
            : 400,
        { error: code },
      );
    }
    const fail = (error: unknown) =>
      reply(200, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: toJsonRpcError(error),
      });
    const extensions = Extensions.parseServiceParameter(
      request.headers.get("a2a-extensions") ?? undefined,
    );
    if (extensions.length !== 1 || extensions[0] !== GENERIC_TEXT_PROFILE)
      return fail(
        new ExtensionSupportRequiredError(
          "Required text profile extension missing or unsupported",
        ),
      );
    if (["SendStreamingMessage", "SubscribeToTask"].includes(parsed.method))
      return fail(
        new UnsupportedOperationError(
          "Streaming and subscriptions unsupported",
        ),
      );
    if (
      [
        "CreateTaskPushNotificationConfig",
        "GetTaskPushNotificationConfig",
        "ListTaskPushNotificationConfigs",
        "DeleteTaskPushNotificationConfig",
      ].includes(parsed.method)
    )
      return fail(
        new PushNotificationNotSupportedError("Push notifications unsupported"),
      );
    if (parsed.method === "GetExtendedAgentCard")
      return fail(
        new ExtendedAgentCardNotConfiguredError("Extended card unsupported"),
      );
    if (
      parsed.method === "ListTasks" &&
      typeof parsed.params === "object" &&
      parsed.params !== null &&
      "includeArtifacts" in parsed.params &&
      parsed.params.includeArtifacts === true
    )
      return fail(
        new UnsupportedOperationError(
          "List artifacts unsupported; use GetTask",
        ),
      );
    const schema =
      parsed.method === "SendMessage"
        ? send
        : parsed.method === "GetTask"
          ? get
          : parsed.method === "ListTasks"
            ? list
            : parsed.method === "CancelTask"
              ? cancel
              : undefined;
    if (!schema)
      return reply(200, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      });
    const params = schema.safeParse(parsed.params);
    if (!params.success)
      return reply(200, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32602, message: "Invalid text profile parameters" },
      });
    const context = new ServerCallContext({
      requestedVersion: "1.0",
      requestedExtensions: extensions,
      user: { isAuthenticated: true, userName: "authenticated-text-caller" },
    });
    context.addActivatedExtension(GENERIC_TEXT_PROFILE);
    requests.set(context, request);
    try {
      const result = await transport.handle(
        { ...parsed, params: params.data },
        context,
      );
      if (Symbol.asyncIterator in result)
        return fail(new UnsupportedOperationError("Streaming unsupported"));
      return reply(200, result, true);
    } catch {
      return reply(503, { error: "text_job_service_unavailable" });
    } finally {
      requests.delete(context);
    }
  };
}
