/** Finite supervisor for a separately reviewed, user-managed external-owner factory. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type OwnerProcessOptions = {
  /** Absolute trusted module exporting createOwnerOptions(signal). No shell/package runner. */
  ownerModule: string;
  cwd: string;
  lifetimeMs: number;
  shutdownTimeoutMs: number;
  ownerSignal: AbortSignal;
};

export function superviseExternalOwner(options: OwnerProcessOptions) {
  if (!isAbsolute(options.ownerModule) || !isAbsolute(options.cwd) ||
      !Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 || options.lifetimeMs > 900000 ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1 || options.shutdownTimeoutMs > 60000 ||
      !options.ownerSignal || options.ownerSignal.aborted) throw Error("invalid_owner_process");
  // Do not copy process.env, execArgv, NODE_OPTIONS, proxy settings or profile secrets.
  // The factory remains trusted code with this OS user's filesystem/network rights.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./owner-process-entry.ts", import.meta.url)), options.ownerModule], {
    cwd: options.cwd, env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let stopping = false, finished = false, clean = false, forced = false, readySeen = false;
  let exitUnconfirmed = false, spawned = false, signalAttempted = false, signalFailed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (value: Readonly<{ url: string; phase: "bound-deny" }>) => void;
  let rejectReady!: (error: Error) => void;
  let resolveCompletion!: () => void, rejectCompletion!: (error: Error) => void;
  let resolveExited!: (value: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void;
  const ready = new Promise<Readonly<{ url: string; phase: "bound-deny" }>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(resolve => { resolveExited = resolve; });
  void ready.catch(() => {}); void completion.catch(() => {});
  const unconfirmed = () => {
    exitUnconfirmed = true;
    if (killTimer) clearTimeout(killTimer); if (exitTimer) clearTimeout(exitTimer);
    rejectReady(Error("owner_process_exit_unconfirmed"));
    rejectCompletion(Error("owner_process_exit_unconfirmed"));
  };
  const signalChild = (signal: NodeJS.Signals) => {
    if (signalFailed) return false;
    signalAttempted = true;
    try { if (!child.kill(signal)) signalFailed = true; }
    catch { signalFailed = true; }
    if (signalFailed) unconfirmed();
    return !signalFailed;
  };
  const stop = () => {
    if (finished) return completion;
    if (!stopping) {
      stopping = true;
      if (child.connected) child.send({ type: "stop" }, () => {});
      else if (!signalChild("SIGTERM")) return completion;
      killTimer = setTimeout(() => {
        forced = true;
        // Only this owned ChildProcess handle, never a discovered PID or whole product gateway.
        if (!signalChild("SIGKILL")) return;
        exitTimer = setTimeout(() => {
          unconfirmed();
          // Keep observing this child, but do not retry a refused/uncertain termination.
          // exited remains pending until actual close; callers MUST retain scratch/state.
        }, options.shutdownTimeoutMs);
      }, options.shutdownTimeoutMs);
    }
    return completion;
  };
  const ownerLost = () => { void stop().catch(() => {}); };
  const lifetime = setTimeout(ownerLost, options.lifetimeMs);
  options.ownerSignal.addEventListener("abort", ownerLost, { once: true });
  child.once("spawn", () => { spawned = true; });
  child.on("message", message => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "ready" && !readySeen && !stopping && "url" in message &&
        typeof message.url === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(message.url)) {
      readySeen = true;
      resolveReady(Object.freeze({ url: message.url, phase: "bound-deny" }));
    }
    if (message.type === "stopped") clean = true;
  });
  child.on("error", () => {
    if (!spawned) { rejectReady(Error("owner_process_start_failed")); return; }
    if (signalAttempted) {
      // A known termination failure must not turn into another/escalated signal attempt.
      signalFailed = true;
      unconfirmed();
    }
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(lifetime); if (killTimer) clearTimeout(killTimer); if (exitTimer) clearTimeout(exitTimer);
    options.ownerSignal.removeEventListener("abort", ownerLost);
    rejectReady(Error("owner_process_not_ready"));
    resolveExited(Object.freeze({ code, signal }));
    if (clean && code === 0 && signal === null && !forced) resolveCompletion();
    else rejectCompletion(Error(forced ? "owner_process_forced_stop" : "owner_process_unclean_exit"));
  };
  // stdio is ignored, so there are no output pipes to drain. Actual process exit is
  // independent evidence even when an earlier IPC disconnect delays/loses "close".
  child.once("exit", finish);
  child.once("close", finish); // Also settles a spawn failure, which has no exit event.
  if (options.ownerSignal.aborted) ownerLost();
  return Object.freeze({ ready, completion, exited, stop,
    status: () => Object.freeze({ state: finished ? "exited" : exitUnconfirmed ? "exit-unconfirmed" : stopping ? "stopping" : "running", forced }) });
}
