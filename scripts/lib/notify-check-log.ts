import type { SessionPresence } from "../../src/agent-notify/session-probe.ts";
/** Safe transition telemetry: callers pass classified codes and already-public notice IDs,
 * never an exception, credential, config or message body. Repeated failures stay quiet.
 */
export function createNotifyCheckLog(
  out: (line: string) => void,
  now = Date.now,
  /** Added to every line, such as the unit's address when one process serves several. */
  tag: Readonly<Record<string, string>> = {},
) {
  const emit = (line: Record<string, unknown>) =>
    out(JSON.stringify({ ...line, ...tag }));
  let failure: { code: string; at: number } | undefined;
  let presence: SessionPresence | undefined;
  return {
    /**
     * ADR-032: the session probe's answer, logged once at the first reading and once per
     * change. A probe stuck at `unknown` shows here, not as silence.
     */
    session(now_presence: SessionPresence) {
      if (now_presence === presence) return;
      presence = now_presence;
      emit({
        at: new Date(now()).toISOString(),
        session: now_presence,
      });
    },
    failed(code: string) {
      const at = now();
      if (failure?.code !== code) {
        emit({ at: new Date(at).toISOString(), error: code });
        failure = { code, at };
      }
    },
    succeeded(shown: unknown[], duration_ms: number) {
      const at = now();
      if (failure) {
        emit({
          at: new Date(at).toISOString(),
          resumed: failure.code,
          blocked_ms: Math.max(0, at - failure.at),
          duration_ms,
        });
        failure = undefined;
      }
      if (shown.length)
        emit({
          at: new Date(at).toISOString(),
          shown,
          duration_ms,
        });
    },
  };
}
