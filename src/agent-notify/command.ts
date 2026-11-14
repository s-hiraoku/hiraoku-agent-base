/**
 * Runs one trusted, operator-configured command for a screen adapter: a display hook or a
 * handoff into an agent product. The argv comes from the notifier config, never from a
 * message; the message travels only as JSON on stdin.
 */
import { spawn } from "node:child_process";

export interface TrustedCommand {
  /** argv; the first entry is an absolute path. Never built from a message. */
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

const OUTPUT_BYTES = 64 * 1024;

/**
 * Writes `input` to the command's stdin and waits for it to exit 0. With `json`, the last
 * stdout line is parsed and returned. Any other exit, a timeout or unparsable output throws.
 */
export function runCommand(
  spec: TrustedCommand,
  input: string,
  options: { json?: boolean; failure?: string } = {},
): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn(spec.command[0]!, spec.command.slice(1), {
      cwd: spec.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        ...spec.env,
      },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: spec.timeout_ms ?? 60_000,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > OUTPUT_BYTES) child.kill();
    });
    child.on("error", fail);
    // A command that exits before reading its input makes the write fail (EPIPE).
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      try {
        if (code !== 0) throw new Error(options.failure ?? "command_failed");
        done(
          options.json
            ? JSON.parse(out.trim().split("\n").at(-1) ?? "")
            : undefined,
        );
      } catch (error) {
        fail(error);
      }
    });
    child.stdin.end(input);
  });
}
