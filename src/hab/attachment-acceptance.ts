/** Optional HAB attachment acceptance. No new tools, download, listener or credentials. */
import { AttachmentAcceptanceService } from "../relay/attachment-acceptance.ts";
import type { AttachmentBindingStore } from "../relay/attachment-bindings.ts";
import type { AcceptanceStore } from "../relay/service.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";

export class HabAttachmentAcceptance {
  readonly #registry: SQLiteHabRegistry;
  readonly #relay: AcceptanceStore;
  readonly #bindings: AttachmentBindingStore;
  readonly #limits: ContractLimits;
  constructor(
    registry: SQLiteHabRegistry,
    relay: AcceptanceStore,
    bindings: AttachmentBindingStore,
    limits: ContractLimits,
  ) {
    this.#registry = registry;
    this.#relay = relay;
    this.#bindings = bindings;
    this.#limits = Object.freeze({ ...limits });
  }
  submit(context: unknown, input: unknown) {
    return this.#registry.withRelay(context, "submit", (authorization) =>
      new AttachmentAcceptanceService(
        this.#relay,
        this.#bindings,
        this.#limits,
        authorization,
      ).submit(context, input),
    );
  }
  status(context: unknown, messageId: string) {
    return this.#registry.withRelay(context, "status", (authorization) =>
      new AttachmentAcceptanceService(
        this.#relay,
        this.#bindings,
        this.#limits,
        authorization,
      ).status(context, messageId),
    );
  }
}
