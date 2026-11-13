/** Optional HAB catalog: the four delivery tools plus exactly one directory operation. */
import { z } from "zod";
import {
  createDeliveryMcpServer,
  executeDeliveryMcpOperation,
  deliveryMcpSchemas,
} from "../host/mcp/server.ts";
import type { DeliveryContextResolver, DeliveryMcpGate } from "../host/mcp/server.ts";
import type { DeliveryService } from "../messaging/delivery-service.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabDirectory } from "./directory.ts";
import { habDiscoverySchema } from "./discovery.ts";
import type { HabDiscoveryService } from "./discovery.ts";
import { HAB_ADDRESS_PATTERN } from "./registry.ts";
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
/** Address-selection v1 is a HAB transport field, never a credential or core sender_id. */
export function prepareHabInvocation(
  service: HabMcpService,
  context: unknown,
  tool: string,
  input: unknown,
) {
  if (!Object.hasOwn(habMcpSchemas, tool))
    throw new MessagingError("forbidden");
  const parsed = habMcpSchemas[tool as keyof typeof habMcpSchemas].parse(input);
  const {
    as_address: address,
    expected_agent_id: expectedAgentId,
    ...payload
  } = parsed;
  if (address === undefined) {
    if (expectedAgentId !== undefined)
      throw new MessagingError("invalid_request");
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
) {
  if (typeof service?.resolve !== "function")
    throw new MessagingError("invalid_hab_mcp_service");
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
      ...(oauthScopes
        ? {
            _meta: {
              securitySchemes: [{ type: "oauth2", scopes: [...oauthScopes] }],
            },
          }
        : {}),
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
  if (service.discoveryEnabled === true) {
    if (typeof service.discover !== "function")
      throw new MessagingError("invalid_hab_mcp_service");
    server.registerTool(
      "hab_discover",
      {
        description:
          "Read your authenticated HAB connection, group-scoped issued addresses and assignments, or exact candidate availability. A selected name is not proof of the running session/bot. Unknown host assignment/presence stays unknown. Availability does not reserve or authorize registration.",
        inputSchema: habDiscoverySchema,
        annotations: { readOnlyHint: true, idempotentHint: true },
        ...(oauthScopes
          ? {
              _meta: {
                securitySchemes: [{ type: "oauth2", scopes: [...oauthScopes] }],
              },
            }
          : {}),
      },
      (input: unknown) =>
        executeDeliveryMcpOperation(resolveContext, gate, (context) =>
          service.discover!(context, input),
        ),
    );
  }
  return server;
}
