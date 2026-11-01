import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentCard,
  Message,
  Role,
  Task,
  TaskState,
  type SendMessageRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import {
  RequestMalformedError,
  TaskNotFoundError,
  TaskNotCancelableError,
} from "@a2a-js/sdk/errors";
import {
  bindingSchema,
  TaskBridgeError,
  taskSchema,
  closedTask,
  taskEvidence,
  type BridgeTasks,
  type TaskEvidence,
} from "../task-bridge/contract.ts";

const linkSchema = z.strictObject({
  request_key: z.string().regex(/^a2a_[a-f0-9]{64}$/),
  binding: bindingSchema,
  engine_task_id: z.string().optional(),
  evidence: taskSchema.optional(),
  submission: z.literal("denied").optional(),
});
export type TaskPortResolver = (context: ServerCallContext) => BridgeTasks;
const states = {
  queued: TaskState.TASK_STATE_SUBMITTED,
  running: TaskState.TASK_STATE_WORKING,
  waiting_approval: TaskState.TASK_STATE_INPUT_REQUIRED,
  succeeded: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_INPUT_REQUIRED,
} satisfies Record<TaskEvidence["state"], TaskState>;

export function connectivityAgentCard(endpoint: string): AgentCard {
  return AgentCard.fromJSON({
    name: "HAB connectivity check",
    description:
      "Submit a fixed connectivity_check to an independently authorized Task engine. Poll GetTask for execution evidence. Cancellation, deadlines, streaming and push notifications are unsupported.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: [] } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "connectivity_check",
        name: "Connectivity check",
        description:
          "Send connectivity_check. Use returnImmediately=true to poll, or wait up to five seconds for execution. Only an engine-confirmed success produces a result artifact.",
        tags: ["connectivity"],
        examples: ["connectivity_check"],
      },
    ],
  });
}

const uuid = (hash: string) =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
function project(task: Task, evidence: TaskEvidence): Task {
  const link = linkSchema.parse(task.metadata?.hab);
  const previous = link.evidence;
  if (link.engine_task_id && evidence.id !== link.engine_task_id)
    throw new TaskBridgeError("bridge_task_regressed");
  if (
    previous &&
    (evidence.id !== previous.id ||
      evidence.fence < previous.fence ||
      (closedTask(previous) &&
        JSON.stringify(evidence) !== JSON.stringify(previous)))
  )
    throw new TaskBridgeError("bridge_task_regressed");
  const state =
    evidence.state === "cancelled" && evidence.execution_open === 0
      ? TaskState.TASK_STATE_CANCELED
      : states[evidence.state];
  if (
    [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
    ].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED) &&
    state !== task.status?.state
  )
    throw new TaskBridgeError("bridge_task_regressed");
  return {
    ...task,
    status: {
      state,
      timestamp:
        task.status?.state === state
          ? task.status.timestamp
          : new Date().toISOString(),
      message: undefined,
    },
    artifacts:
      evidence.state === "succeeded"
        ? [
            {
              artifactId: "connectivity-result",
              name: "Connectivity result",
              description: "Confirmed Task engine result",
              parts: [
                {
                  content: { $case: "text", value: evidence.result ?? "" },
                  mediaType: "text/plain",
                  filename: "",
                  metadata: undefined,
                },
              ],
              metadata: undefined,
              extensions: [],
            },
          ]
        : [],
    metadata: {
      hab: {
        ...linkSchema.parse(task.metadata?.hab),
        engine_task_id: evidence.id,
        evidence,
      },
    },
  };
}

export class ConnectivityA2aHandler extends DefaultRequestHandler {
  readonly #store: TaskStore;
  readonly #ports: TaskPortResolver;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(card: AgentCard, store: TaskStore, ports: TaskPortResolver) {
    super(card, store, {
      async execute(ctx, bus) {
        const task = ctx.task;
        if (!task) throw new RequestMalformedError("Task seed missing");
        const link = linkSchema.parse(task.metadata?.hab);
        const port = ports(ctx.context);
        if (JSON.stringify(port.binding) !== JSON.stringify(link.binding))
          throw new RequestMalformedError("Task engine binding changed");
        let next = task;
        try {
          const evidence = taskEvidence(
            await port.submit(link.request_key),
            link.binding,
            link.request_key,
          );
          next = project(task, evidence);
        } catch (error) {
          if (
            error instanceof TaskBridgeError &&
            error.code === "bridge_forbidden"
          ) {
            next = {
              ...task,
              status: {
                state: TaskState.TASK_STATE_REJECTED,
                timestamp: new Date().toISOString(),
                message: undefined,
              },
              metadata: { hab: { ...link, submission: "denied" } },
            };
          }
        }
        bus.publish(AgentEvent.task(next));
      },
      async cancelTask() {
        throw new TaskNotCancelableError("Cancellation is unsupported");
      },
    });
    this.#store = store;
    this.#ports = ports;
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }

  #port(context: ServerCallContext) {
    if (!context.user?.isAuthenticated || !context.user.userName)
      throw new RequestMalformedError(
        "Authenticated execution principal required",
      );
    return this.#ports(context);
  }

  async #refresh(task: Task, context: ServerCallContext): Promise<Task> {
    const link = linkSchema.parse(task.metadata?.hab);
    const port = this.#port(context);
    if (JSON.stringify(port.binding) !== JSON.stringify(link.binding))
      throw new RequestMalformedError("Task engine binding changed");
    if (link.submission === "denied") return task;
    const evidence = taskEvidence(
      link.engine_task_id
        ? await port.get(link.engine_task_id, link.request_key)
        : await port.submit(link.request_key),
      link.binding,
      link.request_key,
    );
    const next = project(task, evidence);
    if (JSON.stringify(next) !== JSON.stringify(task))
      await this.#store.save(next, context);
    return next;
  }

  override sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task | Message> {
    return this.#serial(async () => {
      const port = this.#port(context);
      const message = params.message;
      if (
        !message ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(message.messageId) ||
        message.role !== Role.ROLE_USER ||
        message.taskId ||
        message.contextId ||
        message.parts.length !== 1 ||
        message.parts[0].content?.$case !== "text" ||
        message.parts[0].content.value !== "connectivity_check"
      )
        throw new RequestMalformedError("Use a new connectivity_check message");
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            context.tenant ?? "",
            context.user!.userName,
            message.messageId,
          ]),
        )
        .digest("hex");
      const id = uuid(hash);
      const contextId = uuid(
        createHash("sha256").update(`context:${hash}`).digest("hex"),
      );
      const existing = await this.#store.load(id, context);
      if (existing)
        return this.#respond(
          await this.#refresh(existing, context),
          params,
          context,
        );
      const seed = Task.fromJSON({
        id,
        contextId,
        status: {
          state: "TASK_STATE_SUBMITTED",
          timestamp: new Date().toISOString(),
        },
        metadata: {
          hab: { request_key: `a2a_${hash}`, binding: port.binding },
        },
      });
      await this.#store.save(seed, context);
      const result = await super.sendMessage(
        {
          ...params,
          configuration: {
            ...params.configuration,
            acceptedOutputModes: ["text/plain"],
            returnImmediately: true,
            taskPushNotificationConfig: undefined,
          },
          message: { ...message, taskId: id, contextId },
        },
        context,
      );
      if (!("id" in result)) throw Error("Expected a Task result");
      return this.#respond(result, params, context);
    });
  }

  async #respond(
    task: Task,
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    let latest = task;
    const until = Date.now() + 5000;
    while (
      params.configuration?.returnImmediately !== true &&
      (latest.status?.state === TaskState.TASK_STATE_SUBMITTED ||
        latest.status?.state === TaskState.TASK_STATE_WORKING)
    ) {
      if (Date.now() >= until)
        throw Error("Transport wait exceeded; execution remains queryable");
      await new Promise((resolve) => setTimeout(resolve, 25));
      latest = await this.#refresh(latest, context);
    }
    const historyLength = params.configuration?.historyLength;
    return historyLength === undefined
      ? latest
      : {
          ...latest,
          history:
            historyLength === 0 ? [] : latest.history.slice(-historyLength),
        };
  }

  override listTasks(
    params: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    return this.#serial(async () => {
      this.#port(context);
      const page = await super.listTasks(
        { ...params, includeArtifacts: true },
        context,
      );
      const tasks = [];
      for (const task of page.tasks) {
        const source = await this.#store.load(task.id, context);
        if (!source) throw new TaskNotFoundError();
        const current = await this.#refresh(source, context);
        tasks.push({
          ...current,
          history: task.history,
          artifacts: params.includeArtifacts ? current.artifacts : [],
        });
      }
      return { ...page, tasks };
    });
  }

  override getTask(
    params: GetTaskRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return this.#serial(async () => {
      this.#port(context);
      const task = await this.#store.load(params.id, context);
      if (!task) throw new TaskNotFoundError();
      await this.#refresh(task, context);
      return super.getTask(params, context);
    });
  }
}
