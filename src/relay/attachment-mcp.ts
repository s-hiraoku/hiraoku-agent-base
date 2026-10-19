/** Explicit optional upload/read tools. No maintenance, identity arguments or automatic activation. */
import type { McpServer } from "@modelcontextprotocol/server";
import { createRelayMcpServer, executeRelayMcpOperation } from "./mcp.ts";
import type { RelayContextResolver, RelayMcpGate } from "./mcp.ts";
import type { RelayOperations } from "./service.ts";
import { RelayError } from "./service.ts";
import { parseUploadIntent } from "./attachments.ts";
import type { UploadReceipt } from "./attachments.ts";
import type { AttachmentChunk } from "./attachment-read.ts";
import {
  attachmentWirePolicy,
  attachmentMcpSchemas,
  decodeAttachmentBase64,
  parseWireUploadReceipt,
  encodeWireAttachmentChunk,
} from "./attachment-wire.ts";
import type { AttachmentWirePolicy } from "./attachment-wire.ts";
export interface AttachmentMcpOperations {
  uploads: {
    begin(context: unknown, input: unknown): UploadReceipt;
    status(context: unknown, id: string): UploadReceipt;
    put(
      context: unknown,
      id: string,
      offset: number,
      bytes: Uint8Array,
    ): UploadReceipt;
    finalize(context: unknown, id: string): UploadReceipt;
    cancel(context: unknown, id: string): UploadReceipt;
  };
  reads: { read(context: unknown, input: unknown): AttachmentChunk };
}
function synchronous<T>(value: T): T {
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    throw new RelayError("relay_operation_failed");
  }
  return value;
}
export function registerAttachmentMcpTools(
  server: McpServer,
  operations: AttachmentMcpOperations,
  policy: AttachmentWirePolicy,
  resolve: RelayContextResolver = () => null,
  gate?: RelayMcpGate,
): void {
  const p = attachmentWirePolicy(policy),
    schemas = attachmentMcpSchemas(p);
  if (
    !operations ||
    ["begin", "status", "put", "finalize", "cancel"].some(
      (k) =>
        typeof (operations.uploads as unknown as Record<string, unknown>)?.[
          k
        ] !== "function",
    ) ||
    typeof operations.reads?.read !== "function"
  )
    throw new RelayError("invalid_attachment_mcp_service");
  for (const [name, schema] of Object.entries(schemas)) {
    const tool = name as keyof typeof schemas;
    server.registerTool(
      tool,
      {
        description:
          tool === "relay_attachment_read"
            ? "Read one bounded chunk for the authenticated receiver. Save and verify all bytes durably before ACK. This does not execute content."
            : "Manage one authenticated-owner upload using a fixed ID and deadline. A single call transfers at most one bounded chunk; no automatic retry or execution.",
        inputSchema: schema,
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (input: unknown) =>
        executeRelayMcpOperation(resolve, gate, (context) => {
          if (tool === "relay_attachment_read")
            return encodeWireAttachmentChunk(
              synchronous(
                operations.reads.read(
                  context,
                  schemas.relay_attachment_read.parse(input),
                ),
              ),
              p,
            );
          let result: UploadReceipt;
          if (tool === "relay_attachment_begin")
            result = synchronous(
              operations.uploads.begin(
                context,
                parseUploadIntent(input, p.max_attachment_bytes),
              ),
            );
          else if (tool === "relay_attachment_put") {
            const r = schemas.relay_attachment_put.parse(input);
            result = synchronous(
              operations.uploads.put(
                context,
                r.attachment_id,
                r.offset,
                decodeAttachmentBase64(r.data_base64, p.chunk_bytes),
              ),
            );
          } else {
            const r = schemas.relay_attachment_status.parse(input);
            const action =
              tool === "relay_attachment_status"
                ? "status"
                : tool === "relay_attachment_finalize"
                  ? "finalize"
                  : "cancel";
            result = synchronous(
              operations.uploads[action](context, r.attachment_id),
            );
          }
          return parseWireUploadReceipt(result, p);
        }),
    );
  }
}
export function createAttachmentMcpServer(
  service: RelayOperations,
  attachments: AttachmentMcpOperations,
  policy: AttachmentWirePolicy,
  resolve: RelayContextResolver = () => null,
  gate?: RelayMcpGate,
) {
  const server = createRelayMcpServer(service, resolve, gate);
  registerAttachmentMcpTools(server, attachments, policy, resolve, gate);
  return server;
}
