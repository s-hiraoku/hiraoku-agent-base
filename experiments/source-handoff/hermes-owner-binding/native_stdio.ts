/** Bounded local IPC to a trusted native MCP owner. Never launches from a received message. */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from 'zod';

import type {
  NativeCallControl,
  NativeRelayPort,
  NativeTool,
} from "./native_mcp_client.ts";

export interface NativeRelayStdioOptions {
  resource_url: string;
  /** Bytes per JSON frame, excluding the newline; applies in both directions. */
  max_frame_bytes: number;
  shutdown_timeout_ms: number;
}
export interface NativeRelayStdioStart extends NativeRelayStdioOptions {
  /** Already approved local executables/config paths only. No shell or token arguments. */
  command: string;
  args: string[];
  cwd: string;
  /** Explicit process environment; do not pass access/refresh tokens here. */
  env: Record<string, string>;
}
class StdioFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const incomingFrame = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("check"),
    id: sequence,
    check_id: sequence,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("result"),
    id: sequence,
    result: z.string(),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("failure"),
    id: sequence,
    reason: z.enum(["native_call_failed", "projection_failed"]),
  }),
]);
type Pending = {
  id: number;
  lastCheck: number;
  denied: boolean;
  rejected: boolean;
  control: NativeCallControl;
  abort(): void;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};
function validate(options: NativeRelayStdioOptions) {
  try {
    const url = new URL(options.resource_url);
    if (
      url.href !== options.resource_url ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      !Number.isSafeInteger(options.max_frame_bytes) ||
      options.max_frame_bytes < 512 ||
      options.max_frame_bytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(options.shutdown_timeout_ms) ||
      options.shutdown_timeout_ms < 1 ||
      options.shutdown_timeout_ms > 10000
    )
      throw Error();
  } catch {
    throw new StdioFailure("invalid_native_stdio_composition");
  }
}

export class NativeRelayStdioPort implements NativeRelayPort {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: Readonly<NativeRelayStdioOptions>;
  readonly #exited: Promise<void>;
  #onExit!: () => void;
  #pending: Pending | undefined;
  #seq = 0;
  #buffer: Buffer;
  #length = 0;
  #closed = false;
  #closing = false;
  #broken = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  /** Explicit lifecycle action. Construction below only attaches to an existing owned child. */
  static start(options: NativeRelayStdioStart): NativeRelayStdioPort {
    validate(options);
    if (
      typeof options.command !== "string" ||
      options.command.includes("\0") ||
      !isAbsolute(options.command) ||
      typeof options.cwd !== "string" ||
      options.cwd.includes("\0") ||
      !isAbsolute(options.cwd) ||
      !Array.isArray(options.args) ||
      options.args.some(
        (arg) => typeof arg !== "string" || arg.includes("\0"),
      ) ||
      !options.env ||
      typeof options.env !== "object" ||
      Object.entries(options.env).some(
        ([key, value]) =>
          !key ||
          key.includes("=") ||
          key.includes("\0") ||
          typeof value !== "string" ||
          value.includes("\0"),
      )
    )
      throw new StdioFailure("invalid_native_stdio_composition");
    try {
      const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: false,
        windowsHide: true,
      });
      return new NativeRelayStdioPort(child, options);
    } catch {
      throw new StdioFailure("native_stdio_failed");
    }
  }
  constructor(
    child: ChildProcessWithoutNullStreams,
    options: NativeRelayStdioOptions,
  ) {
    validate(options);
    if (
      !child?.stdin ||
      !child.stdout ||
      !child.stderr ||
      typeof child.kill !== "function"
    )
      throw new StdioFailure("invalid_native_stdio_composition");
    this.#child = child;
    this.#options = Object.freeze({
      resource_url: options.resource_url,
      max_frame_bytes: options.max_frame_bytes,
      shutdown_timeout_ms: options.shutdown_timeout_ms,
    });
    this.#buffer = Buffer.alloc(Math.min(options.max_frame_bytes, 4096));
    this.#exited = new Promise((resolve) => {
      this.#onExit = resolve;
    });
    // stderr is intentionally discarded without collecting or printing credentials/provider details.
    child.stderr.resume();
    child.stdin.on("error", () => this.#fatal());
    child.stdout.on("error", () => this.#fatal());
    child.stderr.on("error", () => this.#fatal());
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stdout.on("end", () => {
      if (!this.#closed) this.#fatal();
    });
    child.on("error", () => this.#fatal());
    child.on("close", () => {
      this.#closed = true;
      if (this.#killTimer) clearTimeout(this.#killTimer);
      this.#rejectPending("native_stdio_closed");
      if (this.#pending) this.#pending.control.signal.removeEventListener("abort", this.#pending.abort);
      this.#pending = undefined;
      this.#onExit();
    });
    if (
      (child.exitCode !== null || child.signalCode !== null) &&
      child.stdout.destroyed &&
      child.stderr.destroyed
    ) {
      this.#closed = true;
      this.#broken = true;
      this.#onExit();
    } else if (child.exitCode !== null || child.signalCode !== null)
      this.#fatal();
  }
  get version(): 1 {
    return 1;
  }
  get resource_url() {
    return this.#options.resource_url;
  }
  /** A caller-visible timeout/abort never clears the actual child work admission. */
  get activeRequests() {
    return this.#pending ? 1 : 0;
  }
  /** Lifecycle metadata only. A replacement still requires awaiting close(). */
  get failed() {
    return this.#broken || this.#closing || this.#closed;
  }
  #rejectPending(code: string) {
    const pending = this.#pending;
    if (pending && !pending.rejected) {
      pending.rejected = true;
      pending.reject(new StdioFailure(code));
    }
  }
  #terminate() {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    this.#child.kill("SIGTERM");
    this.#killTimer = setTimeout(() => {
      if (!this.#closed) this.#child.kill("SIGKILL");
    }, this.#options.shutdown_timeout_ms);
  }
  #fatal() {
    this.#broken = true;
    this.#rejectPending("native_stdio_failed");
    this.#terminate();
  }
  #write(value: unknown) {
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > this.#options.max_frame_bytes)
        throw Error();
    } catch {
      throw new StdioFailure("native_stdio_frame_limit");
    }
    try {
      this.#child.stdin.write(encoded + "\n", (error) => {
        if (error) this.#fatal();
      });
    } catch {
      this.#fatal();
    }
  }
  #read(chunk: Buffer) {
    if (this.#broken || this.#closing || this.#closed) return;
    if (!(chunk instanceof Buffer)) {
      this.#fatal();
      return;
    }
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const size = this.#length + end - start;
        if (size > this.#options.max_frame_bytes) throw Error();
        if (size > this.#buffer.length) {
          const next = Buffer.alloc(
            Math.min(
              this.#options.max_frame_bytes,
              Math.max(size, this.#buffer.length * 2),
            ),
          );
          next.set(this.#buffer.subarray(0, this.#length));
          this.#buffer = next;
        }
        this.#buffer.set(chunk.subarray(start, end), this.#length);
        this.#length = size;
        if (newline < 0) return;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          this.#buffer.subarray(0, this.#length),
        );
        this.#length = 0;
        this.#frame(text);
        if (this.#broken || this.#closing) return;
        start = newline + 1;
      }
    } catch {
      this.#fatal();
    }
  }
  #frame(text: string) {
    const frame = incomingFrame.parse(JSON.parse(text));
    const pending = this.#pending;
    if (!pending || frame.id !== pending.id) throw Error();
    if (frame.type === "check") {
      if (frame.check_id !== pending.lastCheck + 1 || frame.check_id > 10000)
        throw Error();
      pending.lastCheck = frame.check_id;
      let allowed =
        !pending.denied && !pending.control.signal.aborted && !this.#closing;
      try {
        if (allowed) pending.control.check();
      } catch {
        allowed = false;
      }
      if (!allowed) pending.denied = true;
      this.#write({
        version: 1,
        type: "checked",
        id: frame.id,
        check_id: frame.check_id,
        allowed,
      });
      return;
    }
    // The peer declares its native operation settled. Only now is admission released.
    pending.control.signal.removeEventListener("abort", pending.abort);
    this.#pending = undefined;
    if (pending.rejected) return;
    if (frame.type === "failure") {
      pending.reject(new StdioFailure(frame.reason));
    } else if (
      pending.denied ||
      pending.control.signal.aborted ||
      pending.lastCheck === 0
    ) {
      pending.reject(new StdioFailure("native_stdio_cancelled"));
    } else {
      try {
        pending.control.check();
        pending.resolve(frame.result);
      } catch {
        pending.reject(new StdioFailure("native_stdio_cancelled"));
      }
    }
  }
  #request(
    type: "call" | "project",
    value: Record<string, unknown>,
    control: NativeCallControl,
  ): Promise<string> {
    try {
      if (this.#closed || this.#closing || this.#broken)
        throw new StdioFailure("native_stdio_closed");
      if (this.#pending) throw new StdioFailure("native_stdio_busy");
      if (
        !control ||
        typeof control.check !== "function" ||
        !(control.signal instanceof AbortSignal) ||
        control.signal.aborted
      )
        throw new StdioFailure("native_stdio_cancelled");
      control.check();
      if (this.#seq >= Number.MAX_SAFE_INTEGER)
        throw new StdioFailure("native_stdio_closed");
      const id = ++this.#seq;
      return new Promise((resolve, reject) => {
        const abort = () => {
          if (this.#pending?.id !== id) return;
          this.#pending.denied = true;
          this.#rejectPending("native_stdio_cancelled");
          // Never target a PID/name. This is the exact child owned by this port.
          // Work remains active until its actual close event, even if a late
          // result arrives while termination is pending.
          this.#terminate();
        };
        this.#pending = {
          id,
          lastCheck: 0,
          denied: false,
          rejected: false,
          control,
          abort,
          resolve,
          reject,
        };
        control.signal.addEventListener("abort", abort, { once: true });
        if (control.signal.aborted) { abort(); return; }
        try {
          this.#write({ version: 1, type, id, ...value });
        } catch {
          // Serialization/size refusal happens before writing the first byte.
          control.signal.removeEventListener("abort", abort);
          this.#pending = undefined;
          reject(new StdioFailure("native_stdio_frame_limit"));
        }
      });
    } catch (error) {
      return Promise.reject(
        error instanceof StdioFailure
          ? error
          : new StdioFailure("native_stdio_cancelled"),
      );
    }
  }
  callTool(
    name: NativeTool,
    args: Readonly<Record<string, unknown>>,
    control: NativeCallControl,
  ) {
    if (!["relay_poll", "relay_ack", "relay_submit", "relay_status"].includes(name))
      return Promise.reject(new StdioFailure("native_stdio_forbidden"));
    return this.#request("call", { name, args }, control);
  }
  /** Stops only this explicitly owned child, waits for actual close, never revokes authentication. */
  async close() {
    this.#terminate();
    await this.#exited;
  }
}
