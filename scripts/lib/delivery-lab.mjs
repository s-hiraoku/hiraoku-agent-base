import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createServer } from "node:net";

export async function assertLoopbackPortFree(port) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close(() => {});
      reject(
        Object.assign(Error("loopback preflight timeout"), {
          code: "PREFLIGHT_TIMEOUT",
        }),
      );
    }, 2000);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }),
    );
  });
}

export function labEnvironment(parent, scratch, preparedNats) {
  return {
    PATH: parent.PATH ?? "/usr/bin:/bin",
    ...(parent.SystemRoot ? { SystemRoot: parent.SystemRoot } : {}),
    LANG: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    NO_COLOR: "1",
    NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
    HAB_DELIVERY_LAB: "synthetic-only",
    ...(preparedNats ? { HAB_NATS_SERVER: preparedNats.stagedPath } : {}),
  };
}

export function tapTotals(output) {
  const keys = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
  const totals = Object.fromEntries(
    keys.map((key) => {
      const match = output.match(new RegExp(`^# ${key} (\\d+)\\s*$`, "m"));
      if (!match) throw Error(`missing TAP summary: ${key}`);
      return [key, Number(match[1])];
    }),
  );
  if (
    totals.tests === 0 ||
    totals.tests !==
      totals.pass +
        totals.fail +
        totals.cancelled +
        totals.skipped +
        totals.todo
  )
    throw Error("inconsistent TAP totals");
  return totals;
}

export function gateVerdict(groups, pending, release, expectedIds) {
  if (
    !expectedIds?.length ||
    new Set(expectedIds).size !== expectedIds.length ||
    groups.length !== expectedIds.length ||
    new Set(groups.map((group) => group.id)).size !== groups.length ||
    expectedIds.some((id) => !groups.some((group) => group.id === id))
  )
    return "FAIL";
  if (
    groups.length === 0 ||
    groups.some(
      (group) =>
        group.exit_code !== 0 ||
        !group.totals ||
        group.totals.fail ||
        group.totals.cancelled ||
        group.totals.todo,
    )
  )
    return "FAIL";
  if (
    release &&
    (pending.length > 0 || groups.some((group) => group.totals.skipped))
  )
    return "BLOCKED";
  return release ? "RELEASE_PASS" : "BASELINE_PASS";
}
export async function executeNode({
  cwd,
  env,
  log,
  args,
  signal,
  timeout_ms = 300000,
}) {
  const handle = await open(log, "wx", 0o600);
  try {
    return await new Promise((resolveExit) => {
      let error;
      const child = spawn(process.execPath, args, {
        cwd,
        env,
        signal,
        timeout: timeout_ms,
        killSignal: "SIGTERM",
        stdio: ["ignore", handle.fd, handle.fd],
      });
      child.once("error", (failure) => {
        error = failure.message;
      });
      child.once("close", (code, signal) =>
        resolveExit({ exit_code: code ?? 1, signal, error }),
      );
    });
  } finally {
    await handle.close();
  }
}
