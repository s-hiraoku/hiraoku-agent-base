import type { Submission, ContractLimits } from "../relay/contract.ts";
import type { InboxEntry } from "../relay/receiver.ts";
import type { OutboxRecord } from "../relay/sender.ts";
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
  flush(): Promise<void>;
  replies(): InboxEntry[];
  readonly evidence: HabExecutionEvidence;
}
export const HAB_A2A_LIMITS: Readonly<ContractLimits> = Object.freeze({
  envelope_bytes: 16384,
  text_bytes: 4096,
  data_bytes: 4096,
  attachment_bytes: 1,
  total_attachment_bytes: 1,
  parts: 1,
  attachments: 1,
  json_depth: 16,
  json_nodes: 128,
});
