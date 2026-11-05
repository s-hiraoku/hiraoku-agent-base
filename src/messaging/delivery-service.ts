import type { Submission } from "./contract.ts";
export class MessagingError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "MessagingError";
    this.code = code;
  }
}
export interface Receipt {
  sender_id: string;
  message_id: string;
  recipient_id: string;
  receipt_id: string;
  accepted_at: string;
  expires_at: string;
  state: "pending" | "leased" | "acked" | "expired" | "quarantined";
}
/** Trusted host policy resolves identity and operation rights; no agent names supplied by callers. */
export interface Authorization {
  authorize(
    context: unknown,
    operation: "submit" | "status" | "poll" | "ack" | "maintenance",
    peerId?: string,
    kind?: string,
  ): { agent_id: string } | undefined;
}
export interface Delivery {
  message: Submission & { sender_id: string };
  generation: number;
  lease_token: string;
  lease_until: string;
}
export interface AckReceipt {
  recipient_id: string;
  sender_id: string;
  message_id: string;
  request_id: string;
  receipt_id: string;
  acked_at: string;
  state: "acked";
}
/** Public delivery surface. NATS JetStream (packages/relay-nats) is its only implementation. */
export interface DeliveryService {
  submit(context: unknown, input: unknown): Receipt;
  status(context: unknown, messageId: string): Receipt;
  poll(context: unknown): Delivery | null;
  ack(context: unknown, input: unknown): AckReceipt;
}
