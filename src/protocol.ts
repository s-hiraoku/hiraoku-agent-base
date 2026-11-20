import type { z } from "zod";
import type { SecurityContext } from "./security.ts";
/**
 * MCP methods the audit may name. Anything else is logged as `method_other`, so a
 * client's free text never reaches the log.
 */
const KNOWN_METHODS = [
  "server/discover",
  "initialize",
  "ping",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
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
  "roots/list",
  "sampling/createMessage",
  "elicitation/create",
  "tasks/get",
  "tasks/list",
  "tasks/result",
  "tasks/cancel",
];
/** The only resource URI the audit names; the agent catalog's card (ADR-026). */
const CARD_URI = "ui://hab/inbox-v1";
/** A fixed audit code for an MCP method, e.g. `resources/read` → `method_resources_read`. */
export function methodCode(method: unknown): string {
  if (typeof method !== "string") return "method_missing";
  if (!KNOWN_METHODS.includes(method)) return "method_other";
  return `method_${method.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
}
/**
 * Protocol classification only: no payload or arguments enter the log. The method is
 * logged only as a code from KNOWN_METHODS, and a read resource only as whether it is
 * the card.
 */
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
    await security?.record(
      "resource_rejected",
      typeof method === "string" && allowed.includes(method)
        ? "method_header_mismatch"
        : methodCode(method),
    );
    return false;
  }
  // Which non-tool methods a client sends (did it reload the tool list, read the card,
  // subscribe?) shows whether a host can show HAB's card. tools/call has its own lines.
  if (method !== "tools/call" && method !== "ping") {
    const params = (legacy ? envelope.params : envelope) as
      Record<string, unknown> | undefined;
    await security?.record(
      "protocol_method",
      method === "resources/read"
        ? params?.uri === CARD_URI
          ? "method_resources_read_card"
          : "method_resources_read_other"
        : methodCode(method),
    );
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
