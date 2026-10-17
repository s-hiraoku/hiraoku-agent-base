/** Optional receiver-only chunk reads. No transport, lease issuance, ACK or runtime activation. */
import { RelayError } from "./service.ts";
import type {
  Authorization,
  ReceiveAuthorization,
  Receipt,
} from "./service.ts";
import type { ContractLimits, Submission } from "./contract.ts";
import { uploadIdentifier } from "./attachments.ts";
export interface AttachmentReadRequest {
  version: 1;
  sender_id: string;
  message_id: string;
  attachment_id: string;
  offset: number;
}
export interface AttachmentReadGrant {
  sender_id: string;
  message: Submission;
  receipt: Receipt;
  /** Valid only inside the fixed Relay transaction; cannot be retained as a read capability. */
  assertCurrent(): void;
}
export interface AttachmentChunk {
  version: 1;
  sender_id: string;
  recipient_id: string;
  message_id: string;
  attachment_id: string;
  expires_at: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  filename?: string;
  offset: number;
  next_offset: number;
  chunk_bytes: number;
  eof: boolean;
  data: Uint8Array;
}
/** Fixed host ports provide the live message proof; none of these grants are caller arguments. */
export interface AttachmentReadRelay {
  withAttachmentRead<T>(
    request: AttachmentReadRequest,
    limits: ContractLimits,
    authorize: ReceiveAuthorization,
    action: (grant: AttachmentReadGrant) => T,
  ): T;
}
export interface AttachmentChunkStore {
  read(
    request: AttachmentReadRequest,
    grant: AttachmentReadGrant,
    limits: ContractLimits,
    authorize: ReceiveAuthorization,
  ): AttachmentChunk;
}
export function parseAttachmentRead(value: unknown): AttachmentReadRequest {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw Error();
    const keys = [
        "version",
        "sender_id",
        "message_id",
        "attachment_id",
        "offset",
      ],
      descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(
        (k) =>
          !Object.hasOwn(descriptors, k) ||
          !("value" in descriptors[k]) ||
          !descriptors[k].enumerable,
      )
    )
      throw Error();
    const v = value as AttachmentReadRequest;
    if (v.version !== 1 || !Number.isSafeInteger(v.offset) || v.offset < 0)
      throw Error();
    return {
      version: 1,
      sender_id: uploadIdentifier(v.sender_id),
      message_id: uploadIdentifier(v.message_id),
      attachment_id: uploadIdentifier(v.attachment_id),
      offset: v.offset,
    };
  } catch {
    throw new RelayError("invalid_attachment_read");
  }
}
const knownErrors = new Set([
  "forbidden",
  "invalid_attachment_read",
  "attachment_read_not_found",
  "attachment_integrity_failed",
  "attachment_store_unavailable",
  "attachment_binding_unavailable",
  "attachment_read_failed",
  "upload_not_migrated",
  "upload_busy",
]);
export class AttachmentReadService {
  readonly #relay: AttachmentReadRelay;
  readonly #blobs: AttachmentChunkStore;
  readonly #limits: ContractLimits;
  readonly #authorization: Authorization | undefined;
  constructor(
    relay: AttachmentReadRelay,
    blobs: AttachmentChunkStore,
    limits: ContractLimits,
    authorization?: Authorization,
  ) {
    this.#relay = relay;
    this.#blobs = blobs;
    this.#limits = Object.freeze({ ...limits });
    this.#authorization = authorization;
  }
  read(context: unknown, input: unknown): AttachmentChunk {
    try {
      const request = parseAttachmentRead(input);
      const authorize: ReceiveAuthorization = (peer) => {
        try {
          const result = this.#authorization?.authorize(
            context,
            "poll",
            peer?.sender_id,
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
      const result = this.#relay.withAttachmentRead(
        request,
        this.#limits,
        authorize,
        (grant) => this.#blobs.read(request, grant, this.#limits, authorize),
      );
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new RelayError("attachment_read_failed");
      }
      return result;
    } catch (error) {
      if (error instanceof RelayError && knownErrors.has(error.code))
        throw error;
      throw new RelayError("attachment_read_failed");
    }
  }
}
