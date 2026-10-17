/** Optional, transport-neutral upload contract. No IO, listener or attachment delivery activation. */
import {
  parseSubmission,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
} from "./contract.ts";
import type { Part } from "./contract.ts";
import { RelayError } from "./service.ts";

export type AttachmentPart = Extract<Part, { type: "attachment" }>;
export interface UploadIntent {
  version: 1;
  request_id: string;
  message_id: string;
  recipient_id: string;
  kind: string;
  first_sent_at: string;
  expires_at: string;
  attachment: Omit<AttachmentPart, "type" | "attachment_id">;
}
export type UploadState =
  "uploading" | "finalized" | "cancelled" | "expired" | "rejected";
export interface UploadReceipt extends UploadIntent {
  attachment_id: string;
  owner_id: string;
  state: UploadState;
  created_at: string;
  upload_expires_at: string;
  finalized_at: string | null;
  terminal_at: string | null;
  received_bytes: number;
  next_offset: number;
  chunk_bytes: number;
  reason:
    "cancelled" | "expired" | "digest_mismatch" | "integrity_failed" | null;
}
export type UploadOperation =
  "begin" | "status" | "chunk" | "finalize" | "cancel" | "maintenance";
export interface UploadAuthorization {
  authorize(
    context: unknown,
    operation: UploadOperation,
    recipientId?: string,
    kind?: string,
  ): { agent_id: string } | undefined;
}
export type UploadAuthorize = (peer?: {
  recipient_id: string;
  kind: string;
}) => string;
export interface AttachmentUploadStore {
  begin(intent: UploadIntent, authorize: UploadAuthorize): UploadReceipt;
  status(attachmentId: string, authorize: UploadAuthorize): UploadReceipt;
  put(
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
    authorize: UploadAuthorize,
  ): UploadReceipt;
  finalize(attachmentId: string, authorize: UploadAuthorize): UploadReceipt;
  cancel(attachmentId: string, authorize: UploadAuthorize): UploadReceipt;
  maintain(
    authorize: () => void,
    limit: number,
  ): { expired: number; purged: number };
}
/** Time-bound idempotency ID allows safe finite receipt collection; caller supplies fresh entropy. */
export function makeUploadRequestId(
  firstSentAt: string,
  entropyHex: string,
): string {
  return makeReplayBoundMessageId(firstSentAt, entropyHex).replace(
    /^rm1\./,
    "au1.",
  );
}
export function uploadIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(value)
  )
    throw new RelayError("invalid_upload_request");
  return value;
}
function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (k) =>
        typeof k !== "string" ||
        (!required.includes(k) && !optional.includes(k)) ||
        !("value" in descriptors[k]) ||
        !descriptors[k].enumerable,
    ) ||
    required.some((k) => !Object.hasOwn(descriptors, k))
  )
    throw Error();
  return value as Record<string, unknown>;
}
/** Metadata uses precisely the existing version-1 message/attachment validation rules. */
export function parseUploadIntent(
  value: unknown,
  maxAttachmentBytes: number,
): UploadIntent {
  try {
    if (
      !Number.isSafeInteger(maxAttachmentBytes) ||
      maxAttachmentBytes < 1 ||
      maxAttachmentBytes > 268435456
    )
      throw Error();
    const v = record(value, [
      "version",
      "request_id",
      "message_id",
      "recipient_id",
      "kind",
      "first_sent_at",
      "expires_at",
      "attachment",
    ]);
    const a = record(
      v.attachment,
      ["media_type", "size_bytes", "sha256"],
      ["filename"],
    );
    const parsed = parseSubmission(
      {
        version: v.version,
        message_id: v.message_id,
        recipient_id: v.recipient_id,
        kind: v.kind,
        first_sent_at: v.first_sent_at,
        expires_at: v.expires_at,
        thread_id: "upload-intent",
        in_reply_to: null,
        body: {
          parts: [{ type: "attachment", attachment_id: "upload-intent", ...a }],
        },
      },
      {
        envelope_bytes: 8192,
        text_bytes: 1,
        data_bytes: 1,
        attachment_bytes: maxAttachmentBytes,
        total_attachment_bytes: maxAttachmentBytes,
        parts: 1,
        attachments: 1,
        json_depth: 8,
        json_nodes: 100,
      },
    );
    const {
      type: _type,
      attachment_id: _id,
      ...attachment
    } = parsed.body.parts[0] as AttachmentPart;
    void _type;
    void _id;
    const requestId = uploadIdentifier(v.request_id);
    if (
      !requestId.startsWith("au1.") ||
      !isReplayBoundMessageId(
        requestId.replace(/^au1\./, "rm1."),
        Date.parse(parsed.expires_at),
      )
    )
      throw Error();
    if (
      attachment.sha256.length !== 64 ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$(?![\s\S])/.test(
        attachment.media_type,
      )
    )
      throw Error();
    return {
      version: 1,
      request_id: requestId,
      message_id: uploadIdentifier(parsed.message_id),
      recipient_id: uploadIdentifier(parsed.recipient_id),
      kind: uploadIdentifier(parsed.kind),
      first_sent_at: parsed.first_sent_at,
      expires_at: parsed.expires_at,
      attachment,
    };
  } catch {
    throw new RelayError("invalid_upload_request");
  }
}
export class AttachmentUploadService {
  readonly #store: AttachmentUploadStore;
  readonly #authorization: UploadAuthorization | undefined;
  readonly #maxAttachmentBytes: number;
  readonly #chunkBytes: number;
  constructor(
    store: AttachmentUploadStore,
    limits: { max_attachment_bytes: number; chunk_bytes: number },
    authorization?: UploadAuthorization,
  ) {
    if (
      !Number.isSafeInteger(limits?.max_attachment_bytes) ||
      limits.max_attachment_bytes < 1 ||
      limits.max_attachment_bytes > 268435456 ||
      !Number.isSafeInteger(limits.chunk_bytes) ||
      limits.chunk_bytes < 1 ||
      limits.chunk_bytes > 1048576
    )
      throw new RelayError("invalid_upload_limits");
    this.#store = store;
    this.#authorization = authorization;
    this.#maxAttachmentBytes = limits.max_attachment_bytes;
    this.#chunkBytes = limits.chunk_bytes;
  }
  #authorize(context: unknown, operation: UploadOperation): UploadAuthorize {
    return (peer) => {
      try {
        const result = this.#authorization?.authorize(
          context,
          operation,
          peer?.recipient_id,
          peer?.kind,
        );
        if (result && typeof result === "object" && "then" in result) {
          void Promise.resolve(result).catch(() => {});
          throw Error();
        }
        if (!result) throw Error();
        return uploadIdentifier(result.agent_id);
      } catch {
        throw new RelayError("forbidden");
      }
    };
  }
  begin(context: unknown, value: unknown) {
    return this.#store.begin(
      parseUploadIntent(value, this.#maxAttachmentBytes),
      this.#authorize(context, "begin"),
    );
  }
  status(context: unknown, attachmentId: string) {
    return this.#store.status(
      uploadIdentifier(attachmentId),
      this.#authorize(context, "status"),
    );
  }
  put(
    context: unknown,
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ) {
    uploadIdentifier(attachmentId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > this.#chunkBytes
    )
      throw new RelayError("invalid_upload_chunk");
    return this.#store.put(
      attachmentId,
      offset,
      Uint8Array.from(bytes),
      this.#authorize(context, "chunk"),
    );
  }
  finalize(context: unknown, attachmentId: string) {
    return this.#store.finalize(
      uploadIdentifier(attachmentId),
      this.#authorize(context, "finalize"),
    );
  }
  cancel(context: unknown, attachmentId: string) {
    return this.#store.cancel(
      uploadIdentifier(attachmentId),
      this.#authorize(context, "cancel"),
    );
  }
  maintain(context: unknown, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RelayError("invalid_upload_request");
    return this.#store.maintain(() => {
      this.#authorize(context, "maintenance")();
    }, limit);
  }
}
