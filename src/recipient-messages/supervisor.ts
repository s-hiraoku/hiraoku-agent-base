/** Opt-in recipient owner scheduling. The native port, never HAB, runs the agent. */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AdapterHostCycle } from "../adapter-host/cycle.ts";
import { RecipientMessageError } from "./contract.ts";
import type { MessageSource, RecipientPhase } from "./contract.ts";
import { RecipientMessages } from "./messages.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const sourcesSchema = z
  .array(z.strictObject({ sender_id: id, message_id: id }))
  .max(100);
const policySchema = z.strictObject({
  interval_ms: z.number().int().min(1000).max(3600000),
  drain_timeout_ms: z.number().int().min(1000).max(60000),
});
type MessagesOptions = ConstructorParameters<typeof RecipientMessages>[0];
type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;
export type RecipientOwnerState = Readonly<{
  source: Readonly<MessageSource>;
  /** accepted is native admission, not model completion; unknown is never waiting_owner. */
  phase: RecipientPhase | "not_started" | "reply_queued" | "blocked";
  /** A reply can be accepted by the HAB host without being received or ACKed by its recipient. */
  outbox_state?: ReturnType<
    RecipientMessages["enqueueReplyOnce"]
  >["outbox_state"];
  message_id?: string;
  reason?: string;
}>;
export interface RecipientSupervisorPort {
  version: 1;
  host: Pick<AdapterHostCycle, "status" | "stepOnce">;
  hostContext: unknown;
  messages: MessagesOptions;
  recipientContext: unknown;
  /** Trusted bounded selection, not a message-controlled dispatch hook. Repeated keys reconcile. */
  sources(): readonly MessageSource[];
  /** Optional synchronous, metadata-only observer. It grants no authority. */
  observe?(state: RecipientOwnerState): void;
}
export type RecipientStopReason =
  | "stopped"
  | "paused"
  | "owner_unavailable"
  | "host_unavailable"
  | "recipient_unavailable"
  | "drain_timeout";
export interface RecipientRunResult {
  reason: RecipientStopReason;
  receive_steps: number;
  recipient_steps: number;
  send_steps: number;
  /** False requires retaining stores/ownership while underlying host work settles. */
  drained: boolean;
}
class Stop extends Error {
  readonly reason: RecipientStopReason;
  constructor(reason: RecipientStopReason) {
    super(reason);
    this.reason = reason;
  }
}
const wait: Wait = async (ms, signal) => {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
};
function sync<T>(action: () => T): T {
  const value = action();
  if (value && typeof value === "object" && "then" in value) {
    void Promise.resolve(value).catch(() => {});
    throw new Stop("recipient_unavailable");
  }
  return value;
}

/**
 * A separately opted-in owner, not a change to ReceiveSupervisor or any MCP server.
 * Compose with the SAME inbox/outbox/budget and owner as host; construction starts no IO.
 * The current native policy still authorizes each admission and exact reply.
 */
export class RecipientSupervisor {
  readonly #port: RecipientSupervisorPort;
  readonly #messages: RecipientMessages;
  readonly #policy: z.infer<typeof policySchema>;
  readonly #wait: Wait;
  readonly #now: () => number;
  #running = false;
  #epoch: number | undefined;
  #signal: AbortSignal | undefined;
  constructor(
    port: RecipientSupervisorPort,
    policy: z.infer<typeof policySchema>,
    scheduler: { wait?: Wait; now?: () => number } = {},
  ) {
    if (
      port?.version !== 1 ||
      typeof port.host?.status !== "function" ||
      typeof port.host?.stepOnce !== "function" ||
      typeof port.sources !== "function" ||
      (port.observe !== undefined && typeof port.observe !== "function") ||
      (scheduler.wait !== undefined && typeof scheduler.wait !== "function") ||
      (scheduler.now !== undefined && typeof scheduler.now !== "function")
    )
      throw new Error("invalid_recipient_composition");
    // An installed MCP connection or a receive-only reader is not a native input API.
    if (!port.messages?.recipient)
      throw new RecipientMessageError("recipient_input_unsupported");
    this.#port = Object.freeze({ ...port });
    this.#policy = Object.freeze(policySchema.parse(policy));
    this.#wait = scheduler.wait ?? wait;
    this.#now = scheduler.now ?? (() => performance.now());
    const authorize = port.messages.authorization ?? (() => undefined);
    this.#messages = new RecipientMessages({
      ...port.messages,
      authorization: (context, operation, source) => {
        this.#check();
        const value = sync(() => authorize(context, operation, source));
        this.#check();
        return value;
      },
    });
  }
  #status() {
    const status = this.#port.host.status(this.#port.hostContext);
    if (
      typeof status.paused !== "boolean" ||
      typeof status.running !== "boolean" ||
      !Number.isSafeInteger(status.draining) ||
      status.draining < 0 ||
      !Number.isSafeInteger(status.epoch) ||
      status.epoch < 0 ||
      !["held", "lost", "unconfigured"].includes(status.owner)
    )
      throw new Stop("host_unavailable");
    return status;
  }
  #check() {
    if (!this.#signal || this.#signal.aborted) throw new Stop("stopped");
    const status = this.#status();
    if (status.owner !== "held") throw new Stop("owner_unavailable");
    if (status.paused) throw new Stop("paused");
    if (
      status.running ||
      status.draining ||
      (this.#epoch !== undefined && status.epoch !== this.#epoch)
    )
      throw new Stop("host_unavailable");
    return status;
  }
  #observe(source: MessageSource, state: Omit<RecipientOwnerState, "source">) {
    this.#check();
    sync(() =>
      this.#port.observe?.(
        Object.freeze({
          ...state,
          source: Object.freeze({ ...source }),
        }),
      ),
    );
    this.#check();
  }
  async run(signal: AbortSignal): Promise<RecipientRunResult> {
    if (this.#running) throw new Error("recipient_supervisor_busy");
    this.#running = true;
    this.#signal = signal;
    const counts = { receive_steps: 0, recipient_steps: 0, send_steps: 0 };
    let reason: RecipientStopReason = "stopped";
    try {
      while (!signal.aborted) {
        this.#epoch = this.#check().epoch;
        const received = await this.#port.host.stepOnce(
          this.#port.hostContext,
          { op: "receive" },
        );
        counts.receive_steps++;
        this.#check();
        if (received.op !== "receive") throw new Stop("host_unavailable");
        if (received.state !== "done" || received.reason !== null) {
          if (
            received.state !== "incomplete" ||
            !["poll_transport_failed", "ack_transport_failed"].includes(
              received.reason ?? "",
            )
          )
            throw new Stop("host_unavailable");
          // Existing ACK journal owns retry. Already-confirmed conversations and
          // approved outbox work can progress while polling is unavailable. Each
          // source still independently requires a confirmed receipt at handoff.
        }
        const sources = sourcesSchema.parse(sync(() => this.#port.sources()));
        const keys = sources.map((s) =>
          JSON.stringify([s.sender_id, s.message_id]),
        );
        if (new Set(keys).size !== keys.length)
          throw new Stop("recipient_unavailable");
        for (const source of sources) {
          this.#check();
          try {
            let state = await this.#messages.inspect(
              this.#port.recipientContext,
              source,
            );
            if (state.phase === "not_started")
              state = await this.#messages.handoffOnce(
                this.#port.recipientContext,
                source,
              );
            counts.recipient_steps++;
            this.#observe(source, state);
            if (state.phase === "reply_ready") {
              const queued = this.#messages.enqueueReplyOnce(
                this.#port.recipientContext,
                source,
              );
              this.#observe(source, queued);
            }
          } catch (error) {
            this.#check();
            if (!(error instanceof RecipientMessageError))
              throw new Stop("recipient_unavailable");
            // Never expose native errors, content or credentials; this is a local refusal, not approval wait.
            this.#observe(source, {
              phase: "blocked",
              reason: [
                "recipient_forbidden",
                "recipient_busy",
                "recipient_invalid_source",
                "recipient_unsupported_message",
                "recipient_invalid_receipt",
                "recipient_invalid_port",
                "recipient_invalid_reply",
                "recipient_reply_unavailable",
                "recipient_input_unsupported",
              ].includes(error.code)
                ? error.code
                : "recipient_unavailable",
            });
          }
        }
        this.#check();
        // Drain the SAME dedicated, already-authorized outbox. This is not a source-specific delivery proof.
        const sent = await this.#port.host.stepOnce(this.#port.hostContext, {
          op: "send",
        });
        counts.send_steps++;
        this.#check();
        if (
          sent.op !== "send" ||
          (sent.state !== "done" &&
            !(
              sent.state === "incomplete" &&
              sent.reason === "sender_transport_failed"
            ))
        )
          throw new Stop("host_unavailable");
        if (!signal.aborted) await this.#wait(this.#policy.interval_ms, signal);
      }
    } catch (error) {
      reason = error instanceof Stop ? error.reason : "host_unavailable";
    }
    // Never release ownership/stores or reset journals. A timed-out host may still be settling.
    try {
      const start = this.#now();
      let last = start;
      if (!Number.isFinite(start)) throw Error();
      for (;;) {
        const status = this.#status();
        if (!status.running && !status.draining)
          return { reason, ...counts, drained: true };
        const now = this.#now();
        if (!Number.isFinite(now) || now < last) throw Error();
        last = now;
        if (now - start >= this.#policy.drain_timeout_ms)
          return { reason: "drain_timeout", ...counts, drained: false };
        await this.#wait(
          Math.min(1000, this.#policy.drain_timeout_ms - (now - start)),
        );
      }
    } catch {
      return { reason: "host_unavailable", ...counts, drained: false };
    } finally {
      this.#signal = undefined;
      this.#epoch = undefined;
      this.#running = false;
    }
  }
}
