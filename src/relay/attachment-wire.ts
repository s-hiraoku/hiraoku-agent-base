/** Optional version-1 MCP wire codec. Bounded bytes only; no file URLs or execution. */
import { z } from "zod";
import { RelayError } from "./service.ts";
import { parseUploadIntent } from "./attachments.ts";
import type { UploadReceipt } from "./attachments.ts";
import type { AttachmentChunk } from "./attachment-read.ts";
export interface AttachmentWirePolicy {
  max_attachment_bytes: number;
  chunk_bytes: number;
}
export function attachmentWirePolicy(
  value: AttachmentWirePolicy,
): Readonly<AttachmentWirePolicy> {
  if (
    !value ||
    !Number.isSafeInteger(value.max_attachment_bytes) ||
    value.max_attachment_bytes < 1 ||
    value.max_attachment_bytes > 268435456 ||
    !Number.isSafeInteger(value.chunk_bytes) ||
    value.chunk_bytes < 1 ||
    value.chunk_bytes > 1048576 ||
    Math.ceil(value.max_attachment_bytes / value.chunk_bytes) > 1024
  )
    throw new RelayError("invalid_attachment_wire_policy");
  return Object.freeze({
    max_attachment_bytes: value.max_attachment_bytes,
    chunk_bytes: value.chunk_bytes,
  });
}
export const attachmentWireId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$(?![\s\S])/);
const offset = z.number().int().nonnegative().max(268435456);
const timestamp = z
  .string()
  .max(24)
  .refine((s) => {
    const n = Date.parse(s);
    return (
      Number.isFinite(n) &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
      new Date(n).toISOString() === s
    );
  });
const descriptor = z.strictObject({
  media_type: z
    .string()
    .max(127)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$(?![\s\S])/),
  size_bytes: offset,
  sha256: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
  filename: z.string().max(1024).optional(),
});
const intent = z.strictObject({
  version: z.literal(1),
  request_id: attachmentWireId,
  message_id: attachmentWireId,
  recipient_id: attachmentWireId,
  kind: attachmentWireId,
  first_sent_at: timestamp,
  expires_at: timestamp,
  attachment: descriptor,
});
const receiptSchema = intent.extend({
  attachment_id: attachmentWireId,
  owner_id: attachmentWireId,
  state: z.enum(["uploading", "finalized", "cancelled", "expired", "rejected"]),
  created_at: timestamp,
  upload_expires_at: timestamp,
  finalized_at: timestamp.nullable(),
  terminal_at: timestamp.nullable(),
  received_bytes: offset,
  next_offset: offset,
  chunk_bytes: z.number().int().positive().max(1048576),
  reason: z
    .enum(["cancelled", "expired", "digest_mismatch", "integrity_failed"])
    .nullable(),
});
const chunkSchema = descriptor.omit({ filename: true }).extend({
  version: z.literal(1),
  sender_id: attachmentWireId,
  recipient_id: attachmentWireId,
  message_id: attachmentWireId,
  attachment_id: attachmentWireId,
  expires_at: timestamp,
  filename: z.string().max(1024).optional(),
  offset,
  next_offset: offset,
  chunk_bytes: z.number().int().positive().max(1048576),
  eof: z.boolean(),
  data_base64: z.string(),
});
export function attachmentMcpSchemas(policy: AttachmentWirePolicy) {
  const p = attachmentWirePolicy(policy),
    ref = z.strictObject({
      version: z.literal(1),
      attachment_id: attachmentWireId,
    });
  return Object.freeze({
    relay_attachment_begin: intent,
    relay_attachment_status: ref,
    relay_attachment_put: ref.extend({
      offset,
      data_base64: z.string().max(4 * Math.ceil(p.chunk_bytes / 3)),
    }),
    relay_attachment_finalize: ref,
    relay_attachment_cancel: ref,
    relay_attachment_read: z.strictObject({
      version: z.literal(1),
      sender_id: attachmentWireId,
      message_id: attachmentWireId,
      attachment_id: attachmentWireId,
      offset,
    }),
  });
}
export function decodeAttachmentBase64(
  value: unknown,
  maxBytes: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576 ||
    typeof value !== "string" ||
    value.length > 4 * Math.ceil(maxBytes / 3) ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$(?![\s\S])/.test(value)
  )
    throw new RelayError("invalid_attachment_wire");
  const data = Buffer.from(value, "base64");
  if (data.byteLength > maxBytes || data.toString("base64") !== value)
    throw new RelayError("invalid_attachment_wire");
  return new Uint8Array(data);
}
export function encodeAttachmentBase64(
  value: Uint8Array,
  maxBytes: number,
): string {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength > maxBytes ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1048576
  )
    throw new RelayError("invalid_attachment_wire");
  return Buffer.from(value).toString("base64");
}
export function parseWireUploadReceipt(
  value: unknown,
  policy: AttachmentWirePolicy,
): UploadReceipt {
  try {
    const p = attachmentWirePolicy(policy),
      r = receiptSchema.parse(value);
    parseUploadIntent(
      {
        version: r.version,
        request_id: r.request_id,
        message_id: r.message_id,
        recipient_id: r.recipient_id,
        kind: r.kind,
        first_sent_at: r.first_sent_at,
        expires_at: r.expires_at,
        attachment: r.attachment,
      },
      p.max_attachment_bytes,
    );
    const closed = ["cancelled", "expired", "rejected"].includes(r.state);
    if (
      r.chunk_bytes !== p.chunk_bytes ||
      r.next_offset !== r.received_bytes ||
      r.received_bytes > r.attachment.size_bytes ||
      (r.received_bytes < r.attachment.size_bytes &&
        r.received_bytes % p.chunk_bytes !== 0) ||
      Date.parse(r.created_at) >= Date.parse(r.expires_at) ||
      Date.parse(r.upload_expires_at) <= Date.parse(r.created_at) ||
      Date.parse(r.upload_expires_at) > Date.parse(r.expires_at) ||
      closed !== (r.terminal_at !== null) ||
      closed !== (r.reason !== null) ||
      (r.state === "uploading" && r.finalized_at !== null) ||
      (r.state === "finalized" &&
        (r.finalized_at === null ||
          r.received_bytes !== r.attachment.size_bytes)) ||
      (r.finalized_at !== null &&
        Date.parse(r.finalized_at) < Date.parse(r.created_at)) ||
      (r.terminal_at !== null &&
        Date.parse(r.terminal_at) < Date.parse(r.created_at)) ||
      (r.state === "cancelled" && r.reason !== "cancelled") ||
      (r.state === "expired" && r.reason !== "expired") ||
      (r.state === "rejected" &&
        !["digest_mismatch", "integrity_failed"].includes(r.reason!))
    )
      throw Error();
    return r;
  } catch {
    throw new RelayError("invalid_attachment_wire");
  }
}
export function parseWireAttachmentChunk(
  value: unknown,
  policy: AttachmentWirePolicy,
): AttachmentChunk {
  try {
    const p = attachmentWirePolicy(policy),
      r = chunkSchema.parse(value);
    const { data_base64, ...metadata } = r,
      data = decodeAttachmentBase64(data_base64, p.chunk_bytes);
    if (
      r.chunk_bytes !== p.chunk_bytes ||
      r.size_bytes > p.max_attachment_bytes ||
      r.offset > r.size_bytes ||
      (r.offset !== r.size_bytes && r.offset % p.chunk_bytes !== 0) ||
      data.byteLength !== Math.min(p.chunk_bytes, r.size_bytes - r.offset) ||
      r.next_offset !== r.offset + data.byteLength ||
      r.eof !== (r.next_offset === r.size_bytes)
    )
      throw Error();
    return { ...metadata, data };
  } catch {
    throw new RelayError("invalid_attachment_wire");
  }
}
export function encodeWireAttachmentChunk(
  value: AttachmentChunk,
  policy: AttachmentWirePolicy,
) {
  const p = attachmentWirePolicy(policy);
  if (!value || typeof value !== "object")
    throw new RelayError("invalid_attachment_wire");
  const { data, ...metadata } = value,
    wire = {
      ...metadata,
      data_base64: encodeAttachmentBase64(data, p.chunk_bytes),
    };
  parseWireAttachmentChunk(wire, p);
  return wire;
}
