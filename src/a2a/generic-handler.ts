import {
  AgentCard,
  Task,
  type SendMessageRequest,
  type GetTaskRequest,
  type CancelTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type StreamResponse,
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  ExtendedAgentCardNotConfiguredError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
  GENERIC_TEXT_PROFILE,
  TextJobError,
  type GenericTextJobs,
  type TextJob,
} from "../generic-jobs.ts";

export function genericTextAgentCard(endpoint: string): AgentCard {
  return AgentCard.fromJSON({
    name: "HAB asynchronous text jobs",
    description:
      "Submit bounded text to an independently authorized execution runtime. Acceptance is not completion. Poll GetTask for a confirmed result.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: GENERIC_TEXT_PROFILE,
          required: true,
          description:
            "Bounded asynchronous text, explicit deadline, current owner authorization and confirmed results.",
        },
      ],
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: [] } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "async_text_v1",
        name: "Asynchronous text",
        description:
          "Send one text part with returnImmediately=true and profile deadline metadata. GetTask returns confirmed results. ListTasks returns summaries.",
        tags: ["text", "asynchronous"],
      },
    ],
  });
}

function project(job: TextJob, artifacts = true): Task {
  const states = {
    submitted: "TASK_STATE_SUBMITTED",
    working: "TASK_STATE_WORKING",
    completed: "TASK_STATE_COMPLETED",
    failed: "TASK_STATE_FAILED",
    canceled: "TASK_STATE_CANCELED",
  };
  return Task.fromJSON({
    id: job.id,
    contextId: job.contextId,
    status: {
      state: states[job.state],
      timestamp: new Date(job.statusAt).toISOString(),
    },
    metadata: {
      [GENERIC_TEXT_PROFILE]: {
        version: 1,
        sourceMessageId: job.sourceMessageId,
        acceptedAt: job.acceptedAt,
        workDeadline: job.workDeadline,
        outcome: job.outcome,
        cancellationRequested: job.cancellationRequested,
        cancellationConfirmed: job.cancellationConfirmed,
        ...(job.waitReason ? { waitReason: job.waitReason } : {}),
      },
    },
    ...(artifacts &&
    job.state === "completed" &&
    job.outcome === "confirmed" &&
    job.result
      ? {
          artifacts: [
            {
              artifactId: `${job.id}:result:1`,
              parts: [{ text: job.result.text, mediaType: "text/plain" }],
            },
          ],
        }
      : {}),
  });
}

export class GenericTextA2aHandler implements A2ARequestHandler {
  private readonly card: AgentCard;
  private readonly jobs: GenericTextJobs<Request>;
  private readonly requestFor: (context: ServerCallContext) => Request;
  constructor(
    card: AgentCard,
    jobs: GenericTextJobs<Request>,
    requestFor: (context: ServerCallContext) => Request,
  ) {
    this.card = card;
    this.jobs = jobs;
    this.requestFor = requestFor;
  }

  async #call<T>(
    context: ServerCallContext,
    action: (request: Request) => Promise<T>,
  ): Promise<T> {
    try {
      return await action(this.requestFor(context));
    } catch (error) {
      if (error instanceof TextJobError) {
        if (error.code === "not_found" || error.code === "forbidden")
          throw new TaskNotFoundError("Task unavailable");
        if (error.code === "not_cancelable")
          throw new TaskNotCancelableError("Task cannot be canceled");
        if (error.code === "invalid_request" || error.code === "conflict")
          throw new RequestMalformedError("Invalid text job request");
      }
      throw new Error("Text job service unavailable");
    }
  }
  async getAgentCard() {
    return this.card;
  }
  async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    const message = params.message!;
    const profile = params.metadata?.[GENERIC_TEXT_PROFILE] as {
      workDeadline: number;
    };
    return project(
      await this.#call(context, (request) =>
        this.jobs.submit(request, {
          messageId: message.messageId,
          contextId: message.contextId,
          text:
            message.parts[0].content?.$case === "text"
              ? message.parts[0].content.value
              : "",
          workDeadline: profile.workDeadline,
        }),
      ),
    );
  }
  async getTask(
    params: GetTaskRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return project(
      await this.#call(context, (request) =>
        this.jobs.get(request, { id: params.id }),
      ),
    );
  }
  async cancelTask(
    params: CancelTaskRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return project(
      await this.#call(context, (request) =>
        this.jobs.cancel(request, { id: params.id }),
      ),
    );
  }
  async listTasks(
    params: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    const pageSize = params.pageSize || 20;
    const result = await this.#call(context, (request) =>
      this.jobs.list(request, {
        pageSize,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
        ...(params.contextId ? { contextId: params.contextId } : {}),
      }),
    );
    return {
      tasks: result.jobs.map((job) => project(job, false)),
      nextPageToken: result.nextPageToken ?? "",
      pageSize,
      totalSize: result.totalSize,
    };
  }
  async getAuthenticatedExtendedAgentCard(): Promise<never> {
    throw new ExtendedAgentCardNotConfiguredError("Extended card unsupported");
  }
  async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> {
    throw new UnsupportedOperationError("Streaming unsupported");
  }
  async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> {
    throw new UnsupportedOperationError("Subscriptions unsupported");
  }
  async createTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError(
      "Push notifications unsupported",
    );
  }
  async getTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError(
      "Push notifications unsupported",
    );
  }
  async listTaskPushNotificationConfigs(): Promise<never> {
    throw new PushNotificationNotSupportedError(
      "Push notifications unsupported",
    );
  }
  async deleteTaskPushNotificationConfig(): Promise<never> {
    throw new PushNotificationNotSupportedError(
      "Push notifications unsupported",
    );
  }
}
