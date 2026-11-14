/** Explicit bounded HTTP host adapter. Construction starts no listener or credentials. */
import { WriterAdmission, WriterAdmissionError } from "./writer-admission.ts";
import type { WriterOperation } from "./writer-admission.ts";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuditSink, AuditCategory } from "../../security.ts";
import { protocolAdmission } from "../../protocol.ts";
import { createDeliveryMcpServer, deliveryMcpSchemas } from "./server.ts";
import type { DeliveryMcpGate } from "./server.ts";
import type { DeliveryContextResolver } from "./server.ts";
import type { z } from "zod";
import { McpOAuthResource, HAB_OAUTH_SCOPES } from "./oauth-resource.ts";
import type { DeliveryService } from "../../messaging/delivery-service.ts";
export interface McpHttpPolicy {
  resource_url: string;
  /** Explicit opt-in, fixed issuer discovery and tool consent metadata. */
  oauth_issuer?: string;
  allowed_origins: readonly string[];
  max_request_bytes: number;
  max_response_bytes: number;
  timeout_ms: number;
  max_active_requests: number;
  requests_per_window: number;
  window_ms: number;
}
export type McpHttpVerifier = (input: {
  authorization: string;
  resource: string;
  signal: AbortSignal;
  /** Optional: name a fixed refusal reason (`/^[a-z][a-z0-9_]{0,47}$/`) for the audit log. */
  deny?: (reason: string) => void;
}) => unknown | Promise<unknown>;
const DENY_REASON = /^[a-z][a-z0-9_]{0,47}$/;
class HttpFailure extends Error {
  readonly status: number;
  readonly category: AuditCategory;
  readonly reason: string | undefined;
  constructor(status: number, category: AuditCategory, reason?: string) {
    super("MCP HTTP rejected");
    this.status = status;
    this.category = category;
    this.reason = reason;
  }
}
function origin(value: string): URL {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)
      ))
  )
    throw Error("invalid_mcp_http_policy");
  return u;
}
export class McpHttpGateway {
  readonly #policy: Readonly<McpHttpPolicy>;
  readonly oauth: McpOAuthResource | undefined;
  get policy(): Readonly<McpHttpPolicy> {
    return this.#policy;
  }
  readonly #service: DeliveryService;
  readonly #audit: AuditSink;
  readonly #verify: McpHttpVerifier;
  readonly #admission: WriterAdmission | undefined;
  protected get writerOperations(): Readonly<Record<string, WriterOperation>> {
    return {
      hab_submit: "submit",
      hab_status: "status",
      hab_poll: "poll",
      hab_ack: "ack",
    };
  }
  /** Host-owned read catalog still uses HTTP authentication, audit and request bounds. */
  protected get readOperations(): ReadonlySet<string> {
    return new Set();
  }
  /** Host-code composition hooks; HTTP callers cannot select or register a catalog. */
  protected get toolSchemas(): Record<string, z.ZodType> {
    return deliveryMcpSchemas;
  }
  /** Trusted host may narrow admission to an already authenticated local name. */
  protected writerContext(
    context: unknown,
    _tool: string,
    _input: unknown,
  ): unknown {
    void _tool;
    void _input;
    return context;
  }
  protected createServer(
    resolve: DeliveryContextResolver,
    gate: DeliveryMcpGate,
  ) {
    return createDeliveryMcpServer(
      this.#service,
      resolve,
      gate,
      this.oauth ? HAB_OAUTH_SCOPES : undefined,
    );
  }
  #window = 0;
  #requests = 0;
  #active = 0;
  constructor(
    service: DeliveryService,
    policy: McpHttpPolicy,
    audit: AuditSink,
    verify: McpHttpVerifier = () => null,
    admission?: WriterAdmission,
  ) {
    try {
      const u = origin(policy.resource_url);
      if (
        u.href !== policy.resource_url ||
        !/^\/[A-Za-z0-9/_-]+$/.test(u.pathname) ||
        u.pathname.includes("//") ||
        !Array.isArray(policy.allowed_origins) ||
        policy.allowed_origins.some((v) => origin(v).origin !== v)
      )
        throw Error();
      for (const k of [
        "max_request_bytes",
        "max_response_bytes",
        "timeout_ms",
        "max_active_requests",
        "requests_per_window",
        "window_ms",
      ] as const)
        if (!Number.isSafeInteger(policy[k]) || policy[k] < 1) throw Error();
      if (
        policy.max_request_bytes > 16 * 1024 * 1024 ||
        policy.max_response_bytes > 32 * 1024 * 1024 ||
        policy.timeout_ms > 30000 ||
        policy.max_active_requests > 1000 ||
        policy.requests_per_window > 1000000 ||
        policy.window_ms > 3600000 ||
        typeof audit?.record !== "function" ||
        typeof verify !== "function" ||
        (admission !== undefined && !(admission instanceof WriterAdmission))
      )
        throw Error();
    } catch {
      throw Error("invalid_mcp_http_policy");
    }
    this.oauth =
      policy.oauth_issuer === undefined
        ? undefined
        : new McpOAuthResource(policy.oauth_issuer, policy.resource_url);
    this.#policy = Object.freeze({
      ...policy,
      allowed_origins: Object.freeze([...policy.allowed_origins]),
    });
    this.#service = service;
    this.#audit = audit;
    this.#verify = verify;
    this.#admission = admission;
  }
  async fetch(request: Request): Promise<Response> {
    const correlation = crypto.randomUUID(),
      start = Date.now(),
      abort = new AbortController();
    const headers = {
      "Cache-Control": "no-store",
      "X-Request-ID": correlation,
    };
    const empty = (status: number) =>
      new Response(null, {
        status,
        headers: {
          ...headers,
          ...(status === 401
            ? { "WWW-Authenticate": this.oauth?.challenge() ?? "Bearer" }
            : {}),
        },
      });
    if (start - this.#window >= this.policy.window_ms) {
      this.#window = start;
      this.#requests = 0;
    }
    this.#requests = Math.min(
      this.policy.requests_per_window + 1,
      this.#requests + 1,
    );
    if (
      this.#requests > this.policy.requests_per_window ||
      this.#active >= this.policy.max_active_requests
    ) {
      try {
        this.#audit.note?.("rate_limited");
      } catch {
        /* No raw audit failure escapes. */
      }
      void request.body?.cancel().catch(() => {});
      return empty(
        this.#requests > this.policy.requests_per_window ? 429 : 503,
      );
    }
    this.#active++;
    let closed = false;
    let pendingTools = 0,
      workFinished = false,
      released = false;
    let writerDrained: (() => void) | undefined;
    const releaseAdmission = () => {
      if (pendingTools === 0) writerDrained?.();
      if (workFinished && pendingTools === 0 && !released) {
        released = true;
        this.#active--;
      }
    };
    const check = () => {
      if (
        closed ||
        abort.signal.aborted ||
        Date.now() - start >= this.policy.timeout_ms
      )
        throw new HttpFailure(504, "resource_rejected");
    };
    const record = async (category: AuditCategory, reason?: string) => {
      check();
      await (reason === undefined
        ? this.#audit.record(category, correlation)
        : this.#audit.record(category, correlation, reason));
      check();
    };
    let cancelStatus = 504;
    let rejectDeadline: (e: HttpFailure) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const stop = (status: number) => {
      if (abort.signal.aborted) return;
      cancelStatus = status;
      try {
        this.#audit.note?.("resource_rejected");
      } catch {
        // A deadline must not wait on the failed/stalled audit path.
      }
      abort.abort();
      rejectDeadline(new HttpFailure(status, "resource_rejected"));
    };
    const onAbort = () => stop(408);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(504), this.policy.timeout_ms);
    const gate: DeliveryMcpGate = {
      check,
      begin: async () => {
        pendingTools++;
        try {
          await record("tool_started");
        } catch (error) {
          pendingTools--;
          releaseAdmission();
          throw error;
        }
        let finished = false;
        return async (success, reason) => {
          if (finished) return;
          finished = true;
          try {
            await (success
              ? record("tool_succeeded")
              : record("tool_error", reason));
          } finally {
            pendingTools--;
            releaseAdmission();
          }
        };
      },
    };
    const work = (async () => {
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      try {
        if (request.signal.aborted) stop(408);
        check();
        this.#audit.check?.();
        await record("request");
        const u = new URL(request.url),
          resource = new URL(this.policy.resource_url);
        if (
          u.origin !== resource.origin ||
          (request.headers.has("host") &&
            request.headers.get("host")?.toLowerCase() !== resource.host)
        )
          throw new HttpFailure(403, "access_denied");
        const requestedOrigin = request.headers.get("origin");
        if (
          requestedOrigin !== null &&
          !this.policy.allowed_origins.includes(requestedOrigin)
        )
          throw new HttpFailure(403, "access_denied");
        if (
          this.oauth &&
          u.pathname === this.oauth.metadataPath &&
          !u.search &&
          !u.hash
        ) {
          const metadata = this.oauth.response(u.pathname, request.method);
          if (metadata) return metadata;
        }
        if (u.href !== resource.href || request.method !== "POST")
          throw new HttpFailure(405, "resource_rejected");
        const authorization = request.headers.get("authorization");
        if (!authorization)
          throw new HttpFailure(401, "auth_denied", "bearer_missing");
        if (
          authorization.length > 8192 ||
          !/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(authorization)
        )
          throw new HttpFailure(401, "auth_denied", "bearer_malformed");
        let context: unknown;
        let denied: string | undefined;
        try {
          context = await this.#verify({
            authorization,
            resource: this.policy.resource_url,
            signal: abort.signal,
            deny: (reason) => {
              if (denied === undefined && DENY_REASON.test(reason))
                denied = reason;
            },
          });
        } catch {
          check();
          throw new HttpFailure(401, "auth_denied", "verifier_failed");
        }
        check();
        if (context === null || context === undefined || context === false)
          throw new HttpFailure(
            401,
            "auth_denied",
            denied ?? "credential_rejected",
          );
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") ?? "",
          ) ||
          (request.headers.has("content-encoding") &&
            request.headers.get("content-encoding") !== "identity")
        )
          throw new HttpFailure(415, "resource_rejected");
        const length = request.headers.get("content-length");
        if (
          length !== null &&
          (!/^(0|[1-9][0-9]*)$/.test(length) ||
            Number(length) > this.policy.max_request_bytes)
        )
          throw new HttpFailure(413, "resource_rejected");
        const bytes = await read(
          request.body,
          this.policy.max_request_bytes,
          abort.signal,
          check,
          413,
        );
        if (length !== null && Number(length) !== bytes.byteLength)
          throw new HttpFailure(400, "transport_error");
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          throw new HttpFailure(400, "transport_error");
        }
        check();
        if (
          !(await protocolAdmission(
            parsed,
            request.headers.get("mcp-method") ?? undefined,
            this.toolSchemas,
            {
              correlation,
              record,
              beginTool: async () => {
                const finish = await gate.begin();
                return (outcome) => finish(outcome === "tool_succeeded");
              },
            },
          ))
        )
          throw new HttpFailure(405, "resource_rejected");
        const envelope = parsed as Record<string, unknown>;
        const params = (
          envelope.jsonrpc === "2.0" ? envelope.params : envelope
        ) as Record<string, unknown> | undefined;
        if (
          request.headers.has("mcp-name") &&
          request.headers.get("mcp-name") !== params?.name
        )
          throw new HttpFailure(400, "transport_error");
        check();
        const dispatch = async () => {
          check();
          try {
            handler = createMcpHandler(() =>
              this.createServer(() => {
                check();
                return context;
              }, gate),
            );
            // Forward only MCP framing, never cookies, credentials, host audit IDs or forwarded identities.
            const safeHeaders = new Headers();
            for (const name of [
              "content-type",
              "accept",
              "mcp-method",
              "mcp-name",
              "mcp-protocol-version",
            ])
              if (request.headers.has(name))
                safeHeaders.set(name, request.headers.get(name)!);
            const sdk = await handler.fetch(
              new Request(this.policy.resource_url, {
                method: "POST",
                headers: safeHeaders,
                body: bytes,
                signal: abort.signal,
              }),
            );
            check();
            const result = await read(
              sdk.body,
              this.policy.max_response_bytes,
              abort.signal,
              check,
              503,
            );
            check();
            const responseHeaders = new Headers(headers);
            if (sdk.headers.has("content-type"))
              responseHeaders.set(
                "Content-Type",
                sdk.headers.get("content-type")!,
              );
            if (sdk.status >= 400) await record("transport_error");
            return new Response(result.byteLength ? result : null, {
              status: sdk.status,
              headers: responseHeaders,
            });
          } finally {
            if (this.#admission) {
              const current = handler;
              handler = undefined;
              try {
                await current?.close();
              } finally {
                if (pendingTools > 0)
                  await new Promise<void>((resolve) => {
                    writerDrained = resolve;
                  });
              }
            }
          }
        };
        const method = request.headers.get("mcp-method") ?? envelope.method;
        if (
          this.#admission &&
          method === "tools/call" &&
          !(
            typeof params?.name === "string" &&
            this.readOperations.has(params.name)
          )
        ) {
          const name = params?.name;
          const operation =
            typeof name === "string" &&
            Object.hasOwn(this.toolSchemas, name) &&
            Object.hasOwn(this.writerOperations, name)
              ? this.writerOperations[name]
              : undefined;
          if (!operation) throw new HttpFailure(405, "resource_rejected");
          return await this.#admission.run(
            this.writerContext(context, String(name), params?.arguments ?? {}),
            operation,
            abort.signal,
            dispatch,
          );
        }
        return await dispatch();
      } catch (error) {
        if (abort.signal.aborted) return empty(cancelStatus);
        const failure =
          error instanceof HttpFailure
            ? error
            : error instanceof WriterAdmissionError
              ? new HttpFailure(
                  error.code === "writer_forbidden"
                    ? 403
                    : error.code === "writer_rate_limited"
                      ? 429
                      : 503,
                  error.code === "writer_forbidden"
                    ? "access_denied"
                    : error.code === "writer_rate_limited"
                      ? "rate_limited"
                      : "resource_rejected",
                )
              : new HttpFailure(503, "transport_error");
        try {
          await record(failure.category, failure.reason);
        } catch {
          return empty(503);
        }
        return empty(failure.status);
      } finally {
        if (!request.bodyUsed) void request.body?.cancel().catch(() => {});
        await handler?.close();
      }
    })();
    // Keep admission until even a cancellation-ignoring provider settles. Late results cannot dispatch tools.
    const settled = work.finally(() => {
      closed = true;
      workFinished = true;
      releaseAdmission();
    });
    void settled.catch(() => {});
    try {
      return await Promise.race([settled, deadline]);
    } catch (error) {
      return empty(error instanceof HttpFailure ? error.status : 503);
    } finally {
      closed = true;
      abort.abort();
      if (!request.bodyUsed) void request.body?.cancel().catch(() => {});
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }
}
async function read(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  check: () => void,
  overflow: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  // Bound memory independently of chunk count (including zero-byte chunks).
  let buffer = new Uint8Array(Math.min(limit, 8192));
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    check();
    for (;;) {
      const item = await reader.read();
      check();
      if (item.done) break;
      const end = bytes + item.value.byteLength;
      if (end > limit) throw new HttpFailure(overflow, "resource_rejected");
      if (end > buffer.length) {
        const grown = new Uint8Array(
          Math.min(limit, Math.max(end, buffer.length * 2)),
        );
        grown.set(buffer);
        buffer = grown;
      }
      buffer.set(item.value, bytes);
      bytes = end;
    }
    return buffer.slice(0, bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
