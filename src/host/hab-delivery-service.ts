import { MessagingError } from "../messaging/delivery-service.ts";
import type {
  Authorization,
  DeliveryService,
} from "../messaging/delivery-service.ts";
import type { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { HabDirectory } from "../hab/directory.ts";
import type { SqliteDelivery } from "../delivery/sqlite-delivery.ts";

/** HAB composition: the Registry authorizes each operation and the SQLite store delivers. Public operations stay synchronous. */
export class HabDeliveryService implements DeliveryService, HabDirectory {
  readonly #registry: SQLiteHabRegistry;
  readonly #backend: SqliteDelivery;
  readonly #assertCurrent: () => void;
  constructor(
    registry: SQLiteHabRegistry,
    backend: SqliteDelivery,
    assertCurrent: () => void = () => {},
  ) {
    this.#registry = registry;
    this.#backend = backend;
    this.#assertCurrent = assertCurrent;
    this.#assertCurrent();
  }
  #run<T>(
    context: unknown,
    operation: "submit" | "status" | "poll" | "ack",
    action: (authorization: Authorization) => T,
  ): T {
    this.#assertCurrent();
    return this.#registry.withAuthorization(
      context,
      operation,
      (authorization, agentId) => {
        this.#assertCurrent();
        if (authorization.authorize(context, operation)?.agent_id !== agentId)
          throw new MessagingError("forbidden");
        return action(authorization);
      },
    );
  }
  submit(context: unknown, input: unknown) {
    return this.#run(context, "submit", (authorization) =>
      this.#backend.admitWithAuthorization(context, input, authorization),
    );
  }
  status(context: unknown, messageId: string) {
    return this.#run(context, "status", (authorization) =>
      this.#backend.statusWithAuthorization(context, messageId, authorization),
    );
  }
  poll(context: unknown) {
    return this.#run(context, "poll", (authorization) =>
      this.#backend.pollWithAuthorization(context, authorization),
    );
  }
  ack(context: unknown, input: unknown) {
    return this.#run(context, "ack", (authorization) =>
      this.#backend.ackWithAuthorization(context, input, authorization),
    );
  }
  get discoveryEnabled() {
    return this.#registry.discoveryEnabled;
  }
  discover(context: unknown, input: unknown) {
    this.#assertCurrent();
    return this.#registry.discover(context, input);
  }
  selectAddress(context: unknown, address: string, expectedAgentId?: string) {
    this.#assertCurrent();
    return this.#registry.selectAddress(context, address, expectedAgentId);
  }
  resolve(context: unknown, address: string) {
    this.#assertCurrent();
    return this.#registry.resolve(context, address);
  }
}
