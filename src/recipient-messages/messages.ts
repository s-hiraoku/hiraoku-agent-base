import { createHash } from "node:crypto";
import { z } from "zod";
import {
  comparisonMaterial,
  parseSubmission,
  validateLimits,
} from "../relay/contract.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SQLiteInbox } from "../relay/sqlite-inbox.ts";
import type { SQLiteOutbox } from "../relay/sqlite-outbox.ts";
import { RecipientMessageError } from "./contract.ts";
import type {
  RecipientBinding,
  RecipientMessagePort,
  RecipientAuthorization,
  RecipientOperation,
  MessageSource,
  ExternalMessageInput,
  RecipientReplyAdmission,
} from "./contract.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const sourceSchema = z.strictObject({ sender_id: id, message_id: id });
const bindingSchema = z.strictObject({
  agent_id: id,
  owner_scope: id,
  runtime_id: id,
  authority_epoch: id,
});
const receiptSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum([
    "accepted",
    "processing",
    "waiting_owner",
    "reply_ready",
    "declined",
    "unknown",
  ]),
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fail(code: string): never {
  throw new RecipientMessageError(code);
}
function synchronous(action: () => unknown) {
  const value = action();
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    fail("recipient_invalid_port");
  }
}

/** Explicit recipient-local composition. Import/construction never starts receiving or a model. */
export class RecipientMessages {
  readonly #binding: RecipientBinding;
  readonly #inbox: Pick<SQLiteInbox, "agentId" | "withEntry">;
  readonly #outbox: Pick<SQLiteOutbox, "agentId" | "enqueueGuarded">;
  readonly #budget: RecipientReplyAdmission;
  readonly #limits: ContractLimits;
  readonly #port?: RecipientMessagePort;
  readonly #authorize: RecipientAuthorization;
  #running = false;

  constructor(options: {
    binding: RecipientBinding;
    inbox: Pick<SQLiteInbox, "agentId" | "withEntry">;
    outbox: Pick<SQLiteOutbox, "agentId" | "enqueueGuarded">;
    budget: RecipientReplyAdmission;
    limits: ContractLimits;
    recipient?: RecipientMessagePort;
    authorization?: RecipientAuthorization;
  }) {
    const binding = bindingSchema.parse(options.binding);
    validateLimits(options.limits);
    if (
      [
        options.inbox?.agentId,
        options.outbox?.agentId,
        options.budget?.agentId,
      ].some((agent) => agent !== binding.agent_id) ||
      typeof options.inbox?.withEntry !== "function" ||
      typeof options.outbox?.enqueueGuarded !== "function" ||
      typeof options.budget?.withReply !== "function" ||
      (options.authorization !== undefined &&
        typeof options.authorization !== "function")
    )
      fail("recipient_invalid_composition");
    if (options.recipient) {
      const port = options.recipient;
      if (
        JSON.stringify(bindingSchema.parse(port.binding)) !==
          JSON.stringify(binding) ||
        [port.inspect, port.admit, port.withReply].some(
          (fn) => typeof fn !== "function",
        )
      )
        fail("recipient_invalid_composition");
      this.#port = Object.freeze({
        binding: Object.freeze({ ...binding }),
        inspect: port.inspect.bind(port),
        admit: port.admit.bind(port),
        withReply: port.withReply.bind(port),
      });
    }
    this.#binding = Object.freeze(binding);
    this.#inbox = options.inbox;
    this.#outbox = options.outbox;
    this.#budget = options.budget;
    this.#limits = Object.freeze({ ...options.limits });
    this.#authorize = options.authorization ?? (() => undefined);
  }

  #guard(
    context: unknown,
    operation: RecipientOperation,
    source: MessageSource,
  ) {
    const resolve = () => {
      try {
        const value = this.#authorize(
          context,
          operation,
          Object.freeze({ ...source }),
        );
        if (value && typeof value === "object" && "then" in value) {
          void Promise.resolve(value).catch(() => {});
          throw Error();
        }
        if (
          !value ||
          value.agent_id !== this.#binding.agent_id ||
          value.authority_epoch !== this.#binding.authority_epoch
        )
          throw Error();
        return id.parse(value.actor_id);
      } catch {
        return fail("recipient_forbidden");
      }
    };
    const actor = resolve();
    return () => {
      if (resolve() !== actor) fail("recipient_forbidden");
    };
  }

  #input(source: MessageSource, check: () => void): ExternalMessageInput {
    return this.#inbox.withEntry(
      source.sender_id,
      source.message_id,
      (entry) => {
        check();
        const message = parseSubmission(entry.message, this.#limits);
        if (
          entry.receipt_confirmed !== true ||
          entry.sender_id !== source.sender_id ||
          message.message_id !== source.message_id ||
          message.recipient_id !== this.#binding.agent_id
        )
          fail("recipient_invalid_source");
        if (
          !["question", "notice"].includes(message.kind) ||
          message.in_reply_to !== null ||
          message.body.parts.some((part) => part.type !== "text")
        )
          fail("recipient_unsupported_message");
        const identity = JSON.stringify([
          this.#binding.owner_scope,
          this.#binding.agent_id,
          this.#binding.runtime_id,
          source.sender_id,
          source.message_id,
        ]);
        check();
        return {
          origin: "external_agent",
          binding: { ...this.#binding },
          source: { ...source },
          message,
          key: hash(identity),
          input_hash: hash(
            comparisonMaterial(source.sender_id, message, this.#limits),
          ),
        };
      },
    );
  }

  #receipt(input: ExternalMessageInput, value: unknown) {
    const parsed = receiptSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.key !== input.key ||
      parsed.data.input_hash !== input.input_hash
    )
      fail("recipient_invalid_receipt");
    return { phase: parsed.data.phase };
  }

  async #observe(context: unknown, source: MessageSource, admit: boolean) {
    const key = sourceSchema.parse(source);
    const current = this.#guard(context, admit ? "handoff" : "inspect", key);
    if (!this.#port) fail("recipient_input_unsupported");
    if (this.#running) fail("recipient_busy");
    this.#running = true;
    let live = true;
    const check = () => {
      if (!live) fail("recipient_forbidden");
      current();
    };
    try {
      const input = this.#input(key, check);
      const ref = Object.freeze({
        key: input.key,
        input_hash: input.input_hash,
      });
      let receipt;
      try {
        check();
        receipt = await this.#port.inspect(ref, check);
        check();
        if (receipt === null && admit)
          receipt = await this.#port.admit(structuredClone(input), check);
        check();
      } catch {
        check();
        return { phase: "unknown" as const };
      }
      return receipt === null
        ? { phase: "not_started" as const }
        : this.#receipt(input, receipt);
    } finally {
      live = false;
      this.#running = false;
    }
  }

  handoffOnce(context: unknown, source: MessageSource) {
    return this.#observe(context, source, true);
  }
  inspect(context: unknown, source: MessageSource) {
    return this.#observe(context, source, false);
  }

  enqueueReplyOnce(context: unknown, source: MessageSource) {
    const key = sourceSchema.parse(source);
    const current = this.#guard(context, "reply", key);
    if (!this.#port) fail("recipient_input_unsupported");
    if (this.#running) fail("recipient_busy");
    this.#running = true;
    let live = true,
      called = false;
    const check = () => {
      if (!live) fail("recipient_forbidden");
      current();
    };
    try {
      const input = this.#input(key, check);
      const ref = Object.freeze({
        key: input.key,
        input_hash: input.input_hash,
      });
      let result: ReturnType<SQLiteOutbox["enqueueGuarded"]> | undefined;
      synchronous(() =>
        this.#port!.withReply(ref, check, (value, checkReply) => {
          check();
          if (called || typeof checkReply !== "function")
            fail("recipient_invalid_port");
          called = true;
          const message = parseSubmission(value, this.#limits);
          if (
            input.message.kind !== "question" ||
            message.kind !== "answer" ||
            message.recipient_id !== key.sender_id ||
            message.thread_id !== input.message.thread_id ||
            message.in_reply_to?.sender_id !== key.sender_id ||
            message.in_reply_to?.message_id !== key.message_id ||
            message.body.parts.some((part) => part.type !== "text")
          )
            fail("recipient_invalid_reply");
          const guard = () => {
            check();
            synchronous(checkReply);
            check();
          };
          guard();
          const source = {
            ...key,
            recipient_id: this.#binding.agent_id,
            thread_id: input.message.thread_id,
            kind: input.message.kind,
          };
          synchronous(() =>
            this.#budget.withReply(source, message, guard, () => {
              guard();
              result = this.#outbox.enqueueGuarded(
                structuredClone(message),
                guard,
              );
              guard();
            }),
          );
          if (
            !result ||
            result.message_id !== message.message_id ||
            result.recipient_id !== key.sender_id ||
            result.expires_at !== message.expires_at
          )
            fail("recipient_invalid_port");
          return result;
        }),
      );
      check();
      if (!called || !result) fail("recipient_invalid_port");
      return {
        phase: "reply_queued" as const,
        message_id: result.message_id,
        outbox_state: result.state,
      };
    } catch (error) {
      if (error instanceof RecipientMessageError) throw error;
      fail("recipient_reply_unavailable");
    } finally {
      live = false;
      this.#running = false;
    }
  }
}
