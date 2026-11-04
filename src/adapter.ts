import { verifyTextRuntime, storedTextSchema } from "./text-task.ts";
import { taskRequest, canonicalResult, taskFailure } from "./task-contract.ts";
import {
  RESPONSE,
  type Receipt,
  type HubClient,
  type Principal,
  type Runs,
  type JournalStore,
  type Run,
  type Task,
} from "./types.ts";
import type { TaskService } from "./store.ts";
const payload = (e: Receipt) => ({
  id: e.id,
  fence: e.fence,
  ...(e.run_id ? { run_id: e.run_id } : {}),
});
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
type AdapterOptions = {
  heartbeatMs?: number;
  renewalTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
};
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("heartbeat_timeout_requires_reconciliation")),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export class Adapter {
  private busy = false;
  readonly hub: HubClient;
  readonly principal: Principal;
  readonly runs: Runs;
  readonly journal: JournalStore;
  readonly options: AdapterOptions;
  constructor(
    hub: HubClient,
    principal: Principal,
    runs: Runs,
    journal: JournalStore,
    options: AdapterOptions = {},
  ) {
    this.hub = hub;
    this.principal = principal;
    this.runs = runs;
    this.journal = journal;
    this.options = options;
  }
  async once(signal?: AbortSignal): Promise<string | null> {
    if (this.busy) throw new Error("adapter_busy");
    this.busy = true;
    try {
      return await this.step(signal);
    } finally {
      this.busy = false;
    }
  }
  private async step(signal?: AbortSignal): Promise<string | null> {
    const checkStop = () => {
      if (signal?.aborted) throw new Error("worker_stopped_with_receipt");
    };
    checkStop();
    if (!this.runs.toolIsolationVerified || !this.runs.durableIdempotency)
      throw new Error("runner_boundary_unverified");
    if (
      !(this.principal.taskTypes ?? ["connectivity_check"]).every((type) =>
        (this.runs.supportedTaskTypes ?? ["connectivity_check"]).includes(type),
      )
    )
      throw Error("runner_task_type_unverified");
    if (this.principal.taskTypes?.includes("generic_text"))
      verifyTextRuntime(this.runs, this.principal.runnerScope);
    const now = this.options.now ?? (() => Date.now());
    let entry = this.journal.load();
    if (
      entry &&
      this.runs.boundaryId &&
      entry.runner_scope !== this.runs.boundaryId
    )
      throw new Error("runner_scope_requires_reconciliation");
    if (!entry) {
      if (
        (this.principal.runnerScope ?? undefined) !==
        (this.runs.boundaryId ?? undefined)
      )
        throw new Error("runner_scope_mismatch");
      const task = await this.hub.claim(
        this.principal,
        {},
        this.principal.taskTypes?.includes("generic_text")
          ? { textRetentionMs: this.runs.retentionMs }
          : undefined,
      );
      if (!task) return null;
      const admitted = now();
      const originalAdmission =
        task.task_type === "generic_text"
          ? storedTextSchema.parse(task.text_request).acceptedAt
          : admitted;
      const replayDeadline =
        task.task_type === "generic_text"
          ? Math.min(
              originalAdmission + this.runs.retentionMs,
              task.text_request!.input.workDeadline,
            )
          : admitted + this.runs.retentionMs;
      entry = {
        id: task.id,
        fence: task.fence,
        key: `hub-${task.id}`,
        run_id: task.run_id,
        admitted_at: admitted,
        replay: {
          deadline: replayDeadline,
          retentionMs: this.runs.retentionMs,
          contract: this.runs.admissionContract ?? "fixed-connectivity-v1",
        },
        ...(this.runs.boundaryId ? { runner_scope: this.runs.boundaryId } : {}),
      };
      this.journal.save(entry);
    }
    const receipt = entry;
    const task = await this.hub.get(this.principal, { id: receipt.id });
    if (
      ["succeeded", "failed"].includes(task.state) &&
      task.execution_open === 0
    ) {
      checkStop();
      this.journal.clear();
      return task.id;
    }
    if (
      task.state === "cancelled" &&
      task.execution_open === 0 &&
      receipt.run_id &&
      task.run_id === receipt.run_id &&
      task.runner_scope === receipt.runner_scope
    ) {
      checkStop();
      this.journal.clear();
      return task.id;
    }
    const type = task.task_type ?? "connectivity_check";
    if (
      !(this.runs.supportedTaskTypes ?? ["connectivity_check"]).includes(type)
    )
      throw Error("runner_task_type_unverified");
    if (
      (task.runner_scope ?? undefined) !== (this.runs.boundaryId ?? undefined)
    )
      throw Error("runner_scope_requires_reconciliation");
    if (task.state === "cancelled") {
      // Do not send a guessed stop request or clear a receipt before terminal confirmation.
      if (!receipt.run_id)
        throw new Error("unknown_cancelled_admission_requires_reconciliation");
      const run = await this.runs.get(receipt.run_id, signal);
      if (run.state === "running") return task.id;
      // The Hub slot remains closed to new admission until an authorized reconciliation is implemented.
      throw new Error("terminal_cancelled_run_requires_gate_reconciliation");
    }
    if (task.state !== "running" || task.fence !== receipt.fence)
      throw new Error("reconciliation_requires_approval");
    this.checkAdmission(task, receipt, now);
    const interval = this.options.heartbeatMs ?? 10000;
    if (interval <= 0 || !task.lease || interval >= task.lease - task.at)
      throw new Error("unsafe_heartbeat_interval");
    const timeout = Math.min(this.options.renewalTimeoutMs ?? 5000, interval);
    if (
      timeout <= 0 ||
      interval + timeout + (this.options.pollMs ?? 1000) >= task.lease - task.at
    )
      throw new Error("unsafe_renewal_budget");
    const renew = () =>
      deadline(this.hub.heartbeat(this.principal, payload(receipt)), timeout);
    await renew();
    checkStop();
    const controller = new AbortController();
    let lost: Error | undefined, renewing: Promise<void> | undefined;
    let rejectLease: (reason: Error) => void = () => {};
    const leaseFailure = new Promise<never>((_resolve, reject) => {
      rejectLease = reject;
    });
    let rejectStop: (reason: Error) => void = () => {};
    const stopFailure = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    const stop = () => {
      rejectStop(new Error("worker_stopped_with_receipt"));
      controller.abort();
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = renew()
        .then(() => {})
        .catch(() => {
          lost = new Error("lease_renewal_failed_requires_reconciliation");
          rejectLease(lost);
          controller.abort();
        })
        .finally(() => {
          renewing = undefined;
        });
    }, interval);
    try {
      checkStop();
      this.checkAdmission(task, receipt, now);
      const work = receipt.run_id
        ? this.runs.get(receipt.run_id, controller.signal)
        : type === "generic_text"
          ? this.runs.createText!({
              idempotencyKey: receipt.key,
              content: {
                origin: "external_agent",
                text: task.text_request!.input.text,
                messageId: task.text_request!.input.messageId,
                contextId: task.text_request!.input.contextId,
                senderAgent: task.text_request!.binding.senderAgent,
                recipientAgent: task.text_request!.binding.recipientAgent,
              },
              tools: [],
              replay: receipt.replay,
              signal: controller.signal,
            })
          : this.runs.create({
              idempotencyKey: receipt.key,
              prompt: taskRequest(type),
              tools: [],
              replay: receipt.replay,
              signal: controller.signal,
            });
      const run = await Promise.race([work, leaseFailure, stopFailure]);
      clearInterval(timer);
      await renewing;
      if (lost) throw lost;
      if (receipt.run_id && receipt.run_id !== run.id)
        throw Error("run_identity_requires_reconciliation");
      receipt.run_id = run.id;
      this.journal.save(receipt);
      if (type === "generic_text")
        verifyTextRuntime(this.runs, task.runner_scope ?? undefined);
      checkStop();
      await renew();
      if (lost) throw lost;
      checkStop();
      if (type === "generic_text")
        verifyTextRuntime(this.runs, task.runner_scope ?? undefined);
      if (run.state === "running") return task.id;
      const result = run.text ? canonicalResult(type, run.text) : undefined;
      const success = run.state === "succeeded" && result !== undefined;
      await this.hub.complete(this.principal, {
        id: receipt.id,
        fence: receipt.fence,
        state: success ? "succeeded" : "failed",
        result: success ? result! : taskFailure(type),
      });
      checkStop();
      this.journal.clear();
      return task.id;
    } finally {
      clearInterval(timer);
      signal?.removeEventListener("abort", stop);
      controller.abort();
      await renewing;
    }
  }
  private checkAdmission(task: Task, receipt: Receipt, now: () => number) {
    if (task.task_type === "generic_text") {
      verifyTextRuntime(this.runs, task.runner_scope ?? undefined);
      if (receipt.runner_scope !== this.runs.boundaryId)
        throw Error("runner_scope_requires_reconciliation");
      if (!receipt.run_id) {
        const request = storedTextSchema.parse(task.text_request);
        const originalHorizon = request.acceptedAt + this.runs.retentionMs;
        if (
          !Number.isSafeInteger(originalHorizon) ||
          request.input.workDeadline > originalHorizon ||
          now() >= Math.min(originalHorizon, request.input.workDeadline)
        )
          throw Error("text_work_deadline_requires_reconciliation");
      }
    }
    if (receipt.run_id) return;
    if (
      this.runs.admissionContract &&
      (!receipt.replay ||
        receipt.replay.contract !== this.runs.admissionContract ||
        receipt.replay.retentionMs !== this.runs.retentionMs)
    )
      throw Error("replay_contract_requires_reconciliation");
    const horizon =
      receipt.replay?.deadline ?? receipt.admitted_at + this.runs.retentionMs;
    if (now() >= horizon) throw Error("idempotency_horizon_expired");
  }
  async run(signal?: AbortSignal): Promise<string | null> {
    let id: string | null = null;
    while (!signal?.aborted) {
      id = await this.once(signal);
      if (!id || !this.journal.load()) return id;
      await sleep(this.options.pollMs ?? 1000, signal);
    }
    throw new Error("worker_stopped_with_receipt");
  }
}
export class MockRuns implements Runs {
  toolIsolationVerified = true;
  durableIdempotency = true;
  retentionMs = 86400000;
  readonly byKey = new Map<string, Run>();
  calls = 0;
  async create(a: {
    idempotencyKey: string;
    prompt: string;
    tools: never[];
  }): Promise<Run> {
    if (a.tools.length || a.prompt !== RESPONSE) throw new Error("unsafe");
    const old = this.byKey.get(a.idempotencyKey);
    if (old) return old;
    const r: Run = {
      id: `mock-${++this.calls}`,
      state: "succeeded",
      text: RESPONSE,
    };
    this.byKey.set(a.idempotencyKey, r);
    return r;
  }
  async get(id: string): Promise<Run> {
    const r = [...this.byKey.values()].find((r) => r.id === id);
    if (!r) throw new Error("unknown_run");
    return r;
  }
}
export async function drainOutbox(
  hub: TaskService,
  p: Principal,
  sink: {
    send(id: string, data: { task_id: string; state: string }): Promise<void>;
  },
) {
  for (const event of await hub.pending(p)) {
    await sink.send(event.id, { task_id: event.task, state: event.event });
    await hub.ack(p, event.id);
  }
}
