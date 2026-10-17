/** Explicit bounded HTTP host adapter. Construction starts no listener or credentials. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuditSink, AuditCategory } from "../security.ts";
import { protocolAdmission } from "../protocol.ts";
import { createRelayMcpServer, relayMcpSchemas } from "./mcp.ts";
import type { RelayMcpGate } from "./mcp.ts";
import type { RelayContextResolver } from "./mcp.ts";
import type { z } from "zod";
import type { RelayOperations } from "./service.ts";
export interface RelayHttpPolicy {
  resource_url: string;
  allowed_origins: readonly string[];
  max_request_bytes: number;
  max_response_bytes: number;
  timeout_ms: number;
  max_active_requests: number;
  requests_per_window: number;
  window_ms: number;
}
export type RelayHttpVerifier = (input: {
  authorization: string;
  resource: string;
  signal: AbortSignal;
}) => unknown | Promise<unknown>;
class HttpFailure extends Error {
  readonly status: number;
  readonly category: AuditCategory;
  constructor(status: number, category: AuditCategory) {
    super("Relay HTTP rejected");
    this.status = status;
    this.category = category;
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
    throw Error("invalid_relay_http_policy");
  return u;
}
export class RelayHttpGateway {
  readonly #policy: Readonly<RelayHttpPolicy>;
  get policy(): Readonly<RelayHttpPolicy> {
    return this.#policy;
  }
  readonly #service: RelayOperations;
  readonly #audit: AuditSink;
  readonly #verify: RelayHttpVerifier;
  /** Host-code composition hooks; HTTP callers cannot select or register a catalog. */
  protected get toolSchemas(): Record<string, z.ZodType> {
    return relayMcpSchemas;
  }
  protected createServer(resolve: RelayContextResolver, gate: RelayMcpGate) {
    return createRelayMcpServer(this.#service, resolve, gate);
  }
  #window = 0;
  #requests = 0;
  #active = 0;
  constructor(
    service: RelayOperations,
    policy: RelayHttpPolicy,
    audit: AuditSink,
    verify: RelayHttpVerifier = () => null,
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
        typeof verify !== "function"
      )
        throw Error();
    } catch {
      throw Error("invalid_relay_http_policy");
    }
    this.#policy = Object.freeze({
      ...policy,
      allowed_origins: Object.freeze([...policy.allowed_origins]),
    });
    this.#service = service;
    this.#audit = audit;
    this.#verify = verify;
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
          ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
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
    const releaseAdmission = () => {
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
    const record = async (category: AuditCategory) => {
      check();
      await this.#audit.record(category, correlation);
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
    const gate: RelayMcpGate = {
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
        return async (success) => {
          if (finished) return;
          finished = true;
          try {
            await record(success ? "tool_succeeded" : "tool_error");
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
        if (u.href !== resource.href || request.method !== "POST")
          throw new HttpFailure(405, "resource_rejected");
        const authorization = request.headers.get("authorization");
        if (
          !authorization ||
          authorization.length > 8192 ||
          !/^Bearer [A-Za-z0-9._~+\/-]+=*$/i.test(authorization)
        )
          throw new HttpFailure(401, "auth_denied");
        let context: unknown;
        try {
          context = await this.#verify({
            authorization,
            resource: this.policy.resource_url,
            signal: abort.signal,
          });
        } catch {
          check();
          throw new HttpFailure(401, "auth_denied");
        }
        check();
        if (context === null || context === undefined || context === false)
          throw new HttpFailure(401, "auth_denied");
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
          responseHeaders.set("Content-Type", sdk.headers.get("content-type")!);
        if (sdk.status >= 400) await record("transport_error");
        return new Response(result.byteLength ? result : null, {
          status: sdk.status,
          headers: responseHeaders,
        });
      } catch (error) {
        if (abort.signal.aborted) return empty(cancelStatus);
        const failure =
          error instanceof HttpFailure
            ? error
            : new HttpFailure(503, "transport_error");
        try {
          await record(failure.category);
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
