/** Optional acceptance-only coordinator. Durable prepare precedes Relay commit; no distributed transaction. */
import { parseSubmission, ContractError } from "./contract.ts";
import type { ContractLimits, Submission } from "./contract.ts";
import { RelayService, RelayError } from "./service.ts";
import type { AcceptanceStore, Authorization, Receipt } from "./service.ts";
import { uploadIdentifier } from "./attachments.ts";
import type { UploadAuthorize } from "./attachments.ts";
import type { AttachmentBindingStore } from "./attachment-bindings.ts";
const knownErrors = new Set([
  "forbidden",
  "not_found",
  "clock_skew",
  "expired_before_acceptance",
  "capacity_exceeded",
  "invalid_reference",
  "idempotency_conflict",
  "attachment_store_unavailable",
  "attachment_binding_unavailable",
  "attachment_binding_conflict",
  "attachment_not_finalized",
  "attachment_reference_mismatch",
  "upload_not_found",
  "upload_closed",
  "upload_capacity_exceeded",
  "upload_clock_skew",
  "attachment_receipt_mismatch",
  "attachment_binding_not_found",
  "invalid_attachment_message",
  "upload_not_migrated",
  "upload_busy",
  "invalid_upload_request",
]);
export class AttachmentAcceptanceService {
  readonly #relay: AcceptanceStore;
  readonly #bindings: AttachmentBindingStore;
  readonly #limits: ContractLimits;
  readonly #authorization: Authorization | undefined;
  constructor(
    relay: AcceptanceStore,
    bindings: AttachmentBindingStore,
    limits: ContractLimits,
    authorization?: Authorization,
  ) {
    this.#relay = relay;
    this.#bindings = bindings;
    this.#limits = Object.freeze({ ...limits });
    this.#authorization = authorization;
  }
  #owner(
    context: unknown,
    message: Submission,
    peer?: { recipient_id: string; kind: string },
  ): string {
    try {
      const decision = this.#authorization?.authorize(
        context,
        "submit",
        peer?.recipient_id ?? message.recipient_id,
        peer?.kind ?? message.kind,
      );
      if (decision && typeof decision === "object" && "then" in decision) {
        void Promise.resolve(decision).catch(() => {});
        throw Error();
      }
      if (!decision) throw Error();
      return uploadIdentifier(decision.agent_id);
    } catch {
      throw new RelayError("forbidden");
    }
  }
  submit(context: unknown, input: unknown): Receipt {
    try {
      return this.#submit(context, input);
    } catch (error) {
      return this.#error(error);
    }
  }
  #error(error: unknown): never {
    if (
      error instanceof ContractError ||
      (error instanceof RelayError && knownErrors.has(error.code))
    )
      throw error;
    throw new RelayError("attachment_acceptance_failed");
  }
  #submit(context: unknown, input: unknown): Receipt {
    const message = parseSubmission(input, this.#limits),
      service = new RelayService(
        this.#relay,
        this.#limits,
        this.#authorization,
      );
    if (!message.body.parts.some((p) => p.type === "attachment"))
      return service.submit(context, message);
    const owner = this.#owner(context, message);
    const authorize: UploadAuthorize = (peer) => {
      if (this.#owner(context, message, peer) !== owner)
        throw new RelayError("forbidden");
      return owner;
    };
    let existing: Receipt | undefined;
    try {
      existing = this.#relay.status(() => {
        authorize();
        return { sender_id: owner, message_id: message.message_id };
      });
    } catch (error) {
      if (!(error instanceof RelayError && error.code === "not_found"))
        throw error;
    }
    if (!existing) this.#bindings.prepare(message, this.#limits, authorize);
    const receipt = service.submit(context, message);
    // Only a fixed trusted Relay port supplies receipts. No receipt proof is accepted in arguments.
    try {
      this.#bindings.confirm(message.message_id, receipt, authorize);
    } catch (error) {
      if (!(
        existing &&
        (receipt.state === "expired" || receipt.state === "acked") &&
        error instanceof RelayError &&
        error.code === "attachment_binding_not_found"
      ))
        throw error;
    }
    return receipt;
  }
  status(context: unknown, messageId: string): Receipt {
    try {
      return new RelayService(
        this.#relay,
        this.#limits,
        this.#authorization,
      ).status(context, messageId);
    } catch (error) {
      return this.#error(error);
    }
  }
}
