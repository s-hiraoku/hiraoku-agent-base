import type { Submission, ContractLimits } from "../messaging/contract.ts";
import type { InboxEntry } from "../agent-sdk/receiver.ts";
import type { OutboxRecord } from "../agent-sdk/sender.ts";
import type {
  SourceKey,
  TaskBinding,
  TaskEvidence,
} from "../task-bridge/contract.ts";

export interface HabExecutionEvidence {
  readonly binding: TaskBinding;
  verify(
    source: SourceKey,
    recipientId: string,
    engineTaskId: string,
  ): Promise<{ request_key: string; task: TaskEvidence }>;
}
export interface HabA2aRoute {
  readonly ownerId: string;
  readonly senderId: string;
  readonly recipientId: string;
  assertCurrent(): void;
  enqueue(message: Submission): OutboxRecord;
  delivery(messageId: string): OutboxRecord;
  /** Sends the saved intent; a route may send only this message. */
  flush(messageId: string): Promise<void>;
  replies(): InboxEntry[];
  /** Called once the saved Task holds what these replies carried; may release their bodies. */
  settle?(replies: InboxEntry[]): void;
  /**
   * Independent read-only engine evidence. Without it the route is reply-attested:
   * Task state reports the recipient's durable replies and claims no engine verification.
   */
  readonly evidence?: HabExecutionEvidence;
}
export const HAB_A2A_LIMITS: Readonly<ContractLimits> = Object.freeze({
  envelope_bytes: 16384,
  text_bytes: 4096,
  data_bytes: 4096,
  parts: 1,
  json_depth: 16,
  json_nodes: 128,
});
