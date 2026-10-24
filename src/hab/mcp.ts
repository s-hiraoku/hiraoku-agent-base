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
export type HabMcpService = RelayOperations & HabDirectory;
export const habMcpSchemas = Object.freeze({
  ...relayMcpSchemas,
  relay_resolve: z.strictObject({
    address: z.string().max(101).regex(new RegExp(HAB_ADDRESS_PATTERN)),
  }),
});
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
  );
  server.registerTool(
    "relay_resolve",
    {
      description:
        "Resolve one canonical HAB address to an immutable recipient ID. Save that ID in the durable outbox before sending; never re-resolve on retry. This grants no delivery, mailbox or execution rights.",
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
        const { address } = parseHabResolveInput(input);
        return parseHabResolution(service.resolve(context, address), address);
      }),
  );
  return server;
}
