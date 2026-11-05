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

const linkSchema = z.strictObject({
  version: z.literal(1),
  owner_id: identifier,
  sender_id: identifier,
  recipient_id: identifier,
  message_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.unknown(),
  binding: bindingSchema,
  execution: taskSchema.optional(),
  result_message_id: identifier.optional(),
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
      JSON.stringify(link.binding) !==
        JSON.stringify(bindingSchema.parse(route.evidence.binding))
    )
      throw new RequestMalformedError("HAB route binding changed");
    return { ...link, source };
  }
  async #observe(
    task: Task,
    context: ServerCallContext,
    route: HabA2aRoute,
  ): Promise<Task> {
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
      if (link.execution && link.execution.id !== value.task_id)
        throw new RequestMalformedError("Engine task identity conflict");
      if (reply.kind === "execution_accepted" && terminal(next)) continue;
      const observed = await route.evidence.verify(
        sourceKey,
        route.recipientId,
        value.task_id,
      );
      route.assertCurrent();
      const evidence = taskEvidence(
        observed.task,
        link.binding,
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
      let state: TaskState;
      if (reply.kind === "execution_result") {
        const result = resultSchema.parse(value);
        if (
          !closedTask(evidence) ||
          evidence.state !== result.state ||
          evidence.result !== result.result
        )
          throw new RequestMalformedError(
            "Execution result is not confirmed closed",
          );
        state =
          evidence.state === "succeeded"
            ? TaskState.TASK_STATE_COMPLETED
            : evidence.state === "failed"
              ? TaskState.TASK_STATE_FAILED
              : TaskState.TASK_STATE_CANCELED;
        if (terminal(next) && next.status?.state !== state)
          throw new RequestMalformedError("Terminal result conflict");
      } else {
        state = ["running", "succeeded", "failed"].includes(evidence.state)
          ? TaskState.TASK_STATE_WORKING
          : ["waiting_approval", "cancelled"].includes(evidence.state)
            ? TaskState.TASK_STATE_INPUT_REQUIRED
            : TaskState.TASK_STATE_SUBMITTED;
      }
      link = {
        ...link,
        execution: evidence,
        ...(reply.kind === "execution_result"
          ? { result_message_id: reply.message_id }
          : {}),
      };
      const artifacts =
        reply.kind === "execution_result" && evidence.state === "succeeded"
          ? [
              {
                artifactId: "connectivity-result",
                name: "Connectivity result",
                description: "Confirmed closed recipient execution",
                parts: [
                  {
                    content: {
                      $case: "text" as const,
                      value: evidence.result ?? "",
                    },
                    mediaType: "text/plain",
                    filename: "",
                    metadata: undefined,
                  },
                ],
                extensions: [],
                metadata: undefined,
              },
            ]
          : [];
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
    if (!terminal(next)) {
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
      if (expired && !link.execution)
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
    route.assertCurrent();
    if (JSON.stringify(next) !== JSON.stringify(task))
      await this.#store.save(next, context);
    route.assertCurrent();
    return next;
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
      current = await this.#observe(current, context, route);
    }
    route.assertCurrent();
    return publicTask(current, params.configuration?.historyLength);
  }
  override sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task | Message> {
    return this.#serial(async () => {
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
              binding: bindingSchema.parse(route.evidence.binding),
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
        await route.flush();
        route.assertCurrent();
      }
      return this.#wait(
        await this.#observe(task, context, route),
        params,
        context,
        route,
      );
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
