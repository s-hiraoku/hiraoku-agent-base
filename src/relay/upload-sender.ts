/** Host-invoked one-operation upload pump. No loops, credential issuance or model execution. */
import { RelayError } from "./service.ts";
import { parseUploadIntent, uploadIdentifier } from "./attachments.ts";
import type { UploadIntent, UploadReceipt } from "./attachments.ts";
import type {
  UploadJournalStore,
  UploadJournalJob,
  UploadJournalFailure,
} from "./upload-journal.ts";
export interface AttachmentUploadTransport {
  beginUpload(intent: UploadIntent): Promise<UploadReceipt>;
  putUploadChunk(
    attachmentId: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<UploadReceipt>;
  finalizeUpload(attachmentId: string): Promise<UploadReceipt>;
}
export interface AttachmentUploadSenderPolicy {
  timeout_ms: number;
}
export interface AttachmentUploadWorkResult {
  state: "idle" | "progress" | "finalized" | "closed" | "deferred";
  request_id?: string;
}
function failure(error: unknown): UploadJournalFailure {
  if (!(error instanceof RelayError)) return "transport";
  if (error.code === "forbidden") return "forbidden";
  if (error.code === "invalid_upload_journal_receipt") return "invalid_receipt";
  if (
    [
      "upload_idempotency_conflict",
      "upload_chunk_conflict",
      "upload_not_found",
      "upload_bound",
      "upload_closed",
      "invalid_upload_request",
      "invalid_upload_chunk",
      "expired_before_acceptance",
      "upload_clock_skew",
      "invalid_attachment_wire",
    ].includes(error.code)
  )
    return "remote_conflict";
  return "transport";
}
function jobInput(job: UploadJournalJob) {
  try {
    const intent = parseUploadIntent(job.intent, 268435456);
    if (
      intent.request_id !== job.request_id ||
      !Number.isSafeInteger(job.fence) ||
      job.fence < 1 ||
      !Number.isSafeInteger(job.offset) ||
      job.offset < 0 ||
      job.offset > intent.attachment.size_bytes ||
      !["begin", "put", "finalize"].includes(job.operation) ||
      !Number.isFinite(Date.parse(job.lease_until)) ||
      new Date(job.lease_until).toISOString() !== job.lease_until
    )
      throw Error();
    if (job.operation === "begin") {
      if (job.attachment_id !== null || job.offset !== 0 || job.data !== null)
        throw Error();
    } else {
      uploadIdentifier(job.attachment_id);
      if (job.operation === "put") {
        if (
          !(job.data instanceof Uint8Array) ||
          job.data.length < 1 ||
          job.data.length > 1048576 ||
          job.offset + job.data.length > intent.attachment.size_bytes
        )
          throw Error();
      } else if (
        job.data !== null ||
        job.offset !== intent.attachment.size_bytes
      )
        throw Error();
    }
    return intent;
  } catch {
    throw new RelayError("invalid_upload_sender_job");
  }
}
export class AttachmentUploadSender {
  readonly #store: UploadJournalStore;
  readonly #transport: AttachmentUploadTransport;
  readonly #timeout: number;
  #running = false;
  constructor(
    store: UploadJournalStore,
    transport: AttachmentUploadTransport,
    policy: AttachmentUploadSenderPolicy,
  ) {
    if (
      !store ||
      ["claim", "accept", "fail"].some(
        (k) =>
          typeof (store as unknown as Record<string, unknown>)[k] !==
          "function",
      ) ||
      !transport ||
      ["beginUpload", "putUploadChunk", "finalizeUpload"].some(
        (k) =>
          typeof (transport as unknown as Record<string, unknown>)[k] !==
          "function",
      ) ||
      !policy ||
      !Number.isSafeInteger(policy.timeout_ms) ||
      policy.timeout_ms < 1 ||
      policy.timeout_ms > 30000
    )
      throw new RelayError("invalid_upload_sender_options");
    this.#store = store;
    this.#transport = transport;
    this.#timeout = policy.timeout_ms;
  }
  async workOnce(): Promise<AttachmentUploadWorkResult> {
    if (this.#running) throw new RelayError("upload_sender_busy");
    this.#running = true;
    let settled = true,
      returned = false,
      closed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const job = this.#store.claim();
      if (job && typeof job === "object" && "then" in job) {
        void Promise.resolve(job).catch(() => {});
        throw new RelayError("invalid_upload_sender_job");
      }
      if (!job) return { state: "idle" };
      const input = jobInput(job),
        deadline = Math.min(
          Date.now() + this.#timeout,
          Date.parse(job.lease_until),
          Date.parse(input.expires_at),
        );
      const check = () => {
        if (closed || Date.now() >= deadline)
          throw new RelayError("upload_sender_deadline");
      };
      const perform = async () => {
        check();
        let receipt: UploadReceipt;
        switch (job.operation) {
          case "begin":
            receipt = await this.#transport.beginUpload(input);
            break;
          case "put":
            receipt = await this.#transport.putUploadChunk(
              job.attachment_id!,
              job.offset,
              Uint8Array.from(job.data!),
            );
            break;
          case "finalize":
            receipt = await this.#transport.finalizeUpload(job.attachment_id!);
            break;
        }
        check();
        const result = this.#store.accept(job, receipt);
        if (result && typeof result === "object" && "then" in result) {
          void Promise.resolve(result).catch(() => {});
          throw new RelayError("upload_sender_uncertain");
        }
        check();
        return {
          state:
            result.state === "finalized"
              ? "finalized"
              : result.state === "queued"
                ? "progress"
                : "closed",
          request_id: job.request_id,
        } satisfies AttachmentUploadWorkResult;
      };
      settled = false;
      const work = perform().finally(() => {
        settled = true;
        if (returned) this.#running = false;
      });
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                closed = true;
                reject(new RelayError("upload_sender_deadline"));
              },
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        closed = true;
        try {
          const result: unknown = this.#store.fail(job, failure(error));
          if (result !== undefined) {
            if (result && typeof result === "object" && "then" in result)
              void Promise.resolve(result).catch(() => {});
            throw Error();
          }
        } catch {
          throw new RelayError("upload_sender_uncertain");
        }
        if (
          error instanceof RelayError &&
          error.code === "upload_sender_uncertain"
        )
          throw new RelayError("upload_sender_uncertain");
        return { state: "deferred", request_id: job.request_id };
      }
    } finally {
      closed = true;
      returned = true;
      clearTimeout(timer);
      if (settled) this.#running = false;
    }
  }
}
