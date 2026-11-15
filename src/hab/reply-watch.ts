/** Scheduling advice only: the caller owns durable scheduling, cancellation and receipt display.
 * No inbox reads, ACKs, credentials, timers or external effects occur here.
 */
export function replyWatchPlan(
  acceptedAt: string,
  expiresAt: string,
  replyState: "waiting" | "replied" | "no_reply" | "not_expected",
  now = Date.now(),
) {
  const accepted = Date.parse(acceptedAt);
  const expires = Date.parse(expiresAt);
  if (![accepted, expires, now].every(Number.isFinite))
    throw new Error("invalid_reply_watch_time");
  // Short, bounded burst; never keep an interactive turn or a week-long watcher alive.
  const stop = Math.min(expires, accepted + 30 * 60_000);
  const stop_at = new Date(stop).toISOString();
  if (replyState === "replied")
    return { action: "read_reply" as const, stop_at };
  if (replyState !== "waiting" || now >= stop)
    return { action: "stop" as const, stop_at };
  const age = Math.max(0, now - accepted);
  const interval = age < 120_000 ? 15_000 : age < 600_000 ? 60_000 : 300_000;
  // At the bound, stop instead of requesting one final poll at/after the deadline.
  if (now + interval >= stop) return { action: "stop" as const, stop_at };
  return {
    action: "check_status" as const,
    next_check_at: new Date(now + interval).toISOString(),
    stop_at,
  };
}
