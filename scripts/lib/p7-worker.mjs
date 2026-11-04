import { spawn, execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function groupExists(pid) {
  try {
    return signalGroup(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    const output = execFileSync("/bin/ps", ["-axo", "pgid="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const groups = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (groups.some((group) => !/^\d+$/.test(group)))
      throw Error("owned_group_probe_unavailable");
    return groups.some((group) => Number(group) === pid);
  }
}
export async function executeOwnedNode({
  cwd,
  env,
  log,
  args,
  timeout_ms = 300000,
  signal,
  grace_ms = 500,
}) {
  const handle = await open(log, "wx", 0o600);
  let child,
    timer,
    escalation,
    interrupted = false,
    timedOut = false,
    error;
  try {
    const result = await new Promise((resolve) => {
      child = spawn(process.execPath, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", handle.fd, handle.fd],
      });
      const terminate = () => {
        if (!child.pid) return;
        signalGroup(child.pid, "SIGTERM");
        escalation ??= setTimeout(
          () => signalGroup(child.pid, "SIGKILL"),
          grace_ms,
        );
      };
      const abort = () => {
        interrupted = true;
        terminate();
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout_ms);
      if (signal?.aborted) abort();
      child.once("error", (failure) => {
        error = failure.message;
      });
      child.once("close", (code, exitSignal) => {
        signal?.removeEventListener("abort", abort);
        resolve({ exit_code: code ?? 1, signal: exitSignal });
      });
    });
    clearTimeout(timer);
    clearTimeout(escalation);
    if (child.pid && groupExists(child.pid)) {
      signalGroup(child.pid, "SIGTERM");
      await delay(grace_ms);
      if (groupExists(child.pid)) signalGroup(child.pid, "SIGKILL");
      for (let n = 0; n < 200 && groupExists(child.pid); n++) await delay(10);
    }
    return {
      ...result,
      error,
      timed_out: timedOut,
      interrupted,
      owned_group: child.pid,
      owned_group_closed: !child.pid || !groupExists(child.pid),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    await handle.close();
  }
}

export function successfulExecution(result) {
  return (
    result.exit_code === 0 &&
    !result.error &&
    !result.timed_out &&
    !result.interrupted &&
    result.owned_group_closed === true
  );
}
