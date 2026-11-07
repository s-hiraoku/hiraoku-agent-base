import { RELAY_OAUTH_SCOPES } from "../host/mcp/oauth-resource.ts";
import type { WriterAdmission } from "../host/mcp/writer-admission.ts";
/** Explicit HAB HTTP composition; constructing starts no listener or connection. */
import { RelayHttpGateway } from "../host/mcp/http.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "../host/mcp/http.ts";
import type { AuditSink } from "../security.ts";
import type { RelayContextResolver, RelayMcpGate } from "../host/mcp/server.ts";
import {
  createHabMcpServer,
  habMcpSchemas,
  prepareHabInvocation,
} from "./mcp.ts";
import type { HabMcpService } from "./mcp.ts";
import { habDiscoverySchema } from "./discovery.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
export class HabHttpGateway extends RelayHttpGateway {
  readonly #hab: HabMcpService;
  constructor(
    service: HabMcpService,
    policy: RelayHttpPolicy,
    audit: AuditSink,
    verify: RelayHttpVerifier = () => null,
    admission?: WriterAdmission,
  ) {
    if (typeof service?.resolve !== "function")
      throw new MessagingError("invalid_hab_mcp_service");
    super(service, policy, audit, verify, admission);
    this.#hab = service;
  }
  protected override get writerOperations() {
    return { ...super.writerOperations, relay_resolve: "resolve" as const };
  }
  protected override get toolSchemas() {
    return this.#hab.discoveryEnabled === true
      ? { ...habMcpSchemas, hab_discover: habDiscoverySchema }
      : habMcpSchemas;
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
    return Object.hasOwn(habMcpSchemas, tool)
      ? prepareHabInvocation(this.#hab, context, tool, input).context
      : super.writerContext(context, tool, input);
  }
  protected override createServer(
    resolve: RelayContextResolver,
    gate: RelayMcpGate,
  ) {
    return createHabMcpServer(
      this.#hab,
      resolve,
      gate,
      this.oauth ? RELAY_OAUTH_SCOPES : undefined,
    );
  }
}
