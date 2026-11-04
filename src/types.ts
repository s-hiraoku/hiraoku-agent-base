import type {
  TextBinding,
  StoredTextRequest,
  TextBoundary,
} from "./text-task.ts";
import type { TaskType } from "./task-contract.ts";
export const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,124}$/;
export const RESPONSE = "Agent Hub connectivity check completed.";
export type State =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Operation =
  | "submit"
  | "claim"
  | "heartbeat"
  | "complete"
  | "get"
  | "cancel"
  | "events"
  | "grants"
  | "reconcile"
  | "ping_submit"
  | "ping_get"
  | "ping_reply"
  | "ping_pending";
export interface Principal {
  /** Static verified client binding; never a caller argument. */
  clientId?: string;
  /** DB epoch captured at the authenticated HTTP boundary. */
  authorizationEpoch?: number;
  subject: string;
  /** Approved task allowlist; absent means connectivity only. */
  taskTypes?: readonly TaskType[];
  operations: readonly Operation[];
  destination?: string;
  worker?: string;
  textBinding?: TextBinding;
  runnerScope?: string;
  /** Trusted verifier policy only; never copied from task arguments. */
  resultReaders?: readonly { subject: string; notify: boolean }[];
}
export interface Lease {
  id: string;
  fence: number;
}
export interface Task extends Lease {
  text_request?: StoredTextRequest;
  task_type?: TaskType;
  owner: string;
  destination: string;
  request_key: string;
  state: State;
  lease: number | null;
  run_id: string | null;
  runner_scope: string | null;
  runner_subject: string | null;
  result: string | null;
  execution_open: number;
  at: number;
}
export interface ReplayContract {
  deadline: number;
  retentionMs: number;
  contract: string;
}
export interface Receipt extends Lease {
  key: string;
  run_id: string | null;
  admitted_at: number;
  runner_scope?: string;
  replay?: ReplayContract;
}
export interface Run {
  id: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  text?: string;
}
export interface Runs {
  readonly textBoundary?: TextBoundary;
  createText?(input: {
    idempotencyKey: string;
    content: {
      origin: "external_agent";
      text: string;
      messageId: string;
      contextId: string;
      senderAgent: string;
      recipientAgent: string;
    };
    tools: never[];
    signal?: AbortSignal;
    replay?: ReplayContract;
  }): Promise<Run>;
  readonly supportedTaskTypes?: readonly TaskType[];
  readonly boundaryId?: string;
  readonly admissionContract?: string;
  readonly toolIsolationVerified: boolean;
  readonly durableIdempotency: boolean;
  readonly retentionMs: number;
  create(input: {
    idempotencyKey: string;
    prompt: string;
    tools: never[];
    signal?: AbortSignal;
    replay?: ReplayContract;
  }): Promise<Run>;
  get(id: string, signal?: AbortSignal): Promise<Run>;
}
export interface JournalStore {
  load(): Receipt | null;
  save(entry: Receipt): void;
  clear(): void;
}
export interface HubClient {
  claim(
    p: Principal,
    a: Record<string, never>,
    capabilities?: { textRetentionMs: number },
  ): Promise<Task | null>;
  get(p: Principal, a: { id: string }): Promise<Task>;
  heartbeat(p: Principal, a: Lease & { run_id?: string }): Promise<Task>;
  complete(
    p: Principal,
    a: Lease & { state: "succeeded" | "failed"; result: string },
  ): Promise<Task>;
}
export type SQLValue = string | number | null;
export interface Statement {
  sql: string;
  params?: SQLValue[];
}
export type Row = Record<string, SQLValue>;
export interface Driver {
  readonly nowSQL: string;
  batch(statements: Statement[]): Promise<Row[][]>;
}
export interface Outbox {
  id: string;
  task: string;
  owner: string;
  event: string;
  at: number;
  delivered: number;
}

export class CallbackEndpointError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("Callback verification failed");
    this.reason = reason;
  }
}
