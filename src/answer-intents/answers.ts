/** Explicit local producer boundary. No scheduler, model, network, Task creation or HAB identity mapping. */
import {
  comparisonMaterial,
  parseSubmission,
  validateLimits,
} from "../relay/contract.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { OutboxRecord } from "../relay/sender.ts";
import type {
  AnswerInbox,
  AnswerOutbox,
} from "../adapter-policy/inbox-answers.ts";
import {
  id,
  sourceKey,
  checkGuard,
  ReplyBudgetError,
} from "../adapter-policy/contract.ts";
import type {
  ReplySourceKey,
  ReplyAdmission,
} from "../adapter-policy/contract.ts";
import type { SQLiteAnswerJournal } from "./sqlite-journal.ts";
export type AnswerOperation =
  "prepare" | "enqueue" | "inspect" | "pending" | "maintain";
export type AnswerAuthorization = (
  context: unknown,
  operation: AnswerOperation,
  source: Readonly<ReplySourceKey> | null,
) => { agent_id: string; actor_id: string } | undefined;
export type AnswerJournal = Pick<
  SQLiteAnswerJournal,
  "agentId" | "get" | "prepare" | "handoff" | "pending" | "maintain"
>;
export interface IntentOutbox extends AnswerOutbox {
  get(id: string): OutboxRecord;
}
export class AnswerIntents {
  readonly #journal: AnswerJournal;
  readonly #inbox: AnswerInbox;
  readonly #outbox: IntentOutbox;
  readonly #budget: ReplyAdmission;
  readonly #limits: ContractLimits;
  readonly #authorize: AnswerAuthorization;
  constructor(
    journal: AnswerJournal,
    inbox: AnswerInbox,
    outbox: IntentOutbox,
    budget: ReplyAdmission,
    limits: ContractLimits,
    authorize: AnswerAuthorization = () => undefined,
  ) {
    if (
      !journal ||
      journal.agentId !== outbox?.agentId ||
      journal.agentId !== budget?.agentId ||
      typeof inbox?.withEntry !== "function" ||
      typeof outbox?.enqueueGuarded !== "function" ||
      typeof outbox?.get !== "function" ||
      typeof budget?.withReply !== "function" ||
      typeof authorize !== "function"
    )
      throw new ReplyBudgetError("invalid_answer_intent_composition");
    validateLimits(limits);
    this.#journal = Object.freeze({
      agentId: journal.agentId,
      get: journal.get.bind(journal),
      prepare: journal.prepare.bind(journal),
      handoff: journal.handoff.bind(journal),
      pending: journal.pending.bind(journal),
      maintain: journal.maintain.bind(journal),
    });
    this.#inbox = Object.freeze({ withEntry: inbox.withEntry.bind(inbox) });
    this.#outbox = Object.freeze({
      agentId: outbox.agentId,
      enqueueGuarded: outbox.enqueueGuarded.bind(outbox),
      get: outbox.get.bind(outbox),
    });
    this.#budget = Object.freeze({
      agentId: budget.agentId,
      withReply: budget.withReply.bind(budget),
    });
    this.#limits = Object.freeze({ ...limits });
    this.#authorize = authorize;
  }
  #guard(context: unknown, op: AnswerOperation, key: ReplySourceKey | null) {
    const resolve = () => {
      try {
        const v = this.#authorize(
          context,
          op,
          key ? Object.freeze({ ...key }) : null,
        );
        if (v && typeof v === "object" && "then" in v) {
          void Promise.resolve(v).catch(() => {});
          throw Error();
        }
        if (!v || v.agent_id !== this.#journal.agentId) throw Error();
        return id.parse(v.actor_id);
      } catch {
        throw new ReplyBudgetError("answer_intent_forbidden");
      }
    };
    const actor = resolve();
    return {
      actor,
      check: () => {
        if (resolve() !== actor)
          throw new ReplyBudgetError("answer_intent_forbidden");
      },
    };
  }
  prepare(context: unknown, input: ReplySourceKey, body: unknown) {
    const key = sourceKey.parse(input),
      guard = this.#guard(context, "prepare", key);
    let live = true;
    const check = () => {
      if (!live) throw new ReplyBudgetError("answer_intent_forbidden");
      guard.check();
    };
    try {
      if (this.#journal.get(key, check))
        return this.#journal.prepare(key, body, guard.actor, null, check);
      const result = this.#inbox.withEntry(
        key.sender_id,
        key.message_id,
        (entry) => {
          check();
          const m = parseSubmission(entry.message, this.#limits);
          if (
            entry.receipt_confirmed !== true ||
            entry.sender_id !== key.sender_id ||
            m.message_id !== key.message_id ||
            m.recipient_id !== this.#journal.agentId ||
            m.kind !== "question"
          )
            throw new ReplyBudgetError("invalid_reply_source");
          return this.#journal.prepare(
            key,
            body,
            guard.actor,
            {
              source: {
                ...key,
                recipient_id: m.recipient_id,
                thread_id: m.thread_id,
                kind: m.kind,
              },
              expires_at: m.expires_at,
              fingerprint_material: comparisonMaterial(
                key.sender_id,
                m,
                this.#limits,
              ),
            },
            check,
          );
        },
      );
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new ReplyBudgetError("invalid_answer_intent_action");
      }
      return result;
    } finally {
      live = false;
    }
  }

  enqueueOnce(context: unknown, input: ReplySourceKey) {
    const key = sourceKey.parse(input),
      guard = this.#guard(context, "enqueue", key);
    let live = true;
    const check = () => {
      if (!live) throw new ReplyBudgetError("answer_intent_forbidden");
      guard.check();
    };
    try {
      return this.#journal.handoff(key, check, (source, message) => {
        let completed = false;
        const result: unknown = this.#budget.withReply(
          source,
          message,
          check,
          () => {
            check();
            const record = this.#outbox.enqueueGuarded(
              structuredClone(message),
              check,
            );
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
            completed = true;
          },
        );
        if (result && typeof result === "object" && "then" in result) {
          void Promise.resolve(result).catch(() => {});
          throw new ReplyBudgetError("invalid_reply_action");
        }
        if (!completed) throw new ReplyBudgetError("invalid_reply_action");
      });
    } finally {
      live = false;
    }
  }

  inspect(context: unknown, input: ReplySourceKey) {
    const key = sourceKey.parse(input),
      guard = this.#guard(context, "inspect", key);
    const intent = this.#journal.get(key, guard.check);
    if (!intent) return null;
    let outbox: OutboxRecord | null = null;
    try {
      outbox = this.#outbox.get(intent.reply_id);
      if (outbox && typeof outbox === "object" && "then" in outbox) {
        void Promise.resolve(outbox).catch(() => {});
        throw Error();
      }
      if (
        !outbox ||
        outbox.message_id !== intent.reply_id ||
        outbox.recipient_id !== key.sender_id ||
        outbox.expires_at !== intent.expires_at ||
        ![
          "queued",
          "sending",
          "accepted",
          "quarantined",
          "expired_unknown",
        ].includes(outbox.state)
      )
        throw Error();
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "not_found"))
        throw new ReplyBudgetError("answer_intent_outbox_unavailable");
    }
    checkGuard(guard.check);
    // Return only status, never a caller-supplied reason, receipt, body or private fingerprint.
    return { ...intent, outbox_state: outbox?.state ?? "missing" };
  }
  pending(context: unknown, limit: number, after: string | null = null) {
    const guard = this.#guard(context, "pending", null);
    return this.#journal.pending(limit, after, guard.check);
  }
  maintain(context: unknown, limit: number) {
    const guard = this.#guard(context, "maintain", null);
    return this.#journal.maintain(limit, guard.check);
  }
}
