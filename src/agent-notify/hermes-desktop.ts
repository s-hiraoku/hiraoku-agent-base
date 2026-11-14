/**
 * The Hermes Desktop screen (ADR-021). Hermes Desktop shows display-only "external
 * messages" in a saved conversation. It runs a configured reader command
 * (`external_messages.readers` in the profile config, paging `cursor-v1`) and shows each
 * event whose `stored_session_id` is that conversation. The card is outside the model
 * conversation, so showing it starts no model work.
 *
 * `HermesDesktopScreen.show` appends the notice to a private JSON Lines file.
 * `hermesDesktopPage` is that reader: it turns the file into the event pages Hermes
 * accepts. Nothing here talks to HAB or to Hermes over the network.
 *
 * After 対応する, `handoff` runs the configured handoff command once, with
 * `{session_id, text, submission_id}` on stdin. It is `hermes_bridge.desktop_handoff`, run in
 * the Hermes runtime. That command admits the text into the same saved conversation through
 * Hermes's own gateway client (`session.resume`, then `prompt.submit`). Its answers map like
 * this: `queued` → `queued`; `refused` (nothing sent) → `unsupported`; anything else throws, and
 * the notifier records `unknown` and never resends. Without a configured command, `handoff`
 * returns `unsupported`. It never falls back to another session or a CLI.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  AgentScreen,
  HandoffResult,
  NoticeState,
  PeekedMessage,
} from "./contract.ts";
import { appendPrivate } from "./private-file.ts";

export interface HermesDesktopBinding {
  /** The saved Hermes conversation (session) ID shown in Desktop. */
  session_id: string;
  /** The Hermes profile that owns it, such as `local-lab`. */
  profile: string;
  /** Must equal the reader's `backend_namespace` in the profile config. */
  backend_namespace: string;
  /** Must equal the reader's `profile_scope` in the profile config. */
  profile_scope: string;
  /** The recipient's HAB agent ID. */
  receiver_id: string;
}

/** The trusted, operator-configured command that hands one request to the conversation. */
export interface HermesDesktopHandoff {
  /** argv; the first entry is an absolute path. Never built from a message. */
  command: string[];
  cwd: string;
  /** Such as HERMES_HOME (the owning profile) and HERMES_SOURCE (the Hermes checkout). */
  env?: Record<string, string>;
  timeout_ms?: number;
}

const HANDOFF_OUTPUT_BYTES = 64 * 1024;

function runHandoff(
  handoff: HermesDesktopHandoff,
  input: string,
): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn(handoff.command[0]!, handoff.command.slice(1), {
      cwd: handoff.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        ...handoff.env,
      },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: handoff.timeout_ms ?? 60_000,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > HANDOFF_OUTPUT_BYTES) child.kill();
    });
    child.on("error", fail);
    // A command that exits before reading its input makes the write fail (EPIPE).
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      try {
        if (code !== 0) throw new Error("handoff_failed");
        done(JSON.parse(out.trim().split("\n").at(-1) ?? ""));
      } catch (error) {
        fail(error);
      }
    });
    child.stdin.end(input);
  });
}

/**
 * Names this one decision, so the owner can tell a repeat apart: a hash of the full
 * (sender_id, message_id) pair, since joining the two with a separator could collide.
 */
export const submissionId = (message: {
  sender_id: string;
  message_id: string;
}) =>
  "hab-" +
  createHash("sha256")
    .update(JSON.stringify([message.sender_id, message.message_id]))
    .digest("hex")
    .slice(0, 32);

export const hermesDesktopTarget = (binding: HermesDesktopBinding) =>
  `hermes-desktop:${binding.profile}:${binding.session_id}`;

interface NoticeLine {
  type: "notice";
  message_id: string;
  sender_id: string;
  from: string | null;
  display: string;
  at: string;
  /** The binding the notice was shown for; the reader returns it only to that binding. */
  binding?: string;
}

const bindingKey = (binding: HermesDesktopBinding) =>
  JSON.stringify([
    binding.session_id,
    binding.profile,
    binding.backend_namespace,
    binding.profile_scope,
    binding.receiver_id,
  ]);

export class HermesDesktopScreen implements AgentScreen {
  readonly target: string;
  readonly #path: string;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #binding: string;
  readonly #handoff: HermesDesktopHandoff | undefined;
  constructor(
    path: string,
    binding: HermesDesktopBinding,
    options: { handoff?: HermesDesktopHandoff; now?: () => number } = {},
  ) {
    this.#path = path;
    this.target = hermesDesktopTarget(binding);
    this.#sessionId = binding.session_id;
    this.#binding = bindingKey(binding);
    this.#handoff = options.handoff;
    this.#now = options.now ?? Date.now;
  }
  #write(line: Record<string, unknown>) {
    appendPrivate(
      this.#path,
      JSON.stringify({ ...line, at: new Date(this.#now()).toISOString() }) +
        "\n",
      "insecure_screen_file",
    );
  }
  async show(message: PeekedMessage) {
    this.#write({
      type: "notice",
      message_id: message.message_id,
      sender_id: message.sender_id,
      from: message.from,
      display: message.display,
      binding: this.#binding,
    });
  }
  async handoff(message: PeekedMessage): Promise<HandoffResult> {
    if (!this.#handoff) return "unsupported";
    const answer = (await runHandoff(
      this.#handoff,
      JSON.stringify({
        session_id: this.#sessionId,
        text: message.handoff_prompt,
        submission_id: submissionId(message),
      }),
    )) as { result?: unknown };
    if (answer?.result === "queued") return "queued";
    if (answer?.result === "refused") return "unsupported";
    // "unknown" or anything else: the prompt may be queued. Never resend.
    throw new Error("handoff_unknown");
  }
  async report(message: PeekedMessage, state: NoticeState) {
    this.#write({
      type: "state",
      message_id: message.message_id,
      sender_id: message.sender_id,
      state,
    });
  }
}

/** The cursor is the number of notices already returned, as decimal digits. */
const cursorPattern = /^[0-9]{1,15}$/;

/**
 * One cursor-v1 page for the Hermes Desktop reader. Each displayed notice is one event;
 * showing a message again adds another event. Hermes needs `handoff_state` to be
 * `pending`, so a card stays as it was shown after the user decides.
 */
export function hermesDesktopPage(
  path: string,
  binding: HermesDesktopBinding,
  options: { after?: string; limit: number },
) {
  if (options.after !== undefined && !cursorPattern.test(options.after))
    throw new Error("invalid_cursor");
  if (!Number.isInteger(options.limit) || options.limit < 1)
    throw new Error("invalid_limit");
  const start = options.after === undefined ? 0 : Number(options.after);
  const notices = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        // Only complete lines: a trailing line without its newline is still being written.
        .slice(0, -1)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type?: unknown })
        .filter((line): line is NoticeLine => line.type === "notice")
    : [];
  const page = notices.slice(start, start + options.limit);
  const target = hermesDesktopTarget(binding);
  const key = bindingKey(binding);
  return {
    source: "external_agent",
    // A notice written for another session, profile or reader (the same file reused under a
    // changed config) is skipped, never relabelled; the cursor still moves past it.
    events: page.flatMap((notice, index) =>
      notice.binding !== key
        ? []
        : [
            {
              event_id: `${notice.sender_id}:${notice.message_id}:${start + index}`,
              source: "external_agent",
              format: "plain_text",
              sender_id: notice.sender_id,
              receiver_id: binding.receiver_id,
              message_id: notice.message_id,
              address: notice.from ?? notice.sender_id,
              backend_namespace: binding.backend_namespace,
              profile_scope: binding.profile_scope,
              owner_kind: "session",
              received_at: notice.at,
              text: notice.display,
              binding_id: target,
              binding_generation: 1,
              logical_target: target,
              stored_session_id: binding.session_id,
              handoff_state: "pending",
            },
          ],
    ),
    next_cursor: String(start + page.length),
    has_more: start + page.length < notices.length,
  };
}
