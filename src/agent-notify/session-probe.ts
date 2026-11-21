/**
 * ADR-032: asks the product whether the session this notifier is bound to still exists.
 * The probe is a trusted, operator-configured command (for Hermes Desktop,
 * `hermes_bridge.desktop_session`), given `{session_id}` on stdin, that prints one JSON line
 * `{"result": "present" | "gone" | "unknown"}`. Only an explicit `gone` counts: a failed,
 * slow or unparsable probe is `unknown`, so an outage never makes an address absent.
 */
import { runCommand, type TrustedCommand } from "./command.ts";

export type SessionPresence = "present" | "gone" | "unknown";

/** Short enough that HAB (10 s for a doorbell) always gets an answer. */
export const PROBE_TIMEOUT_MS = 3000;
/** A ring and the check it starts share one answer. */
export const PROBE_REUSE_MS = 5000;

export function sessionProbe(
  spec: TrustedCommand,
  sessionId: string,
  options: { now?: () => number; reuseMs?: number } = {},
): () => Promise<SessionPresence> {
  const now = options.now ?? Date.now;
  const reuseMs = options.reuseMs ?? PROBE_REUSE_MS;
  const command = {
    ...spec,
    timeout_ms: Math.min(spec.timeout_ms ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
  };
  let last: { at: number; answer: Promise<SessionPresence> } | undefined;
  const ask = async (): Promise<SessionPresence> => {
    try {
      const answer = (await runCommand(
        command,
        JSON.stringify({ session_id: sessionId }),
        { json: true, failure: "session_probe_failed" },
      )) as { result?: unknown } | null;
      return answer?.result === "present" || answer?.result === "gone"
        ? answer.result
        : "unknown";
    } catch {
      return "unknown";
    }
  };
  return () => {
    const at = now();
    if (!last || at - last.at >= reuseMs) last = { at, answer: ask() };
    return last.answer;
  };
}
