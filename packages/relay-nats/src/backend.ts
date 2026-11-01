import { createHash } from "node:crypto";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
} from "@nats-io/jetstream";
import type {
  JetStreamClient,
  JetStreamManager,
  JsMsg,
  StreamConfig,
} from "@nats-io/jetstream";
import {
  parseSubmission,
  parseAck,
  comparisonMaterial,
  validateLimits,
  DELIVERY_TTL_MS,
} from "../../../src/relay/contract.ts";
import type { ContractLimits } from "../../../src/relay/contract.ts";
import { RelayError } from "../../../src/relay/service.ts";
import type {
  Authorization,
  Receipt,
  Delivery,
  AckReceipt,
} from "../../../src/relay/service.ts";
import { NatsJournal } from "./journal.ts";
import type { JournalOptions, Row } from "./journal.ts";

export interface JetStreamRelayOptions extends JournalOptions {
  journal_path: string;
  server: string;
  user: string;
  password: string;
  stream: string;
  subject_prefix: string;
  max_consumers: number;
  broker_max_bytes: number;
  broker_max_message_bytes: number;
  request_timeout_ms: number;
  limits: ContractLimits;
  authorization: Authorization;
}
export interface AsyncRelayOperations {
  submit(context: unknown, input: unknown): Promise<Receipt>;
  status(context: unknown, messageId: string): Promise<Receipt>;
  poll(context: unknown): Promise<Delivery | null>;
  ack(context: unknown, input: unknown): Promise<AckReceipt>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function apiCode(error: unknown): number | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}
function safeError(error: unknown): Error {
  return error instanceof RelayError
    ? error
    : new RelayError("broker_unavailable");
}

export class JetStreamRelay implements AsyncRelayOperations {
  readonly #options: JetStreamRelayOptions;
  readonly #journal: NatsJournal;
  readonly #nc: NatsConnection;
  readonly #js: JetStreamClient;
  readonly #manager: JetStreamManager;
  readonly #deliveries = new Map<string, JsMsg>();
  private constructor(
    options: JetStreamRelayOptions,
    journal: NatsJournal,
    nc: NatsConnection,
    manager: JetStreamManager,
  ) {
    this.#options = options;
    this.#journal = journal;
    this.#nc = nc;
    this.#manager = manager;
    this.#js = jetstream(nc, { timeout: options.request_timeout_ms });
  }
  static async open(input: JetStreamRelayOptions): Promise<JetStreamRelay> {
    const options = { ...input, limits: { ...input.limits } };
    validateLimits(options.limits);
    const url = new URL(options.server);
    if (
      url.protocol !== "nats:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname ||
      url.search ||
      url.hash
    )
      throw new RelayError("loopback_broker_required");
    for (const key of [
      "max_consumers",
      "broker_max_bytes",
      "broker_max_message_bytes",
      "request_timeout_ms",
    ] as const)
      if (!Number.isSafeInteger(options[key]) || options[key] < 1)
        throw new RelayError("invalid_broker_options");
    if (
      ![options.stream, options.subject_prefix].every(
        (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v),
      ) ||
      !options.user ||
      !options.password ||
      !options.authorization ||
      options.request_timeout_ms > 30_000
    )
      throw new RelayError("invalid_broker_options");
    const journal = new NatsJournal(
      options.journal_path,
      options,
      JSON.stringify([options.stream, options.subject_prefix]),
    );
    let nc: NatsConnection | undefined;
    try {
      nc = await connect({
        servers: options.server,
        user: options.user,
        pass: options.password,
        timeout: options.request_timeout_ms,
        reconnect: false,
      });
      if (nc.info?.version !== "2.15.2")
        throw new RelayError("unsupported_broker_version");
      const manager = await jetstreamManager(nc, {
        timeout: options.request_timeout_ms,
      });
      const config = {
        name: options.stream,
        subjects: [options.subject_prefix + ".>"],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: 1,
        discard: DiscardPolicy.New,
        discard_new_per_subject: true,
        max_msgs_per_subject: 1,
        max_msgs: options.max_pending,
        max_bytes: options.broker_max_bytes,
        max_msg_size: options.broker_max_message_bytes,
        max_consumers: options.max_consumers,
        max_age: nanos(DELIVERY_TTL_MS),
        duplicate_window: nanos(120_000),
        allow_msg_ttl: true,
      } satisfies Partial<StreamConfig>;
      let actual;
      try {
        actual = (await manager.streams.info(options.stream)).config;
      } catch (error) {
        if (apiCode(error) !== 10059) throw error;
        if (journal.hasLivePublished())
          throw new RelayError("broker_store_missing");
        try {
          actual = (await manager.streams.add(config)).config;
        } catch (creationError) {
          // Another process may have created the same stream while this request was in flight.
          try {
            actual = (await manager.streams.info(options.stream)).config;
          } catch {
            throw creationError;
          }
        }
      }
      for (const [key, value] of Object.entries(config)) {
        if (
          JSON.stringify(actual[key as keyof StreamConfig]) !==
          JSON.stringify(value)
        )
          throw new RelayError("broker_configuration_mismatch");
      }
      const backend = new JetStreamRelay(options, journal, nc, manager);
      await backend.maintainInternal(100);
      return backend;
    } catch (error) {
      await nc?.close();
      journal.close();
      throw safeError(error);
    }
  }
  #identity(
    context: unknown,
    operation: "submit" | "status" | "poll" | "ack" | "maintenance",
    peer?: string,
    kind?: string,
  ): string {
    let decision;
    try {
      decision = this.#options.authorization.authorize(
        context,
        operation,
        peer,
        kind,
      );
    } catch {
      throw new RelayError("forbidden");
    }
    if (!decision || !id(decision.agent_id)) throw new RelayError("forbidden");
    return decision.agent_id;
  }
  #subject(recipient: string, sender: string, message: string): string {
    return `${this.#options.subject_prefix}.${hash(recipient)}.${hash(JSON.stringify([sender, message]))}`;
  }
  async #stored(subject: string) {
    try {
      return await this.#manager.streams.getMessage(this.#options.stream, {
        last_by_subj: subject,
      });
    } catch (error) {
      if (apiCode(error) === 10037) return null;
      throw error;
    }
  }
  async #publish(row: Row): Promise<Row> {
    const current = this.#journal.row(row.sender_id, row.message_id)!;
    if (current.state !== "staging") return current;
    if (current.expires_at <= Date.now()) {
      this.#journal.status(current.sender_id, current.message_id);
      return this.#journal.row(current.sender_id, current.message_id)!;
    }
    const envelope = JSON.parse(current.outbox!);
    if (
      !envelope ||
      envelope.sender_id !== current.sender_id ||
      Object.keys(envelope).sort().join(",") !== "message,sender_id"
    )
      throw new RelayError("journal_integrity_failed");
    const original = parseSubmission(envelope.message, this.#options.limits);
    if (
      original.message_id !== current.message_id ||
      original.recipient_id !== current.recipient_id ||
      current.fingerprint !==
        this.#journal.hash(
          "submission",
          comparisonMaterial(current.sender_id, original, this.#options.limits),
        )
    )
      throw new RelayError("journal_integrity_failed");
    let stored = await this.#stored(current.subject);
    let sequence: number;
    if (!stored) {
      try {
        const ack = await this.#js.publish(
          current.subject,
          new TextEncoder().encode(current.outbox!),
          {
            msgID: hash(current.subject),
            expect: {
              streamName: this.#options.stream,
              lastSubjectSequence: 0,
            },
            ttl: `${Math.max(1, Math.ceil((current.expires_at - Date.now()) / 1000))}s`,
            timeout: this.#options.request_timeout_ms,
            retries: 1,
          },
        );
        sequence = ack.seq;
      } catch (error) {
        stored = await this.#stored(current.subject);
        if (!stored) {
          if ([10077, 10054, 10009].includes(apiCode(error) ?? -1))
            throw new RelayError("capacity_exceeded");
          throw error;
        }
        sequence = stored.seq;
      }
    } else sequence = stored.seq;
    if (stored && stored.string() !== current.outbox)
      throw new RelayError("broker_integrity_failed");
    const result = this.#journal.published(
      current.sender_id,
      current.message_id,
      sequence,
    );
    if (["acked", "expired"].includes(result.state))
      await this.#cleanup(result);
    return result;
  }
  admit(context: unknown, input: unknown): Receipt {
    const message = parseSubmission(input, this.#options.limits);
    if (message.body.parts.some((part) => part.type === "attachment"))
      throw new RelayError("attachment_store_unavailable");
    const sender = this.#identity(
      context,
      "submit",
      message.recipient_id,
      message.kind,
    );
    const authorize = () => {
      if (
        this.#identity(
          context,
          "submit",
          message.recipient_id,
          message.kind,
        ) !== sender
      )
        throw new RelayError("forbidden");
    };
    const row = this.#journal.stage(
      sender,
      message,
      comparisonMaterial(sender, message, this.#options.limits),
      this.#subject(message.recipient_id, sender, message.message_id),
      authorize,
    );
    return this.#journal.receipt(row);
  }
  async submit(context: unknown, input: unknown): Promise<Receipt> {
    const receipt = this.admit(context, input);
    try {
      const row = await this.#publish(
        this.#journal.row(receipt.sender_id, receipt.message_id)!,
      );
      return this.#journal.receipt(row);
    } catch (error) {
      throw safeError(error);
    }
  }
  async status(context: unknown, messageId: string): Promise<Receipt> {
    if (!id(messageId)) throw new RelayError("invalid_request");
    return this.#journal.status(this.#identity(context, "status"), messageId);
  }
  async #consumer(recipient: string) {
    const name = "mailbox_" + hash(recipient);
    const config = {
      durable_name: name,
      filter_subject: `${this.#options.subject_prefix}.${hash(recipient)}.>`,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      ack_wait: nanos(this.#options.lease_ms),
      max_ack_pending: 1,
      max_deliver: -1,
      max_waiting: 16,
      max_batch: 1,
    };
    let actual;
    try {
      actual = (await this.#manager.consumers.info(this.#options.stream, name))
        .config;
    } catch (error) {
      if (apiCode(error) !== 10014) throw error;
      actual = (await this.#manager.consumers.add(this.#options.stream, config))
        .config;
    }
    for (const [key, value] of Object.entries(config)) {
      if (
        JSON.stringify(actual[key as keyof typeof actual]) !==
        JSON.stringify(value)
      )
        throw new RelayError("consumer_configuration_mismatch");
    }
    return this.#js.consumers.get(this.#options.stream, name);
  }
  #decode(msg: JsMsg) {
    if (msg.data.byteLength > this.#options.broker_max_message_bytes)
      throw new RelayError("broker_integrity_failed");
    const body = msg.json<{ sender_id: string; message: unknown }>();
    if (
      !body ||
      !id(body.sender_id) ||
      Object.keys(body).sort().join(",") !== "message,sender_id"
    )
      throw new RelayError("broker_integrity_failed");
    const message = parseSubmission(body.message, this.#options.limits);
    const row = this.#journal.row(body.sender_id, message.message_id);
    if (
      !row ||
      row.recipient_id !== message.recipient_id ||
      msg.subject !== row.subject ||
      row.fingerprint !==
        this.#journal.hash(
          "submission",
          comparisonMaterial(body.sender_id, message, this.#options.limits),
        )
    )
      throw new RelayError("broker_integrity_failed");
    return { sender: body.sender_id, message, row };
  }
  async poll(context: unknown): Promise<Delivery | null> {
    const recipient = this.#identity(context, "poll");
    const pull = this.#journal.claimPull(
      recipient,
      this.#options.request_timeout_ms * 5 + 2000,
    );
    if (!pull) return null;
    try {
      const consumer = await this.#consumer(recipient);
      const msg = await consumer.next({ expires: 1000 });
      if (!msg) return null;
      let decoded;
      try {
        decoded = this.#decode(msg);
      } catch (error) {
        msg.nak(this.#options.retry_cap_ms);
        throw error;
      }
      const { sender, message } = decoded;
      const current = this.#journal.row(sender, message.message_id)!;
      if (["acked", "expired"].includes(current.state)) {
        await this.#cleanup(current);
        return null;
      }
      if (current.state === "quarantined") {
        msg.term("HAB retry exhausted");
        return null;
      }
      if (current.state === "staging") {
        msg.nak(this.#options.retry_base_ms);
        return null;
      }
      const authorize = () => {
        if (
          message.recipient_id !== recipient ||
          this.#identity(context, "poll", sender, message.kind) !== recipient
        )
          throw new RelayError("forbidden");
      };
      try {
        const delivery = this.#journal.lease(
          sender,
          message,
          msg.seq,
          authorize,
        );
        if (delivery) this.#deliveries.set(current.subject, msg);
        if (!delivery)
          msg.nak(
            Math.max(
              this.#options.retry_base_ms,
              current.next_visible_at - Date.now(),
            ),
          );
        return delivery;
      } catch (error) {
        msg.nak(this.#options.retry_base_ms);
        throw error;
      }
    } catch (error) {
      throw safeError(error);
    } finally {
      this.#journal.releasePull(recipient, pull);
    }
  }
  async #cleanup(row: Row): Promise<void> {
    if (row.cleaned) return;
    const delivery = this.#deliveries.get(row.subject);
    if (row.state === "acked" && delivery)
      await delivery.ackAck({ timeout: this.#options.request_timeout_ms });
    const stored = await this.#stored(row.subject);
    if (stored)
      await this.#manager.streams.deleteMessage(
        this.#options.stream,
        stored.seq,
        true,
      );
    if (await this.#stored(row.subject))
      throw new RelayError("broker_cleanup_pending");
    this.#journal.cleaned(row);
    this.#deliveries.delete(row.subject);
  }
  async ack(context: unknown, input: unknown): Promise<AckReceipt> {
    const request = parseAck(input, this.#options.limits);
    const recipient = this.#identity(context, "ack");
    const row = this.#journal.acknowledge(recipient, request, (current) => {
      if (
        this.#identity(context, "ack", current.sender_id, current.kind) !==
        recipient
      )
        throw new RelayError("forbidden");
    });
    try {
      await this.#cleanup(row);
    } catch {
      // The saved receipt is authoritative; durable cleanup remains visible to maintenance.
      return this.#journal.ackReceipt(row);
    }
    return this.#journal.ackReceipt(row);
  }
  private async maintainInternal(limit: number) {
    for (const row of this.#journal.pendingCleanup(limit))
      await this.#cleanup(row);
    for (const row of this.#journal.staging(limit)) await this.#publish(row);
    return this.#journal.collect(limit);
  }
  async publishPending(limit = 100): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RelayError("invalid_maintenance_limit");
    try {
      for (const row of this.#journal.staging(limit)) await this.#publish(row);
    } catch (error) {
      throw safeError(error);
    }
  }
  async maintain(context: unknown, limit = 100) {
    this.#identity(context, "maintenance");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RelayError("invalid_maintenance_limit");
    try {
      return await this.maintainInternal(limit);
    } catch (error) {
      throw safeError(error);
    }
  }
  diagnostics(context: unknown) {
    this.#identity(context, "maintenance");
    return this.#journal.diagnostics();
  }
  async close(): Promise<void> {
    await this.#nc.close();
    this.#journal.close();
  }
}
