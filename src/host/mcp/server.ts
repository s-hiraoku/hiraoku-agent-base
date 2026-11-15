/** Optional SDK boundary. Importing/constructing starts no listener or external connection. */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publishedInputSchema } from "./published-schema.ts";
import { ContractError } from "../../messaging/contract.ts";
import { MessagingError } from "../../messaging/delivery-service.ts";
import {
  explainToolError,
  isPublicToolError,
} from "../../messaging/tool-errors.ts";
import type { DeliveryService } from "../../messaging/delivery-service.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const part = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("data"),
    schema_id: id,
    schema_version: z.number().int().positive(),
    // The core enforces finite JSON depth/node/byte limits, without recursion here.
    value: z.unknown(),
  }),
]);
export const deliveryMcpSchemas = Object.freeze({
  hab_submit: z.strictObject({
    version: z.literal(1),
    message_id: id,
    recipient_id: id,
    kind: id,
    body: z.strictObject({ parts: z.array(part).min(1) }),
    thread_id: id,
    in_reply_to: z.strictObject({ sender_id: id, message_id: id }).nullable(),
    first_sent_at: z.string(),
    expires_at: z.string(),
  }),
  hab_status: z.strictObject({ message_id: id }),
  hab_poll: z.strictObject({}),
  hab_ack: z.strictObject({
    sender_id: id,
    message_id: id,
    generation: z.number().int().positive(),
    lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    request_id: id,
  }),
});
const descriptions = {
  hab_submit:
    "Persist a HAB message with its fixed ID, recipient and one-hour deadline. Acceptance is delivery only; it does not execute work.",
  hab_status:
    "Read the authenticated sender's acceptance receipt without body. Delivery state is not work completion.",
  hab_poll:
    "Lease at most one message for the authenticated receiver. Save it durably before acknowledging it.",
  hab_ack:
    "Confirm a durably saved delivery using its exact journaled ACK request. This removes the server body and does not execute work.",
};
/** Supplied by a trusted host per connection/request; never derived from tool arguments. */
export type DeliveryContextResolver = () => unknown | Promise<unknown>;
/** Optional transport admission/audit guard; it cannot grant identity or permissions. */
export interface DeliveryMcpGate {
  check(): void;
  /** The finish callback takes a fixed refusal reason for the audit, never a body or secret. */
  begin(): Promise<(success: boolean, reason?: string) => Promise<void>>;
}
/** The fixed public error: code, explanation and only details the code allows. */
export function toolError(error: unknown): {
  error: string;
  message: string;
  [detail: string]: unknown;
} {
  const code =
    (error instanceof MessagingError || error instanceof ContractError) &&
    isPublicToolError(error.code)
      ? error.code
      : "operation_failed";
  const details =
    error instanceof MessagingError && code === error.code
      ? error.details
      : undefined;
  return { error: code, message: explainToolError(code), ...details };
}
/** The audit reason of a failed tool call: the refusal's own reason, else its public code. */
export function auditReason(error: unknown, code: string): string {
  if (error instanceof MessagingError && error.reason) return error.reason;
  if (error instanceof ContractError) return error.code;
  return code;
}
/** Shared optional transport boundary. Operations stay synchronous after verified context resolution. */
export async function executeDeliveryMcpOperation(
  resolveContext: DeliveryContextResolver,
  gate: DeliveryMcpGate | undefined,
  operation: (context: unknown) => unknown,
) {
  let finish:
    ((success: boolean, reason?: string) => Promise<void>) | undefined;
  try {
    gate?.check();
    finish = await gate?.begin();
    let context: unknown;
    try {
      context = await resolveContext();
    } catch {
      throw new MessagingError("forbidden");
    }
    if (context === null || context === undefined || context === false)
      throw new MessagingError("forbidden");
    gate?.check();
    const value = operation(context);
    if (value && typeof value === "object" && "then" in value) {
      void Promise.resolve(value).catch(() => {});
      throw new MessagingError("operation_failed");
    }
    const output = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    await finish?.(true);
    gate?.check();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const output = toolError(error);
    try {
      await finish?.(false, auditReason(error, output.error));
    } catch {
      /* A service may already have committed; never repeat it here. */
    }
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
}
/** Trusted transport composition only; a preparation hook cannot bypass service authorization. */
export interface DeliveryMcpToolBinding {
  schemas: Readonly<Record<keyof typeof deliveryMcpSchemas, z.ZodType>>;
  prepare(
    context: unknown,
    tool: keyof typeof deliveryMcpSchemas,
    input: unknown,
  ): { context: unknown; input: unknown };
}
export function createDeliveryMcpServer(
  service: DeliveryService,
  resolveContext: DeliveryContextResolver = () => null,
  gate?: DeliveryMcpGate,
  oauthScopes?: readonly string[],
  binding?: DeliveryMcpToolBinding,
): McpServer {
  const server = new McpServer({ name: "hab", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  for (const [name, schema] of Object.entries(deliveryMcpSchemas)) {
    const tool = name as keyof typeof deliveryMcpSchemas;
    server.registerTool(
      tool,
      {
        description: descriptions[tool],
        inputSchema: publishedInputSchema(binding?.schemas[tool] ?? schema),
        ...(oauthScopes
          ? {
              _meta: {
                securitySchemes: [{ type: "oauth2", scopes: [...oauthScopes] }],
              },
            }
          : {}),
        // Even status may expire old records. These are hints, never authorization.
        annotations: {
          readOnlyHint: false,
          idempotentHint: tool !== "hab_poll",
        },
      },
      (input: unknown) =>
        executeDeliveryMcpOperation(resolveContext, gate, (verified) => {
          const { context, input: prepared } = binding?.prepare(
            verified,
            tool,
            input,
          ) ?? { context: verified, input };
          switch (tool) {
            case "hab_submit":
              return service.submit(context, prepared);
            case "hab_status":
              return service.status(
                context,
                deliveryMcpSchemas.hab_status.parse(prepared).message_id,
              );
            case "hab_poll":
              return { delivery: service.poll(context) };
            case "hab_ack":
              return service.ack(context, prepared);
          }
        }),
    );
  }
  return server;
}
