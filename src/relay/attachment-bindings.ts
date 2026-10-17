/** Durable per-message attachment reservation port. No IO or automatic delivery activation. */
import { parseSubmission, isReplayBoundMessageId } from "./contract.ts";
import type { ContractLimits, Submission } from "./contract.ts";
import type { Receipt, Acceptance } from "./service.ts";
import { RelayError } from "./service.ts";
import type { UploadAuthorize } from "./attachments.ts";
export interface AttachmentBindingReceipt {
  owner_id: string;
  message_id: string;
  recipient_id: string;
  expires_at: string;
  attachment_ids: string[];
  state: "prepared" | "accepted" | "expired";
  receipt: Receipt | null;
}
/** Host-only port. Confirmation receipts come from a fixed trusted Relay store, never tool arguments. */
export interface AttachmentBindingStore {
  prepare(
    message: Submission,
    limits: ContractLimits,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt;
  binding(
    messageId: string,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt;
  confirm(
    messageId: string,
    receipt: Receipt,
    authorize: UploadAuthorize,
  ): AttachmentBindingReceipt;
  /** Read-only admission check, called from Relay's acceptance transaction after durable prepare. */
  checkPrepared(acceptance: Acceptance, limits: ContractLimits): void;
}
export function parseAttachmentMessage(
  input: unknown,
  limits: ContractLimits,
): Submission {
  const message = parseSubmission(input, limits);
  const parts = message.body.parts.filter((p) => p.type === "attachment");
  if (
    parts.length < 1 ||
    parts.length > 64 ||
    new Set(parts.map((p) => p.attachment_id)).size !== parts.length ||
    !isReplayBoundMessageId(message.message_id, Date.parse(message.expires_at))
  )
    throw new RelayError("invalid_attachment_message");
  return message;
}
