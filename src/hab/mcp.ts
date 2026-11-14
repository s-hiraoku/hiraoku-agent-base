/**
 * HAB MCP catalogs. The agent catalog (hab_send, hab_reply, hab_inbox, hab_status and
 * hab_discover) is what agents connect to. The delivery catalog (hab_submit, hab_status,
 * hab_poll, hab_ack, hab_resolve, hab_peek and hab_discover) is for the SDK, the receive
 * service and the arrival notifier (ADR-021).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createDeliveryMcpServer,
  executeDeliveryMcpOperation,
  deliveryMcpSchemas,
} from "../host/mcp/server.ts";
import { publishedInputSchema } from "../host/mcp/published-schema.ts";
import type {
  DeliveryContextResolver,
  DeliveryMcpGate,
} from "../host/mcp/server.ts";
import type { DeliveryService } from "../messaging/delivery-service.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabDirectory } from "./directory.ts";
import { habDiscoverySchema } from "./discovery.ts";
import type { HabDiscoveryService } from "./discovery.ts";
import { HAB_ADDRESS_PATTERN } from "./registry.ts";
import {
  HAB_AGENT_INSTRUCTIONS,
  habAgentDescriptions,
  habAgentSchemas,
  inboxEntry,
  runHabAgentTool,
} from "./agent-tools.ts";
import type { HabAgentService, HabAgentTool } from "./agent-tools.ts";
import type { InboxMessage } from "../messaging/delivery-service.ts";
import {
  formatHandoffPrompt,
  formatIncomingDisplay,
} from "../messaging/incoming-notice.ts";
/** Which tools one MCP endpoint offers; host code chooses it, never the caller. */
export type HabMcpCatalog = "agent" | "delivery";
export type HabMcpService = DeliveryService &
  HabDiscoveryService &
  HabDirectory & {
    selectAddress?(
      context: unknown,
      address: string,
      expectedAgentId?: string,
    ): unknown;
    /** Unread messages left unread, for the arrival notifier (ADR-021). */
    peek?(
      context: unknown,
      options: {
        limit: number;
        max_bytes?: number;
        after?: { accepted_at: number; sender_id: string; message_id: string };
      },
    ): (InboxMessage & { from: string | null })[];
  };
const asAddress = z
  .string()
  .max(101)
  .regex(new RegExp(HAB_ADDRESS_PATTERN))
  .describe(
    "Your local HAB name within the authenticated group, not the recipient. Omit only for an unambiguous single address.",
  )
  .optional();
const selection = {
  as_address: asAddress,
  expected_agent_id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/)
    .describe(
      "Optional immutable local ID check paired with as_address; not authentication.",
    )
    .optional(),
};
export const habMcpSchemas = Object.freeze({
  hab_submit: deliveryMcpSchemas.hab_submit.extend(selection),
  hab_status: deliveryMcpSchemas.hab_status.extend(selection),
  hab_poll: deliveryMcpSchemas.hab_poll.extend(selection),
  hab_ack: deliveryMcpSchemas.hab_ack.extend(selection),
  hab_resolve: z.strictObject({
    ...selection,
    address: z.string().max(101).regex(new RegExp(HAB_ADDRESS_PATTERN)),
  }),
  hab_peek: z.strictObject({
    ...selection,
    limit: z
      .number()
      .describe("How many unread messages to return, 1 to 50. Default 10.")
      .optional(),
    after: z
      .string()
      .max(512)
      .describe(
        "Optional. The next_cursor of the previous page, to continue past messages already returned.",
      )
      .optional(),
  }),
});
/** hab_peek page cursor: the last returned message's place in inbox order. */
function peekCursor(message: InboxMessage) {
  return Buffer.from(
    JSON.stringify([
      Date.parse(message.received_at),
      message.sender_id,
      message.message_id,
    ]),
  ).toString("base64url");
}
function parsePeekCursor(value: string) {
  try {
    const [accepted_at, sender_id, message_id] = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown[];
    if (
      Number.isSafeInteger(accepted_at) &&
      typeof sender_id === "string" &&
      typeof message_id === "string"
    )
      return { accepted_at: accepted_at as number, sender_id, message_id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new MessagingError("invalid_request", {
    details: { field: "after", expected: "next_cursor from hab_peek" },
  });
}
export const habAgentMcpSchemas = Object.freeze({
  hab_send: habAgentSchemas.hab_send.extend(selection),
  hab_reply: habAgentSchemas.hab_reply.extend(selection),
  hab_inbox: habAgentSchemas.hab_inbox.extend(selection),
  hab_status: habAgentSchemas.hab_status.extend(selection),
});
/** The input schemas of a catalog's address-selecting tools. */
export function habCatalogSchemas(
  catalog: HabMcpCatalog,
): Readonly<Record<string, z.ZodType>> {
  return catalog === "agent" ? habAgentMcpSchemas : habMcpSchemas;
}
/** Address-selection v1 is a HAB transport field, never a credential or core sender_id. */
export function prepareHabInvocation(
  service: HabMcpService,
  context: unknown,
  tool: string,
  input: unknown,
  catalog: HabMcpCatalog = "delivery",
) {
  const schemas = habCatalogSchemas(catalog);
  if (!Object.hasOwn(schemas, tool)) throw new MessagingError("forbidden");
  const result = schemas[tool].safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new MessagingError("invalid_request", {
      details: { field: issue?.path.map(String).join(".") || "arguments" },
    });
  }
  const parsed = result.data as Record<string, unknown> & {
    as_address?: string;
    expected_agent_id?: string;
  };
  const {
    as_address: address,
    expected_agent_id: expectedAgentId,
    ...payload
  } = parsed;
  if (address === undefined) {
    if (expectedAgentId !== undefined)
      throw new MessagingError("invalid_request", {
        details: { field: "expected_agent_id", requires: "as_address" },
      });
    return { context, input: payload };
  }
  if (typeof service.selectAddress !== "function")
    throw new MessagingError("forbidden");
  return {
    context: service.selectAddress(context, address, expectedAgentId),
    input: payload,
  };
}
export function createHabMcpServer(
  service: HabMcpService,
  resolveContext: DeliveryContextResolver = () => null,
  gate?: DeliveryMcpGate,
  oauthScopes?: readonly string[],
  catalog: HabMcpCatalog = "delivery",
  /** The transport's response limit; hab_inbox reads no more than fits in it. */
  maxResponseBytes?: number,
) {
  if (typeof service?.resolve !== "function")
    throw new MessagingError("invalid_hab_mcp_service");
  const security = oauthScopes
    ? {
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: [...oauthScopes] }],
        },
      }
    : {};
  const server =
    catalog === "agent"
      ? createAgentServer(
          service,
          resolveContext,
          gate,
          security,
          maxResponseBytes,
        )
      : createDeliveryServer(
          service,
          resolveContext,
          gate,
          oauthScopes,
          security,
          maxResponseBytes,
        );
  if (service.discoveryEnabled === true) {
    if (typeof service.discover !== "function")
      throw new MessagingError("invalid_hab_mcp_service");
    server.registerTool(
      "hab_discover",
      {
        description:
          "Find agents and addresses you can message, or check which HAB address this connection uses (action `whoami`). A listed name is not proof that its agent is running. Availability does not reserve or authorize registration.",
        inputSchema: publishedInputSchema(habDiscoverySchema),
        annotations: { readOnlyHint: true, idempotentHint: true },
        ...security,
      },
      (input: unknown) =>
        executeDeliveryMcpOperation(resolveContext, gate, (context) =>
          service.discover!(context, input),
        ),
    );
  }
  return server;
}
function createAgentServer(
  service: HabMcpService,
  resolveContext: DeliveryContextResolver,
  gate: DeliveryMcpGate | undefined,
  security: object,
  maxResponseBytes: number | undefined,
) {
  const agent = service as unknown as HabAgentService;
  for (const name of [
    "submit",
    "received",
    "inbox",
    "statusWithAddress",
  ] as const)
    if (typeof agent[name] !== "function")
      throw new MessagingError("invalid_hab_mcp_service");
  const server = new McpServer(
    { name: "hab", version: "0.2.0" },
    { instructions: HAB_AGENT_INSTRUCTIONS },
  );
  server.server.registerCapabilities({ tools: { listChanged: false } });
  for (const name of Object.keys(habAgentMcpSchemas)) {
    const tool = name as HabAgentTool;
    server.registerTool(
      tool,
      {
        description: habAgentDescriptions[tool],
        inputSchema: publishedInputSchema(habAgentMcpSchemas[tool]),
        ...security,
        annotations: {
          readOnlyHint: false,
          idempotentHint: tool === "hab_status",
        },
      },
      (input: unknown) =>
        executeDeliveryMcpOperation(resolveContext, gate, (verified) => {
          const prepared = prepareHabInvocation(
            service,
            verified,
            tool,
            input,
            "agent",
          );
          return runHabAgentTool(
            agent,
            prepared.context,
            tool,
            prepared.input as Record<string, unknown>,
            maxResponseBytes,
          );
        }),
    );
  }
  return server;
}
function createDeliveryServer(
  service: HabMcpService,
  resolveContext: DeliveryContextResolver,
  gate: DeliveryMcpGate | undefined,
  oauthScopes: readonly string[] | undefined,
  security: object,
  maxResponseBytes: number | undefined,
) {
  const server = createDeliveryMcpServer(
    service,
    resolveContext,
    gate,
    oauthScopes,
    {
      schemas: habMcpSchemas,
      prepare: (context, tool, input) =>
        prepareHabInvocation(service, context, tool, input),
    },
  );
  server.registerTool(
    "hab_resolve",
    {
      description:
        "Resolve one canonical HAB address to an immutable recipient ID. Optional as_address selects your registered local name, never grants identity. Save the result in the durable outbox; never re-resolve on retry. This grants no mailbox or execution rights.",
      inputSchema: publishedInputSchema(habMcpSchemas.hab_resolve),
      ...security,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (input: unknown) =>
      executeDeliveryMcpOperation(resolveContext, gate, (context) => {
        const prepared = prepareHabInvocation(
          service,
          context,
          "hab_resolve",
          input,
        );
        const { address } = parseHabResolveInput(prepared.input);
        return parseHabResolution(
          service.resolve(prepared.context, address),
          address,
        );
      }),
  );
  if (typeof service.peek === "function") {
    const peek = service.peek.bind(service);
    server.registerTool(
      "hab_peek",
      {
        description:
          "For the arrival notifier (ADR-021): return the caller's unread messages oldest first WITHOUT marking them read. Each has `display` (show it to the user as soon as it arrives) and `handoff_prompt` (give it to the user's own session only after they chose 対応する). Reading and replying stay with the agent's hab_inbox and hab_reply.",
        inputSchema: publishedInputSchema(habMcpSchemas.hab_peek),
        ...security,
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      (input: unknown) =>
        executeDeliveryMcpOperation(resolveContext, gate, (context) => {
          const prepared = prepareHabInvocation(
            service,
            context,
            "hab_peek",
            input,
          );
          const { limit = 10, after } = prepared.input as {
            limit?: number;
            after?: string;
          };
          if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new MessagingError("invalid_request", {
              details: { field: "limit", min: 1, max: 50 },
            });
          const found = peek(prepared.context, {
            limit,
            ...(after !== undefined ? { after: parsePeekCursor(after) } : {}),
            // Like hab_inbox, the body appears twice (display and handoff_prompt).
            ...(maxResponseBytes !== undefined
              ? { max_bytes: Math.max(1, maxResponseBytes - 4096) }
              : {}),
          });
          const messages = found.map((message) => {
            const fields = {
              message_id: message.message_id,
              from: message.from,
              kind: message.kind,
              text: message.text,
              data_parts: message.data_parts,
              reply_by: message.expires_at,
            };
            const entry: Partial<ReturnType<typeof inboxEntry>> =
              inboxEntry(message);
            delete entry.text;
            delete entry.notice;
            return {
              ...entry,
              // The immutable sender ID: (sender_id, message_id) names one message.
              sender_id: message.sender_id,
              display: formatIncomingDisplay(fields),
              handoff_prompt: formatHandoffPrompt(fields),
            };
          });
          return {
            messages,
            // Pass it as `after` for the next page; null once nothing follows.
            next_cursor: found.length ? peekCursor(found.at(-1)!) : null,
            explanation: messages.length
              ? "These messages are still unread. Show `display` to the user; nothing was marked read. Call again with after: next_cursor for more."
              : "No more unread messages.",
          };
        }),
    );
  }
  return server;
}
