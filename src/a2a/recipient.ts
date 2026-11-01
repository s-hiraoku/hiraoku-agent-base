import { TaskBridge } from "../task-bridge/bridge.ts";
import { TaskReplies } from "../task-bridge/replies.ts";
import {
  TaskBridgeError,
  executionRequest,
  taskEvidence,
  keySchema,
  bindingSchema,
} from "../task-bridge/contract.ts";
import type {
  BridgeAuthorization,
  BridgeTasks,
  SourceKey,
} from "../task-bridge/contract.ts";
import type { SQLiteTaskBridgeJournal } from "../task-bridge/sqlite-journal.ts";
import type { SQLiteInbox } from "../relay/sqlite-inbox.ts";
import type { BridgeReplyOutbox } from "../task-bridge/replies.ts";
import type { DurableReceiver } from "../relay/receiver.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SubmissionReceipts } from "./submission-receipts.ts";
import type { ReplyKind } from "../task-bridge/reply-contract.ts";

export function createHabA2aRecipient(options: {
  inbox: Pick<SQLiteInbox, "withEntry" | "inbox">;
  receiver: Pick<DurableReceiver, "receiveOnce">;
  journal: SQLiteTaskBridgeJournal;
  tasks: BridgeTasks;
  receipts: SubmissionReceipts;
  outbox: BridgeReplyOutbox;
  authorize: BridgeAuthorization;
  limits: ContractLimits;
  now?: () => number;
}) {
  if (
    options.receipts.receiverId !== options.journal.receiverId ||
    JSON.stringify(bindingSchema.parse(options.receipts.binding)) !==
      JSON.stringify(options.journal.binding)
  )
    throw new TaskBridgeError("invalid_bridge_composition");
  const now = options.now ?? Date.now;
  let attempt:
    | {
        context: unknown;
        source: SourceKey;
        phase: "before_rpc" | "confirmed";
        actor_id?: string;
      }
    | undefined;
  const authorize: BridgeAuthorization = (context, operation, source) => {
    const decision = options.authorize(context, operation, source);
    if (!decision) return undefined;
    const confirmed =
      operation === "submit" &&
      attempt?.phase === "confirmed" &&
      attempt.context === context &&
      attempt.source.sender_id === source.sender_id &&
      attempt.source.message_id === source.message_id;
    if ((operation === "accept" || operation === "submit") && !confirmed) {
      const entry = options.inbox
        .inbox()
        .find(
          (value) =>
            value.sender_id === source.sender_id &&
            value.message.message_id === source.message_id,
        );
      if (!entry) throw new TaskBridgeError("bridge_invalid_request");
      const accepted = executionRequest(
        entry,
        options.journal.receiverId,
        options.limits,
      );
      const at = now();
      if (
        !Number.isSafeInteger(at) ||
        at >= Date.parse(accepted.message.expires_at)
      )
        throw new TaskBridgeError("bridge_request_expired");
    }
    return decision;
  };
  const bridge = new TaskBridge(
    options.journal,
    options.inbox,
    {
      binding: options.tasks.binding,
      async submit(key) {
        const current = attempt;
        if (!current) throw new TaskBridgeError("bridge_invalid_request");
        options.receipts.prepare(current.source, key);
        const known = options.receipts.read(current.source, key);
        if (!known) {
          const decision = authorize(current.context, "submit", current.source);
          if (
            !decision ||
            decision.receiver_id !== options.journal.receiverId ||
            decision.actor_id !== current.actor_id
          )
            throw new TaskBridgeError("bridge_forbidden");
        }
        const task =
          known ??
          taskEvidence(
            await options.tasks.submit(key),
            options.tasks.binding,
            key,
          );
        options.receipts.record(current.source, key, task);
        current.phase = "confirmed";
        return task;
      },
      get: options.tasks.get.bind(options.tasks),
    },
    authorize,
  );
  const replies = new TaskReplies(options.journal, options.outbox, authorize);
  return {
    receiveOnce: () => options.receiver.receiveOnce(),
    accept: (context: unknown, source: SourceKey) =>
      bridge.accept(context, source),
    async submitOnce(context: unknown, source: SourceKey, reconcile = false) {
      if (attempt) throw new TaskBridgeError("bridge_busy");
      const key = keySchema.parse(source);
      attempt = { context, source: key, phase: "before_rpc" };
      try {
        const decision = options.authorize(context, "submit", key);
        if (!decision || decision.receiver_id !== options.journal.receiverId)
          throw new TaskBridgeError("bridge_forbidden");
        attempt.actor_id = decision.actor_id;
        const before = options.journal.get(key);
        if (options.receipts.read(key, before.request_key))
          attempt.phase = "confirmed";
        const result = await bridge.submitOnce(context, key, reconcile);
        if (
          result.state === "uncertain" &&
          options.receipts.read(key, result.request_key)
        ) {
          attempt.phase = "confirmed";
          return await bridge.submitOnce(context, key, true);
        }
        return result;
      } finally {
        attempt = undefined;
      }
    },
    observeOnce: (context: unknown, source: SourceKey) =>
      bridge.observeOnce(context, source),
    replyOnce: (context: unknown, source: SourceKey, kind: ReplyKind) => {
      replies.prepare(context, source, kind);
      return replies.enqueueOnce(context, source, kind);
    },
  };
}
