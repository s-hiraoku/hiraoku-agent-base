/** Safe transition telemetry: callers pass classified codes and already-public notice IDs,
 * never an exception, credential, config or message body. Repeated failures stay quiet.
 */
export function createNotifyCheckLog(
  out: (line: string) => void,
  now = Date.now,
) {
  let failure: { code: string; at: number } | undefined;
  let gone = false;
  return {
    /**
     * ADR-032: logged once when the product says the bound session is gone, and once when
     * it no longer says so (checks run again).
     */
    sessionGone(nowGone: boolean) {
      if (nowGone === gone) return;
      gone = nowGone;
      out(
        JSON.stringify({
          at: new Date(now()).toISOString(),
          session_gone: nowGone,
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
