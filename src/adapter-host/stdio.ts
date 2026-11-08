/** Explicit owner-side stdio wiring. No credentials, native runner, scheduler or auto-grant. */
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSingleSourceHost } from "./single-source-authority.ts";
import type { SQLiteAnswerJournal } from "../answer-intents/sqlite-journal.ts";
import { createRecipientHostMcpServer } from "./mcp.ts";

export type SingleSourceStdioOptions = Parameters<
  typeof createSingleSourceHost
>[0] & {
  /** Bounded stop attempt; an incomplete drain retains ownership and all stores. */
  shutdownTimeoutMs: number;
  /** Owner-selected finite lifetime; expiry begins the same fail-closed stop. */
  lifetimeMs: number;
  hostOptions: Parameters<typeof createSingleSourceHost>[0]["hostOptions"] & {
    answer_intents: SQLiteAnswerJournal;
  };
  maxInboxReadResultBytes?: number;
};

/**
 * Connect an already authenticated owner's dedicated host to this process stdio.
 * The caller opens/migrates stores, acquires ownership and verifies both opaque
 * contexts. It must close stores only after stop resolves. A failed stop retains
 * state for a later stop attempt or confirmed process exit; it is not success.
 * Initial policy remains deny and paused. Management is local-only, never MCP.
 */
export async function startSingleSourceRecipientStdio(
  options: SingleSourceStdioOptions,
) {
  if (
    !Number.isSafeInteger(options.shutdownTimeoutMs) ||
    options.shutdownTimeoutMs < 1 ||
    options.shutdownTimeoutMs > 60000
  )
    throw Error("invalid_stdio_shutdown_timeout");
  const shutdownTimeoutMs = options.shutdownTimeoutMs,
    lifetimeMs = options.lifetimeMs;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > 900000 ||
    !options.hostOptions?.answer_intents ||
    (options.maxInboxReadResultBytes !== undefined &&
      (!Number.isSafeInteger(options.maxInboxReadResultBytes) ||
        options.maxInboxReadResultBytes < 1024))
  )
    throw Error("invalid_stdio_composition");
  const operator = options.verifiedOperatorContext;
  const composition = createSingleSourceHost(options);
  const host = composition.host;
  const server = createRecipientHostMcpServer({
    host,
    context: options.verifiedRecipientContext,
    allowedOperations: [
      "receive",
      "send",
      "inbox_read",
      "answer_prepare",
      "answer_inspect",
      "answer_enqueue",
    ],
    maxInboxReadResultBytes: options.maxInboxReadResultBytes,
  });
  let stopping = false,
    stopped = false;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion!: () => void,
    rejectCompletion!: (error: unknown) => void;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const completion = {
    promise: completionPromise,
    resolve: resolveCompletion,
    reject: rejectCompletion,
  };
  // Retain rejection for callers without an unhandled-rejection side effect.
  void completion.promise.catch(() => {});
  let stopAttempt: Promise<void> | undefined;
  /** Keep local grant/resume handles closed after shutdown begins. */
  const requireOpen = () => {
    if (stopping || stopped) throw Error("recipient_stdio_stopping");
  };
  /** Fence recipient guards before control IO; retain stores/owner on a failed stop attempt. */
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (stopAttempt) return stopAttempt;
    stopping = true;
    composition.revokePermanently(operator);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    stopAttempt = (async () => {
      const deadline = performance.now() + shutdownTimeoutMs;
      host.setPaused(operator, true, host.status(operator).epoch);
      for (;;) {
        const state = host.status(operator);
        if (!state.running && state.draining === 0) break;
        if (performance.now() >= deadline)
          throw Error("recipient_stdio_drain_timeout");
        await delay(Math.min(10, Math.max(1, deadline - performance.now())));
      }
      // Shutdown uses the SDK's existing close, never process-wide killing.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          server.close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("recipient_stdio_close_timeout")),
              Math.max(1, deadline - performance.now()),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      host.releaseOwner(operator);
      stopped = true;
      process.stdin.off("end", disconnected);
      process.stdin.off("close", disconnected);
      process.stdin.off("error", disconnected);
      process.stdout.off("error", disconnected);
      completion.resolve();
    })()
      .catch((error: unknown) => {
        completion.reject(error);
        throw error;
      })
      .finally(() => {
        stopAttempt = undefined;
      });
    return stopAttempt;
  };
  const disconnected = () => { void stop().catch(() => {}); };
  server.server.onclose = () => {
    if (!stopping) disconnected();
  };
  // The SDK stdio transport does not turn input EOF into an onclose event.
  // Own these listeners explicitly so a disconnected peer cannot retain a grant.
  process.stdin.once("end", disconnected);
  process.stdin.once("close", disconnected);
  process.stdin.once("error", disconnected);
  process.stdout.once("error", disconnected);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "recipient_stdio_start_cleanup_failed",
      );
    }
    throw error;
  }
  if (process.stdin.readableEnded || process.stdin.destroyed || process.stdout.destroyed)
    disconnected();
  if (!stopping)
    lifetimeTimer = setTimeout(() => {
      void stop().catch(() => {});
    }, lifetimeMs);
  return Object.freeze({
    completion: completion.promise,
    status: () => host.status(operator),
    updatePermission(expectedEpoch: number, allow: boolean) {
      requireOpen();
      composition.updateWhilePaused(operator, expectedEpoch, allow);
      return host.status(operator);
    },
    pause(expectedEpoch: number) {
      requireOpen();
      return host.setPaused(operator, true, expectedEpoch);
    },
    resume(expectedEpoch: number) {
      requireOpen();
      return host.setPaused(operator, false, expectedEpoch);
    },
    stop,
  });
}
