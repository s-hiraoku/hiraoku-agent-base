/** Fixed Task replies, separate from reusable Relay transport. */
import { z } from "zod";
import { parseSubmission, DELIVERY_TTL_MS } from "../relay/contract.ts";
import type { Submission, ContractLimits } from "../relay/contract.ts";
import { TaskBridgeError, closedTask, taskSchema } from "./contract.ts";
import type { TaskEvidence } from "./contract.ts";
import type { BridgeLink } from "./sqlite-journal.ts";
export const replyKindSchema = z.enum([
  "execution_accepted",
  "execution_result",
]);
export type ReplyKind = z.infer<typeof replyKindSchema>;
export const replyRecordSchema = z.strictObject({
  kind: replyKindSchema,
  state: z.enum(["prepared", "enqueued", "expired"]),
  task: taskSchema,
  message: z.unknown(),
});
export interface BridgeReply {
  kind: ReplyKind;
  state: "prepared" | "enqueued" | "expired";
  task: TaskEvidence;
  message: Submission;
}
export function replyMessage(
  link: BridgeLink,
  kind: ReplyKind,
  task: TaskEvidence,
  messageId: string,
  firstSentAt: string,
  limits: ContractLimits,
): Submission {
  kind = replyKindSchema.parse(kind);
  if (link.state !== "linked" || !link.task || task.id !== link.task.id)
    throw new TaskBridgeError("bridge_not_linked");
  if (kind === "execution_result" && !closedTask(task))
    throw new TaskBridgeError("bridge_task_not_closed");
  const value =
    kind === "execution_accepted"
      ? { task_type: "connectivity_check", task_id: task.id }
      : {
          task_type: "connectivity_check",
          task_id: task.id,
          state: task.state,
          result: task.result,
        };
  return parseSubmission(
    {
      version: 1,
      message_id: messageId,
      recipient_id: link.sender_id,
      kind,
      thread_id: link.thread_id,
      in_reply_to: { sender_id: link.sender_id, message_id: link.message_id },
      first_sent_at: firstSentAt,
      expires_at: new Date(
        Date.parse(firstSentAt) + DELIVERY_TTL_MS,
      ).toISOString(),
      body: {
        parts: [
          { type: "data", schema_id: "task." + kind, schema_version: 1, value },
        ],
      },
    },
    limits,
  );
}
