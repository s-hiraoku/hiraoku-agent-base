import type { Submission } from "./contract.ts";
/** Fixed, secret-free reason for the host audit; never shown to the caller. */
const REASON = /^[a-z][a-z0-9_]{0,47}$/;
/** Safe, fixed details a caller may see, such as the allowed values of a field. */
export type ErrorDetails = Readonly<
  Record<string, string | number | readonly string[]>
>;
export class MessagingError extends Error {
  readonly code: string;
  /** Why the request was refused, for the host audit only (e.g. `kind_not_allowed`). */
  readonly reason: string | undefined;
  /** Public details that help the caller correct its request. */
  readonly details: ErrorDetails | undefined;
  constructor(
    code: string,
    options: { reason?: string; details?: ErrorDetails } = {},
  ) {
    super(code);
    this.name = "MessagingError";
    this.code = code;
    this.reason =
      options.reason !== undefined && REASON.test(options.reason)
        ? options.reason
        : undefined;
    this.details = options.details
      ? Object.freeze({ ...options.details })
      : undefined;
  }
}
/** A refusal that names its audit reason; the caller still sees only `forbidden`. */
export function denied(reason: string): MessagingError {
  return new MessagingError("forbidden", { reason });
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
/** One message in a recipient's host inbox, as an agent reads it. */
export interface InboxMessage {
  message_id: string;
  sender_id: string;
  kind: string;
  /** The text parts joined by blank lines. */
  text: string;
  /** Number of structured data parts; their values are not shown in the inbox. */
  data_parts: number;
  thread_id: string;
  in_reply_to: { sender_id: string; message_id: string } | null;
  sent_at: string;
  received_at: string;
  /** When it was marked read; null for a peek, which leaves it unread. */
  read_at: string | null;
  expires_at: string;
  /** Whether this read returned it for the first time. */
  new: boolean;
}
/** A message the caller received, as hab_reply needs it. Metadata only. */
export interface ReceivedMessage {
  message_id: string;
  sender_id: string;
  kind: string;
  thread_id: string;
  state: Receipt["state"];
  expires_at: string;
}
/** Public delivery surface. The SQLite store (src/delivery) is its only implementation. */
export interface DeliveryService {
  submit(context: unknown, input: unknown): Receipt;
  status(context: unknown, messageId: string): Receipt;
  poll(context: unknown): Delivery | null;
  ack(context: unknown, input: unknown): AckReceipt;
}
