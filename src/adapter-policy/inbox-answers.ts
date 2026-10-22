/** Explicit automatic answers to confirmed durable inbox entries. No model, Task or network IO. */
import { parseSubmission, validateLimits } from "../relay/contract.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { InboxEntry } from "../relay/receiver.ts";
import type { OutboxRecord } from "../relay/sender.ts";
import { ReplyBudgetError, sourceKey, authorizationGuard } from "./contract.ts";
import type { ReplySourceKey, ReplyAuthorization } from "./contract.ts";
import type { SQLiteReplyBudget } from "./sqlite-reply-budget.ts";
export interface AnswerInbox {
  withEntry<T>(
    sender: string,
    message: string,
    action: (entry: InboxEntry) => T,
  ): T;
}
export interface AnswerOutbox {
  readonly agentId: string;
  enqueueGuarded(input: unknown, guard: () => void): OutboxRecord;
}
export class InboxAnswers {
  readonly #budget: SQLiteReplyBudget;
  readonly #inbox: AnswerInbox;
  readonly #enqueue: AnswerOutbox["enqueueGuarded"];
  readonly #limits: ContractLimits;
  readonly #authorize: ReplyAuthorization;
  constructor(
    budget: SQLiteReplyBudget,
    inbox: AnswerInbox,
    outbox: AnswerOutbox,
    limits: ContractLimits,
    authorize: ReplyAuthorization = () => undefined,
  ) {
    if (
      budget.agentId !== outbox?.agentId ||
      typeof inbox?.withEntry !== "function" ||
      typeof outbox?.enqueueGuarded !== "function" ||
      typeof authorize !== "function"
    )
      throw new ReplyBudgetError("invalid_reply_composition");
    validateLimits(limits);
    this.#budget = budget;
    this.#inbox = Object.freeze({ withEntry: inbox.withEntry.bind(inbox) });
    this.#enqueue = outbox.enqueueGuarded.bind(outbox);
    this.#limits = Object.freeze({ ...limits });
    this.#authorize = authorize;
  }
  enqueueOnce(
    context: unknown,
    inputKey: ReplySourceKey,
    input: unknown,
  ): OutboxRecord {
    const key = sourceKey.parse(inputKey);
    const guard = authorizationGuard(
      this.#authorize,
      context,
      key,
      this.#budget.agentId,
    );
    const message = parseSubmission(input, this.#limits);
    if (message.kind !== "answer")
      throw new ReplyBudgetError("automatic_reply_forbidden");
    const run = (source: import("./contract.ts").ReplySource) =>
      this.#budget.withReply(source, message, guard, () => {
        const record = this.#enqueue(structuredClone(message), guard);
        if (record && typeof record === "object" && "then" in record) {
          void Promise.resolve(record).catch(() => {});
          throw new ReplyBudgetError("invalid_reply_outbox_record");
        }
        if (
          !record ||
          record.message_id !== message.message_id ||
          record.recipient_id !== message.recipient_id ||
          record.expires_at !== message.expires_at ||
          ![
            "queued",
            "sending",
            "accepted",
            "quarantined",
            "expired_unknown",
          ].includes(record.state)
        )
          throw new ReplyBudgetError("invalid_reply_outbox_record");
        return record;
      });
    // Exact retries after source release use the already admitted durable source metadata.
    const existing = this.#budget.lookup(key, "answer");
    if (existing) return run(existing.source);
    return this.#inbox.withEntry(key.sender_id, key.message_id, (entry) => {
      const received = parseSubmission(entry.message, this.#limits);
      if (
        entry.receipt_confirmed !== true ||
        entry.sender_id !== key.sender_id ||
        received.message_id !== key.message_id ||
        received.recipient_id !== this.#budget.agentId
      )
        throw new ReplyBudgetError("invalid_reply_source");
      return run({
        ...key,
        recipient_id: received.recipient_id,
        thread_id: received.thread_id,
        kind: received.kind,
      });
    });
  }
}
