import { z } from "zod";
import type { TaskService } from "./store.ts";
import type { Principal, Task } from "./types.ts";
import {
  boundedText,
  textBinding,
  textInputSchema,
  textListSchema,
  type TextListInput,
} from "./text-task.ts";

export const GENERIC_TEXT_PROFILE =
  "https://github.com/s-hiraoku/hiraoku-agent-base/blob/main/docs/profiles/async-text-v1.md";
export type GenericJobOperation =
  "discover" | "submit" | "get" | "list" | "cancel";
export type TextJobErrorCode =
  | "invalid_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "not_cancelable"
  | "unavailable";
export class TextJobError extends Error {
  readonly code: TextJobErrorCode;
  constructor(code: TextJobErrorCode) {
    super(code);
    this.name = "TextJobError";
    this.code = code;
  }
}
export interface TextJob {
  profile: string;
  version: 1;
  id: string;
  contextId: string;
  sourceMessageId: string;
  acceptedAt: number;
  statusAt: number;
  workDeadline: number;
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  outcome: "pending" | "unknown" | "confirmed";
  cancellationRequested: boolean;
  cancellationConfirmed: boolean;
  waitReason?: "execution_reconciliation" | "cancellation_confirmation";
  result?: { version: 1; text: string };
}
const idInput = z.strictObject({ id: z.string().uuid() });
const senderOperations = ["submit", "get", "cancel"] as const;
function publicError(error: unknown, fallback: TextJobErrorCode): TextJobError {
  if (error instanceof TextJobError) return error;
  if (error instanceof z.ZodError) return new TextJobError("invalid_request");
  if (error instanceof Error) {
    if (
      [
        "forbidden",
        "authorization_rejected",
        "authorization_changed",
        "text_binding_required",
      ].includes(error.message)
    )
      return new TextJobError("forbidden");
    if (error.message === "text_idempotency_conflict")
      return new TextJobError("conflict");
    if (error.message === "invalid_text_cursor")
      return new TextJobError("invalid_request");
    if (error.message === "operation_rejected")
      return new TextJobError(fallback);
  }
  return new TextJobError("unavailable");
}
export class GenericTextJobs<C> {
  private readonly tasks: TaskService;
  private readonly resolve: (
    context: C,
    operation: GenericJobOperation,
  ) => Principal | null | Promise<Principal | null>;
  constructor(
    tasks: TaskService,
    resolve: (
      context: C,
      operation: GenericJobOperation,
    ) => Principal | null | Promise<Principal | null>,
  ) {
    this.tasks = tasks;
    this.resolve = resolve;
  }
  private async principal(
    context: C,
    operation: GenericJobOperation,
  ): Promise<Principal> {
    const resolved = await this.resolve(context, operation);
    if (!resolved) throw new TextJobError("forbidden");
    let binding;
    try {
      binding = Object.freeze(textBinding(resolved));
    } catch {
      throw new TextJobError("forbidden");
    }
    const p: Principal = Object.freeze({
      subject: resolved.subject,
      clientId: resolved.clientId,
      authorizationEpoch: resolved.authorizationEpoch,
      operations: Object.freeze([...resolved.operations]),
      taskTypes: Object.freeze([...(resolved.taskTypes ?? [])]),
      destination: resolved.destination,
      textBinding: binding,
    });
    const required = operation === "list" ? "get" : operation;
    if (
      resolved.worker ||
      resolved.runnerScope ||
      resolved.resultReaders?.length ||
      p.destination !== binding.recipientAgent ||
      (required === "discover"
        ? !senderOperations.some((op) => p.operations.includes(op))
        : !p.operations.includes(required))
    )
      throw new TextJobError("forbidden");
    return this.tasks.authorization.bind(p);
  }
  private project(task: Task, includeResult = true): TextJob {
    const request = task.text_request;
    if (
      task.task_type !== "generic_text" ||
      !request ||
      ![0, 1].includes(task.execution_open)
    )
      throw new TextJobError("unavailable");
    const job: TextJob = {
      profile: GENERIC_TEXT_PROFILE,
      version: 1,
      id: task.id,
      contextId: request.input.contextId,
      sourceMessageId: request.input.messageId,
      acceptedAt: request.acceptedAt,
      statusAt: task.at,
      workDeadline: request.input.workDeadline,
      state: "working",
      outcome: "pending",
      cancellationRequested: false,
      cancellationConfirmed: false,
    };
    switch (task.state) {
      case "queued":
        job.state = "submitted";
        break;
      case "running":
        break;
      case "waiting_approval":
        job.outcome = "unknown";
        job.waitReason = "execution_reconciliation";
        break;
      case "cancelled":
        job.cancellationRequested = true;
        if (task.execution_open) {
          job.outcome = "unknown";
          job.waitReason = "cancellation_confirmation";
        } else {
          job.state = "canceled";
          job.outcome = "confirmed";
          job.cancellationConfirmed = true;
        }
        break;
      case "succeeded":
      case "failed":
        if (task.execution_open) throw new TextJobError("unavailable");
        job.state = task.state === "succeeded" ? "completed" : "failed";
        job.outcome = "confirmed";
        if (task.state === "succeeded") {
          const result = boundedText.safeParse(task.result);
          if (!result.success) throw new TextJobError("unavailable");
          if (includeResult) job.result = { version: 1, text: result.data };
        }
        break;
      default:
        throw new TextJobError("unavailable");
    }
    return job;
  }
  async capabilities(context: C) {
    try {
      const p = await this.principal(context, "discover");
      return {
        submit: p.operations.includes("submit"),
        get: p.operations.includes("get"),
        list: p.operations.includes("get"),
        cancel: p.operations.includes("cancel"),
      };
    } catch (error) {
      throw publicError(error, "forbidden");
    }
  }
  async submit(context: C, input: unknown): Promise<TextJob> {
    try {
      const p = await this.principal(context, "submit");
      return this.project(
        await this.tasks.submitText(p, textInputSchema.parse(input)),
        false,
      );
    } catch (error) {
      throw publicError(error, "invalid_request");
    }
  }
  async get(context: C, input: { id: string }): Promise<TextJob> {
    try {
      const p = await this.principal(context, "get");
      const task = await this.tasks.get(p, idInput.parse(input));
      if (task.task_type !== "generic_text")
        throw new TextJobError("not_found");
      return this.project(task);
    } catch (error) {
      throw publicError(error, "not_found");
    }
  }
  async list(
    context: C,
    input: TextListInput = {},
  ): Promise<{ jobs: TextJob[]; nextPageToken?: string; totalSize: number }> {
    try {
      const p = await this.principal(context, "list");
      const page = await this.tasks.listText(p, textListSchema.parse(input));
      return {
        jobs: page.tasks.map((task) => this.project(task, false)),
        totalSize: page.totalSize,
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    } catch (error) {
      throw publicError(error, "invalid_request");
    }
  }
  async cancel(context: C, input: { id: string }): Promise<TextJob> {
    try {
      const p = await this.principal(context, "cancel");
      const task = await this.tasks.cancelText(p, idInput.parse(input));
      if (task.state === "succeeded" || task.state === "failed")
        throw new TextJobError("not_cancelable");
      return this.project(task);
    } catch (error) {
      throw publicError(error, "not_found");
    }
  }
}
