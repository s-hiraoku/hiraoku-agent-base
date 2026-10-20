import type { WriterAdmission } from "./writer-admission.ts";
/** Host-only optional catalog, retaining the bounded authenticated HTTP gateway. */
import { RelayHttpGateway } from "./http.ts";
import type { RelayHttpPolicy, RelayHttpVerifier } from "./http.ts";
import type { AuditSink } from "../security.ts";
import { relayMcpSchemas } from "./mcp.ts";
import type { RelayContextResolver, RelayMcpGate } from "./mcp.ts";
import { createAttachmentMcpServer } from "./attachment-mcp.ts";
import type { AttachmentMcpOperations } from "./attachment-mcp.ts";
import {
  attachmentMcpSchemas,
  attachmentWirePolicy,
} from "./attachment-wire.ts";
import type { AttachmentWirePolicy } from "./attachment-wire.ts";
import type { RelayOperations } from "./service.ts";
export const attachmentWriterOperations = Object.freeze({
  relay_attachment_begin: "submit",
  relay_attachment_status: "submit",
  relay_attachment_put: "submit",
  relay_attachment_finalize: "submit",
  relay_attachment_cancel: "submit",
  relay_attachment_read: "poll",
} as const);
export class AttachmentHttpGateway extends RelayHttpGateway {
  readonly #relay: RelayOperations;
  readonly #attachments: AttachmentMcpOperations;
  readonly #wire: Readonly<AttachmentWirePolicy>;
  constructor(
    service: RelayOperations,
    attachments: AttachmentMcpOperations,
    wire: AttachmentWirePolicy,
    policy: RelayHttpPolicy,
    audit: AuditSink,
    verify: RelayHttpVerifier = () => null,
    admission?: WriterAdmission,
  ) {
    super(service, policy, audit, verify, admission);
    this.#relay = service;
    this.#attachments = attachments;
    this.#wire = attachmentWirePolicy(wire);
  }
  protected override get writerOperations() {
    return { ...super.writerOperations, ...attachmentWriterOperations };
  }
  protected override get toolSchemas() {
    return { ...relayMcpSchemas, ...attachmentMcpSchemas(this.#wire) };
  }
  protected override createServer(
    resolve: RelayContextResolver,
    gate: RelayMcpGate,
  ) {
    return createAttachmentMcpServer(
      this.#relay,
      this.#attachments,
      this.#wire,
      resolve,
      gate,
    );
  }
}
