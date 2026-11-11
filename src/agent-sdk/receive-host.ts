/** Durable agent-side host core and the receive-only host. No scheduler, model, Task or reply policy. */
import { z } from "zod";
import { id } from "./guard.ts";
import { DurableReceiver } from "./receiver.ts";
import type { SenderTransport } from "./sender.ts";
import type { ReceiverTransport } from "./receiver.ts";
import type { SQLiteInbox } from "./sqlite-inbox.ts";
import { HostError } from "./sqlite-host-control.ts";
import type { SQLiteHostControl } from "./sqlite-host-control.ts";
import type { SQLiteHostOwner, HostOwnership } from "./sqlite-host-owner.ts";
import { authenticationRecoveryReason } from "./authentication-recovery.ts";

/** Operations every host authorizes, whatever its command set. */
export type HostCoreOperation = "control" | "status" | "release_owner";
export type HostSourceKey = Readonly<{ sender_id: string; message_id: string }>;
export type HostAuthorizationFor<Op extends string> = (
  context: unknown,
  operation: Op | HostCoreOperation,
  source: HostSourceKey | null,
) => { agent_id: string; actor_id: string } | undefined;
export interface HostTransport extends SenderTransport, ReceiverTransport {
  readonly agentId: string;
  /** Underlying work, including timeouts still settling. Must fail closed on unknown state. */
  readonly activeRequests: number;
}
/** Trusted local capability for exactly one command, never an authentication token.
 * Call check after credential waits and before every network admission/retry. Observe
 * signal, and report activeRequests until actual native work and cleanup settle.
 */
export interface ManagedOperation {
  readonly signal: AbortSignal;
  check(): void;
}
export type HostTransportOptions =
  | {
      transport: (fetch: typeof globalThis.fetch) => HostTransport;
      network?: typeof globalThis.fetch;
      managedTransport?: never;
    }
  | {
      managedTransport: (operation: ManagedOperation) => HostTransport;
      transport?: never;
      network?: never;
    };
/** Exclusive trusted transport choices. Construction must start no IO. */
export type HostCoreOptions<Op extends string> = {
  control: SQLiteHostControl;
  inbox: SQLiteInbox;
  authorization?: HostAuthorizationFor<Op>;
  owner?: SQLiteHostOwner;
} & HostTransportOptions;
export interface HostStepResult<Op extends string = string> {
  op: Op;
  state: "done" | "incomplete";
  reason: string | null;
  value: unknown;
}
/** The per-command capabilities a host command runs with. */
export interface HostSession {
  readonly actor: string;
  /** Fixed local token proving a call came from this command. */
  readonly token: object;
  /** Current authorization, ownership, epoch and stop checks. */
  check(): void;
  /** Runs one store mutation inside the control's active section. */
  atomic<T>(action: () => T): T;
  guarded<A extends unknown[], T>(action: (...args: A) => T): (...args: A) => T;
  /** Network call bracketed by current checks. */
  rpc<T>(action: () => Promise<T>): Promise<T>;
  /** The command's one transport, created on first use. */
  transport(): HostTransport;
}
const coreErrors = [
  "invalid_host_composition",
  "host_busy",
  "sender_transport_failed",
  "poll_transport_failed",
  "ack_transport_failed",
];

export abstract class HostCore<Op extends string> {
  readonly #control: SQLiteHostControl;
  readonly #inbox: SQLiteInbox;
  readonly #factory: HostCoreOptions<Op>["transport"];
  readonly #managedFactory: HostCoreOptions<Op>["managedTransport"];
  #managedActive: AbortController | undefined;
  readonly #network: typeof globalThis.fetch;
  readonly #authorize: HostAuthorizationFor<Op>;
  readonly #ownership?: HostOwnership;
  readonly #knownErrors: readonly string[];
  #running = false;
  #draining: HostTransport[] = [];
  #networkPending = new Set<Promise<Response>>();
  protected constructor(
    options: HostCoreOptions<Op>,
    /** Fixed error codes a subclass reports unchanged. */
    knownErrors: readonly string[] = [],
  ) {
    const { control, inbox } = options;
    if (
      !control ||
      !inbox ||
      [options.owner?.agentId ?? control.agentId, inbox.agentId].some(
        (value) => value !== control.agentId,
      ) ||
      !(
        (typeof options.transport === "function" &&
          options.managedTransport === undefined) ||
        (typeof options.managedTransport === "function" &&
          options.transport === undefined &&
          options.network === undefined)
      ) ||
      (options.network !== undefined &&
        typeof options.network !== "function") ||
      (options.authorization !== undefined &&
        typeof options.authorization !== "function")
    )
      throw new HostError("invalid_host_composition");
    this.#control = control;
    this.#inbox = inbox;
    this.#factory = options.transport;
    this.#managedFactory = options.managedTransport;
    this.#network = options.network ?? globalThis.fetch;
    this.#authorize = options.authorization ?? (() => undefined);
    this.#knownErrors = Object.freeze([...coreErrors, ...knownErrors]);
    if (options.owner) this.#ownership = options.owner.attach();
  }
  protected get agentId() {
    return this.#control.agentId;
  }
  protected get inbox() {
    return this.#inbox;
  }
  #decision(
    context: unknown,
    op: Op | HostCoreOperation,
    source: HostSourceKey | null,
  ) {
    try {
      const value = this.#authorize(
        context,
        op,
        source ? Object.freeze({ ...source }) : null,
      );
      if (value && typeof value === "object" && "then" in value) {
        void Promise.resolve(value).catch(() => {});
        throw Error();
      }
      if (!value || value.agent_id !== this.#control.agentId) throw Error();
      return id.parse(value.actor_id);
    } catch {
      throw new HostError("host_forbidden");
    }
  }
  #guard(
    context: unknown,
    op: Op | HostCoreOperation,
    source: HostSourceKey | null,
  ) {
    const actor = this.#decision(context, op, source);
    return {
      actor,
      check: () => {
        if (this.#decision(context, op, source) !== actor)
          throw new HostError("host_forbidden");
      },
    };
  }
  #pending() {
    this.#draining = this.#draining.filter((client) => {
      try {
        const n = client.activeRequests;
        return !Number.isSafeInteger(n) || n !== 0;
      } catch {
        return true;
      }
    });
    return Math.max(this.#draining.length, this.#networkPending.size);
  }
  status(context: unknown) {
    const guard = this.#guard(context, "status", null),
      state = this.#control.snapshot();
    guard.check();
    let owner: "unconfigured" | "held" | "lost" = "unconfigured";
    if (this.#ownership) {
      try {
        this.#ownership.check();
        owner = "held";
      } catch {
        owner = "lost";
      }
    }
    return {
      ...state,
      running: this.#running,
      draining: this.#pending(),
      owner,
    };
  }
  #cancelManaged() {
    const current = this.#managedActive;
    this.#managedActive = undefined; // Detach before synchronous abort callbacks reenter.
    current?.abort();
  }
  setPaused(context: unknown, paused: boolean, expectedEpoch: number) {
    const guard = this.#guard(context, "control", null);
    try {
      const state = this.#control.setPaused(
        paused,
        expectedEpoch,
        guard.actor,
        guard.check,
      );
      if (paused) this.#cancelManaged();
      return state;
    } catch (error) {
      // An authorized stop with failed persistence must still fence local IO.
      // Invalid/stale/unauthorized requests cannot cancel someone else's command.
      if (
        paused === true &&
        !(
          error instanceof HostError &&
          [
            "invalid_host_control_request",
            "host_epoch_changed",
            "host_forbidden",
          ].includes(error.code)
        )
      )
        this.#cancelManaged();
      throw error;
    }
  }
  releaseOwner(context: unknown) {
    const guard = this.#guard(context, "release_owner", null);
    if (this.#running || this.#pending()) throw new HostError("host_busy");
    if (!this.#ownership) throw new HostError("host_owner_unconfigured");
    if (!this.#control.snapshot().paused)
      throw new HostError("host_must_pause");
    guard.check();
    this.#ownership.release();
  }
  /** Fails before parsing when another command or its network work is still active. */
  protected assertIdle() {
    if (this.#running || this.#pending()) throw new HostError("host_busy");
  }
  /** Runs one already parsed command. Every command is serialized and fenced by the control epoch. */
  protected async execute(
    context: unknown,
    op: Op,
    source: HostSourceKey | null,
    run: (session: HostSession) => Promise<unknown>,
  ): Promise<HostStepResult<Op>> {
    this.assertIdle();
    const guard = this.#guard(context, op, source),
      snapshot = this.#control.snapshot();
    let live = true;
    let managedController: AbortController | undefined;
    const authority = () => {
      if (!live) throw new HostError("host_session_closed");
      guard.check();
      this.#ownership?.check();
      if (managedController?.signal.aborted)
        throw new HostError("host_session_closed");
    };
    const check = () => {
      authority();
      this.#control.check(snapshot.epoch);
      if (managedController?.signal.aborted)
        throw new HostError("host_session_closed");
    };
    check();
    let depth = 0;
    const atomic = <T>(action: () => T): T => {
      if (depth) {
        check();
        const value = action();
        check();
        return value;
      }
      return this.#control.withActive(snapshot.epoch, authority, () => {
        depth++;
        try {
          return action();
        } finally {
          depth--;
        }
      });
    };
    const guarded =
      <A extends unknown[], T>(action: (...args: A) => T) =>
      (...args: A) =>
        atomic(() => action(...args));
    const rpc = async <T>(action: () => Promise<T>) => {
      check();
      const result = await action();
      check();
      return result;
    };
    let transport: HostTransport | undefined;
    const openTransport = (): HostTransport => {
      if (transport) return transport;
      // Each client/fetch closure retains THIS command's epoch; a late callback cannot borrow a new session.
      const fetch: typeof globalThis.fetch = (input, init) => {
        let pending!: Promise<Response>;
        let abandoned = false;
        try {
          atomic(() => {
            pending = Promise.resolve(this.#network(input, init)).then(
              async (response) => {
                if (abandoned) {
                  await response.body?.cancel();
                  throw new HostError("host_session_closed");
                }
                return response;
              },
            );
            this.#networkPending.add(pending);
            void pending.then(
              () => {
                this.#networkPending.delete(pending);
              },
              () => {
                this.#networkPending.delete(pending);
              },
            );
          });
        } catch (error) {
          abandoned = true;
          throw error;
        }
        return pending;
      };
      let created: HostTransport;
      if (this.#managedFactory) {
        managedController = new AbortController();
        this.#managedActive = managedController;
        const controller = managedController;
        const operation: ManagedOperation = Object.freeze({
          signal: controller.signal,
          check: () => {
            if (controller.signal.aborted)
              throw new HostError("host_session_closed");
            try {
              atomic(() => {});
              if (controller.signal.aborted)
                throw new HostError("host_session_closed");
            } catch (error) {
              controller.abort();
              throw error;
            }
          },
        });
        operation.check();
        created = this.#managedFactory(operation);
      } else created = this.#factory!(fetch);
      if (created && typeof created === "object") this.#draining.push(created);
      if (
        created?.agentId !== this.#control.agentId ||
        created.activeRequests !== 0 ||
        ["submit", "status", "poll", "ack"].some(
          (k) => typeof created[k as keyof HostTransport] !== "function",
        )
      )
        throw new HostError("invalid_host_composition");
      transport = created;
      return created;
    };
    const session: HostSession = Object.freeze({
      actor: guard.actor,
      token: Object.freeze({}),
      check,
      atomic,
      guarded,
      rpc,
      transport: openTransport,
    });
    this.#running = true;
    try {
      const value = await run(session);
      check();
      const uncertain =
        value &&
        typeof value === "object" &&
        "state" in value &&
        ["uncertain", "submitting", "waiting_approval"].includes(
          String(value.state),
        );
      return {
        op,
        state: uncertain ? "incomplete" : "done",
        reason: uncertain ? "reconcile_required" : null,
        value,
      };
    } catch (error) {
      // Report current stop/revocation first; component wrappers may have translated the original error.
      let reason: string | undefined;
      try {
        check();
      } catch (current) {
        if (current instanceof HostError) reason = current.code;
      }
      if (!reason) reason = authenticationRecoveryReason(error);
      if (
        !reason &&
        error instanceof Error &&
        "code" in error &&
        this.#knownErrors.includes(String(error.code))
      )
        reason = String(error.code);
      return {
        op,
        state: "incomplete",
        reason: reason ?? "host_step_unavailable",
        value: null,
      };
    } finally {
      live = false;
      if (managedController) {
        if (this.#managedActive === managedController)
          this.#managedActive = undefined;
        managedController.abort();
      }
      this.#running = false;
      this.#pending();
    }
  }
  /** One save-then-ACK receive step through the command's transport. */
  protected async receiveOnce(session: HostSession) {
    const transport = session.transport();
    const inbox = this.#inbox;
    const receiver = new DurableReceiver(
      {
        save: session.guarded(inbox.save.bind(inbox)),
        claimAck: session.guarded(inbox.claimAck.bind(inbox)),
        confirmAck: session.guarded(inbox.confirmAck.bind(inbox)),
        rejectAck: session.guarded(inbox.rejectAck.bind(inbox)),
        inbox: session.guarded(inbox.inbox.bind(inbox)),
      },
      {
        poll: () => session.rpc(() => transport.poll()),
        ack: (request) => session.rpc(() => transport.ack(request)),
      },
    );
    await receiver.receiveOnce();
    return null;
  }
}

export const receiveCommand = z.strictObject({ op: z.literal("receive") });
export type ReceiveCommand = z.infer<typeof receiveCommand>;
export type ReceiveHostOptions = HostCoreOptions<"receive">;

/**
 * The standard agent-side receive host: durable inbox, stop/epoch control and an optional
 * process owner. It needs no outbox, reply budget, Task bridge or answer journal.
 */
export class ReceiveHost extends HostCore<"receive"> {
  constructor(options: ReceiveHostOptions) {
    super(options);
  }
  async stepOnce(
    context: unknown,
    input: ReceiveCommand,
  ): Promise<HostStepResult<"receive">> {
    this.assertIdle();
    try {
      receiveCommand.parse(input);
    } catch {
      throw new HostError("invalid_host_command");
    }
    return this.execute(context, "receive", null, (session) =>
      this.receiveOnce(session),
    );
  }
}
