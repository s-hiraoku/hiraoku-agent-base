/** Explicit one-step sending; no scheduler, identity provisioning or product logic. */
import { RelayError } from "./service.ts";
import type { Submission } from "./contract.ts";
import type { Receipt } from "./service.ts";
export type OutboxState =
  "queued" | "sending" | "accepted" | "quarantined" | "expired_unknown";
export interface OutboxRecord {
  message_id: string;
  recipient_id: string;
  expires_at: string;
  state: OutboxState;
  submit_attempts: number;
  status_attempts: number;
  reason: string | null;
  receipt: Receipt | null;
}
export interface OutboxMaintenanceResult {
  expired: number;
  purged: number;
  safety_held: number;
}
export type SendJob = { message_id: string; fence: number } & (
  { operation: "submit"; message: Submission } | { operation: "status" }
);
export interface SenderTransport {
  submit(message: Submission): Promise<Receipt>;
  status(messageId: string): Promise<Receipt>;
}
export interface SenderStore {
  enqueue(input: unknown): OutboxRecord;
  get(messageId: string): OutboxRecord;
  claim(): SendJob | null;
  confirm(job: SendJob, receipt: Receipt): void;
  defer(job: SendJob, forceStatus?: boolean): void;
  quarantine(job: SendJob, reason: string): void;
  notFound(job: SendJob): void;
}
export class DurableSender {
  readonly #store: SenderStore;
  readonly #transport: SenderTransport;
  #running = false;
  constructor(store: SenderStore, transport: SenderTransport) {
    this.#store = store;
    this.#transport = transport;
  }
  enqueue(input: unknown): OutboxRecord {
    return this.#store.enqueue(input);
  }
  get(messageId: string): OutboxRecord {
    return this.#store.get(messageId);
  }
  async sendOnce(): Promise<void> {
    if (this.#running) throw new RelayError("sender_busy");
    this.#running = true;
    try {
      const job = this.#store.claim();
      if (!job) return;
      let receipt: Receipt;
      try {
        receipt =
          job.operation === "submit"
            ? await this.#transport.submit(structuredClone(job.message))
            : await this.#transport.status(job.message_id);
      } catch (error) {
        const code =
          error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "not_found" && job.operation === "status") {
          this.#store.notFound(job);
          return;
        }
        if (code === "expired_before_acceptance") {
          this.#store.defer(job, true);
          return;
        }
        const permanent = [
          "forbidden",
          "idempotency_conflict",
          "attachment_store_unavailable",
          "invalid_contract",
          "invalid_reference",
          "unsupported_version",
        ];
        if (typeof code === "string" && permanent.includes(code)) {
          this.#store.quarantine(job, code);
          return;
        }
        this.#store.defer(job);
        throw new RelayError("sender_transport_failed");
      }
      // Storage failure intentionally keeps the durable claim until lease recovery.
      this.#store.confirm(job, receipt);
    } finally {
      this.#running = false;
    }
  }
}
