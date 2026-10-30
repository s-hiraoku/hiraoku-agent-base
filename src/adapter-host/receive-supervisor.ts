/** Receive-only scheduling over the existing durable host. No authentication or execution. */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AdapterHostCycle } from "./cycle.ts";

const policySchema = z
  .strictObject({
    interval_ms: z.number().int().min(1000).max(3600000),
    retry_base_ms: z.number().int().min(1000).max(3600000),
    retry_cap_ms: z.number().int().min(1000).max(3600000),
    drain_timeout_ms: z.number().int().min(1000).max(60000),
  })
  .refine((p) => p.retry_cap_ms >= p.retry_base_ms);
export type ReceiveSupervisorPolicy = z.infer<typeof policySchema>;
/** Trusted host composition, version 1. Never populated from received messages. */
export interface ReceiveSupervisorPort {
  version: 1;
  host: Pick<AdapterHostCycle, "status" | "stepOnce">;
  context: unknown;
}
export type ReceiveStopReason =
  | "stopped"
  | "paused"
  | "owner_unavailable"
  | "host_unavailable"
  | "drain_timeout";
export interface ReceiveRunResult {
  reason: ReceiveStopReason;
  receive_steps: number;
  retries: number;
  /** False means the caller must retain stores/ownership until work settles or process exit. */
  drained: boolean;
}
type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;
const wait: Wait = async (ms, signal) => {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
};

/** The operator resumes the host and owns its process-lifetime lock before starting. */
export class ReceiveSupervisor {
  readonly #port: ReceiveSupervisorPort;
  readonly #policy: ReceiveSupervisorPolicy;
  readonly #wait: Wait;
  readonly #now: () => number;
  #running = false;
  constructor(
    port: ReceiveSupervisorPort,
    policy: ReceiveSupervisorPolicy,
    /** Trusted scheduler ports; not user configuration or a message dispatch hook. */
    scheduler: { wait?: Wait; now?: () => number } = {},
  ) {
    if (
      port?.version !== 1 ||
      typeof port.host?.status !== "function" ||
      typeof port.host?.stepOnce !== "function" ||
      (scheduler.wait !== undefined && typeof scheduler.wait !== "function") ||
      (scheduler.now !== undefined && typeof scheduler.now !== "function")
    )
      throw new Error("invalid_receive_composition");
    this.#port = Object.freeze({ ...port });
    this.#policy = Object.freeze(policySchema.parse(policy));
    this.#wait = scheduler.wait ?? wait;
    this.#now = scheduler.now ?? (() => performance.now());
  }
  #status() {
    const status = this.#port.host.status(this.#port.context);
    if (
      typeof status.paused !== "boolean" ||
      typeof status.running !== "boolean" ||
      !Number.isSafeInteger(status.draining) ||
      status.draining < 0 ||
      !["held", "lost", "unconfigured"].includes(status.owner)
    )
      throw new Error("invalid_receive_host_state");
    return status;
  }
  async run(signal: AbortSignal): Promise<ReceiveRunResult> {
    if (this.#running) throw new Error("receive_supervisor_busy");
    this.#running = true;
    let receive_steps = 0,
      retries = 0,
      failures = 0;
    let reason: ReceiveStopReason = "stopped";
    try {
      while (!signal.aborted) {
        const status = this.#status();
        if (status.owner !== "held") {
          reason = "owner_unavailable";
          break;
        }
        if (status.paused) {
          reason = "paused";
          break;
        }
        // Never replace a timed-out client while its underlying work still runs.
        if (status.running || status.draining) {
          reason = "host_unavailable";
          break;
        }
        const step = await this.#port.host.stepOnce(this.#port.context, {
          op: "receive",
        });
        receive_steps++;
        if (step.op !== "receive") throw new Error("invalid_receive_result");
        let next: number;
        if (step.state === "done" && step.reason === null) {
          failures = 0;
          next = this.#policy.interval_ms;
        } else if (
          step.state === "incomplete" &&
          ["poll_transport_failed", "ack_transport_failed"].includes(
            step.reason ?? "",
          )
        ) {
          retries++;
          failures = Math.min(failures + 1, 32);
          next = Math.min(
            this.#policy.retry_cap_ms,
            this.#policy.retry_base_ms * 2 ** (failures - 1),
          );
        } else {
          reason = "host_unavailable";
          break;
        }
        if (!signal.aborted) await this.#wait(next, signal);
      }
    } catch {
      // Unknown exceptions may contain message bodies, credentials or endpoint responses.
      reason = "host_unavailable";
    }
    try {
      // Stop does not revoke, pause, release ownership, discard ACKs or cancel remote commits.
      const start = this.#now();
      if (!Number.isFinite(start)) throw new Error("invalid_clock");
      let last = start;
      for (;;) {
        const status = this.#status();
        if (!status.running && status.draining === 0)
          return { reason, receive_steps, retries, drained: true };
        const now = this.#now();
        if (!Number.isFinite(now) || now < last)
          throw new Error("invalid_clock");
        last = now;
        if (now - start >= this.#policy.drain_timeout_ms)
          return {
            reason: "drain_timeout",
            receive_steps,
            retries,
            drained: false,
          };
        // The stop signal must not short-circuit drain waits into a busy loop.
        await this.#wait(
          Math.min(1000, this.#policy.drain_timeout_ms - (now - start)),
        );
      }
    } catch {
      return {
        reason: "host_unavailable",
        receive_steps,
        retries,
        drained: false,
      };
    } finally {
      this.#running = false;
    }
  }
}
