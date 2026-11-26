/**
 * ADR-034: the presence `hab_discover` shows for an address, derived only from what HAB
 * itself observed (ADR-032 §7 of the wake model): the doorbell, its last answer, the
 * product's receive mode from the ledger, the recipient's own hab_inbox reads and the
 * product's session_gone answers. It says whether HAB can expect the address to notice
 * mail, never that the agent will act on it, and grants or reserves nothing.
 */

/** A polling product is late once this many of its intervals pass without a read. */
export const POLL_OVERDUE_FACTOR = 2;
/** A hab_inbox read this recent shows the address as available whatever its receive mode. */
export const INBOX_READ_RECENT_MS = 60 * 60_000;

export type PresenceState = "available" | "unavailable" | "unknown";
export type PresenceReason =
  | "doorbell_live"
  | "polling"
  | "inbox_read_recently"
  | "session_gone"
  | "doorbell_failing"
  | "poll_overdue"
  | "doorbell_lapsed"
  | "doorbell_missing"
  | "on_request"
  | "inbox_read_earlier"
  | "not_observed";
export interface Presence {
  state: PresenceState;
  reason: PresenceReason;
  /** When HAB observed the fact the state rests on, or null when there is none. */
  observed_at: string | null;
}
/** The doorbell facts presence reads (a subset of `DoorbellState`). */
export interface PresenceFacts {
  live: number;
  lapsed_at: number | null;
  rang_at: number | null;
  status: number | null;
  delivered_at: number | null;
  inbox_read_at: number | null;
  absent_since: number | null;
}
/** The ledger's receive mode for the address's product (ADR-032), or null when unset. */
export interface PresenceReceive {
  mode: "hook" | "poll" | "on_request";
  interval_ms: number | null;
  updated_at: string;
}
/** Asked by hab_discover for each listed address; undefined keeps `not_observed`. */
export type PresenceObserver = (
  agentId: string,
  receive: PresenceReceive | null,
) => Presence | undefined;

export const NOT_OBSERVED: Presence = Object.freeze({
  state: "unknown",
  reason: "not_observed",
  observed_at: null,
});

const iso = (ms: number | null | undefined) =>
  typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
const latest = (...values: (number | null | undefined)[]) => {
  const known = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  return known.length ? Math.max(...known) : null;
};

/**
 * First match wins:
 * 1. the product said the session ended (`session_gone`, hab_send refuses it);
 * 2. a live doorbell whose latest ring was not taken (`doorbell_failing`), else `doorbell_live`;
 * 3. a polling product read within two intervals (`polling`), else `poll_overdue`;
 * 4. any hab_inbox read within the last hour (`inbox_read_recently`);
 * 5. a doorbell that ended without renewal (`doorbell_lapsed`);
 * 6. a hook product with nothing to ring (`doorbell_missing`);
 * 7. a product that reads only when its user asks (`on_request`, unknown);
 * 8. an older hab_inbox read and nothing else (`inbox_read_earlier`, unknown);
 * 9. nothing observed (`not_observed`).
 */
export function derivePresence(
  facts: PresenceFacts | undefined,
  receive: PresenceReceive | null,
  now: number,
): Presence {
  const read = facts?.inbox_read_at ?? null;
  if (facts?.absent_since != null)
    return {
      state: "unavailable",
      reason: "session_gone",
      observed_at: iso(facts.absent_since),
    };
  if (facts && facts.live > 0) {
    if (
      facts.rang_at != null &&
      !(facts.status! >= 200 && facts.status! <= 299)
    )
      return {
        state: "unavailable",
        reason: "doorbell_failing",
        observed_at: iso(facts.rang_at),
      };
    return {
      state: "available",
      reason: "doorbell_live",
      observed_at: iso(latest(facts.delivered_at, read)),
    };
  }
  if (receive?.mode === "poll" && receive.interval_ms !== null) {
    const since = latest(read, Date.parse(receive.updated_at)) ?? 0;
    return now - since > POLL_OVERDUE_FACTOR * receive.interval_ms
      ? { state: "unavailable", reason: "poll_overdue", observed_at: iso(read) }
      : { state: "available", reason: "polling", observed_at: iso(read) };
  }
  if (read !== null && now - read <= INBOX_READ_RECENT_MS)
    return {
      state: "available",
      reason: "inbox_read_recently",
      observed_at: iso(read),
    };
  if (facts?.lapsed_at != null)
    return {
      state: "unavailable",
      reason: "doorbell_lapsed",
      observed_at: iso(facts.lapsed_at),
    };
  if (receive?.mode === "hook")
    return {
      state: "unavailable",
      reason: "doorbell_missing",
      observed_at: null,
    };
  if (receive?.mode === "on_request")
    return { state: "unknown", reason: "on_request", observed_at: iso(read) };
  return read !== null
    ? { state: "unknown", reason: "inbox_read_earlier", observed_at: iso(read) }
    : NOT_OBSERVED;
}
