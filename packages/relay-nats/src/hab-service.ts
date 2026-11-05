import { createHash } from "node:crypto";
import { parseSubmission, parseAck } from "../../../src/relay/contract.ts";
import type { ContractLimits } from "../../../src/relay/contract.ts";
import { RelayError, RelayService } from "../../../src/relay/service.ts";
import type { Authorization, Receipt } from "../../../src/relay/service.ts";
import type { SQLiteRelayStore } from "../../../src/relay/sqlite-store.ts";
import type { StoreOptions } from "../../../src/relay/sqlite-store.ts";
import {
  agentCapacityPolicy,
  assertAgentCapacity,
} from "../../../src/relay/agent-capacity.ts";
import type { SenderCapacityUsage } from "../../../src/relay/agent-capacity.ts";
import type { SQLiteHabRegistry } from "../../../src/hab/sqlite-registry.ts";
import type { JetStreamRelay } from "./backend.ts";

export interface JetStreamRoutingPolicy {
  epoch: number;
  enabled: boolean;
  recipients: readonly string[];
  kinds: readonly string[];
}
type Owner = "sqlite" | "jetstream";
export function routingDigest(policy: JetStreamRoutingPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: policy.enabled,
        recipients: [...policy.recipients].sort(),
        kinds: [...policy.kinds].sort(),
      }),
    )
    .digest("hex");
}
export class HabJetStreamService {
  readonly #registry: SQLiteHabRegistry;
  readonly #legacy: SQLiteRelayStore;
  readonly #backend: JetStreamRelay;
  readonly #limits: ContractLimits;
  readonly #routing: JetStreamRoutingPolicy;
  readonly #digest: string;
  readonly #assertCurrent: () => void;
  readonly #capacity: StoreOptions;
  constructor(
    registry: SQLiteHabRegistry,
    legacy: SQLiteRelayStore,
    backend: JetStreamRelay,
    limits: ContractLimits,
    routing: JetStreamRoutingPolicy,
    capacity: StoreOptions,
    assertCurrent: () => void,
  ) {
    this.#registry = registry;
    this.#legacy = legacy;
    this.#backend = backend;
    this.#limits = Object.freeze({ ...limits });
    this.#routing = Object.freeze({
      ...routing,
      recipients: Object.freeze([...routing.recipients]),
      kinds: Object.freeze([...routing.kinds]),
    });
    this.#digest = routingDigest(this.#routing);
    this.#assertCurrent = assertCurrent;
    this.#capacity = {
      ...capacity,
      agent_capacity: capacity.agent_capacity
        ? agentCapacityPolicy(capacity.agent_capacity, capacity)
        : undefined,
    };
    if (
      backend.prefetchWindow <
      Math.min(capacity.max_pending, capacity.max_pending_per_recipient)
    )
      throw new RelayError("insufficient_prefetch_window");
    this.#assertCurrent();
    this.#backend.configureRouting(routing.epoch, this.#digest);
  }
  #run<T>(
    context: unknown,
    operation: "submit" | "status" | "poll" | "ack",
    action: (authorization: Authorization, agentId: string) => T,
  ): T {
    this.#assertCurrent();
    return this.#registry.withRelay(
      context,
      operation,
      (authorization, agentId) => {
        this.#assertCurrent();
        if (authorization.authorize(context, operation)?.agent_id !== agentId)
          throw new RelayError("forbidden");
        return action(authorization, agentId);
      },
    );
  }
  #owner(sender: string, messageId: string): Owner | null {
    let legacy: Receipt | undefined;
    try {
      legacy = this.#legacy.status(() => ({
        sender_id: sender,
        message_id: messageId,
      }));
    } catch (error) {
      if (!(error instanceof RelayError && error.code === "not_found"))
        throw error;
    }
    const current = this.#backend.lookupReceipt(sender, messageId);
    if (legacy && current) throw new RelayError("route_owner_conflict");
    return legacy ? "sqlite" : current ? "jetstream" : null;
  }
  submit(context: unknown, input: unknown) {
    const message = parseSubmission(input, this.#limits);
    return this.#run(context, "submit", (authorization, sender) => {
      if (
        authorization.authorize(
          context,
          "submit",
          message.recipient_id,
          message.kind,
        )?.agent_id !== sender
      )
        throw new RelayError("forbidden");
      this.#backend.configureRouting(this.#routing.epoch, this.#digest);
      const existing = this.#owner(sender, message.message_id);
      const parentOwner = message.in_reply_to
        ? this.#owner(
            message.in_reply_to.sender_id,
            message.in_reply_to.message_id,
          )
        : null;
      const selected =
        this.#routing.enabled &&
        this.#routing.recipients.includes(message.recipient_id) &&
        this.#routing.kinds.includes(message.kind);
      const owner =
        existing ?? parentOwner ?? (selected ? "jetstream" : "sqlite");
      if (!existing)
        this.#checkCapacity(
          sender,
          message.recipient_id,
          Buffer.byteLength(
            JSON.stringify(
              owner === "jetstream" ? { sender_id: sender, message } : message,
            ),
          ),
        );
      return owner === "jetstream"
        ? this.#backend.admitWithAuthorization(context, message, authorization)
        : new RelayService(this.#legacy, this.#limits, authorization).submit(
            context,
            message,
          );
    });
  }
  status(context: unknown, messageId: string) {
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(messageId)
    )
      throw new RelayError("invalid_request");
    return this.#run(context, "status", (authorization, sender) => {
      const owner = this.#owner(sender, messageId);
      if (!owner) throw new RelayError("not_found");
      return owner === "jetstream"
        ? this.#backend.statusWithAuthorization(
            context,
            messageId,
            authorization,
          )
        : new RelayService(this.#legacy, this.#limits, authorization).status(
            context,
            messageId,
          );
    });
  }
  #checkCapacity(sender: string, recipientId: string, bytes: number) {
    const old = this.#legacy.capacityUsage(recipientId),
      current = this.#backend.capacityUsage(recipientId);
    const combined = new Map<string, SenderCapacityUsage>();
    for (const row of [...old.senders, ...current.senders]) {
      const previous = combined.get(row.sender_id) ?? {
        sender_id: row.sender_id,
        records: 0,
        pending: 0,
        body_bytes: 0,
      };
      combined.set(row.sender_id, {
        sender_id: row.sender_id,
        records: previous.records + row.records,
        pending: previous.pending + row.pending,
        body_bytes: previous.body_bytes + row.body_bytes,
      });
    }
    const senders = [...combined.values()];
    const totals = senders.reduce(
      (sum, row) => ({
        records: sum.records + row.records,
        pending: sum.pending + row.pending,
        body_bytes: sum.body_bytes + row.body_bytes,
      }),
      { records: 0, pending: 0, body_bytes: 0 },
    );
    const recipient = {
      records: old.recipient.records + current.recipient.records,
      pending: old.recipient.pending + current.recipient.pending,
      body_bytes: old.recipient.body_bytes + current.recipient.body_bytes,
    };
    if (
      totals.records >= this.#capacity.max_records ||
      totals.pending >= this.#capacity.max_pending ||
      totals.body_bytes + bytes > this.#capacity.max_body_bytes ||
      recipient.pending >= this.#capacity.max_pending_per_recipient
    )
      throw new RelayError("capacity_exceeded");
    if (this.#capacity.agent_capacity)
      assertAgentCapacity(
        this.#capacity.agent_capacity,
        this.#capacity,
        sender,
        bytes,
        senders,
        recipient,
      );
  }
  poll(context: unknown) {
    return this.#run(context, "poll", (authorization, recipient) => {
      if (
        this.#legacy.hasActiveLease(recipient) ||
        this.#backend.hasActiveLease(recipient)
      )
        return null;
      const first = this.#backend.pollTurn(recipient);
      const order: Owner[] = [
        first,
        first === "sqlite" ? "jetstream" : "sqlite",
      ];
      for (const owner of order) {
        const delivery =
          owner === "jetstream"
            ? this.#backend.pollWithAuthorization(context, authorization)
            : new RelayService(this.#legacy, this.#limits, authorization).poll(
                context,
              );
        if (delivery) {
          this.#backend.recordPollTurn(
            recipient,
            owner === "sqlite" ? "jetstream" : "sqlite",
          );
          return delivery;
        }
      }
      return null;
    });
  }
  ack(context: unknown, input: unknown) {
    const request = parseAck(input, this.#limits);
    return this.#run(context, "ack", (authorization, recipient) => {
      const owner = this.#owner(request.sender_id, request.message_id);
      if (!owner) throw new RelayError("invalid_ack");
      const receipts = [
        this.#legacy.lookupAckRequest(recipient, request.request_id),
        this.#backend.lookupAckRequest(recipient, request.request_id),
      ].filter((receipt) => receipt !== null);
      if (
        receipts.length > 1 ||
        receipts.some(
          (receipt) =>
            receipt.sender_id !== request.sender_id ||
            receipt.message_id !== request.message_id,
        )
      )
        throw new RelayError("ack_idempotency_conflict");
      return owner === "jetstream"
        ? this.#backend.ackWithAuthorization(context, request, authorization)
        : new RelayService(this.#legacy, this.#limits, authorization).ack(
            context,
            request,
          );
    });
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
