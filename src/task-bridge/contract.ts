/** Integration contract; intentionally outside the reusable Relay core. */
import { z } from "zod";
import { parseSubmission, validateLimits } from "../relay/contract.ts";
import type { ContractLimits } from "../relay/contract.ts";
import type { InboxEntry } from "../relay/receiver.ts";
import { RESPONSE } from "../types.ts";
export class TaskBridgeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
export const keySchema = z.strictObject({
  sender_id: identifier,
  message_id: identifier,
});
export type SourceKey = z.infer<typeof keySchema>;
export interface TaskBinding {
  engine_id: string;
  owner_subject: string;
  client_id: string | null;
}
export const bindingSchema = z.strictObject({
  engine_id: identifier,
  owner_subject: z.string().min(1).max(200),
  client_id: z.string().min(1).max(200).nullable(),
});
export const taskSchema = z.strictObject({
  id: identifier,
  owner: z.string().min(1).max(200),
  destination: z.literal("hermes"),
  request_key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$(?![\s\S])/),
  task_type: z.literal("connectivity_check"),
  state: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  execution_open: z.union([z.literal(0), z.literal(1)]),
  fence: z.number().int().nonnegative(),
  result: z.string().max(256).nullable(),
});
export type TaskEvidence = z.infer<typeof taskSchema>;
export const closedTask = (t: TaskEvidence) =>
  t.execution_open === 0 &&
  ["succeeded", "failed", "cancelled"].includes(t.state);
export function taskEvidence(
  raw: unknown,
  binding: TaskBinding,
  requestKey: string,
): TaskEvidence {
  try {
    if (!raw || typeof raw !== "object") throw Error();
    const value = raw as Record<string, unknown>,
      projected: Record<string, unknown> = {};
    for (const k of Object.keys(taskSchema.shape)) projected[k] = value[k];
    const task = taskSchema.parse(projected);
    if (
      task.owner !== binding.owner_subject ||
      task.request_key !== requestKey ||
      (task.state === "succeeded" &&
        (task.execution_open !== 0 || task.result !== RESPONSE)) ||
      (task.state === "failed" &&
        (task.execution_open !== 0 ||
          task.result !== "connectivity_check_failed")) ||
      (task.state === "queued" && task.execution_open !== 0) ||
      (task.state === "running" && task.execution_open !== 1) ||
      (!["succeeded", "failed"].includes(task.state) && task.result !== null)
    )
      throw Error();
    return task;
  } catch {
    throw new TaskBridgeError("bridge_invalid_task");
  }
}
export function executionRequest(
  entry: InboxEntry,
  receiver: string,
  limits: ContractLimits,
) {
  try {
    validateLimits(limits);
    const message = parseSubmission(entry.message, limits);
    identifier.parse(entry.sender_id);
    if (
      entry.receipt_confirmed !== true ||
      message.recipient_id !== receiver ||
      message.kind !== "execution_request" ||
      message.body.parts.length !== 1
    )
      throw Error();
    const part = message.body.parts[0];
    if (
      part.type !== "data" ||
      part.schema_id !== "task.execution_request" ||
      part.schema_version !== 1
    )
      throw Error();
    z.strictObject({ task_type: z.literal("connectivity_check") }).parse(
      part.value,
    );
    if (
      !Number.isFinite(Date.parse(entry.received_at)) ||
      new Date(Date.parse(entry.received_at)).toISOString() !==
        entry.received_at
    )
      throw Error();
    return { ...entry, message };
  } catch {
    throw new TaskBridgeError("bridge_invalid_request");
  }
}
export type BridgeOperation = "accept" | "submit" | "observe" | "reply";
export type BridgeAuthorization = (
  context: unknown,
  operation: BridgeOperation,
  source: SourceKey,
) => { receiver_id: string; actor_id: string } | undefined;
export interface BridgeInbox {
  withEntry<T>(
    sender: string,
    message: string,
    action: (entry: InboxEntry) => T,
  ): T;
}
export interface BridgeTasks {
  readonly binding: TaskBinding;
  submit(requestKey: string): Promise<TaskEvidence>;
  get(id: string, requestKey: string): Promise<TaskEvidence>;
}
