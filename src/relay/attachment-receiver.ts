/** Finite receive orchestration: one RPC at most, durable checkpoint before staging, no background loop. */
import { RelayError } from "./service.ts";
import type { Delivery } from "./service.ts";
import type { ContractLimits } from "./contract.ts";
import { validateLimits } from "./contract.ts";
import type { ReceiverStore, ReceiverTransport } from "./receiver.ts";
import type { AttachmentInboxStore } from "./attachment-inbox.ts";
import { AttachmentStager } from "./attachment-stager.ts";
import type { AttachmentReadTransport } from "./attachment-stager.ts";
import type {
  ReceiveCheckpoint,
  ReceiveFailure,
} from "./receive-checkpoint.ts";
export interface AttachmentReceiveResult {
  state:
    | "idle"
    | "polled"
    | "staging"
    | "saved"
    | "acked"
    | "refreshed"
    | "deferred"
    | "closed";
}
const sync = <T>(value: T): T => {
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    throw new RelayError("receive_worker_uncertain");
  }
  return value;
};
function reason(error: unknown): ReceiveFailure {
  if (!(error instanceof RelayError)) return "local_store";
  if (error.code === "forbidden") return "forbidden";
  if (error.code === "receive_delivery_changed") return "delivery_changed";
  if (
    [
      "attachment_integrity_failed",
      "invalid_attachment_chunk",
      "attachment_staging_rejected",
      "attachment_inbox_integrity",
      "attachment_inbox_closed",
      "invalid_receive_delivery",
      "invalid_attachment_wire",
      "receive_checkpoint_integrity",
      "attachment_read_not_found",
    ].includes(error.code)
  )
    return "integrity";
  if (
    [
      "receive_worker_deadline",
      "receive_poll_failed",
      "receive_ack_failed",
      "attachment_read_transport_failed",
    ].includes(error.code)
  )
    return "transport";
  return "local_store";
}
export class AttachmentReceiver {
  readonly #checkpoint: ReceiveCheckpoint;
  readonly #inbox: ReceiverStore;
  readonly #files: AttachmentInboxStore;
  readonly #transport: ReceiverTransport & AttachmentReadTransport;
  readonly #limits: ContractLimits;
  readonly #timeout: number;
  #running = false;
  constructor(
    checkpoint: ReceiveCheckpoint,
    inbox: ReceiverStore,
    files: AttachmentInboxStore,
    transport: ReceiverTransport & AttachmentReadTransport,
    limits: ContractLimits,
    policy: { timeout_ms: number },
  ) {
    validateLimits(limits);
    for (const [port, methods] of [
      [checkpoint, ["claim", "save", "release", "complete", "fail"]],
      [inbox, ["save", "claimAck", "confirmAck", "rejectAck"]],
      [files, ["prepare", "put", "verify"]],
      [transport, ["poll", "ack", "read"]],
    ] as const)
      if (
        !port ||
        methods.some(
          (name) =>
            typeof (port as unknown as Record<string, unknown>)[name] !==
            "function",
        )
      )
        throw new RelayError("invalid_receive_worker_options");
    if (
      !policy ||
      !Number.isSafeInteger(policy.timeout_ms) ||
      policy.timeout_ms < 1 ||
      policy.timeout_ms > 30000
    )
      throw new RelayError("invalid_receive_worker_options");
    this.#checkpoint = checkpoint;
    this.#inbox = inbox;
    this.#files = files;
    this.#transport = Object.freeze({
      poll: transport.poll.bind(transport),
      ack: transport.ack.bind(transport),
      read: transport.read.bind(transport),
    });
    this.#limits = Object.freeze({ ...limits });
    this.#timeout = policy.timeout_ms;
  }
  async workOnce(): Promise<AttachmentReceiveResult> {
    if (this.#running) throw new RelayError("receive_worker_busy");
    this.#running = true;
    let settled = true,
      returned = false,
      closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const job = sync(this.#checkpoint.claim());
      if (!job) return { state: "idle" };
      if (
        !Number.isSafeInteger(job.fence) ||
        job.fence < 1 ||
        !Number.isFinite(Date.parse(job.lease_until)) ||
        new Date(job.lease_until).toISOString() !== job.lease_until
      )
        throw new RelayError("invalid_receive_worker_job");
      const deadline = Math.min(
        Date.now() + this.#timeout,
        Date.parse(job.lease_until),
      );
      const check = () => {
        if (closed || Date.now() >= deadline)
          throw new RelayError("receive_worker_deadline");
      };
      const release = (state: AttachmentReceiveResult["state"]) => {
        check();
        sync(this.#checkpoint.release(job));
        return { state };
      };
      const poll = async (): Promise<Delivery | null> => {
        check();
        let d: Delivery | null;
        try {
          d = await this.#transport.poll();
        } catch (e) {
          if (e instanceof RelayError && e.code === "forbidden") throw e;
          throw new RelayError("receive_poll_failed");
        }
        check();
        return d;
      };
      const perform = async (): Promise<AttachmentReceiveResult> => {
        check();
        // Only the existing verified inbox can issue ACK requests. The checkpoint cannot.
        const ack = sync(this.#inbox.claimAck());
        check();
        if (ack) {
          let receipt;
          try {
            receipt = await this.#transport.ack(structuredClone(ack));
          } catch (e) {
            check();
            const code = e instanceof RelayError ? e.code : undefined;
            if (
              code === "invalid_ack" ||
              code === "forbidden" ||
              code === "ack_idempotency_conflict"
            ) {
              sync(this.#inbox.rejectAck(ack, code));
              if (code === "forbidden") throw e;
              if (code === "ack_idempotency_conflict")
                throw new RelayError("receive_delivery_changed");
              return release("deferred");
            }
            throw new RelayError("receive_ack_failed");
          }
          check();
          sync(this.#inbox.confirmAck(ack, receipt));
          return release("acked");
        }
        if (job.delivery === null) {
          const d = await poll();
          if (!d) return release("idle");
          sync(this.#checkpoint.save(job, d));
          return release("polled");
        }
        const d = job.delivery,
          { sender_id, ...message } = d.message;
        if (message.body.parts.some((p) => p.type === "attachment")) {
          let read = false;
          const stager = new AttachmentStager(
            this.#files,
            {
              read: async (request) => {
                check();
                read = true;
                const chunk = await this.#transport.read(request);
                // A late read cannot write bytes after the worker deadline.
                check();
                return chunk;
              },
            },
            this.#limits,
          );
          const snapshot = await stager.stageOnce(sender_id, message);
          check();
          if (read || snapshot.state !== "verified") return release("staging");
        }
        try {
          check();
          sync(this.#inbox.save(d));
        } catch (e) {
          check();
          if (!(e instanceof RelayError) || e.code !== "expired_delivery")
            throw e;
          // Download first; renew an expired server lease only once full bytes are durable.
          const fresh = await poll();
          if (!fresh) throw new RelayError("receive_poll_failed");
          sync(this.#checkpoint.save(job, fresh));
          return release("refreshed");
        }
        check();
        sync(this.#checkpoint.complete(job));
        return { state: "saved" };
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
                reject(new RelayError("receive_worker_deadline"));
              },
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        closed = true;
        try {
          sync(this.#checkpoint.fail(job, reason(error)));
        } catch {
          throw new RelayError("receive_worker_uncertain");
        }
        if (
          error instanceof RelayError &&
          error.code === "receive_worker_uncertain"
        )
          throw error;
        return {
          state: ["forbidden", "integrity", "delivery_changed"].includes(
            reason(error),
          )
            ? "closed"
            : "deferred",
        };
      }
    } finally {
      closed = true;
      returned = true;
      clearTimeout(timer);
      if (settled) this.#running = false;
    }
  }
}
