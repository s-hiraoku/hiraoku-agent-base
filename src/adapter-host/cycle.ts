/** Explicit one-command host. No scheduler, registration, model, worker or background task. */
import { z } from "zod";
import { AnswerIntents } from "../answer-intents/answers.ts";
import type { SQLiteAnswerJournal } from "../answer-intents/sqlite-journal.ts";
import { id, sourceKey } from "../adapter-policy/contract.ts";
import { InboxAnswers } from "../adapter-policy/inbox-answers.ts";
import type { SQLiteReplyBudget } from "../adapter-policy/sqlite-reply-budget.ts";
import { DurableSender } from "../agent-sdk/sender.ts";
import { parseSubmission } from "../messaging/contract.ts";
import type { ContractLimits } from "../messaging/contract.ts";
import type { SQLiteInbox } from "../agent-sdk/sqlite-inbox.ts";
import type { SQLiteOutbox } from "../agent-sdk/sqlite-outbox.ts";
import { TaskBridge } from "../task-bridge/bridge.ts";
import { TaskReplies } from "../task-bridge/replies.ts";
import type { SQLiteTaskBridgeJournal } from "../task-bridge/sqlite-journal.ts";
import { bindingSchema } from "../task-bridge/contract.ts";
import type { BridgeTasks } from "../task-bridge/contract.ts";
import { HostCore } from "../agent-sdk/receive-host.ts";
import type {
  HostAuthorizationFor,
  HostCoreOperation,
  HostSession,
  HostStepResult as CoreStepResult,
  HostTransportOptions,
} from "../agent-sdk/receive-host.ts";
import { HostError } from "../agent-sdk/sqlite-host-control.ts";
import type { SQLiteHostControl } from "../agent-sdk/sqlite-host-control.ts";
import type { SQLiteHostOwner } from "../agent-sdk/sqlite-host-owner.ts";
export type {
  HostTransport,
  ManagedOperation,
} from "../agent-sdk/receive-host.ts";
const kind = z.enum(["execution_accepted", "execution_result"]);
export const hostCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("message_enqueue"), message: z.unknown() }),
  z.strictObject({ op: z.literal("receive") }),
  z.strictObject({ op: z.literal("send") }),
  z.strictObject({ op: z.literal("inbox") }),
  z.strictObject({ op: z.literal("inbox_read"), source: sourceKey }),
  z.strictObject({
    op: z.literal("answer"),
    source: sourceKey,
    message: z.unknown(),
  }),
  z.strictObject({
    op: z.literal("answer_prepare"),
    source: sourceKey,
    body: z.unknown(),
  }),
  z.strictObject({ op: z.literal("answer_enqueue"), source: sourceKey }),
  z.strictObject({ op: z.literal("answer_inspect"), source: sourceKey }),
  z.strictObject({
    op: z.literal("answer_pending"),
    limit: z.number().int().min(1).max(1000),
    after: id.nullable().optional(),
  }),
  z.strictObject({
    op: z.literal("answer_maintain"),
    limit: z.number().int().min(1).max(1000),
  }),
  z.strictObject({ op: z.literal("task_accept"), source: sourceKey }),
  z.strictObject({
    op: z.literal("task_submit"),
    source: sourceKey,
    reconcile: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal("task_observe"), source: sourceKey }),
  z.strictObject({
    op: z.literal("task_reply_prepare"),
    source: sourceKey,
    kind,
  }),
  z.strictObject({
    op: z.literal("task_reply_enqueue"),
    source: sourceKey,
    kind,
  }),
]);
export type HostCommand = z.infer<typeof hostCommand>;

export type HostOperation = HostCommand["op"] | HostCoreOperation;
export type HostAuthorization = HostAuthorizationFor<HostCommand["op"]>;
interface AdapterHostBaseOptions {
  control: SQLiteHostControl;
  inbox: SQLiteInbox;
  outbox: SQLiteOutbox;
  budget: SQLiteReplyBudget;
  limits: ContractLimits;
  authorization?: HostAuthorization;
  task?: { journal: SQLiteTaskBridgeJournal; tasks: BridgeTasks };
  answer_intents?: SQLiteAnswerJournal;
  owner?: SQLiteHostOwner;
}
/** Exclusive trusted transport choices. Construction must start no IO. */
export type AdapterHostOptions = AdapterHostBaseOptions & HostTransportOptions;
export type HostStepResult = CoreStepResult<HostCommand["op"]>;
const cycleErrors = [
  "host_answer_intents_unconfigured",
  "host_answer_intents_required",
  "answer_intent_conflict",
  "answer_intent_not_found",
  "answer_intent_capacity_exceeded",
  "answer_intent_clock_regressed",
  "answer_intent_source_horizon_closed",
  "answer_intent_outbox_unavailable",
  "host_initial_message_required",
  "host_task_unconfigured",
  "reply_thread_exhausted",
  "reply_rate_exhausted",
  "reply_budget_capacity_exceeded",
  "reply_budget_conflict",
  "bridge_reconciliation_required",
  "bridge_busy",
];
const bridgeOperation: Partial<Record<HostOperation, string>> = {
  task_accept: "accept",
  task_submit: "submit",
  task_observe: "observe",
  task_reply_prepare: "reply",
  task_reply_enqueue: "reply",
};
function freezeTask(task: AdapterHostOptions["task"]) {
  if (!task) return undefined;
  try {
    const tasks = task.tasks;
    return Object.freeze({
      journal: task.journal,
      tasks: Object.freeze({
        binding: Object.freeze(bindingSchema.parse(tasks.binding)),
        submit: tasks.submit.bind(tasks),
        get: tasks.get.bind(tasks),
      }),
    });
  } catch {
    throw new HostError("invalid_host_composition");
  }
}
/** The adapter host: the agent-sdk receive core plus send, answers and the optional Task bridge. */
export class AdapterHostCycle extends HostCore<HostCommand["op"]> {
  readonly #outbox: SQLiteOutbox;
  readonly #budget: SQLiteReplyBudget;
  readonly #limits: ContractLimits;
  readonly #task?: ReturnType<typeof freezeTask>;
  readonly #answers?: SQLiteAnswerJournal;
  constructor(options: AdapterHostOptions) {
    const { control, outbox, budget } = options;
    const agentId = control?.agentId;
    if (
      !outbox ||
      !budget ||
      [
        options.answer_intents?.agentId ?? agentId,
        outbox.agentId,
        budget.agentId,
        options.task?.journal.receiverId ?? agentId,
      ].some((value) => value !== agentId)
    )
      throw new HostError("invalid_host_composition");
    // Validate the Task binding before the process owner is attached.
    const task = freezeTask(options.task);
    super(options, cycleErrors);
    this.#answers = options.answer_intents;
    this.#outbox = outbox;
    this.#budget = budget;
    this.#limits = Object.freeze({ ...options.limits });
    this.#task = task;
  }
  async stepOnce(
    context: unknown,
    input: HostCommand,
  ): Promise<HostStepResult> {
    this.assertIdle();
    let command: HostCommand;
    try {
      command = hostCommand.parse(input);
    } catch {
      throw new HostError("invalid_host_command");
    }
    const source = "source" in command ? command.source : null;
    return this.execute(context, command.op, source, (session) =>
      this.#run(command, source, session),
    );
  }
  async #run(
    command: HostCommand,
    source: { sender_id: string; message_id: string } | null,
    session: HostSession,
  ): Promise<unknown> {
    const { token, check, atomic, guarded, rpc } = session;
    const agentId = this.agentId,
      inbox = this.inbox;
    const localAuthority = (
      ctx: unknown,
      key: { sender_id: string; message_id: string },
    ) => {
      check();
      if (
        ctx !== token ||
        !source ||
        key.sender_id !== source.sender_id ||
        key.message_id !== source.message_id
      )
        throw new HostError("host_forbidden");
      return { agent_id: agentId, actor_id: session.actor };
    };
    const bridgeAuthority = (
      ctx: unknown,
      op: unknown,
      key: { sender_id: string; message_id: string },
    ) => {
      if (op !== bridgeOperation[command.op])
        throw new HostError("host_forbidden");
      const value = localAuthority(ctx, key);
      return { receiver_id: value.agent_id, actor_id: value.actor_id };
    };
    switch (command.op) {
      case "receive":
        return this.receiveOnce(session);
      case "send": {
        const transport = session.transport();
        const outbox = this.#outbox;
        const sender = new DurableSender(
          {
            enqueue: guarded(outbox.enqueue.bind(outbox)),
            get: guarded(outbox.get.bind(outbox)),
            claim: guarded(outbox.claim.bind(outbox)),
            confirm: guarded(outbox.confirm.bind(outbox)),
            defer: guarded(outbox.defer.bind(outbox)),
            quarantine: guarded(outbox.quarantine.bind(outbox)),
            notFound: guarded(outbox.notFound.bind(outbox)),
          },
          {
            submit: (message) => rpc(() => transport.submit(message)),
            status: (id) => rpc(() => transport.status(id)),
          },
        );
        await sender.sendOnce();
        return null;
      }
      case "message_enqueue":
        return atomic(() => {
          const message = parseSubmission(command.message, this.#limits);
          // Replies must retain their source, intent and common reply-budget boundary.
          if (
            message.in_reply_to !== null ||
            !["question", "notice", "execution_request"].includes(message.kind)
          )
            throw new HostError("host_initial_message_required");
          return this.#outbox.enqueueGuarded(message, check);
        });
      case "inbox_read":
        return atomic(() =>
          inbox.withEntry(
            command.source.sender_id,
            command.source.message_id,
            (entry) => structuredClone(entry),
          ),
        );
      case "inbox":
        return atomic(() =>
          inbox.inbox().map((entry) => ({
            sender_id: entry.sender_id,
            message_id: entry.message.message_id,
            kind: entry.message.kind,
            receipt_confirmed: entry.receipt_confirmed,
          })),
        );
      case "answer_prepare":
      case "answer_enqueue":
      case "answer_inspect":
      case "answer_pending":
      case "answer_maintain": {
        if (!this.#answers)
          throw new HostError("host_answer_intents_unconfigured");
        const answers = new AnswerIntents(
          this.#answers,
          inbox,
          this.#outbox,
          this.#budget,
          this.#limits,
          (ctx, op, key) => {
            check();
            if (
              ctx !== token ||
              command.op !== "answer_" + op ||
              (source === null
                ? key !== null
                : !key ||
                  source.sender_id !== key.sender_id ||
                  source.message_id !== key.message_id)
            )
              throw new HostError("host_forbidden");
            return { agent_id: agentId, actor_id: session.actor };
          },
        );
        return atomic(() => {
          switch (command.op) {
            case "answer_prepare":
              return answers.prepare(token, command.source, command.body);
            case "answer_enqueue":
              return answers.enqueueOnce(token, command.source);
            case "answer_inspect":
              return answers.inspect(token, command.source);
            case "answer_pending":
              return answers.pending(
                token,
                command.limit,
                command.after ?? null,
              );
            case "answer_maintain":
              return answers.maintain(token, command.limit);
          }
        });
      }
      case "answer": {
        if (this.#answers) throw new HostError("host_answer_intents_required");
        const answers = new InboxAnswers(
          this.#budget,
          inbox,
          this.#outbox,
          this.#limits,
          localAuthority,
        );
        return atomic(() =>
          answers.enqueueOnce(token, command.source, command.message),
        );
      }
    }
    if (!this.#task) throw new HostError("host_task_unconfigured");
    const j = this.#task.journal,
      tasks = this.#task.tasks;
    const journal = {
      receiverId: j.receiverId,
      binding: j.binding,
      prepare: guarded(j.prepare.bind(j)),
      begin: guarded(j.begin.bind(j)),
      get: guarded(j.get.bind(j)),
      confirm: guarded(j.confirm.bind(j)),
      uncertain: guarded(j.uncertain.bind(j)),
      observe: guarded(j.observe.bind(j)),
      prepareReply: guarded(j.prepareReply.bind(j)),
      handoffReply: guarded(j.handoffReply.bind(j)),
    };
    const bridge = new TaskBridge(
      journal,
      inbox,
      {
        binding: tasks.binding,
        submit: (key) => rpc(() => tasks.submit(key)),
        get: (id, key) => rpc(() => tasks.get(id, key)),
      },
      bridgeAuthority,
    );
    const replies = new TaskReplies(
      journal,
      this.#outbox,
      bridgeAuthority,
      this.#budget,
    );
    switch (command.op) {
      case "task_accept":
        return atomic(() => bridge.accept(token, command.source));
      case "task_submit":
        return bridge.submitOnce(
          token,
          command.source,
          command.reconcile ?? false,
        );
      case "task_observe":
        return bridge.observeOnce(token, command.source);
      case "task_reply_prepare":
        return replies.prepare(token, command.source, command.kind);
      case "task_reply_enqueue":
        return replies.enqueueOnce(token, command.source, command.kind);
    }
  }
}
