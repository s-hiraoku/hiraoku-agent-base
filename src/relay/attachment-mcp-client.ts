/** Fixed optional attachment client. No discovery, credential issuance, retry, files or scheduler. */
import { RelayMcpClient } from "./mcp-client.ts";
import type { RelayMcpClientOptions } from "./mcp-client.ts";
import { RelayError } from "./service.ts";
import { parseUploadIntent, uploadIdentifier } from "./attachments.ts";
import type { UploadIntent, UploadReceipt } from "./attachments.ts";
import { parseAttachmentRead } from "./attachment-read.ts";
import type {
  AttachmentReadRequest,
  AttachmentChunk,
} from "./attachment-read.ts";
import type { AttachmentReadTransport } from "./attachment-stager.ts";
import {
  attachmentWirePolicy,
  encodeAttachmentBase64,
  parseWireUploadReceipt,
  parseWireAttachmentChunk,
} from "./attachment-wire.ts";
import type { AttachmentWirePolicy } from "./attachment-wire.ts";
export interface AttachmentMcpClientOptions extends RelayMcpClientOptions {
  attachments: AttachmentWirePolicy;
}
export class AttachmentMcpClient
  extends RelayMcpClient
  implements AttachmentReadTransport
{
  readonly #wire: Readonly<AttachmentWirePolicy>;
  readonly #owner: string;
  constructor(options: AttachmentMcpClientOptions) {
    super(options);
    this.#wire = attachmentWirePolicy(options.attachments);
    this.#owner = options.policy.agent_id;
  }
  #receipt(value: unknown, id?: string, input?: UploadIntent): UploadReceipt {
    let r: UploadReceipt;
    try {
      r = parseWireUploadReceipt(value, this.#wire);
    } catch {
      throw new RelayError("relay_transport_failed");
    }
    if (r.owner_id !== this.#owner) throw new RelayError("forbidden");
    if (
      (id !== undefined && r.attachment_id !== id) ||
      (input &&
        (r.request_id !== input.request_id ||
          r.message_id !== input.message_id ||
          r.recipient_id !== input.recipient_id ||
          r.kind !== input.kind ||
          r.first_sent_at !== input.first_sent_at ||
          r.expires_at !== input.expires_at ||
          JSON.stringify(r.attachment) !== JSON.stringify(input.attachment)))
    )
      throw new RelayError("relay_transport_failed");
    return r;
  }
  async beginUpload(value: UploadIntent): Promise<UploadReceipt> {
    const input = parseUploadIntent(value, this.#wire.max_attachment_bytes);
    return this.#receipt(
      await this.requestTool("relay_attachment_begin", { ...input }),
      undefined,
      input,
    );
  }
  async uploadStatus(attachmentId: string): Promise<UploadReceipt> {
    const id = uploadIdentifier(attachmentId);
    return this.#receipt(
      await this.requestTool("relay_attachment_status", {
        version: 1,
        attachment_id: id,
      }),
      id,
    );
  }
  async putUploadChunk(
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<UploadReceipt> {
    const id = uploadIdentifier(attachmentId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % this.#wire.chunk_bytes !== 0 ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > this.#wire.chunk_bytes ||
      offset + bytes.byteLength > this.#wire.max_attachment_bytes
    )
      throw new RelayError("invalid_upload_chunk");
    const length = bytes.byteLength,
      data = encodeAttachmentBase64(bytes, this.#wire.chunk_bytes);
    const r = this.#receipt(
      await this.requestTool("relay_attachment_put", {
        version: 1,
        attachment_id: id,
        offset,
        data_base64: data,
      }),
      id,
    );
    if (
      ["uploading", "finalized"].includes(r.state) &&
      r.next_offset < offset + length
    )
      throw new RelayError("relay_transport_failed");
    return r;
  }
  async finalizeUpload(attachmentId: string): Promise<UploadReceipt> {
    const id = uploadIdentifier(attachmentId),
      r = this.#receipt(
        await this.requestTool("relay_attachment_finalize", {
          version: 1,
          attachment_id: id,
        }),
        id,
      );
    if (r.state === "uploading") throw new RelayError("relay_transport_failed");
    return r;
  }
  async cancelUpload(attachmentId: string): Promise<UploadReceipt> {
    const id = uploadIdentifier(attachmentId),
      r = this.#receipt(
        await this.requestTool("relay_attachment_cancel", {
          version: 1,
          attachment_id: id,
        }),
        id,
      );
    if (r.state === "uploading" || r.state === "finalized")
      throw new RelayError("relay_transport_failed");
    return r;
  }
  async read(value: AttachmentReadRequest): Promise<AttachmentChunk> {
    const input = parseAttachmentRead(value);
    if (input.offset > this.#wire.max_attachment_bytes)
      throw new RelayError("invalid_attachment_read");
    const valueFromServer = await this.requestTool("relay_attachment_read", {
      ...input,
    });
    let r: AttachmentChunk;
    try {
      r = parseWireAttachmentChunk(valueFromServer, this.#wire);
    } catch {
      throw new RelayError("relay_transport_failed");
    }
    if (r.recipient_id !== this.#owner) throw new RelayError("forbidden");
    if (
      r.sender_id !== input.sender_id ||
      r.message_id !== input.message_id ||
      r.attachment_id !== input.attachment_id ||
      r.offset !== input.offset ||
      Date.parse(r.expires_at) <= Date.now()
    )
      throw new RelayError("relay_transport_failed");
    return r;
  }
}
