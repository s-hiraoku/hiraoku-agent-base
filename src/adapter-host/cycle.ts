/** Explicit one-command host. No scheduler, registration, model, worker or background task. */
import { z } from "zod";
import type { SQLiteHostOwner, HostOwnership } from "./sqlite-owner.ts";
import { AnswerIntents } from "../answer-intents/answers.ts";
import type { SQLiteAnswerJournal } from "../answer-intents/sqlite-journal.ts";
import { id, sourceKey } from "../adapter-policy/contract.ts";
import { InboxAnswers } from "../adapter-policy/inbox-answers.ts";
import type { SQLiteReplyBudget } from "../adapter-policy/sqlite-reply-budget.ts";
import { DurableSender } from "../relay/sender.ts";
import { DurableReceiver } from "../relay/receiver.ts";
import type { SenderTransport } from "../relay/sender.ts";
import type { ReceiverTransport } from "../relay/receiver.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { SQLiteInbox } from "../relay/sqlite-inbox.ts";
import type { SQLiteOutbox } from "../relay/sqlite-outbox.ts";
import { TaskBridge } from "../task-bridge/bridge.ts";
import { TaskReplies } from "../task-bridge/replies.ts";
import type { SQLiteTaskBridgeJournal } from "../task-bridge/sqlite-journal.ts";
import { bindingSchema } from "../task-bridge/contract.ts";
import type { BridgeTasks } from "../task-bridge/contract.ts";
import { HostError } from "./sqlite-control.ts";
import type { SQLiteHostControl } from "./sqlite-control.ts";
const kind = z.enum(["execution_accepted", "execution_result"]);
export const hostCommand = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("receive") }),
  z.strictObject({ op: z.literal("send") }),
  z.strictObject({ op: z.literal("inbox") }),
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
export type HostOperation =
  HostCommand["op"] | "control" | "status" | "release_owner";
export type HostAuthorization = (
  context: unknown,
  operation: HostOperation,
  source: Readonly<{ sender_id: string; message_id: string }> | null,
) => { agent_id: string; actor_id: string } | undefined;
export interface HostTransport extends SenderTransport, ReceiverTransport {
  readonly agentId: string;
  /** Underlying work, including timeouts still settling. Must fail closed on unknown state. */
  readonly activeRequests: number;
}
export interface AdapterHostOptions {
  control: SQLiteHostControl;
  inbox: SQLiteInbox;
  outbox: SQLiteOutbox;
  budget: SQLiteReplyBudget;
  limits: ContractLimits;
  /** Pure factory: construct a fixed client using only the supplied fetch port. */
  transport: (fetch: typeof globalThis.fetch) => HostTransport;
  network?: typeof globalThis.fetch;
  authorization?: HostAuthorization;
  task?: { journal: SQLiteTaskBridgeJournal; tasks: BridgeTasks };
  answer_intents?: SQLiteAnswerJournal;
  owner?: SQLiteHostOwner;
}
export interface HostStepResult {
  op: HostCommand["op"];
  state: "done" | "incomplete";
  reason: string | null;
  value: unknown;
}
export class AdapterHostCycle {
  readonly #control: SQLiteHostControl;
  readonly #inbox: SQLiteInbox;
  readonly #outbox: SQLiteOutbox;
  readonly #budget: SQLiteReplyBudget;
  readonly #limits: ContractLimits;
  readonly #factory: AdapterHostOptions["transport"];
  readonly #network: typeof globalThis.fetch;
  readonly #authorize: HostAuthorization;
  readonly #task?: NonNullable<AdapterHostOptions["task"]>;
  readonly #answers?: SQLiteAnswerJournal;
  readonly #ownership?: HostOwnership;
  #running = false;
  #draining: HostTransport[] = [];
  #networkPending = new Set<Promise<Response>>();
  constructor(options: AdapterHostOptions) {
    const { control, inbox, outbox, budget } = options;
    if (
      !control ||
      !inbox ||
      !outbox ||
      !budget ||
      [
        options.owner?.agentId ?? control.agentId,
        options.answer_intents?.agentId ?? control.agentId,
        inbox.agentId,
        outbox.agentId,
        budget.agentId,
        options.task?.journal.receiverId ?? control.agentId,
      ].some((value) => value !== control.agentId) ||
      typeof options.transport !== "function" ||
      (options.network !== undefined &&
        typeof options.network !== "function") ||
      (options.authorization !== undefined &&
        typeof options.authorization !== "function")
    )
      throw new HostError("invalid_host_composition");
    this.#answers = options.answer_intents;
    this.#control = control;
    this.#inbox = inbox;
    this.#outbox = outbox;
    this.#budget = budget;
    this.#limits = Object.freeze({ ...options.limits });
    this.#factory = options.transport;
    this.#network = options.network ?? globalThis.fetch;
    this.#authorize = options.authorization ?? (() => undefined);
    if (options.task) {
      try {
        const tasks = options.task.tasks;
        this.#task = Object.freeze({
          journal: options.task.journal,
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
    if (options.owner) this.#ownership = options.owner.attach();
  }
  #decision(
    context: unknown,
    op: HostOperation,
    source: { sender_id: string; message_id: string } | null,
  ) {
    try {
      const value = this.#authorize(
        context,
        op,
        source ? Object.freeze({ ...source }) : null,
      );
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw Error();
      }
      if (!value || value.agent_id !== this.#control.agentId) throw Error();
      return id.parse(value.actor_id);
    } catch {
      throw new HostError("host_forbidden");
    }
  }
  #guard(
    context: unknown,
    op: HostOperation,
    source: { sender_id: string; message_id: string } | null,
  ) {
    const actor = this.#decision(context, op, source);
    return {
      actor,
      check: () => {
        if (this.#decision(context, op, source) !== actor)
          throw new HostError("host_forbidden");
      },
    };
  }
  #pending() {
    this.#draining = this.#draining.filter((client) => {
      try {
        const n = client.activeRequests;
        return !Number.isSafeInteger(n) || n !== 0;
      } catch {
        return true;
      }
    });
    return Math.max(this.#draining.length, this.#networkPending.size);
  }
  status(context: unknown) {
    const guard = this.#guard(context, "status", null),
      state = this.#control.snapshot();
    guard.check();
    let owner: "unconfigured" | "held" | "lost" = "unconfigured";
    if (this.#ownership) {
      try {
        this.#ownership.check();
        owner = "held";
      } catch {
        owner = "lost";
      }
    }
    return {
      ...state,
      running: this.#running,
      draining: this.#pending(),
      owner,
    };
  }
  setPaused(context: unknown, paused: boolean, expectedEpoch: number) {
    const guard = this.#guard(context, "control", null);
    return this.#control.setPaused(
      paused,
      expectedEpoch,
      guard.actor,
      guard.check,
    );
  }
  releaseOwner(context: unknown) {
    const guard = this.#guard(context, "release_owner", null);
    if (this.#running || this.#pending()) throw new HostError("host_busy");
    if (!this.#ownership) throw new HostError("host_owner_unconfigured");
    if (!this.#control.snapshot().paused)
      throw new HostError("host_must_pause");
    guard.check();
    this.#ownership.release();
  }
  async stepOnce(
    context: unknown,
    input: HostCommand,
  ): Promise<HostStepResult> {
    if (this.#running || this.#pending()) throw new HostError("host_busy");
    let command: HostCommand;
    try {
      command = hostCommand.parse(input);
    } catch {
      throw new HostError("invalid_host_command");
    }
    const source = "source" in command ? command.source : null;
    const guard = this.#guard(context, command.op, source),
      snapshot = this.#control.snapshot();
    let live = true;
    const authority = () => {
      if (!live) throw new HostError("host_session_closed");
      guard.check();
      this.#ownership?.check();
    };
    const check = () => {
      authority();
      this.#control.check(snapshot.epoch);
    };
    check();
    let depth = 0;
    const atomic = <T>(action: () => T): T => {
      if (depth) {
        check();
        const value = action();
        check();
        return value;
      }
      return this.#control.withActive(snapshot.epoch, authority, () => {
        depth++;
        try {
          return action();
        } finally {
          depth--;
        }
      });
    };
    const guarded =
      <A extends unknown[], T>(action: (...args: A) => T) =>
      (...args: A) =>
        atomic(() => action(...args));
    const rpc = async <T>(action: () => Promise<T>) => {
      check();
      const result = await action();
      check();
      return result;
    };
    const token = Object.freeze({});
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
      return { agent_id: this.#control.agentId, actor_id: guard.actor };
    };
    const bridgeAuthority = (
      ctx: unknown,
      op: unknown,
      key: { sender_id: string; message_id: string },
    ) => {
      const expected: Partial<Record<HostOperation, string>> = {
        task_accept: "accept",
        task_submit: "submit",
        task_observe: "observe",
        task_reply_prepare: "reply",
        task_reply_enqueue: "reply",
      };
      if (op !== expected[command.op]) throw new HostError("host_forbidden");
      const value = localAuthority(ctx, key);
      return { receiver_id: value.agent_id, actor_id: value.actor_id };
    };
    this.#running = true;
    try {
      let value: unknown;
      if (command.op === "receive" || command.op === "send") {
        // Each client/fetch closure retains THIS command's epoch; a late callback cannot borrow a new session.
        const fetch: typeof globalThis.fetch = (input, init) => {
          let pending!: Promise<Response>;
          let abandoned = false;
          try {
            atomic(() => {
              pending = Promise.resolve(this.#network(input, init)).then(
                async (response) => {
                  if (abandoned) {
                    await response.body?.cancel();
                    throw new HostError("host_session_closed");
                  }
                  return response;
                },
              );
              this.#networkPending.add(pending);
              void pending.then(
                () => {
                  this.#networkPending.delete(pending);
                },
                () => {
                  this.#networkPending.delete(pending);
                },
              );
            });
          } catch (error) {
            abandoned = true;
            throw error;
          }
          return pending;
        };
        const transport = this.#factory(fetch);
        if (transport && typeof transport === "object")
          this.#draining.push(transport);
        if (
          transport?.agentId !== this.#control.agentId ||
          transport.activeRequests !== 0 ||
          ["submit", "status", "poll", "ack"].some(
            (k) => typeof transport[k as keyof HostTransport] !== "function",
          )
        )
          throw new HostError("invalid_host_composition");
        if (command.op === "receive") {
          const inbox = this.#inbox;
          const receiver = new DurableReceiver(
            {
              save: guarded(inbox.save.bind(inbox)),
              claimAck: guarded(inbox.claimAck.bind(inbox)),
              confirmAck: guarded(inbox.confirmAck.bind(inbox)),
              rejectAck: guarded(inbox.rejectAck.bind(inbox)),
              inbox: guarded(inbox.inbox.bind(inbox)),
            },
            {
              poll: () => rpc(() => transport.poll()),
              ack: (request) => rpc(() => transport.ack(request)),
            },
          );
          await receiver.receiveOnce();
          value = null;
        } else {
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
          value = null;
        }
      } else if (command.op === "inbox") {
        value = atomic(() =>
          this.#inbox.inbox().map((entry) => ({
            sender_id: entry.sender_id,
            message_id: entry.message.message_id,
            kind: entry.message.kind,
            receipt_confirmed: entry.receipt_confirmed,
          })),
        );
      } else if (
        command.op === "answer_prepare" ||
        command.op === "answer_enqueue" ||
        command.op === "answer_inspect" ||
        command.op === "answer_pending" ||
        command.op === "answer_maintain"
      ) {
        if (!this.#answers)
          throw new HostError("host_answer_intents_unconfigured");
        const answers = new AnswerIntents(
          this.#answers,
          this.#inbox,
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
            return { agent_id: this.#control.agentId, actor_id: guard.actor };
          },
        );
        value = atomic(() => {
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
      } else if (command.op === "answer") {
        if (this.#answers) throw new HostError("host_answer_intents_required");
        const answers = new InboxAnswers(
          this.#budget,
          this.#inbox,
          this.#outbox,
          this.#limits,
          localAuthority,
        );
        value = atomic(() =>
          answers.enqueueOnce(token, command.source, command.message),
        );
      } else {
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
          this.#inbox,
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
            value = atomic(() => bridge.accept(token, command.source));
            break;
          case "task_submit":
            value = await bridge.submitOnce(
              token,
              command.source,
              command.reconcile ?? false,
            );
            break;
          case "task_observe":
            value = await bridge.observeOnce(token, command.source);
            break;
          case "task_reply_prepare":
            value = replies.prepare(token, command.source, command.kind);
            break;
          case "task_reply_enqueue":
            value = replies.enqueueOnce(token, command.source, command.kind);
            break;
        }
      }
      check();
      const uncertain =
        value &&
        typeof value === "object" &&
        "state" in value &&
        ["uncertain", "submitting", "waiting_approval"].includes(
          String(value.state),
        );
      return {
        op: command.op,
        state: uncertain ? "incomplete" : "done",
        reason: uncertain ? "reconcile_required" : null,
        value,
      };
    } catch (error) {
      // Report current stop/revocation first; component wrappers may have translated the original error.
      let reason: string | undefined;
      try {
        check();
      } catch (current) {
        if (current instanceof HostError) reason = current.code;
      }
      if (
        !reason &&
        error instanceof Error &&
        "code" in error &&
        [
          "host_answer_intents_unconfigured",
          "host_answer_intents_required",
          "answer_intent_conflict",
          "answer_intent_not_found",
          "answer_intent_capacity_exceeded",
          "answer_intent_clock_regressed",
          "answer_intent_source_horizon_closed",
          "answer_intent_outbox_unavailable",
          "host_task_unconfigured",
          "invalid_host_composition",
          "host_busy",
          "reply_thread_exhausted",
          "reply_rate_exhausted",
          "reply_budget_capacity_exceeded",
          "reply_budget_conflict",
          "bridge_reconciliation_required",
          "bridge_busy",
          "sender_transport_failed",
          "poll_transport_failed",
          "ack_transport_failed",
        ].includes(String(error.code))
      )
        reason = String(error.code);
      return {
        op: command.op,
        state: "incomplete",
        reason: reason ?? "host_step_unavailable",
        value: null,
      };
    } finally {
      live = false;
      this.#running = false;
      this.#pending();
    }
  }
}
