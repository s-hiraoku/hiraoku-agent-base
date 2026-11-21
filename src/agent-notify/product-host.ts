/**
 * docs/receiver/session-routing.md: one notifier process serves up to 32 sessions behind one
 * doorbell. This module is the pure core: the routing table (address → session unit) and the
 * answer to one verified ring. It knows nothing about config files, tokens, stores or screens;
 * a unit is opaque behind check() and presence().
 */
import { HAB_EVENT_NAME } from "../hab/events.ts";
import { parseHabAddress } from "../hab/registry.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import type { SessionPresence } from "./session-probe.ts";
import { wakeableSleep, type WakeAnswer } from "./wake-listener.ts";

/** A HAB address that parseHabAddress accepted; HAB keys absence by it. */
export type Address = string & { readonly __brand: "HabAddress" };

/** Throws RegistryError("invalid_registry_request") unless `raw` is a normalized HAB address. */
export function address(raw: unknown): Address {
  return parseHabAddress(raw).address as Address;
}

export type RingAnswer = WakeAnswer;

type RoutingIssue =
  "unknown_address" | "session_mismatch" | "conversation_gone";

/** Adding a resource here makes SessionTable.of refuse two units sharing it (`shared_<key>`). */
const EXCLUSIVE_KEYS = ["store", "screen", "binding"] as const;
export type Exclusive = Readonly<
  Record<(typeof EXCLUSIVE_KEYS)[number], string>
>;

export interface SessionUnit {
  readonly address: Address | undefined;
  /** The ledger's session name: the product's own conversation ID. */
  readonly label: string;
  readonly exclusive: Exclusive;
  readonly interval_ms: number;
  check(): Promise<string[]>;
  /** Omitted when the product has no session probe. */
  presence?(): Promise<SessionPresence>;
  close(): void;
}

export interface Ring {
  readonly to: Address;
  /** Absent from hosts before PR #259; the unit is then chosen by address alone. */
  readonly session: string | undefined;
}

export type Route =
  | {
      readonly unit: SessionUnit;
      readonly match: "exact" | "provisional" | "legacy";
    }
  | { readonly issue: "unknown_address" }
  | { readonly issue: "session_mismatch"; readonly unit: SessionUnit };

export interface RingLog {
  readonly reason: RoutingIssue | "provisional";
  readonly ring: Ring;
}

export const MAX_UNITS = 32;
export const PROBE_MS = 1500;

export class SessionTable {
  readonly units: readonly SessionUnit[];
  readonly #byAddress: ReadonlyMap<Address, SessionUnit>;
  readonly #mismatched = new Set<SessionUnit>();
  readonly #presence = new Map<SessionUnit, SessionPresence>();
  readonly #pendingPresence = new Map<SessionUnit, Promise<SessionPresence>>();

  private constructor(units: readonly SessionUnit[]) {
    this.units = Object.freeze([...units]);
    this.#byAddress = new Map(
      units.flatMap((unit) =>
        unit.address === undefined ? [] : [[unit.address, unit]],
      ),
    );
  }

  /**
   * Throws MessagingError: no_sessions, too_many_sessions, as_address_required, duplicate_address,
   * duplicate_session, shared_store, shared_screen, shared_binding.
   */
  static of(units: readonly SessionUnit[]): SessionTable {
    if (units.length === 0) throw new MessagingError("no_sessions");
    if (units.length > MAX_UNITS) throw new MessagingError("too_many_sessions");
    if (units.some((unit) => unit.address === undefined))
      throw new MessagingError("as_address_required");
    const unique: Record<string, (unit: SessionUnit) => string | undefined> = {
      duplicate_address: (unit) => unit.address,
      duplicate_session: (unit) => unit.label,
      ...Object.fromEntries(
        EXCLUSIVE_KEYS.map((key) => [
          `shared_${key}`,
          (unit: SessionUnit) => unit.exclusive[key],
        ]),
      ),
    };
    for (const [code, value] of Object.entries(unique))
      if (new Set(units.map(value)).size !== units.length)
        throw new MessagingError(code);
    return new SessionTable(units);
  }

  /** A standalone legacy notifier may have no address. */
  static single(unit: SessionUnit): SessionTable {
    return new SessionTable([unit]);
  }

  /**
   * A session equal to the address is the ledger's provisional name (ADR-032) and is served;
   * refusing it would mark today's single-session notifier absent right after deployment.
   */
  route(ring: Ring): Route {
    const unit = this.#byAddress.get(ring.to);
    if (!unit) return { issue: "unknown_address" };
    if (ring.session === undefined) return { unit, match: "legacy" };
    if (ring.session === ring.to) return { unit, match: "provisional" };
    if (ring.session === unit.label) return { unit, match: "exact" };
    return { issue: "session_mismatch", unit };
  }

  /** The recipient's own hab_peek clears absence, so a configured probe must confirm presence. */
  mayPeek(unit: SessionUnit): boolean {
    return (
      !this.hasRoutingPause(unit) &&
      (unit.presence === undefined ||
        (!this.#pendingPresence.has(unit) &&
          this.#presence.get(unit) === "present"))
    );
  }

  hasRoutingPause(unit: SessionUnit): boolean {
    return this.#mismatched.has(unit);
  }

  noteBinding(unit: SessionUnit, matches: boolean): void {
    if (matches) this.#mismatched.delete(unit);
    else this.#mismatched.add(unit);
  }

  /** Share a bounded observation between a ring and the unit's scheduled check. */
  async refreshPresence(
    unit: SessionUnit,
    ms = PROBE_MS,
  ): Promise<SessionPresence | undefined> {
    const probe = unit.presence?.bind(unit);
    if (!probe) return;
    let pending = this.#pendingPresence.get(unit);
    if (!pending) {
      pending = presenceWithin(probe, ms).then((presence) => {
        this.#presence.set(unit, presence);
        this.#pendingPresence.delete(unit);
        return presence;
      });
      this.#pendingPresence.set(unit, pending);
    }
    return pending;
  }
}

/** Strict on the fields routing needs; ignores the rest so HAB may add fields. */
export function parseRing(body: string): Ring | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.name !== HAB_EVENT_NAME) return undefined;
  const data = value.data;
  if (!isRecord(data)) return undefined;
  const session = data.session;
  if (
    session !== undefined &&
    (typeof session !== "string" || session.length === 0)
  )
    return undefined;
  try {
    return { to: address(data.to), session };
  } catch {
    return undefined;
  }
}

/**
 * Answers one verified ring. The only side effect besides `log` and the unit's peek state is
 * `wake` on the routed unit, never another.
 */
export async function answerRing(
  table: SessionTable,
  body: string,
  wake: (unit: SessionUnit) => void = () => {},
  log: (event: RingLog) => void = () => {},
  probe_ms = PROBE_MS,
): Promise<RingAnswer> {
  const ring = parseRing(body);
  if (!ring) return "bad_request";
  const route = table.route(ring);
  if ("issue" in route) {
    if (route.issue === "session_mismatch")
      table.noteBinding(route.unit, false);
    log({ reason: route.issue, ring });
    return "session_unconfirmed";
  }

  const { unit, match } = route;
  if (match === "exact") table.noteBinding(unit, true);
  if (match === "provisional") log({ reason: "provisional", ring });

  const presence = await table.refreshPresence(unit, probe_ms);
  if (table.hasRoutingPause(unit)) return "session_unconfirmed";
  if (match === "exact" && presence === "gone") {
    log({ reason: "conversation_gone", ring });
    return "session_gone";
  }

  if (!table.mayPeek(unit)) return "session_unconfirmed";
  wake(unit);
  return match === "exact" ? "accepted" : "session_unconfirmed";
}

export type UnitEvent =
  | { readonly presence: SessionPresence }
  | { readonly shown: string[]; readonly duration_ms: number }
  | { readonly error: unknown };

export interface ProductRunOptions {
  readonly stop: AbortSignal;
  /** Opens the doorbell. Called only after every unit is built, and closed first on stop. */
  readonly listen?: (
    answer: (body: string) => Promise<RingAnswer>,
  ) => Promise<{ close(): Promise<void> }>;
  readonly report?: (unit: SessionUnit, event: UnitEvent) => void;
  readonly ringLog?: (event: RingLog) => void;
  readonly presenceTimeoutMs?: number;
  readonly answer?: (
    body: string,
    wake: (unit: SessionUnit) => void,
  ) => Promise<RingAnswer>;
}

/**
 * One loop and one sleep per unit: a ring wakes only its unit, and a unit whose check is slow
 * or failing never holds up another. Closes every unit when the last loop ends.
 */
export async function runProduct(
  table: SessionTable,
  options: ProductRunOptions,
): Promise<void> {
  const failed = new AbortController();
  const stop = AbortSignal.any([options.stop, failed.signal]);
  const report = options.report ?? (() => {});
  const sleeps = new Map(table.units.map((unit) => [unit, wakeableSleep()]));
  const wake = (unit: SessionUnit) => sleeps.get(unit)!.ring();
  const answer =
    options.answer ??
    ((body: string) => answerRing(table, body, wake, options.ringLog));
  try {
    if (stop.aborted) return;
    const listener = await options.listen?.(async (body) => {
      if (stop.aborted) return "session_unconfirmed";
      const result = await answer(body, wake);
      return stop.aborted ? "session_unconfirmed" : result;
    });
    const stopped = new Promise<void>((resolve) => {
      if (stop.aborted) resolve();
      else stop.addEventListener("abort", () => resolve(), { once: true });
    }).then(async () => {
      try {
        await listener?.close();
      } finally {
        for (const sleep of sleeps.values()) sleep.ring();
      }
    });
    const loop = async (unit: SessionUnit) => {
      const sleep = sleeps.get(unit)!;
      while (!stop.aborted) {
        try {
          const presence = await table.refreshPresence(
            unit,
            options.presenceTimeoutMs,
          );
          if (stop.aborted) break;
          if (presence) report(unit, { presence });
          if (table.mayPeek(unit)) {
            const started = performance.now();
            const shown = await unit.check();
            report(unit, {
              shown,
              duration_ms: Math.round(performance.now() - started),
            });
          }
        } catch (error) {
          report(unit, { error });
        }
        if (!stop.aborted) await sleep.sleep(unit.interval_ms);
      }
    };
    const outcomes = await Promise.allSettled([
      ...table.units.map(async (unit) => {
        try {
          await loop(unit);
        } catch (error) {
          failed.abort();
          throw error;
        }
      }),
      stopped,
    ]);
    const failure = outcomes.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  } finally {
    for (const unit of table.units) unit.close();
  }
}

/** A slow or failing probe yields no presence decision. Late results are discarded. */
async function presenceWithin(
  probe: () => Promise<SessionPresence>,
  ms: number,
): Promise<SessionPresence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SessionPresence>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch((): SessionPresence => "unknown"),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
