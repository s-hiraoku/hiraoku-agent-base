import {
  guardedResponse,
  SecurityMonitor,
  type AuditSink,
} from "./security.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ApprovedSubjects, Auth0Verifier, OAuthResource } from "./oauth.ts";
import { handler, fetchMCP } from "./mcp.ts";
import { PingService } from "./ping.ts";
import type { TaskService } from "./store.ts";

const identity = z
  .object({ subject: z.string(), clientId: z.string() })
  .strict();
const settings = z
  .object({
    version: z.literal(1),
    mode: z.literal("auth0"),
    enabled: z.boolean(),
    oauth: z
      .object({
        issuer: z.string(),
        resource: z.string(),
        scopes: z.array(z.string()).min(1).max(8),
      })
      .strict(),
    subjects: z.array(z.unknown()).min(1).max(100),
    ping: z.object({ dots: identity, grok: identity }).strict().optional(),
  })
  .strict();

/** Pure composition. No listeners, token acquisition, callbacks, workers or model calls. */
export function createRuntime(
  hub: TaskService,
  input?: unknown,
  dependencies: {
    fetch?: typeof fetch;
    now?: () => number;
    audit?: AuditSink;
  } = {},
) {
  let oauth: OAuthResource | undefined;
  let verifier: Auth0Verifier | undefined;
  let ping: PingService | undefined;
  try {
    if (input !== undefined) {
      const config = settings.parse(input);
      oauth = new OAuthResource({
        issuer: config.oauth.issuer,
        resource: config.oauth.resource,
        userScopes: config.oauth.scopes as ConstructorParameters<
          typeof OAuthResource
        >[0]["userScopes"],
      });
      const subjects = new ApprovedSubjects(config.subjects, {
        enabled: config.enabled,
      });
      const policy = subjects.policy();
      // This entrypoint enables only the fixed text MVP, not the inventory/model rollout.
      if (
        policy.some(
          (p) =>
            p.operations.some((op) =>
              ["events", "grants", "reconcile"].includes(op),
            ) || p.taskTypes?.some((type) => type !== "connectivity_check"),
        )
      )
        throw Error();
      if (
        policy.some(
          (p) =>
            p.operations.some((op) =>
              ["claim", "heartbeat", "complete"].includes(op),
            ) &&
            (p.kind !== "service" || p.worker !== "hermes" || !p.runnerScope),
        )
      )
        throw Error();
      if (config.ping) {
        for (const peer of [config.ping.dots, config.ping.grok]) {
          const enrolled = policy.find(
            (p) => p.subject === peer.subject && p.clientId === peer.clientId,
          );
          if (
            !enrolled ||
            enrolled.kind !== "user" ||
            !["ping_submit", "ping_get", "ping_reply", "ping_pending"].every(
              (op) =>
                enrolled.operations.includes(
                  op as (typeof enrolled.operations)[number],
                ),
            )
          )
            throw Error();
        }
        ping = new PingService(hub, config.ping);
      }
      if (
        !ping &&
        policy.some((p) => p.operations.some((op) => op.startsWith("ping_")))
      )
        throw Error();
      if (config.enabled)
        verifier = new Auth0Verifier({
          resource: oauth,
          subjects,
          ...dependencies,
        });
    }
  } catch {
    // Never log tenant/subject/config contents, including malformed input.
    throw Error("runtime_config_rejected");
  }
  const allowedHosts = new Set([
    "127.0.0.1:8787",
    ...(oauth ? [new URL(oauth.resource).host] : []),
  ]);
  const allowedOrigins = new Set(oauth ? [new URL(oauth.resource).origin] : []);
  const admissible = (host: string | undefined, origin: string | undefined) =>
    !!host &&
    allowedHosts.has(host) &&
    (origin === undefined || allowedOrigins.has(origin));
  const monitor = new SecurityMonitor(dependencies.audit, dependencies.now);
  const nodeHandler = handler(
    hub,
    (req) =>
      verifier?.verify(req.headers.authorization) ?? Promise.resolve(null),
    undefined,
    oauth,
    ping,
    monitor,
  );
  return Object.freeze({
    oauth,
    workerEndpoint: `http://127.0.0.1:8787${oauth?.mcpPath ?? "/mcp"}`,
    async handle(req: IncomingMessage, res: ServerResponse) {
      const duplicate = ["host", "authorization", "origin"].some(
        (name) =>
          req.rawHeaders.filter(
            (_value, i) =>
              i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
          ).length > 1,
      );
      if (duplicate || !admissible(req.headers.host, req.headers.origin)) {
        try {
          const context = await monitor.enter();
          try {
            await context.record("access_denied");
          } finally {
            context.release();
          }
        } catch {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      await nodeHandler(req, res);
    },
    async fetch(request: Request): Promise<Response> {
      if (
        !admissible(
          request.headers.get("host") ?? new URL(request.url).host,
          request.headers.get("origin") ?? undefined,
        )
      ) {
        try {
          const context = await monitor.enter();
          try {
            await context.record("access_denied");
          } finally {
            context.release();
          }
        } catch {
          return new Response(null, { status: 503 });
        }
        return new Response(null, {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        });
      }
      let context;
      try {
        context = await monitor.enter();
      } catch {
        return new Response(null, { status: 503 });
      }
      try {
        return guardedResponse(
          await fetchMCP(
            hub,
            request,
            (req) =>
              verifier?.verify(req.headers.get("authorization") ?? undefined) ??
              Promise.resolve(null),
            undefined,
            oauth,
            ping,
            context,
          ),
          context,
        );
      } catch {
        context.release();
        return new Response(null, { status: 503 });
      }
    },
  });
}
