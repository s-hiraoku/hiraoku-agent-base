/** Optional external-owner wiring. No product authentication or policy selection is implemented here. */
import { createServer } from "node:http";
import { createPrivateRecipientHttp } from "./private-http.ts";

type PrivateHttp = ReturnType<typeof createPrivateRecipientHttp>;
export type VerifiedOwnerBinding = Parameters<PrivateHttp["bindVerified"]>[1];
export type OwnerLaunch = Readonly<{
  /** An object identity local to this generation, not a serialized identity assertion. */
  generation: object;
  mcp: Readonly<{ name: string; type: "http"; url: string; headers: Readonly<{ Authorization: string }> }>;
  signal: AbortSignal;
}>;
export type ExternalOwnerDriver = {
  /** Abort on loss/replacement of the authenticated native owner or approved participant scope. */
  ownerSignal: AbortSignal;
  /** Called exactly once. Must use an owner-authorized, authenticated native management channel. */
  create(launch: OwnerLaunch): Promise<unknown>;
  /**
   * Trusted deployment code, NOT a verifier supplied by the recipient or an MCP tool.
   * Independently verify committed creation, exclusive configuration delivery, current
   * generation and approved effective participants. Reject ambiguous/lost responses.
   * The driver must abort ownerSignal if that verified native scope is lost or changes.
   */
  verifyCommitted(result: unknown, launch: OwnerLaunch): Promise<VerifiedOwnerBinding>;
  /** Close only owned channels/processes. Does not imply native history/session deletion. */
  close(): Promise<void>;
};
/** Trusted owner-local controls; never serialized or exposed to the native peer/MCP/IPC. */
export type ExternalOwnerControls = Readonly<Pick<PrivateHttp, "status" | "updatePermission" | "pause" | "resume"> & {
  /** Aborts before listener/store cleanup. Retained controls are unusable after this signal. */
  signal: AbortSignal;
}>;
export type ExternalOwnerOptions = {
  /** Already authorized for this one launch; never issued, reused or persisted here. */
  bearerToken: string;
  /** Unique owner-selected server name, avoiding existing profile MCP declarations. */
  serverName: string;
  lifetimeMs: number;
  shutdownTimeoutMs: number;
  ownerSignal: AbortSignal;
  driver: ExternalOwnerDriver;
  /**
   * Optional, trusted owner composition invoked once AFTER verified binding, still paused/denied.
   * No automatic grant: call the existing current-epoch controls only under approved local policy.
   * Await all startup work. Shutdown retains stores until this callback settles; never await
   * this owner's completion from inside it. Omitting the callback preserves deny-only behavior.
   */
  onBound?(controls: ExternalOwnerControls): void | Promise<void>;
  /** Called only after the composition has stopped and released its owner. */
  closeStores(): void | Promise<void>;
};

function bounded<T>(work: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(reason)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Actually owns one numeric-loopback listener. Operator controls stay in trusted local composition.
 * Use the separately supervised clean-environment process for a deployable process boundary.
 */
export async function startExternalOwner(options: ExternalOwnerOptions) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.bearerToken) ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(options.serverName) ||
      !Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 || options.lifetimeMs > 900000 ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1 || options.shutdownTimeoutMs > 60000 ||
      !options.ownerSignal || options.ownerSignal.aborted ||
      !options.driver?.ownerSignal || options.driver.ownerSignal.aborted ||
      typeof options.driver?.create !== "function" || typeof options.driver?.verifyCommitted !== "function" ||
      typeof options.driver?.close !== "function" || typeof options.closeStores !== "function" ||
      (options.onBound !== undefined && typeof options.onBound !== "function"))
    throw Error("invalid_external_owner");

  const driver = options.driver, closeStores = options.closeStores, onBound = options.onBound;
  const ownerSignal = AbortSignal.any([options.ownerSignal, driver.ownerSignal]);
  const controller = new AbortController();
  let api: PrivateHttp | undefined;
  let phase: "creating" | "verifying" | "bound-deny" | "bound" | "stopping" | "stopped" = "creating";
  let failure: Error | undefined, stopAttempt: Promise<void> | undefined, startupWork: Promise<unknown> | undefined;
  let resolveCompletion!: () => void, rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  void completion.catch(() => {});
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
    if (!api) { response.writeHead(503, { "cache-control": "no-store" }); response.end(); return; }
    void api.handleRequest(request, response).catch(() => { response.destroy(); });
  });
  server.maxConnections = 16;
  server.keepAliveTimeout = 1000;
  // Includes accepted idle/partial bodies, rather than relying on HTTP headersTimeout alone.
  server.setTimeout(5000, socket => socket.destroy());
  const closeListener = () => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve(); });
    server.closeAllConnections();
  });
  const stop = (): Promise<void> => {
    if (stopAttempt) return stopAttempt;
    let resolveStop!: () => void, rejectStop!: (error: Error) => void;
    // Abort listeners may synchronously reenter stop via the native owner signal.
    // Publish the shared attempt first, while keeping admission fencing synchronous.
    stopAttempt = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    void stopAttempt.then(() => {
      if (failure) rejectCompletion(failure); else resolveCompletion();
    }, () => rejectCompletion(Error("external_owner_cleanup_failed")));
    phase = "stopping";
    void (async () => {
      controller.abort();
      const privateStop = api?.stop() ?? Promise.resolve();
      // Close admission/sockets even if durable drain or driver cleanup later fails.
      const listenerStop = closeListener();
      const results = await Promise.allSettled([
        bounded(privateStop, options.shutdownTimeoutMs, "external_owner_host_stop_timeout"),
        bounded(listenerStop, options.shutdownTimeoutMs, "external_owner_listener_stop_timeout"),
        bounded(Promise.resolve().then(() => driver.close()), options.shutdownTimeoutMs, "external_owner_driver_stop_timeout"),
        bounded(startupWork?.then(() => {}, () => {}) ?? Promise.resolve(), options.shutdownTimeoutMs, "external_owner_startup_work_timeout"),
      ]);
      // Never close stores while the underlying host may still own work.
      if (results[0].status === "fulfilled" && results[2].status === "fulfilled" && results[3].status === "fulfilled")
        await bounded(Promise.resolve().then(closeStores), options.shutdownTimeoutMs, "external_owner_store_close_timeout");
      if (results.some(result => result.status === "rejected")) throw Error("external_owner_cleanup_failed");
      phase = "stopped";
    })().catch(() => { throw Error("external_owner_cleanup_failed"); }).finally(() => {
      ownerSignal.removeEventListener("abort", ownerLost);
    }).then(resolveStop, rejectStop);
    return stopAttempt;
  };
  const ownerLost = () => { void stop().catch(() => {}); };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    if (controller.signal.aborted || ownerSignal.aborted) throw Error("external_owner_stopping");
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw Error("external_owner_listener_invalid");
    const authority = `127.0.0.1:${address.port}`;
    api = createPrivateRecipientHttp({ bearerToken: options.bearerToken, authority,
      lifetimeMs: options.lifetimeMs, shutdownTimeoutMs: options.shutdownTimeoutMs, ownerSignal: controller.signal });
    ownerSignal.addEventListener("abort", ownerLost, { once: true });
    const current = api;
    const launch: OwnerLaunch = Object.freeze({
      generation: Object.freeze({}), signal: controller.signal,
      mcp: Object.freeze({ name: options.serverName, type: "http", url: `http://${authority}/mcp`,
        headers: Object.freeze({ Authorization: `Bearer ${options.bearerToken}` }) }),
    });
    server.on("error", () => { failure = Error("external_owner_listener_failed"); ownerLost(); });
    void current.completion.then(ownerLost, () => { failure = Error("external_owner_host_failed"); ownerLost(); });
    // Only our own post-settlement cancellation is not a startup failure.
    // Driver rejections, including identically named errors, remain failures.
    const startupCancelled = Error("external_owner_stopping");
    const ready = (async () => {
      // No retry, recovery by label, or activation after an uncertain create outcome.
      startupWork = Promise.resolve().then(() => driver.create(launch));
      const result = await startupWork;
      if (controller.signal.aborted) throw startupCancelled;
      phase = "verifying";
      const receipt = current.discoveryReceipt();
      if (!receipt) throw Error("external_owner_discovery_missing");
      const verification = Promise.resolve().then(() => driver.verifyCommitted(result, launch));
      startupWork = verification;
      const binding = await verification;
      if (controller.signal.aborted) throw startupCancelled;
      current.bindVerified(receipt, binding);
      phase = onBound ? "bound" : "bound-deny";
      if (onBound) {
        const requireBound = () => {
          if (controller.signal.aborted || phase !== "bound") throw Error("external_owner_controls_unavailable");
        };
        const controls: ExternalOwnerControls = Object.freeze({
          signal: controller.signal,
          status: () => { requireBound(); return current.status(); },
          updatePermission: (epoch, allow) => { requireBound(); return current.updatePermission(epoch, allow); },
          pause: epoch => { requireBound(); return current.pause(epoch); },
          resume: epoch => { requireBound(); return current.resume(epoch); },
        });
        startupWork = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw startupCancelled;
          return onBound(controls);
        });
        await startupWork;
        if (controller.signal.aborted) throw startupCancelled;
      }
      // "bound" reports the local composition boundary, not permission, activity or delivery.
      return Object.freeze({ url: launch.mcp.url, phase });
    })().catch(error => {
      if (error === startupCancelled) throw error;
      failure ??= Error("external_owner_create_or_verification_failed");
      void stop().catch(() => {});
      throw failure;
    });
    const finiteReady = Promise.race([ready, completion.then(() => { throw Error("external_owner_stopped_before_ready"); })]);
    void finiteReady.catch(() => {});
    return Object.freeze({ ready: finiteReady, completion, stop, status: () => Object.freeze({ phase }) });
  } catch {
    failure = Error("external_owner_start_failed");
    await stop().catch(() => {});
    throw failure;
  }
}
