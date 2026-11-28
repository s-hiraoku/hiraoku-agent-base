/**
 * The Antigravity screen (ADR-021). Antigravity (app, IDE and CLI) has no public way for
 * another program to show a notice in a conversation or to wake one when mail arrives: its
 * hooks run only at the edges of a turn the user started, and `antigravity://` links open a
 * new conversation. The notice is therefore shown outside Antigravity (the notice file and an
 * optional display command), as for Codex.
 *
 * The one public entrance into an existing conversation is the CLI's headless mode:
 * `agy -p <prompt> --conversation <id> --output-format stream-json` resumes that conversation
 * and runs one turn. `handoff` uses it only after 対応する (or an ADR-023 auto_accept), never
 * on arrival, so the model is not woken by mail alone and the message stays unread until the
 * approved turn reads it.
 *
 * Answers: the run's first NDJSON event is `init` with the same `conversation_id` →
 * `started`, and the turn goes on in the background (its output is drained, and the last
 * `result` line is kept in `log_file` when one is set). An `init` for another conversation
 * means `--conversation` did not resume ours: the run is killed before its turn and the
 * answer is `unsupported`. An exit before any `init` → `unsupported` (nothing was given to the
 * conversation). No `init` before the deadline → the run is killed and the handoff throws, so
 * the notifier records `unknown` and never resends.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { HandoffResult, PeekedMessage } from "./contract.ts";

export interface AntigravityCli {
  /** Absolute path of `agy` (Antigravity CLI). */
  agy_bin: string;
  /** Absolute workspace directory the conversation belongs to; the run starts there. */
  cwd: string;
  /** Owner-only file that gets one JSON line per finished run (status, never the text). */
  log_file?: string;
  /** How long to wait for `init`; default 20 s. */
  timeout_ms?: number;
}

export interface AntigravityBinding {
  /** The Antigravity CLI conversation the user works in (`conversation_id`). */
  conversation_id: string;
  cli?: AntigravityCli;
}

export const antigravityTarget = (binding: AntigravityBinding) =>
  `antigravity:${binding.conversation_id}`;

/** One running `agy`: its stdout lines, its exit, and a way to stop it. */
export interface AgyRun {
  /** Called with each stdout line; `null` once the process exited (with its code). */
  listen(receive: (line: string | null, code?: number | null) => void): void;
  kill(): void;
}

export type SpawnAgy = (argv: string[], cwd: string) => AgyRun;

export const spawnAgy: SpawnAgy = (argv, cwd) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let receive: (line: string | null, code?: number | null) => void = () => {};
  let rest = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    rest += chunk;
    let end: number;
    while ((end = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (line.trim()) receive(line);
    }
    // A run that never ends its lines must not grow memory without bound.
    if (rest.length > 1024 * 1024) rest = "";
  });
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    if (rest.trim()) receive(rest);
    rest = "";
    receive(null, code);
  };
  child.on("error", () => exit(null));
  child.on("close", (code) => exit(code));
  return {
    listen: (next) => {
      receive = next;
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
};

const INIT_TIMEOUT_MS = 20_000;

const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Gives one approved request to the bound conversation as a headless turn. */
export function antigravityHandoff(
  binding: AntigravityBinding,
  message: PeekedMessage,
  run: SpawnAgy = spawnAgy,
): Promise<HandoffResult> {
  const cli = binding.cli;
  if (!cli) return Promise.resolve("unsupported");
  const argv = [
    cli.agy_bin,
    "-p",
    message.handoff_prompt,
    "--conversation",
    binding.conversation_id,
    "--output-format",
    "stream-json",
  ];
  return new Promise((done, fail) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const agy = run(argv, cli.cwd);
    const timer = setTimeout(
      () =>
        settle(() => {
          agy.kill();
          fail(new Error("antigravity_timeout"));
        }),
      cli.timeout_ms ?? INIT_TIMEOUT_MS,
    );
    agy.listen((line, code) => {
      if (line === null) {
        // Exited before init: nothing reached the conversation.
        settle(() => done("unsupported"));
        if (cli.log_file)
          record(cli.log_file, {
            conversation_id: binding.conversation_id,
            message_id: message.message_id,
            exit_code: code ?? null,
          });
        return;
      }
      const event = parse(line);
      if (!event) return;
      if (event.type === "init") {
        if (event.conversation_id === binding.conversation_id)
          settle(() => done("started"));
        else
          settle(() => {
            agy.kill();
            done("unsupported");
          });
        return;
      }
      if (event.type === "result" && cli.log_file)
        record(cli.log_file, {
          conversation_id: binding.conversation_id,
          message_id: message.message_id,
          status: typeof event.status === "string" ? event.status : null,
          num_turns:
            typeof event.num_turns === "number" ? event.num_turns : null,
        });
    });
  });
}

function record(file: string, entry: Record<string, unknown>) {
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // The log is a convenience; the handoff answer is already decided.
  }
}
