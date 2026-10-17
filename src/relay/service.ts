import { comparisonMaterial, parseSubmission } from "./contract.ts";
import type { ContractLimits, Submission } from "./contract.ts";
export class RelayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RelayError";
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
  state: "pending" | "expired";
}
/** Trusted host policy resolves identity and operation rights; no agent names supplied by callers. */
export interface Authorization {
  authorize(
    context: unknown,
    operation: "submit" | "status",
    recipientId?: string,
    kind?: string,
  ): { agent_id: string } | undefined;
}
export interface Acceptance {
  message: Submission;
  sender_id: string;
  comparison_material: string;
}
export interface ReceiptQuery {
  sender_id: string;
  message_id: string;
}
/** Resolution runs inside the store transaction. Must be synchronous, current and side-effect-free. */
export interface AcceptanceStore {
  accept(resolve: () => Acceptance): Receipt;
  status(resolve: () => ReceiptQuery): Receipt;
}
export class RelayService {
  readonly #store: AcceptanceStore;
  readonly #authorization: Authorization | undefined;
  readonly #limits: ContractLimits;
  constructor(
    store: AcceptanceStore,
    limits: ContractLimits,
    authorization?: Authorization,
  ) {
    this.#store = store;
    this.#limits = Object.freeze({ ...limits });
    this.#authorization = authorization;
  }
  #identity(
    context: unknown,
    op: "submit" | "status",
    recipient?: string,
    kind?: string,
  ) {
    let decision;
    try {
      decision = this.#authorization?.authorize(context, op, recipient, kind);
    } catch {
      throw new RelayError("forbidden");
    }
    if (
      !decision ||
      typeof decision.agent_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(decision.agent_id)
    )
      throw new RelayError("forbidden");
    return decision.agent_id;
  }
  submit(context: unknown, input: unknown): Receipt {
    // Validate a private snapshot before entering the write transaction.
    const message = parseSubmission(input, this.#limits);
    return this.#store.accept(() => {
      const sender = this.#identity(
        context,
        "submit",
        message.recipient_id,
        message.kind,
      );
      return {
        message,
        sender_id: sender,
        comparison_material: comparisonMaterial(sender, message, this.#limits),
      };
    });
  }
  status(context: unknown, messageId: string): Receipt {
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(messageId)
    )
      throw new RelayError("invalid_request");
    return this.#store.status(() => ({
      sender_id: this.#identity(context, "status"),
      message_id: messageId,
    }));
  }
}
