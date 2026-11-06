import type { Submission } from "../relay/contract.ts";

export interface MessageSource {
  sender_id: string;
  message_id: string;
}
export interface RecipientBinding {
  agent_id: string;
  owner_scope: string;
  runtime_id: string;
  authority_epoch: string;
}
export interface ExternalMessageRef {
  key: string;
  input_hash: string;
}
export interface ExternalMessageInput extends ExternalMessageRef {
  origin: "external_agent";
  binding: RecipientBinding;
  source: MessageSource;
  message: Submission;
}
export type RecipientPhase =
  | "accepted"
  | "processing"
  | "waiting_owner"
  | "reply_ready"
  | "declined"
  | "unknown";
export interface RecipientReceipt extends ExternalMessageRef {
  phase: RecipientPhase;
}

export interface RecipientReplyAdmission {
  readonly agentId: string;
  withReply<T>(
    source: MessageSource & {
      recipient_id: string;
      thread_id: string;
      kind: string;
    },
    message: Submission,
    check: () => void,
    action: () => T,
  ): T;
}

/** Recipient-owned API. It supplies durable deduplication and its existing policy/approval. */
export interface RecipientMessagePort {
  readonly binding: Readonly<RecipientBinding>;
  /** Read-only exact-key reconciliation. Unknown is a receipt, never absence. */
  inspect(
    ref: Readonly<ExternalMessageRef>,
    check: () => void,
  ): Promise<RecipientReceipt | null>;
  /**
   * Invoke check inside the durable input/key admission commit before scheduling.
   * Same key/different hash must conflict. Later processing uses native current
   * authority; this admission callback expires when the caller operation ends.
   */
  admit(
    input: ExternalMessageInput,
    check: () => void,
  ): Promise<RecipientReceipt>;
  /**
   * Supply only a durably fixed reply allowed by CURRENT recipient policy/approval.
   * checkReply must revalidate that exact reply at the outbox commit boundary.
   * Preserve the envelope and consumed authorization for same-key reconciliation.
   */
  withReply<T>(
    ref: Readonly<ExternalMessageRef>,
    check: () => void,
    action: (message: Submission, checkReply: () => void) => T,
  ): T;
}

export type RecipientOperation = "handoff" | "inspect" | "reply";
export type RecipientAuthorization = (
  context: unknown,
  operation: RecipientOperation,
  source: Readonly<MessageSource>,
) =>
  { agent_id: string; actor_id: string; authority_epoch: string } | undefined;

export class RecipientMessageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
