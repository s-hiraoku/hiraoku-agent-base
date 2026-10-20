import type { WriterAdmission } from "../relay/writer-admission.ts";
/** Explicit HAB HTTP composition; constructing starts no listener or connection. */
import { RelayHttpGateway } from "../relay/http.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "../relay/http.ts";
import type { AuditSink } from "../security.ts";
import type { RelayContextResolver, RelayMcpGate } from "../relay/mcp.ts";
import { createHabMcpServer, habMcpSchemas } from "./mcp.ts";
import type { HabMcpService } from "./mcp.ts";
import { RelayError } from "../relay/service.ts";
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
      throw new RelayError("invalid_hab_mcp_service");
    super(service, policy, audit, verify, admission);
    this.#hab = service;
  }
  protected override get writerOperations() {
    return { ...super.writerOperations, relay_resolve: "resolve" as const };
  }
  protected override get toolSchemas() {
    return habMcpSchemas;
  }
  protected override createServer(
    resolve: RelayContextResolver,
    gate: RelayMcpGate,
  ) {
    return createHabMcpServer(this.#hab, resolve, gate);
  }
}
