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
  /** Reads the caller's host inbox; unread messages become read (ACKed). Runs under `poll`. */
  inbox(
    context: unknown,
    options: {
      limit: number;
      include_read: boolean;
      message_id?: string;
      max_bytes?: number;
      peek?: boolean;
    },
  ) {
    return this.#run(context, "poll", (authorization) => {
      const messages = this.#backend.readInboxWithAuthorization(
        context,
        authorization,
        options,
      );
      const addresses = this.#registry.addressesOf(
        messages.map((message) => message.sender_id),
      );
      return messages.map((message) => ({
        ...message,
        from: addresses.get(message.sender_id) ?? null,
      }));
    });
  }
  /**
   * The caller's unread messages, left unread (ADR-021): the arrival notifier shows them to
   * the user before anything reads them. Runs under `poll`, like reading the inbox.
   */
  peek(context: unknown, options: { limit: number; max_bytes?: number }) {
    return this.inbox(context, { ...options, include_read: false, peek: true });
  }
  /** A message the caller received, for building a reply. Runs under `submit`. */
  received(context: unknown, messageId: string) {
    return this.#run(context, "submit", (authorization) => {
      const message = this.#backend.receivedWithAuthorization(
        context,
        messageId,
        authorization,
      );
      return {
        ...message,
        from:
          this.#registry
            .addressesOf([message.sender_id])
            .get(message.sender_id) ?? null,
      };
    });
  }
  /** The sender's receipt with the recipient's current address. Runs under `status`. */
  statusWithAddress(context: unknown, messageId: string) {
    return this.#run(context, "status", (authorization) => {
      const receipt = this.#backend.statusWithAuthorization(
        context,
        messageId,
        authorization,
      );
      return {
        ...receipt,
        to:
          this.#registry
            .addressesOf([receipt.recipient_id])
            .get(receipt.recipient_id) ?? null,
      };
    });
  }
  get textLimit() {
    return this.#backend.textLimit;
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
