/** Host-invoked, one-job deletion worker. No background loop or credentials. */
import { RelayError } from "./service.ts";
import type { Authorization } from "./service.ts";
import { uploadIdentifier } from "./attachments.ts";
import type {
  AttachmentDeletionQueue,
  AttachmentDeletionPolicy,
  BoundAttachmentDeletion,
} from "./attachment-deletion.ts";
export class AttachmentDeletionWorker {
  readonly #queue: AttachmentDeletionQueue;
  readonly #blobs: BoundAttachmentDeletion;
  readonly #policy: AttachmentDeletionPolicy;
  readonly #authorization: Authorization | undefined;
  #running = false;
  constructor(
    queue: AttachmentDeletionQueue,
    blobs: BoundAttachmentDeletion,
    policy: AttachmentDeletionPolicy,
    authorization?: Authorization,
  ) {
    this.#queue = queue;
    this.#blobs = blobs;
    this.#policy = Object.freeze({ ...policy });
    this.#authorization = authorization;
  }
  workOnce(context: unknown): {
    state: "idle" | "done" | "deferred";
    job_id?: string;
  } {
    if (this.#running) throw new RelayError("attachment_deletion_busy");
    this.#running = true;
    try {
      let owner: string | undefined;
      const authorize = () => {
        try {
          const result = this.#authorization?.authorize(context, "maintenance");
          if (result && typeof result === "object" && "then" in result) {
            void Promise.resolve(result).catch(() => {});
            throw Error();
          }
          if (!result) throw Error();
          const id = uploadIdentifier(result.agent_id);
          if (owner !== undefined && id !== owner) throw Error();
          owner = id;
        } catch {
          throw new RelayError("forbidden");
        }
      };
      const job = this.#queue.claimAttachmentDeletion(authorize, this.#policy);
      if (!job) return { state: "idle" };
      try {
        this.#queue.withAttachmentDeletion(job, authorize, (grant) =>
          this.#blobs.deleteBound(grant),
        );
        this.#queue.completeAttachmentDeletion(job, authorize);
        return { state: "done", job_id: job.job_id };
      } catch {
        try {
          this.#queue.failAttachmentDeletion(job, authorize, this.#policy);
        } catch {
          throw new RelayError("attachment_deletion_uncertain");
        }
        return { state: "deferred", job_id: job.job_id };
      }
    } finally {
      this.#running = false;
    }
  }
}
