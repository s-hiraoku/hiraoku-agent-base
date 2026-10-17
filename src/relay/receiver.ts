/** Model-free orchestration: no background loop, product integration or execution. */
import { RelayError } from "./service.ts";
import type { AckRequest, Submission } from "./contract.ts";
import type { Delivery, AckReceipt } from "./service.ts";
export interface ReceiverTransport {
  poll(): Promise<Delivery | null>;
  ack(request: AckRequest): Promise<AckReceipt>;
}
export interface InboxEntry {
  sender_id: string;
  message: Submission;
  received_at: string;
  receipt_confirmed: boolean;
}
export interface ReceiverStore {
  save(delivery: Delivery): void;
  claimAck(): AckRequest | null;
  confirmAck(request: AckRequest, receipt: AckReceipt): void;
  rejectAck(
    request: AckRequest,
    reason: "invalid_ack" | "forbidden" | "ack_idempotency_conflict",
  ): void;
  inbox(): InboxEntry[];
}
export class DurableReceiver {
  readonly #store: ReceiverStore;
  readonly #transport: ReceiverTransport;
  #running = false;
  constructor(store: ReceiverStore, transport: ReceiverTransport) {
    this.#store = store;
    this.#transport = transport;
  }
  async #flush(): Promise<boolean> {
    const request = this.#store.claimAck();
    if (!request) return true;
    let receipt: AckReceipt;
    try {
      receipt = await this.#transport.ack(request);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (
        code === "invalid_ack" ||
        code === "forbidden" ||
        code === "ack_idempotency_conflict"
      ) {
        this.#store.rejectAck(request, code);
        return code === "invalid_ack";
      }
      throw new RelayError("ack_transport_failed");
    }
    this.#store.confirmAck(request, receipt);
    return true;
  }
  async receiveOnce(): Promise<void> {
    if (this.#running) throw new RelayError("receiver_busy");
    this.#running = true;
    try {
      if (!(await this.#flush())) return;
      let delivery: Delivery | null;
      try {
        delivery = await this.#transport.poll();
      } catch {
        throw new RelayError("poll_transport_failed");
      }
      if (!delivery) return;
      this.#store.save(delivery);
      await this.#flush();
    } finally {
      this.#running = false;
    }
  }
  inbox(): InboxEntry[] {
    return this.#store.inbox();
  }
}
