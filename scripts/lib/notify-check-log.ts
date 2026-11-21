import type { SessionPresence } from "../../src/agent-notify/session-probe.ts";
/** Safe transition telemetry: callers pass classified codes and already-public notice IDs,
 * never an exception, credential, config or message body. Repeated failures stay quiet.
 */
export function createNotifyCheckLog(
  out: (line: string) => void,
  now = Date.now,
) {
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
      out(
        JSON.stringify({
          at: new Date(now()).toISOString(),
          session: now_presence,
        }),
      );
    },
    failed(code: string) {
      const at = now();
      if (failure?.code !== code) {
        out(JSON.stringify({ at: new Date(at).toISOString(), error: code }));
        failure = { code, at };
      }
    },
    succeeded(shown: unknown[], duration_ms: number) {
      const at = now();
      if (failure) {
        out(
          JSON.stringify({
            at: new Date(at).toISOString(),
            resumed: failure.code,
            blocked_ms: Math.max(0, at - failure.at),
            duration_ms,
          }),
        );
        failure = undefined;
      }
      if (shown.length)
        out(
          JSON.stringify({
            at: new Date(at).toISOString(),
            shown,
            duration_ms,
          }),
        );
    },
  };
}
