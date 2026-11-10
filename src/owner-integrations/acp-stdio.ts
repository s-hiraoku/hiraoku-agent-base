/** Optional owner integration. Never imported by the Relay or agent execution core. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import type { ExternalOwnerDriver, OwnerLaunch, VerifiedOwnerBinding } from "../adapter-host/external-owner.ts";

type Commit = Readonly<{ sessionId: string; launch: OwnerLaunch }>;
export type AcpOwnerOptions = {
  /** Independently approved absolute executable and literal arguments. No shell or secret argv. */
  executable: string;
  args: readonly string[];
  cwd: string;
  sessionCwd: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  lifetimeMs: number;
  /** Trusted deployment monitor: abort on participant/profile/generation scope loss. */
  scopeSignal: AbortSignal;
  /**
   * Trusted local deployment verifier, not agent-supplied attestation. Verify product commit
   * semantics and every effective participant. A correlated sessionId alone is NOT identity.
   * The supplied launch/configuration is private; do not log or persist it.
   */
  verifyDeployment(commit: Commit): Promise<VerifiedOwnerBinding>;
};
const MAX_FRAME = 256 * 1024, MAX_BYTES = 8 * 1024 * 1024, MAX_FRAMES = 2048;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const duration = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const literal = (value: string) => typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value);

/** One clean-env, dedicated ACP v1 stdio process; one initialize, one session/new, no prompts. */
export function createAcpOwnerDriver(options: AcpOwnerOptions): ExternalOwnerDriver & {
  exited: Promise<Readonly<{ started: boolean; code: number | null; signal: NodeJS.Signals | null }>>;
  status(): Readonly<{ state: string; forced: boolean }>;
} {
  if (!literal(options.executable) || !isAbsolute(options.executable) || !literal(options.cwd) || !isAbsolute(options.cwd) ||
      !literal(options.sessionCwd) || !isAbsolute(options.sessionCwd) || !Array.isArray(options.args) ||
      options.args.length > 64 || options.args.some(arg => !literal(arg) || arg.length > 4096) ||
      !duration(options.requestTimeoutMs, 60000) || !duration(options.shutdownTimeoutMs, 60000) ||
      !duration(options.lifetimeMs, 900000) || !options.scopeSignal || options.scopeSignal.aborted ||
      typeof options.verifyDeployment !== "function") throw Error("invalid_acp_owner");
  const config = { ...options, args: [...options.args] };
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  let started = false, finished = false, stopping = false, forced = false, signalFailed = false;
  let protocolFailed = false;
  let attempted = false, verified = false, requestId = 0, bytes = 0, frames = 0;
  let buffer: Buffer = Buffer.alloc(0);
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let launchRef: OwnerLaunch | undefined, receipt: object | undefined, sessionId: string | undefined;
  let closeAttempt: Promise<void> | undefined;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let exitValue: Readonly<{ started: boolean; code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let resolveExited!: (value: NonNullable<typeof exitValue>) => void;
  const exited = new Promise<NonNullable<typeof exitValue>>(resolve => { resolveExited = resolve; });
  const rejectPending = () => {
    if (pending) { clearTimeout(pending.timer); pending.reject(Error("acp_request_failed")); pending = undefined; }
  };
  const alive = () => {
    if (stopping || controller.signal.aborted || config.scopeSignal.aborted || launchRef?.signal.aborted)
      throw Error("acp_owner_stopped");
  };
  const loseOwner = () => { controller.abort(); rejectPending(); void close().catch(() => {}); };
  const protocolFault = () => {
    // Shutdown may itself close pipes. Only an active-channel fault is authoritative.
    if (!stopping) protocolFailed = true;
    loseOwner();
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    exitValue = Object.freeze({ started, code, signal });
    resolveExited(exitValue);
    loseOwner();
  };
  const waitExit = async () => {
    if (finished) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exited.then(() => true), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), config.shutdownTimeoutMs);
    })]);
    if (timer) clearTimeout(timer);
    return result;
  };
  const signalChild = (signal: NodeJS.Signals) => {
    if (signalFailed || finished || !child) return;
    forced = true;
    try { if (!child.kill(signal)) signalFailed = true; } catch { signalFailed = true; }
  };
  function close(): Promise<void> {
    if (closeAttempt) return closeAttempt;
    let resolveClose!: () => void, rejectClose!: (error: Error) => void;
    // Publish the shared attempt before any synchronous abort callback can reenter.
    closeAttempt = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    void closeAttempt.catch(() => {});
    stopping = true;
    controller.abort(); rejectPending();
    if (lifetime) clearTimeout(lifetime);
    config.scopeSignal.removeEventListener("abort", loseOwner);
    launchRef?.signal.removeEventListener("abort", loseOwner);
    void Promise.resolve().then(async () => {
      if (!child) { finish(null, null); return; }
      child.stdin.end(); // ACP's owned stdio shutdown, not session deletion or gateway stop.
      if (!await waitExit()) {
        signalChild("SIGTERM");
        if (signalFailed) throw Error("acp_owner_exit_unconfirmed");
        if (!await waitExit()) {
          signalChild("SIGKILL");
          if (signalFailed || !await waitExit()) throw Error("acp_owner_exit_unconfirmed");
        }
      }
      if (forced || signalFailed || exitValue?.code !== 0 || exitValue.signal !== null)
        throw Error("acp_owner_unclean_exit");
      if (protocolFailed) throw Error("acp_owner_protocol_failed");
    }).finally(() => {
      // Release only our pipe handles. This does not claim descendant process cleanup.
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); buffer = Buffer.alloc(0);
    }).then(resolveClose, rejectClose);
    return closeAttempt;
  }
  const write = (value: unknown) => {
    alive();
    const line = JSON.stringify(value) + "\n";
    if (!child || Buffer.byteLength(line) > MAX_FRAME) throw Error("acp_write_failed");
    child.stdin.write(line, error => { if (error) protocolFault(); });
  };
  const onFrame = (line: Buffer) => {
    const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    if (!record(message) || message.jsonrpc !== "2.0") throw Error("acp_invalid_frame");
    if ("method" in message) {
      if (typeof message.method !== "string" || "result" in message || "error" in message || !record(message.params))
        throw Error("acp_invalid_frame");
      if (!("id" in message) && message.method === "session/update") return; // Discard, never trace raw updates.
      // No user approvals are delegated to this deny-only driver. Cancel permission requests.
      if (message.method === "session/request_permission" &&
          (typeof message.id === "string" || Number.isSafeInteger(message.id))) {
        write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      }
      throw Error("acp_unsolicited_request");
    }
    if (!pending || message.id !== pending.id || ("result" in message) === ("error" in message))
      throw Error("acp_unmatched_response");
    if ("error" in message || !record(message.result)) throw Error("acp_request_failed");
    const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message.result);
  };
  const onData = (chunk: Buffer) => {
    if (stopping) return;
    try {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw Error("acp_output_limit");
      // Consume by bounded frame; do not collect an unbounded unterminated line.
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (buffer.length + end - offset > MAX_FRAME) throw Error("acp_frame_limit");
        buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
        if (newline < 0) break;
        if (++frames > MAX_FRAMES || buffer.length === 0) throw Error("acp_frame_limit");
        const line = buffer; buffer = Buffer.alloc(0); onFrame(line); offset = end + 1;
      }
    } catch { protocolFault(); }
  };
  const request = (method: "initialize" | "session/new", params: unknown): Promise<unknown> => {
    alive();
    if (pending) throw Error("acp_request_in_flight");
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pending = { id, resolve, reject, timer: setTimeout(loseOwner, config.requestTimeoutMs) };
      try { write({ jsonrpc: "2.0", id, method, params }); } catch { loseOwner(); }
    });
  };
  const create = async (launch: OwnerLaunch): Promise<unknown> => {
    if (attempted) throw Error("acp_create_already_attempted");
    attempted = true;
    try {
      alive();
      // Enforce only this integration's fixed dedicated HTTP shape, never stdio/env interpolation.
      if (!launch || !Object.isFrozen(launch) || !Object.isFrozen(launch.mcp) || !Object.isFrozen(launch.mcp?.headers) || !launch.signal || launch.signal.aborted || !launch.generation || !launch.mcp ||
          launch.mcp.type !== "http" || !/^[A-Za-z0-9_-]{1,96}$/.test(launch.mcp.name) ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(launch.mcp.url) ||
          !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(launch.mcp.headers?.Authorization) ||
          Object.keys(launch.mcp.headers).length !== 1 || new URL(launch.mcp.url).port === "")
        throw Error("acp_invalid_launch");
      launchRef = launch;
      launch.signal.addEventListener("abort", loseOwner, { once: true });
      config.scopeSignal.addEventListener("abort", loseOwner, { once: true });
      alive();
      lifetime = setTimeout(loseOwner, config.lifetimeMs);
      // No shell, inherited env/execArgv, login, credential loader or output forwarding.
      child = spawn(config.executable, config.args, { cwd: config.cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      child.once("spawn", () => { started = true; });
      child.on("error", () => { if (forced) signalFailed = true; loseOwner(); });
      child.once("exit", finish); child.once("close", finish);
      child.stdout.on("data", onData); child.stdout.on("end", loseOwner); child.stdout.on("error", protocolFault);
      child.stdin.on("error", protocolFault);
      // Drain/discard stderr with no decoding, storage, logging or forwarding.
      child.stderr.on("data", (chunk: Buffer) => {
        if (!stopping && (bytes += chunk.length) > MAX_BYTES) protocolFault();
      });
      child.stderr.on("error", protocolFault);
      const initialized = await request("initialize", { protocolVersion: 1,
        clientInfo: { name: "hab-deny-only-owner", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      alive();
      if (!record(initialized) || initialized.protocolVersion !== 1 || !record(initialized.agentCapabilities) ||
          !record(initialized.agentCapabilities.mcpCapabilities) || initialized.agentCapabilities.mcpCapabilities.http !== true)
        throw Error("acp_capability_mismatch");
      const result = await request("session/new", { cwd: config.sessionCwd, mcpServers: [{
        type: "http", name: launch.mcp.name, url: launch.mcp.url,
        headers: [{ name: "Authorization", value: launch.mcp.headers.Authorization }],
      }] });
      alive();
      if (!record(result) || typeof result.sessionId !== "string" || result.sessionId.length < 1 ||
          result.sessionId.length > 512 || !literal(result.sessionId)) throw Error("acp_invalid_session");
      sessionId = result.sessionId;
      receipt = Object.freeze({}); // Local correlation only, never a serialized native attestation.
      return receipt;
    } catch {
      loseOwner();
      throw Error("acp_create_failed"); // Never copy a native frame, credential, exception or cwd.
    }
  };
  const verifyCommitted = async (result: unknown, launch: OwnerLaunch) => {
    try {
      alive();
      if (verified || !receipt || result !== receipt || launch !== launchRef || !sessionId)
        throw Error("acp_commit_unverified");
      verified = true;
      const binding = await config.verifyDeployment(Object.freeze({ sessionId, launch }));
      alive();
      return binding;
    } catch {
      loseOwner();
      throw Error("acp_verification_failed");
    }
  };
  return Object.freeze({ ownerSignal: controller.signal, create, verifyCommitted, close, exited,
    status: () => Object.freeze({ state: finished ? "exited" : signalFailed ? "exit-unconfirmed" : stopping ? "stopping" : attempted ? "running" : "idle", forced }) });
}
