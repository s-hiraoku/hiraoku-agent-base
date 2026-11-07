import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Message,
  Role,
  Task,
  TaskState,
  type AgentCard,
  type SendMessageRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import {
  RequestMalformedError,
  TaskNotFoundError,
  TaskNotCancelableError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
  parseSubmission,
  makeReplayBoundMessageId,
  DELIVERY_TTL_MS,
} from "../messaging/contract.ts";
import type { Submission } from "../messaging/contract.ts";
import {
  bindingSchema,
  identifier,
  taskSchema,
  taskEvidence,
  closedTask,
} from "../task-bridge/contract.ts";
import { HAB_A2A_LIMITS, type HabA2aRoute } from "./hab-contract.ts";
import { connectivityAgentCard } from "./adapter.ts";

export function habRelayAgentCard(endpoint: string): AgentCard {
  const card = connectivityAgentCard(endpoint);
  return {
    ...card,
    name: "HAB Relay connectivity check",
    description:
      "Deliver a fixed connectivity_check through HAB Relay. Recipient storage ACK does not accept execution. A recipient must explicitly accept the request. Completion requires its durable result reply and independently verified closed execution.",
    skills: card.skills.map((skill) => ({
      ...skill,
      description:
        "Send connectivity_check through Relay. Explicit recipient acceptance is required. Use returnImmediately=true to poll, or wait up to five seconds for the confirmed result. Cancellation and execution deadlines are unsupported.",
    })),
  };
}

/** Card for the host-wired, reply-attested route (no engine evidence port). */
export function habHostAgentCard(endpoint: string): AgentCard {
  const card = habRelayAgentCard(endpoint);
  return {
    ...card,
    name: "HAB host connectivity check",
    description:
      "Deliver a fixed connectivity_check from the HAB host's A2A identity. Recipient storage ACK does not accept execution. The recipient must reply with an explicit acceptance and a durable result. Completion reports that result reply; HAB does not verify the recipient's engine.",
    skills: card.skills.map((skill) => ({
      ...skill,
      description:
        "Send connectivity_check from the host identity. Repeat SendMessage with the same messageId to retry delivery. Use returnImmediately=true to poll, or wait up to five seconds for the result reply. Cancellation and execution deadlines are unsupported.",
    })),
  };
}

const linkSchema = z.strictObject({
  version: z.literal(1),
  owner_id: identifier,
  sender_id: identifier,
  recipient_id: identifier,
  message_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.unknown(),
  // Absent exactly when the route has no engine evidence port (reply-attested).
  binding: bindingSchema.optional(),
  execution: taskSchema.optional(),
  reply_task_id: identifier.optional(),
  result_message_id: identifier.optional(),
  failure: z.literal("result_window_expired").optional(),
});
const acceptedSchema = z.strictObject({
  task_type: z.literal("connectivity_check"),
  task_id: identifier,
});
const resultSchema = acceptedSchema.extend({
  state: z.enum(["succeeded", "failed", "cancelled"]),
  result: z.string().max(256).nullable(),
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid = (hash: string) =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
const terminal = (task: Task) =>
  [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
const closedState = (state: "succeeded" | "failed" | "cancelled") =>
  state === "succeeded"
    ? TaskState.TASK_STATE_COMPLETED
    : state === "failed"
      ? TaskState.TASK_STATE_FAILED
      : TaskState.TASK_STATE_CANCELED;
const routeBinding = (route: HabA2aRoute) =>
  route.evidence ? bindingSchema.parse(route.evidence.binding) : undefined;
function publicTask(task: Task, length: number | undefined): Task {
  const link = linkSchema.parse(task.metadata?.hab_relay);
  return {
    ...task,
    metadata: {
      hab_relay: {
        version: link.version,
        sender_id: link.sender_id,
        recipient_id: link.recipient_id,
        message_id: link.message_id,
        source: structuredClone(link.source),
        ...(link.result_message_id
          ? { result_message_id: link.result_message_id }
          : {}),
        ...(link.failure ? { reason: link.failure } : {}),
        ...(link.binding ? {} : { attestation: "recipient_reply" }),
      },
    },
    history:
      length === undefined
        ? task.history
        : length === 0
          ? []
          : task.history.slice(-length),
  };
}

export class HabA2aHandler extends DefaultRequestHandler {
  readonly #store: TaskStore;
  readonly #resolve: (context: ServerCallContext) => HabA2aRoute;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(
    card: AgentCard,
    store: TaskStore,
    resolveRoute: (context: ServerCallContext) => HabA2aRoute,
  ) {
    super(card, store, {
      async execute() {
        throw new UnsupportedOperationError(
          "Execution requires explicit recipient acceptance",
        );
      },
      async cancelTask() {
        throw new TaskNotCancelableError("Cancellation is unsupported");
      },
    });
    this.#store = store;
    this.#resolve = resolveRoute;
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }
  #route(context: ServerCallContext) {
    const route = this.#resolve(context);
    route.assertCurrent();
    if (
      !context.user?.isAuthenticated ||
      context.user.userName !== route.ownerId
    )
      throw new RequestMalformedError("Authenticated HAB owner required");
    return route;
  }
  #link(task: Task, route: HabA2aRoute) {
    const link = linkSchema.parse(task.metadata?.hab_relay);
    const source = parseSubmission(link.source, HAB_A2A_LIMITS);
    if (
      link.owner_id !== route.ownerId ||
      link.sender_id !== route.senderId ||
      link.recipient_id !== route.recipientId ||
      source.recipient_id !== route.recipientId ||
      source.kind !== "execution_request" ||
      source.thread_id === task.id ||
      source.thread_id === task.contextId ||
      JSON.stringify(link.binding) !== JSON.stringify(routeBinding(route))
    )
      throw new RequestMalformedError("HAB route binding changed");
    return { ...link, source };
  }
  async #observe(
    task: Task,
    context: ServerCallContext,
    route: HabA2aRoute,
  ): Promise<Task> {
    const { next, matches } = await this.#evaluate(task, route);
    route.assertCurrent();
    if (JSON.stringify(next) !== JSON.stringify(task))
      await this.#store.save(next, context);
    route.assertCurrent();
    // A reply-attested Task now holds everything its replies carried; an evidence route
    // re-verifies the engine on each read until the Task is terminal.
    if ((terminal(next) || !route.evidence) && matches.length)
      route.settle?.(matches);
    return next;
  }
  /** The Task the route's confirmed replies make of `task`, without saving it. */
  async #evaluate(task: Task, route: HabA2aRoute) {
    route.assertCurrent();
    let link = this.#link(task, route);
    let next = task;
    const sourceKey = {
      sender_id: link.sender_id,
      message_id: link.source.message_id,
    };
    const matches = route
      .replies()
      .filter(
        (entry) =>
          entry.receipt_confirmed &&
          ["execution_accepted", "execution_result"].includes(
            entry.message.kind,
          ) &&
          entry.sender_id === route.recipientId &&
          entry.message.recipient_id === route.senderId &&
          entry.message.in_reply_to?.sender_id === sourceKey.sender_id &&
          entry.message.in_reply_to.message_id === sourceKey.message_id,
      );
    matches.sort(
      (a, b) =>
        Number(b.message.kind === "execution_result") -
        Number(a.message.kind === "execution_result"),
    );
    for (const entry of matches) {
      // A Task closed by its reply window keeps that outcome; a late reply changes nothing.
      if (link.failure) continue;
      const reply = parseSubmission(entry.message, HAB_A2A_LIMITS);
      if (
        reply.thread_id !== link.source.thread_id ||
        !["execution_accepted", "execution_result"].includes(reply.kind) ||
        reply.body.parts.length !== 1
      )
        throw new RequestMalformedError("Invalid HAB reply correlation");
      const part = reply.body.parts[0];
      if (
        part.type !== "data" ||
        part.schema_id !== `task.${reply.kind}` ||
        part.schema_version !== 1
      )
        throw new RequestMalformedError("Invalid HAB reply schema");
      const value =
        reply.kind === "execution_result"
          ? resultSchema.parse(part.value)
          : acceptedSchema.parse(part.value);
      const knownTaskId = link.execution?.id ?? link.reply_task_id;
      if (knownTaskId && knownTaskId !== value.task_id)
        throw new RequestMalformedError("Engine task identity conflict");
      if (reply.kind === "execution_accepted" && terminal(next)) continue;
      let state: TaskState;
      let result: string | null = null;
      if (route.evidence) {
        const observed = await route.evidence.verify(
          sourceKey,
          route.recipientId,
          value.task_id,
        );
        route.assertCurrent();
        const evidence = taskEvidence(
          observed.task,
          bindingSchema.parse(link.binding),
          observed.request_key,
        );
        if (
          evidence.id !== value.task_id ||
          (link.execution &&
            (evidence.fence < link.execution.fence ||
              (closedTask(link.execution) &&
                JSON.stringify(evidence) !== JSON.stringify(link.execution))))
        )
          throw new RequestMalformedError("Engine evidence regressed");
        if (reply.kind === "execution_result") {
          const claimed = resultSchema.parse(value);
          if (
            !closedTask(evidence) ||
            evidence.state !== claimed.state ||
            evidence.result !== claimed.result
          )
            throw new RequestMalformedError(
              "Execution result is not confirmed closed",
            );
          state = closedState(evidence.state);
          if (evidence.state === "succeeded") result = evidence.result ?? "";
        } else {
          state = ["running", "succeeded", "failed"].includes(evidence.state)
            ? TaskState.TASK_STATE_WORKING
            : ["waiting_approval", "cancelled"].includes(evidence.state)
              ? TaskState.TASK_STATE_INPUT_REQUIRED
              : TaskState.TASK_STATE_SUBMITTED;
        }
        link = { ...link, execution: evidence };
      } else {
        // Reply-attested route: the recipient's own durable reply is the only evidence.
        if (reply.kind === "execution_result") {
          const claimed = resultSchema.parse(value);
          state = closedState(claimed.state);
          if (claimed.state === "succeeded") result = claimed.result ?? "";
        } else state = TaskState.TASK_STATE_WORKING;
        link = { ...link, reply_task_id: value.task_id };
      }
      if (
        reply.kind === "execution_result" &&
        terminal(next) &&
        next.status?.state !== state
      )
        throw new RequestMalformedError("Terminal result conflict");
      if (reply.kind === "execution_result")
        link = { ...link, result_message_id: reply.message_id };
      const artifacts =
        result === null
          ? []
          : [
              {
                artifactId: "connectivity-result",
                name: "Connectivity result",
                description: route.evidence
                  ? "Confirmed closed recipient execution"
                  : "Recipient result reply",
                parts: [
                  {
                    content: { $case: "text" as const, value: result },
                    mediaType: "text/plain",
                    filename: "",
                    metadata: undefined,
                  },
                ],
                extensions: [],
                metadata: undefined,
              },
            ];
      next = {
        ...next,
        status: {
          state,
          timestamp:
            next.status?.state === state
              ? next.status.timestamp
              : new Date().toISOString(),
          message: undefined,
        },
        artifacts,
        metadata: { hab_relay: link },
      };
    }
    if (
      !terminal(next) &&
      route.replyWindowMs !== undefined &&
      Date.now() >= Date.parse(link.source.expires_at) + route.replyWindowMs
    ) {
      link = { ...link, failure: "result_window_expired" };
      next = {
        ...next,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          timestamp: new Date().toISOString(),
          message: Message.fromJSON({
            messageId: `${task.id}-result-window`,
            taskId: task.id,
            contextId: task.contextId,
            role: "ROLE_AGENT",
            parts: [
              {
                text: "result_window_expired: no execution result arrived before the reply window closed. The outcome is unknown: the recipient may or may not have executed the request.",
              },
            ],
            metadata: { hab_relay: { reason: "result_window_expired" } },
          }),
        },
        metadata: { hab_relay: link },
      };
    } else if (!terminal(next)) {
      let expired = Date.parse(link.source.expires_at) <= Date.now();
      try {
        const delivery = route.delivery(link.source.message_id);
        expired ||=
          delivery.state === "expired_unknown" ||
          delivery.state === "quarantined" ||
          delivery.receipt?.state === "expired" ||
          delivery.receipt?.state === "quarantined";
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "not_found"
        ))
          throw error;
      }
      if (expired && !link.execution && !link.reply_task_id)
        next = {
          ...next,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp:
              next.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
                ? next.status.timestamp
                : new Date().toISOString(),
            message: Message.fromJSON({
              messageId: `${task.id}-delivery`,
              taskId: task.id,
              contextId: task.contextId,
              role: "ROLE_AGENT",
              parts: [
                {
                  text: "Delivery is unresolved after its original deadline. Execution has not been confirmed.",
                },
              ],
            }),
          },
        };
    }
    return { next, matches };
  }
  async #wait(
    task: Task,
    params: SendMessageRequest,
    context: ServerCallContext,
    route: HabA2aRoute,
  ): Promise<Task> {
    let current = task;
    const until = Date.now() + 5000;
    while (
      params.configuration?.returnImmediately !== true &&
      [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(
        current.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
      )
    ) {
      if (Date.now() >= until)
        throw Error("Transport wait exceeded; HAB Task remains queryable");
      await new Promise((resolve) => setTimeout(resolve, 25));
      // The wait holds the serializer only per step, so a background apply() can save
      // newer Task state in between; each step therefore reloads the stored Task.
      const id = current.id;
      current = await this.#serial(async () => {
        const stored = await this.#store.load(id, context);
        route.assertCurrent();
        if (!stored) throw new TaskNotFoundError();
        return this.#observe(stored, context, route);
      });
    }
    route.assertCurrent();
    return publicTask(current, params.configuration?.historyLength);
  }
  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task | Message> {
    const { task, route } = await this.#serial(async () => {
      const route = this.#route(context);
      const message = params.message;
      if (
        !message ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(message.messageId) ||
        message.role !== Role.ROLE_USER ||
        message.taskId ||
        message.contextId ||
        message.parts.length !== 1 ||
        message.parts[0].content?.$case !== "text" ||
        message.extensions.length ||
        message.referenceTaskIds.length ||
        message.metadata ||
        params.metadata ||
        params.tenant ||
        params.configuration?.taskPushNotificationConfig
      )
        throw new RequestMalformedError("Invalid HAB connectivity request");
      const text = message.parts[0].content.value;
      const hash = digest(
        JSON.stringify([
          route.ownerId,
          route.senderId,
          route.recipientId,
          message.messageId,
        ]),
      );
      const id = uuid(hash);
      const payloadHash = digest(JSON.stringify({ role: "user", text }));
      let task = await this.#store.load(id, context);
      route.assertCurrent();
      if (task) {
        if (this.#link(task, route).payload_hash !== payloadHash)
          throw new RequestMalformedError("message_id_conflict");
      } else {
        if (text !== "connectivity_check")
          throw new RequestMalformedError("Unsupported HAB skill");
        const at = new Date().toISOString();
        const source: Submission = parseSubmission(
          {
            version: 1,
            message_id: makeReplayBoundMessageId(
              at,
              randomUUID().replaceAll("-", ""),
            ),
            recipient_id: route.recipientId,
            kind: "execution_request",
            thread_id: `a2a_${randomUUID().replaceAll("-", "")}`,
            in_reply_to: null,
            first_sent_at: at,
            expires_at: new Date(
              Date.parse(at) + DELIVERY_TTL_MS,
            ).toISOString(),
            body: {
              parts: [
                {
                  type: "data",
                  schema_id: "task.execution_request",
                  schema_version: 1,
                  value: { task_type: "connectivity_check" },
                },
              ],
            },
          },
          HAB_A2A_LIMITS,
        );
        task = Task.fromJSON({
          id,
          contextId: uuid(digest(`context:${hash}`)),
          status: { state: "TASK_STATE_SUBMITTED", timestamp: at },
          history: [Message.toJSON(message)],
          metadata: {
            hab_relay: {
              version: 1,
              owner_id: route.ownerId,
              sender_id: route.senderId,
              recipient_id: route.recipientId,
              message_id: message.messageId,
              payload_hash: payloadHash,
              source,
              ...(route.evidence ? { binding: routeBinding(route) } : {}),
            },
          },
        });
        route.assertCurrent();
        await this.#store.save(task, context);
        route.assertCurrent();
      }
      const link = this.#link(task, route);
      if (!terminal(task) && Date.parse(link.source.expires_at) > Date.now()) {
        route.enqueue(link.source);
        await route.flush(link.source.message_id);
        route.assertCurrent();
      }
      return { task: await this.#observe(task, context, route), route };
    });
    return this.#wait(task, params, context, route);
  }
  /** Applies the route's saved replies to a stored Task outside any caller request. */
  apply(
    taskId: string,
    context: ServerCallContext,
    route: HabA2aRoute,
  ): Promise<Task | undefined> {
    return this.#serial(async () => {
      const task = await this.#store.load(taskId, context);
      return task && this.#observe(task, context, route);
    });
  }
  /** The stored Task as the route's replies would leave it; nothing is saved or settled. */
  preview(
    taskId: string,
    context: ServerCallContext,
    route: HabA2aRoute,
  ): Promise<Task | undefined> {
    return this.#serial(async () => {
      const task = await this.#store.load(taskId, context);
      return task && (await this.#evaluate(task, route)).next;
    });
  }
  override getTask(
    params: GetTaskRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return this.#serial(async () => {
      const route = this.#route(context);
      const task = await this.#store.load(params.id, context);
      route.assertCurrent();
      if (!task) throw new TaskNotFoundError();
      return publicTask(
        await this.#observe(task, context, route),
        params.historyLength,
      );
    });
  }
  override listTasks(
    params: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    return this.#serial(async () => {
      const route = this.#route(context);
      const page = await super.listTasks(
        { ...params, includeArtifacts: true },
        context,
      );
      route.assertCurrent();
      const tasks: Task[] = [];
      for (const item of page.tasks) {
        const stored = await this.#store.load(item.id, context);
        route.assertCurrent();
        if (!stored) throw new TaskNotFoundError();
        const current = await this.#observe(stored, context, route);
        tasks.push({
          ...publicTask(current, params.historyLength),
          artifacts: params.includeArtifacts ? current.artifacts : [],
        });
      }
      route.assertCurrent();
      return { ...page, tasks };
    });
  }
  override async cancelTask(): Promise<Task> {
    throw new TaskNotCancelableError("Cancellation is unsupported");
  }
}
