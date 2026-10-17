/** Optional SDK boundary. Importing/constructing starts no listener or external connection. */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ContractError } from "./contract.ts";
import { RelayError } from "./service.ts";
import { isRelayMcpError } from "./mcp-errors.ts";
import type { RelayOperations } from "./service.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const part = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("attachment"),
    attachment_id: id,
    media_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    filename: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("data"),
    schema_id: id,
    schema_version: z.number().int().positive(),
    // The core enforces finite JSON depth/node/byte limits, without recursion here.
    value: z.unknown(),
  }),
]);
export const relayMcpSchemas = Object.freeze({
  relay_submit: z.strictObject({
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
  relay_status: z.strictObject({ message_id: id }),
  relay_poll: z.strictObject({}),
  relay_ack: z.strictObject({
    sender_id: id,
    message_id: id,
    generation: z.number().int().positive(),
    lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    request_id: id,
  }),
});
const descriptions = {
  relay_submit:
    "Persist a Relay message with its fixed ID, recipient and one-hour deadline. Acceptance is delivery only; it does not execute work.",
  relay_status:
    "Read the authenticated sender's acceptance receipt without body. Delivery state is not work completion.",
  relay_poll:
    "Lease at most one message for the authenticated receiver. Save it durably before acknowledging it.",
  relay_ack:
    "Confirm a durably saved delivery using its exact journaled ACK request. This removes the server body and does not execute work.",
};
/** Supplied by a trusted host per connection/request; never derived from tool arguments. */
export type RelayContextResolver = () => unknown | Promise<unknown>;
/** Optional transport admission/audit guard; it cannot grant identity or permissions. */
export interface RelayMcpGate {
  check(): void;
  begin(): Promise<(success: boolean) => Promise<void>>;
}
export function createRelayMcpServer(
  service: RelayOperations,
  resolveContext: RelayContextResolver = () => null,
  gate?: RelayMcpGate,
): McpServer {
  const server = new McpServer({ name: "hab-relay", version: "0.1.0" });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  for (const [name, schema] of Object.entries(relayMcpSchemas)) {
    const tool = name as keyof typeof relayMcpSchemas;
    server.registerTool(
      tool,
      {
        description: descriptions[tool],
        inputSchema: schema,
        // Even status may expire old records. These are hints, never authorization.
        annotations: {
          readOnlyHint: false,
          idempotentHint: tool !== "relay_poll",
        },
      },
      async (input: unknown) => {
        let finish: ((success: boolean) => Promise<void>) | undefined;
        try {
          gate?.check();
          finish = await gate?.begin();
          let context: unknown;
          try {
            context = await resolveContext();
          } catch {
            throw new RelayError("forbidden");
          }
          if (context === null || context === undefined || context === false)
            throw new RelayError("forbidden");
          gate?.check();
          let value: unknown;
          switch (tool) {
            case "relay_submit":
              value = service.submit(context, input);
              break;
            case "relay_status":
              value = service.status(
                context,
                relayMcpSchemas.relay_status.parse(input).message_id,
              );
              break;
            case "relay_poll":
              value = { delivery: service.poll(context) };
              break;
            case "relay_ack":
              value = service.ack(context, input);
              break;
          }
          // Results have a single JSON representation for text and structured clients.
          const output = JSON.parse(JSON.stringify(value)) as Record<
            string,
            unknown
          >;
          await finish?.(true);
          gate?.check();
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          try {
            await finish?.(false);
          } catch {
            // The service may already have committed: return no success, never repeat it here.
          }
          const code =
            (error instanceof RelayError || error instanceof ContractError) &&
            isRelayMcpError(error.code)
              ? error.code
              : "relay_operation_failed";
          return {
            isError: true,
            content: [
              { type: "text" as const, text: JSON.stringify({ error: code }) },
            ],
            structuredContent: { error: code },
          };
        }
      },
    );
  }
  return server;
}
