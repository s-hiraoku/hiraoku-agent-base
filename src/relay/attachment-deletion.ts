/** Host-only durable deletion queue. No credentials, scheduler or public tool registration. */
import type { Receipt } from "./service.ts";
export interface AttachmentDeletionPayload {
  receipt: Receipt;
  attachment_ids: string[];
  reason: "acked" | "expired";
  terminal_at: string;
}
export interface AttachmentDeletionJob extends AttachmentDeletionPayload {
  job_id: string;
  generation: number;
  lease_token: string;
  lease_until: string;
}
export interface AttachmentDeletionGrant extends AttachmentDeletionPayload {
  assertCurrent(): void;
}
export interface AttachmentDeletionPolicy {
  lease_ms: number;
  max_attempts: number;
  retry_base_ms: number;
  retry_cap_ms: number;
}
export interface AttachmentDeletionQueue {
  claimAttachmentDeletion(
    authorize: () => void,
    policy: AttachmentDeletionPolicy,
  ): AttachmentDeletionJob | null;
  withAttachmentDeletion<T>(
    job: AttachmentDeletionJob,
    authorize: () => void,
    action: (grant: AttachmentDeletionGrant) => T,
  ): T;
  completeAttachmentDeletion(
    job: AttachmentDeletionJob,
    authorize: () => void,
  ): void;
  failAttachmentDeletion(
    job: AttachmentDeletionJob,
    authorize: () => void,
    policy: AttachmentDeletionPolicy,
  ): void;
}
export interface BoundAttachmentDeletion {
  deleteBound(grant: AttachmentDeletionGrant): { deleted: number };
}
