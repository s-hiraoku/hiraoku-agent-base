/**
 * The Antigravity relay (docs/plans/antigravity-desktop.md 2.2): a sidecar the Antigravity
 * app starts and keeps running. It holds no HAB token or key. It reads the owner-only spool
 * the notifier writes after 対応する and gives each request to its conversation once, with
 * the app's own `agentapi send-message`, which works only in processes the app started.
 *
 * At most once: a request is claimed by renaming it into `sending/` (one rename in one
 * directory) before agentapi runs. Exit 0 → `done/`; anything else → `failed/`; neither is
 * sent again. What is still in `sending/` when the relay starts may or may not have reached
 * the conversation, so it goes to `unknown/` unsent. A request older than `max_age_ms`
 * (24 hours) goes to `expired/` unsent, so a long-closed app does not wake the conversation
 * with old mail. The log has one JSON line per request: time, message_id, conversation_id,
 * the outcome and agentapi's exit code. Never the request text, the environment or a token.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  watch,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendPrivate } from "./private-file.ts";
import { spoolProblem, spoolRequestSchema } from "./antigravity-desktop.ts";

export const RELAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Finished requests are kept this long, like HAB's re-read window, then removed. */
export const RELAY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const RELAY_SEND_TIMEOUT_MS = 60_000;
const POLL_MS = 2_000;

export const RELAY_DIRS = [
  "sending",
  "done",
  "failed",
  "unknown",
  "expired",
] as const;
type Outcome = "done" | "failed" | "unknown" | "expired";

/** Runs agentapi with argv (never a shell); resolves its exit code, `null` on a timeout. */
export type RunAgentapi = (
  argv: string[],
  timeoutMs: number,
) => Promise<number | null>;

export const runAgentapi: RunAgentapi = (argv, timeoutMs) =>
  new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });

export interface RelayOptions {
  spool: string;
  log: string;
  /** Default: $ANTIGRAVITY_AGENTAPI_EXE, else ~/.gemini/antigravity/bin/agentapi. */
  agentapi?: string;
  run?: RunAgentapi;
  now?: () => number;
  max_age_ms?: number;
  keep_ms?: number;
  send_timeout_ms?: number;
  /** For tests: how the lock's pid is written (default writeSync). */
  write_lock?: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
  ) => number;
}

export const agentapiPath = (env: NodeJS.ProcessEnv = process.env) =>
  env.ANTIGRAVITY_AGENTAPI_EXE ||
  join(homedir(), ".gemini", "antigravity", "bin", "agentapi");

/** Whether a process with this pid is running (EPERM: running under another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isRequest = (name: string) =>
  !name.startsWith(".") && name.endsWith(".json");

export class AntigravityRelay {
  readonly #spool: string;
  readonly #log: string;
  readonly #agentapi: string;
  readonly #run: RunAgentapi;
  readonly #now: () => number;
  readonly #maxAge: number;
  readonly #keep: number;
  readonly #timeout: number;
  readonly #write: NonNullable<RelayOptions["write_lock"]>;
  constructor(options: RelayOptions) {
    this.#spool = options.spool;
    this.#log = options.log;
    this.#agentapi = options.agentapi ?? agentapiPath();
    this.#run = options.run ?? runAgentapi;
    this.#now = options.now ?? Date.now;
    this.#maxAge = options.max_age_ms ?? RELAY_MAX_AGE_MS;
    this.#keep = options.keep_ms ?? RELAY_KEEP_MS;
    this.#timeout = options.send_timeout_ms ?? RELAY_SEND_TIMEOUT_MS;
    this.#write = options.write_lock ?? writeSync;
  }
  #locked = false;
  /**
   * Takes the spool for this relay, then moves what an earlier run left in `sending/` to
   * `unknown/`. Only one relay may own a spool: a second one would take a live send for an
   * abandoned one. A lock whose process is gone (a crash) is taken over.
   */
  start(): void {
    const problem = spoolProblem(this.#spool);
    if (problem) throw new Error(problem);
    this.#lock();
    for (const dir of RELAY_DIRS)
      mkdirSync(join(this.#spool, dir), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(join(this.#spool, "sending")).filter(
      isRequest,
    ))
      this.#finish("sending", name, "unknown", { reason: "interrupted" });
  }
  /** Gives the spool up; the next relay can start. */
  stop(): void {
    if (!this.#locked) return;
    this.#locked = false;
    try {
      if (readFileSync(this.#lockPath(), "utf8").trim() === String(process.pid))
        unlinkSync(this.#lockPath());
    } catch {
      // Already gone.
    }
  }
  #lockPath() {
    return join(this.#spool, ".relay.lock");
  }
  /**
   * The lock appears with its pid already in it: the pid is written to a private temporary
   * file, which is then hard-linked to `.relay.lock` (a link fails if the lock exists). A
   * relay that dies at any point leaves either no lock or one naming its dead pid, never an
   * empty one that would block every restart.
   */
  #lock() {
    const temporary = join(
      this.#spool,
      `.relay.lock.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // The whole pid, or no lock: a short or failed write (ENOSPC, EIO) must not become a
      // lock naming a cut pid, and must not leave the temporary file behind.
      try {
        const bytes = Buffer.from(`${process.pid}\n`, "utf8");
        for (let done = 0; done < bytes.length;) {
          const wrote = this.#write(fd, bytes, done, bytes.length - done);
          if (wrote <= 0) throw new Error("relay_lock_write_failed");
          done += wrote;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.#linkLock(temporary);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Already gone.
      }
    }
  }
  #linkLock(temporary: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temporary, this.#lockPath());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = NaN;
        try {
          owner = Number(readFileSync(this.#lockPath(), "utf8").trim());
        } catch {
          // Unreadable: treated as held.
        }
        if (!Number.isInteger(owner) || owner <= 0 || alive(owner))
          throw new Error("relay_running");
        this.#takeOver(owner);
        continue;
      }
      this.#locked = true;
      return;
    }
    throw new Error("relay_running");
  }
  /**
   * Removes a lock left by `owner`, a process that is gone. Two relays starting together
   * could both see the dead owner, and the slower one would then delete the lock the faster
   * one had just made. So the removal happens only while holding `.relay.takeover` (one
   * mkdir, which only one process can win), and only if the lock still names `owner`.
   * Whoever loses the mkdir stops with `relay_running`; the app restarts it later. A
   * takeover directory left by a crash in this short step must be removed by hand.
   */
  #takeOver(owner: number) {
    const mutex = join(this.#spool, ".relay.takeover");
    try {
      mkdirSync(mutex, { mode: 0o700 });
    } catch {
      throw new Error("relay_running");
    }
    try {
      let current = NaN;
      try {
        current = Number(readFileSync(this.#lockPath(), "utf8").trim());
      } catch {
        // Gone already: the next open decides.
        return;
      }
      if (current !== owner) throw new Error("relay_running");
      unlinkSync(this.#lockPath());
    } finally {
      rmdirSync(mutex);
    }
  }
  /**
   * Sends every waiting request once, oldest first. Returns how many were taken. Once
   * `signal` aborts, no further request is claimed: the rest stay queued for the next start.
   */
  async drain(signal?: AbortSignal): Promise<number> {
    if (!this.#locked) throw new Error("relay_not_started");
    const names = readdirSync(this.#spool).filter(isRequest).sort();
    let taken = 0;
    for (const name of names) {
      if (signal?.aborted) break;
      try {
        // The claim: whoever renames it sends it; a second relay finds it gone.
        renameSync(join(this.#spool, name), join(this.#spool, "sending", name));
      } catch {
        continue;
      }
      taken++;
      await this.#send(name);
    }
    this.#prune();
    return taken;
  }
  async #send(name: string) {
    const path = join(this.#spool, "sending", name);
    let request;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.mode & 0o077) throw new Error("unsafe");
      request = spoolRequestSchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      );
    } catch {
      this.#finish("sending", name, "failed", { reason: "invalid_request" });
      return;
    }
    const ids = {
      message_id: request.message_id,
      conversation_id: request.conversation_id,
    };
    const now = this.#now();
    // Past HAB's reply deadline hab_reply is refused; past max_age the mail is stale.
    if (
      now - Date.parse(request.written_at) > this.#maxAge ||
      now >= Date.parse(request.expires_at)
    ) {
      this.#finish("sending", name, "expired", ids);
      return;
    }
    let code: number | null;
    try {
      code = await this.#run(
        [
          this.#agentapi,
          "send-message",
          `--title=${request.title}`,
          request.conversation_id,
          request.prompt,
        ],
        this.#timeout,
      );
    } catch {
      code = 127;
    }
    // A timeout may or may not have delivered it: unknown, like an interrupted send.
    const outcome = code === 0 ? "done" : code === null ? "unknown" : "failed";
    this.#finish("sending", name, outcome, { ...ids, exit_code: code });
  }
  #finish(
    from: string,
    name: string,
    outcome: Outcome,
    entry: Record<string, unknown>,
  ) {
    try {
      renameSync(
        join(this.#spool, from, name),
        join(this.#spool, outcome, name),
      );
    } catch {
      // Left where it is: still never sent again, since only the spool root is read.
    }
    try {
      appendPrivate(
        this.#log,
        `${JSON.stringify({ at: new Date(this.#now()).toISOString(), outcome, ...entry })}\n`,
        "relay_log_unsafe",
      );
    } catch {
      // The log is a convenience; the directories are the record.
    }
  }
  /** Finished requests hold message text: remove them after `keep_ms`. */
  #prune() {
    const before = this.#now() - this.#keep;
    for (const dir of ["done", "failed", "unknown", "expired"]) {
      const root = join(this.#spool, dir);
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          if (lstatSync(join(root, name)).mtimeMs < before)
            rmSync(join(root, name), { force: true });
        } catch {
          // Try again next time.
        }
      }
    }
  }
}

/**
 * Runs until the signal aborts: start, then drain on every change in the spool and at
 * least every two seconds (a watch can miss events).
 */
export async function runRelay(
  options: RelayOptions,
  signal: AbortSignal,
): Promise<void> {
  const relay = new AntigravityRelay(options);
  relay.start();
  let wake: (() => void) | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(options.spool, () => wake?.());
    // A watcher can fail later (EMFILE and the like): drop it and keep polling.
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // Polling alone still works.
  }
  try {
    while (!signal.aborted) {
      await relay.drain(signal);
      if (signal.aborted) break;
      await new Promise<void>((done) => {
        const timer = setTimeout(finish, POLL_MS);
        function finish() {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          wake = undefined;
          done();
        }
        wake = finish;
        signal.addEventListener("abort", finish);
      });
    }
  } finally {
    watcher?.close();
    relay.stop();
  }
}
