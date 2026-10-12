import type { z } from "zod";
import type { SecurityContext } from "./security.ts";
/** Protocol classification only: no payload, method string or arguments enter the log. */
export async function protocolAdmission(
  body: unknown,
  header: string | undefined,
  schemas: Record<string, z.ZodType>,
  security?: SecurityContext,
  events = false,
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
