/** Optional HAB catalog: basic Relay delivery plus exactly one directory operation. */
import { z } from "zod";
import {
  createRelayMcpServer,
  executeRelayMcpOperation,
  relayMcpSchemas,
} from "../relay/mcp.ts";
import type { RelayContextResolver, RelayMcpGate } from "../relay/mcp.ts";
import type { RelayOperations } from "../relay/service.ts";
import { RelayError } from "../relay/service.ts";
import { parseHabResolveInput, parseHabResolution } from "./directory.ts";
import type { HabDirectory } from "./directory.ts";
import { HAB_ADDRESS_PATTERN } from "./registry.ts";
export type HabMcpService = RelayOperations &
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
  relay_submit: relayMcpSchemas.relay_submit.extend(selection),
  relay_status: relayMcpSchemas.relay_status.extend(selection),
  relay_poll: relayMcpSchemas.relay_poll.extend(selection),
  relay_ack: relayMcpSchemas.relay_ack.extend(selection),
  relay_resolve: z.strictObject({
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
  if (!Object.hasOwn(habMcpSchemas, tool)) throw new RelayError("forbidden");
  const parsed = habMcpSchemas[tool as keyof typeof habMcpSchemas].parse(input);
  const {
    as_address: address,
    expected_agent_id: expectedAgentId,
    ...payload
  } = parsed;
  if (address === undefined) {
    if (expectedAgentId !== undefined) throw new RelayError("invalid_request");
    return { context, input: payload };
  }
  if (typeof service.selectAddress !== "function")
    throw new RelayError("forbidden");
  return {
    context: service.selectAddress(context, address, expectedAgentId),
    input: payload,
  };
}
export function createHabMcpServer(
  service: HabMcpService,
  resolveContext: RelayContextResolver = () => null,
  gate?: RelayMcpGate,
  oauthScopes?: readonly string[],
) {
  if (typeof service?.resolve !== "function")
    throw new RelayError("invalid_hab_mcp_service");
  const server = createRelayMcpServer(
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
    "relay_resolve",
    {
      description:
        "Resolve one canonical HAB address to an immutable recipient ID. Optional as_address selects your registered local name, never grants identity. Save the result in the durable outbox; never re-resolve on retry. This grants no mailbox or execution rights.",
      inputSchema: habMcpSchemas.relay_resolve,
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
      executeRelayMcpOperation(resolveContext, gate, (context) => {
        const prepared = prepareHabInvocation(
          service,
          context,
          "relay_resolve",
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
