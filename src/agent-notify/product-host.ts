/**
 * docs/receiver/session-routing.md: one notifier process serves up to 32 sessions behind one
 * doorbell. This module is the pure core: the routing table (address → session unit) and the
 * answer to one verified ring. It knows nothing about config files, tokens, stores or screens;
 * a unit is opaque behind check() and presence().
 */
import { MessagingError } from "../messaging/delivery-service.ts";
import { parseHabAddress } from "../hab/registry.ts";

/** A HAB address that parseHabAddress accepted; HAB keys absence by it. */
export type Address = string & { readonly __brand: "HabAddress" };

/** Throws RegistryError("invalid_registry_request") unless `raw` is a normalized HAB address. */
export function address(raw: unknown): Address {
  return parseHabAddress(raw).address as Address;
}

export type Presence = "present" | "gone" | "unknown";
export type RingAnswer = "accepted" | "session_gone" | "bad_request";
/** Logged locally only; on the wire every refusal is `410 session_gone`. */
export type GoneReason =
  "unknown_address" | "session_mismatch" | "conversation_gone";

/** Adding a resource here makes SessionTable.of refuse two units sharing it (`shared_<key>`). */
const EXCLUSIVE_KEYS = ["store", "screen", "binding"] as const;
export type Exclusive = Readonly<
  Record<(typeof EXCLUSIVE_KEYS)[number], string>
>;

export interface SessionUnit {
  readonly address: Address;
  /** The ledger's session name: the product's own conversation ID. */
  readonly label: string;
  readonly exclusive: Exclusive;
  readonly interval_ms: number;
  check(): Promise<string[]>;
  /** Hermes asks sessionProbe; products without one answer "unknown". */
  presence(): Promise<Presence>;
  close(): void;
}

export interface Ring {
  readonly to: Address;
  /** Absent from hosts before PR #259; the unit is then chosen by address alone. */
  readonly session: string | undefined;
}

export type Route =
  | { readonly unit: SessionUnit; readonly provisional: boolean }
  | { readonly gone: "unknown_address" }
  | { readonly gone: "session_mismatch"; readonly unit: SessionUnit };

export interface RingLog {
  readonly reason: GoneReason | "provisional";
  readonly ring: Ring;
}

export const MAX_UNITS = 32;
export const PROBE_MS = 1500;

type Pause = "session_mismatch" | "conversation_gone";

export class SessionTable {
  readonly units: readonly SessionUnit[];
  readonly #byAddress: ReadonlyMap<Address, SessionUnit>;
  readonly #paused = new Map<SessionUnit, Pause>();

  private constructor(units: readonly SessionUnit[]) {
    this.units = Object.freeze([...units]);
    this.#byAddress = new Map(units.map((unit) => [unit.address, unit]));
  }

  /**
   * Throws MessagingError: no_sessions, too_many_sessions, duplicate_address,
   * duplicate_session, shared_store, shared_screen, shared_binding.
   */
  static of(units: readonly SessionUnit[]): SessionTable {
    if (units.length === 0) throw new MessagingError("no_sessions");
    if (units.length > MAX_UNITS) throw new MessagingError("too_many_sessions");
    const unique: Record<string, (unit: SessionUnit) => string> = {
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

  /**
   * A session equal to the address is the ledger's provisional name (ADR-032) and is served;
   * refusing it would mark today's single-session notifier absent right after deployment.
   */
  route(ring: Ring): Route {
    const unit = this.#byAddress.get(ring.to);
    if (!unit) return { gone: "unknown_address" };
    if (ring.session === undefined || ring.session === unit.label)
      return { unit, provisional: false };
    if (ring.session === ring.to) return { unit, provisional: true };
    return { gone: "session_mismatch", unit };
  }

  /**
   * Whether the unit may read its inbox (scheduled check or ring). A unit that answered
   * session_gone must not: with #264, its own hab_inbox or hab_peek clears HAB's absence mark.
   * session_mismatch holds until a ring names this unit's own session (the ledger was fixed)
   * or restart; conversation_gone lifts once presence() is present.
   */
  mayPeek(unit: SessionUnit): boolean {
    return !this.#paused.has(unit);
  }

  /** Records what was just learned about a unit; the only writer of the peek state. */
  observe(
    unit: SessionUnit,
    seen: Presence | "session_mismatch" | "session_matched",
  ): void {
    if (seen === "session_matched") {
      if (this.#paused.get(unit) === "session_mismatch")
        this.#paused.delete(unit);
      return;
    }
    if (this.#paused.get(unit) === "session_mismatch") return;
    if (seen === "session_mismatch") this.#paused.set(unit, seen);
    else if (seen === "gone") this.#paused.set(unit, "conversation_gone");
    else if (seen === "present") this.#paused.delete(unit);
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
  if (!isRecord(value) || value.name !== "hab.message.received")
    return undefined;
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
  if ("gone" in route) {
    if (route.gone === "session_mismatch")
      table.observe(route.unit, "session_mismatch");
    log({ reason: route.gone, ring });
    return "session_gone";
  }
  if (ring.session !== undefined && !route.provisional)
    table.observe(route.unit, "session_matched");
  const presence = await presenceWithin(route.unit, probe_ms);
  table.observe(route.unit, presence);
  if (presence === "gone") {
    log({ reason: "conversation_gone", ring });
    return "session_gone";
  }
  if (route.provisional) log({ reason: "provisional", ring });
  wake(route.unit);
  return "accepted";
}

/** HAB gives up after 10 s; a slow or failing probe answers "unknown" and polling covers it. */
async function presenceWithin(
  unit: SessionUnit,
  ms: number,
): Promise<Presence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Presence>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => unit.presence())
        .catch((): Presence => "unknown"),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
