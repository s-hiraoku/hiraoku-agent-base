import { HAB_OAUTH_SCOPES } from "../host/mcp/oauth-resource.ts";
import type { WriterAdmission } from "../host/mcp/writer-admission.ts";
/** Explicit HAB HTTP composition; constructing starts no listener or connection. */
import { McpHttpGateway } from "../host/mcp/http.ts";
import type { McpHttpPolicy, McpHttpVerifier } from "../host/mcp/http.ts";
import type { AuditSink } from "../security.ts";
import type {
  DeliveryContextResolver,
  DeliveryMcpGate,
} from "../host/mcp/server.ts";
import {
  createHabMcpServer,
  habCatalogSchemas,
  prepareHabInvocation,
} from "./mcp.ts";
import type { HabMcpCatalog, HabMcpService } from "./mcp.ts";
import { habAgentOperations } from "./agent-tools.ts";
import { habDiscoverySchema } from "./discovery.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
/** One HAB MCP endpoint serving one catalog; the host decides which, never the caller. */
export class HabHttpGateway extends McpHttpGateway {
  readonly #hab: HabMcpService;
  readonly catalog: HabMcpCatalog;
  constructor(
    service: HabMcpService,
    policy: McpHttpPolicy,
    audit: AuditSink,
    verify: McpHttpVerifier = () => null,
    admission?: WriterAdmission,
    catalog: HabMcpCatalog = "delivery",
  ) {
    if (
      typeof service?.resolve !== "function" ||
      (catalog !== "agent" && catalog !== "delivery")
    )
      throw new MessagingError("invalid_hab_mcp_service");
    super(service, policy, audit, verify, admission);
    this.#hab = service;
    this.catalog = catalog;
  }
  protected override get writerOperations() {
    return this.catalog === "agent"
      ? habAgentOperations
      : { ...super.writerOperations, hab_resolve: "resolve" as const };
  }
  protected override get toolSchemas() {
    const schemas = habCatalogSchemas(this.catalog);
    return this.#hab.discoveryEnabled === true
      ? { ...schemas, hab_discover: habDiscoverySchema }
      : schemas;
  }
  protected override get readOperations(): ReadonlySet<string> {
    return this.#hab.discoveryEnabled === true
      ? new Set(["hab_discover"])
      : super.readOperations;
  }
  protected override writerContext(
    context: unknown,
    tool: string,
    input: unknown,
  ) {
    if (!Object.hasOwn(habCatalogSchemas(this.catalog), tool))
      return super.writerContext(context, tool, input);
    try {
      return prepareHabInvocation(this.#hab, context, tool, input, this.catalog)
        .context;
    } catch (error) {
      // A malformed call still reaches the tool, which answers with the specific error.
      if (error instanceof MessagingError && error.code === "invalid_request")
        return context;
      throw error;
    }
  }
  protected override createServer(
    resolve: DeliveryContextResolver,
    gate: DeliveryMcpGate,
  ) {
    return createHabMcpServer(
      this.#hab,
      resolve,
      gate,
      this.oauth ? HAB_OAUTH_SCOPES : undefined,
      this.catalog,
    );
  }
}
