import { attachmentWriterOperations } from "../relay/attachment-http.ts";
import type { WriterAdmission } from "../relay/writer-admission.ts";
/** Explicit optional HAB attachment catalog; no listener or production activation. */
import { HabHttpGateway } from "./http.ts";
import { createHabMcpServer } from "./mcp.ts";
import type { HabMcpService } from "./mcp.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "../relay/http.ts";
import type { RelayContextResolver, RelayMcpGate } from "../relay/mcp.ts";
import type { AuditSink } from "../security.ts";
import { registerAttachmentMcpTools } from "../relay/attachment-mcp.ts";
import type { AttachmentMcpOperations } from "../relay/attachment-mcp.ts";
import {
  attachmentMcpSchemas,
  attachmentWirePolicy,
} from "../relay/attachment-wire.ts";
import type { AttachmentWirePolicy } from "../relay/attachment-wire.ts";
export class HabAttachmentHttpGateway extends HabHttpGateway {
  readonly #service: HabMcpService;
  readonly #attachments: AttachmentMcpOperations;
  readonly #wire: Readonly<AttachmentWirePolicy>;
  constructor(
    service: HabMcpService,
    attachments: AttachmentMcpOperations,
    wire: AttachmentWirePolicy,
    policy: RelayHttpPolicy,
    audit: AuditSink,
    verify: RelayHttpVerifier = () => null,
    admission?: WriterAdmission,
  ) {
    super(service, policy, audit, verify, admission);
    this.#service = service;
    this.#attachments = attachments;
    this.#wire = attachmentWirePolicy(wire);
  }
  protected override get writerOperations() {
    return { ...super.writerOperations, ...attachmentWriterOperations };
  }
  protected override get toolSchemas() {
    return { ...super.toolSchemas, ...attachmentMcpSchemas(this.#wire) };
  }
  protected override createServer(
    resolve: RelayContextResolver,
    gate: RelayMcpGate,
  ) {
    const server = createHabMcpServer(this.#service, resolve, gate);
    registerAttachmentMcpTools(
      server,
      this.#attachments,
      this.#wire,
      resolve,
      gate,
    );
    return server;
  }
}
