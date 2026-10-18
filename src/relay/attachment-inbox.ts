/** Optional local receiver storage. No network, leases, ACK or automatic background work. */
import type { Submission } from "./contract.ts";
import type { AttachmentPart } from "./attachments.ts";
import type { AttachmentChunk } from "./attachment-read.ts";
export type AttachmentInboxState =
  "receiving" | "verified" | "released" | "rejected" | "expired";
export interface AttachmentInboxSnapshot {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  expires_at: string;
  state: AttachmentInboxState;
  files: Array<AttachmentPart & { next_offset: number; chunk_bytes: number }>;
}
/** Local trusted-host capability, never a tool argument or remote proof. */
export interface AttachmentInboxAdmission {
  withVerified<T>(senderId: string, message: Submission, action: () => T): T;
}
export interface AttachmentInboxStore extends AttachmentInboxAdmission {
  prepare(senderId: string, message: Submission): AttachmentInboxSnapshot;
  status(senderId: string, messageId: string): AttachmentInboxSnapshot;
  put(
    senderId: string,
    messageId: string,
    chunk: AttachmentChunk,
  ): AttachmentInboxSnapshot;
  verify(senderId: string, messageId: string): AttachmentInboxSnapshot;
}
