/** HAB policy composition. No listener, scheduler, MCP registration or credential creation. */
import { RelayService } from "../relay/service.ts";
import type {
  AcceptanceStore,
  DeliveryStore,
  MaintenanceStore,
  RelayOperations,
} from "../relay/service.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SQLiteHabRegistry } from "./sqlite-registry.ts";
import type { HabDirectory } from "./directory.ts";
export class HabRelayService implements RelayOperations, HabDirectory {
  readonly #registry: SQLiteHabRegistry;
  readonly #store: AcceptanceStore & Partial<DeliveryStore & MaintenanceStore>;
  readonly #limits: ContractLimits;
  constructor(
    registry: SQLiteHabRegistry,
    store: AcceptanceStore & Partial<DeliveryStore & MaintenanceStore>,
    limits: ContractLimits,
  ) {
    this.#registry = registry;
    this.#store = store;
    this.#limits = Object.freeze({ ...limits });
  }
  submit(context: unknown, input: unknown) {
    return this.#registry.withRelay(context, "submit", (authorization) =>
      new RelayService(this.#store, this.#limits, authorization).submit(
        context,
        input,
      ),
    );
  }
  status(context: unknown, messageId: string) {
    return this.#registry.withRelay(context, "status", (authorization) =>
      new RelayService(this.#store, this.#limits, authorization).status(
        context,
        messageId,
      ),
    );
  }
  poll(context: unknown) {
    return this.#registry.withRelay(context, "poll", (authorization) =>
      new RelayService(this.#store, this.#limits, authorization).poll(context),
    );
  }
  ack(context: unknown, input: unknown) {
    return this.#registry.withRelay(context, "ack", (authorization) =>
      new RelayService(this.#store, this.#limits, authorization).ack(
        context,
        input,
      ),
    );
  }
  get discoveryEnabled() {
    return this.#registry.discoveryEnabled;
  }
  discover(context: unknown, input: unknown) {
    return this.#registry.discover(context, input);
  }
  selectAddress(context: unknown, address: string, expectedAgentId?: string) {
    return this.#registry.selectAddress(context, address, expectedAgentId);
  }
  resolve(context: unknown, address: string) {
    return this.#registry.resolve(context, address);
  }
}
