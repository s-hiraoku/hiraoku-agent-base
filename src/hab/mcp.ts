/**
 * HAB MCP catalogs. The agent catalog (hab_send, hab_reply, hab_inbox, hab_status and
 * hab_discover) is what agents connect to. The delivery catalog (hab_submit, hab_status,
 * hab_poll, hab_ack, hab_resolve and hab_discover) is for the SDK and the receive service.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createDeliveryMcpServer,
  executeDeliveryMcpOperation,
  deliveryMcpSchemas,
} from "../host/mcp/server.ts";
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
  runHabAgentTool,
} from "./agent-tools.ts";
import type { HabAgentService, HabAgentTool } from "./agent-tools.ts";
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
});
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
        );
  if (service.discoveryEnabled === true) {
    if (typeof service.discover !== "function")
      throw new MessagingError("invalid_hab_mcp_service");
    server.registerTool(
      "hab_discover",
      {
        description:
          "Find agents and addresses you can message, or check which HAB address this connection uses (action `whoami`). A listed name is not proof that its agent is running. Availability does not reserve or authorize registration.",
        inputSchema: habDiscoverySchema,
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
        inputSchema: habAgentMcpSchemas[tool],
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
      inputSchema: habMcpSchemas.hab_resolve,
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
  return server;
}
