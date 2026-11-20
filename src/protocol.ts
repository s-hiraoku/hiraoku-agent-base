import type { z } from "zod";
import type { SecurityContext } from "./security.ts";
/**
 * MCP methods named in the audit by a fixed code. The caller's own method string never enters
 * the log: a method outside this table is `other`, so the audit can show which methods a host
 * asks for (and which were refused) without recording caller-chosen text.
 */
const METHOD_CODES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [
      "initialize",
      "ping",
      "server/discover",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "resources/subscribe",
      "resources/unsubscribe",
      "prompts/list",
      "prompts/get",
      "completion/complete",
      "logging/setLevel",
      "events/list",
      "events/subscribe",
      "events/unsubscribe",
      "tasks/get",
      "tasks/list",
      "tasks/result",
      "tasks/cancel",
      "roots/list",
      "sampling/createMessage",
      "elicitation/create",
      "notifications/initialized",
      "notifications/cancelled",
      "notifications/progress",
      "notifications/roots/list_changed",
      "notifications/tasks/status",
    ].map((name) => [name, name.replace(/\//g, "_").toLowerCase()]),
  ),
);
/**
 * The audit code of the MCP method in a request: a code from `METHOD_CODES`, `other` for a
 * method outside it, `mismatch` when the Mcp-Method header and the body disagree, `invalid`
 * when there is no method. `resources/read` is split into `resources_read_ui` (a `ui://`
 * card such as the ADR-026 inbox card) and `resources_read_other`; the URI itself is not kept.
 */
export function mcpMethodCode(
  body: unknown,
  header: string | undefined,
): string {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "invalid";
  const envelope = body as Record<string, unknown>;
  const method = header ?? envelope.method;
  if (typeof method !== "string") return "invalid";
  if (
    header !== undefined &&
    envelope.jsonrpc === "2.0" &&
    header !== envelope.method
  )
    return "mismatch";
  if (!Object.hasOwn(METHOD_CODES, method)) return "other";
  if (method !== "resources/read") return METHOD_CODES[method];
  const params = (envelope.jsonrpc === "2.0" ? envelope.params : envelope) as
    Record<string, unknown> | undefined;
  const uri = params?.uri;
  return typeof uri === "string" && uri.startsWith("ui://")
    ? "resources_read_ui"
    : "resources_read_other";
}
/** Protocol classification only: no payload, method string or arguments enter the log. */
export async function protocolAdmission(
  body: unknown,
  header: string | undefined,
  schemas: Record<string, z.ZodType>,
  security?: SecurityContext,
  events = false,
  /** The agent catalog's MCP Apps card (ADR-026): read-only static resources. */
  resources = false,
): Promise<boolean> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    await security?.record("transport_error");
    return false;
  }
  const envelope = body as Record<string, unknown>;
  const method = header ?? envelope.method,
    legacy = envelope.jsonrpc === "2.0";
  const allowed = [
    "server/discover",
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
    ...(events
      ? ["events/list", "events/subscribe", "events/unsubscribe"]
      : []),
    ...(resources
      ? ["resources/list", "resources/read", "resources/templates/list"]
      : []),
  ];
  if (
    typeof method !== "string" ||
    !allowed.includes(method) ||
    (header && legacy && header !== envelope.method)
  ) {
    await security?.record("resource_rejected");
    return false;
  }
  if (method === "tools/call") {
    const params = (legacy ? envelope.params : envelope) as
      Record<string, unknown> | undefined;
    const name = params?.name;
    if (
      typeof name !== "string" ||
      !Object.hasOwn(schemas, name) ||
      !schemas[name].safeParse(params?.arguments ?? {}).success
    )
      await security?.record("tool_error");
  }
  return true;
}
