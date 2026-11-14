/**
 * The Claude Code screen (ADR-021). Claude Code has two public pieces that fit:
 *
 * - Display: the status line. Claude Code runs the configured `statusLine.command` with the
 *   session's JSON (including `session_id`) on stdin and shows what it prints; nothing goes
 *   to the model. `hab-notify statusline` prints the notices waiting for a choice, but only
 *   when the `session_id` is the bound one. Set `refreshInterval` so a notice appears while
 *   the session is idle.
 * - Handoff: channels (research preview). A channel is an MCP server that Claude Code loads
 *   with `--channels` (or `--dangerously-load-development-channels` for a custom one); its
 *   `notifications/claude/channel` events enter that running session as a `<channel>` tag.
 *   `scripts/hab-claude-channel.ts` is that server. It listens on an owner-only Unix socket;
 *   `handoff` writes one request there after 対応する.
 *
 * Answers: `queued` from the channel → `queued` (Claude Code does not acknowledge events, so
 * a start is never confirmed). No socket, or `refused` (nothing sent) → `unsupported`.
 * Anything else, or a break after the request was written → throws, recorded `unknown`.
 */
import { createConnection } from "node:net";
import type { HandoffResult, NoticeRecord, PeekedMessage } from "./contract.ts";
import { submissionId } from "./hermes-desktop.ts";

export interface ClaudeCodeBinding {
  /** The Claude Code session that shows the notices (the status line's `session_id`). */
  session_id: string;
  /** The channel server's socket (`hab-claude-channel --socket`). */
  channel_socket?: string;
  timeout_ms?: number;
}

export const claudeCodeTarget = (binding: ClaudeCodeBinding) =>
  `claude-code:${binding.session_id}`;

/** What the handoff writes to the channel socket: one JSON line. */
export interface ChannelRequest {
  session_id: string;
  submission_id: string;
  text: string;
  meta: Record<string, string>;
}

const ANSWER_BYTES = 4096;

/**
 * The largest request the channel takes, in UTF-8 bytes. A message body is at most 512 KiB
 * and the whole envelope at most 1 MiB; JSON escaping can grow control characters six-fold,
 * so 8 MiB holds any request built from a message HAB accepted.
 */
export const CHANNEL_REQUEST_BYTES = 8 * 1024 * 1024;

export function claudeCodeHandoff(
  binding: ClaudeCodeBinding,
  message: PeekedMessage,
): Promise<HandoffResult> {
  const socketPath = binding.channel_socket;
  if (!socketPath) return Promise.resolve("unsupported");
  const request: ChannelRequest = {
    session_id: binding.session_id,
    submission_id: submissionId(message),
    text: message.handoff_prompt,
    // Attribute names: letters, digits and underscores only (others are dropped).
    meta: {
      message_id: message.message_id,
      sender_id: message.sender_id,
      thread_id: message.thread_id,
      ...(message.from ? { sender_address: message.from } : {}),
    },
  };
  return new Promise((done, fail) => {
    let written = false;
    let answer = "";
    let settled = false;
    const finish = (result: HandoffResult | Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) fail(result);
      else done(result);
    };
    const socket = createConnection(socketPath);
    socket.setTimeout(binding.timeout_ms ?? 30_000, () =>
      finish(written ? new Error("channel_timeout") : "unsupported"),
    );
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n", () => {
        written = true;
      });
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
      if (answer.length > ANSWER_BYTES)
        return finish(new Error("channel_answer_too_long"));
      const end = answer.indexOf("\n");
      if (end < 0) return;
      let result: unknown;
      try {
        result = (JSON.parse(answer.slice(0, end)) as { result?: unknown })
          .result;
      } catch {
        return finish(new Error("channel_answer_invalid"));
      }
      if (result === "queued") finish("queued");
      else if (result === "refused") finish("unsupported");
      else finish(new Error("channel_unknown"));
    });
    // Before anything was written (no socket, nobody listening) nothing reached the session.
    socket.on("error", (error) => finish(written ? error : "unsupported"));
    socket.on("close", () =>
      finish(written ? new Error("channel_closed") : "unsupported"),
    );
  });
}

/** The status line's input, as far as HAB reads it. */
export interface StatusLineInput {
  session_id?: unknown;
}

const MAX_LINES = 14;

/**
 * The status line for one session: the oldest notice waiting for a choice in full, and a
 * count of the rest. Empty for any other session, and for notices put off with あとで.
 * `command` is the runnable hab-notify prefix (with its `--config`) shown in the hints; the
 * hints name the sender too, since two senders may use the same message ID.
 */
export function claudeCodeStatusLine(
  records: NoticeRecord[],
  binding: ClaudeCodeBinding,
  input: StatusLineInput,
  command = "hab-notify",
): string {
  if (input.session_id !== binding.session_id) return "";
  const waiting = records.filter((record) => record.state === "shown");
  if (!waiting.length) return "";
  const [first, ...rest] = waiting;
  const lines = first!.message.display.split("\n");
  const shown =
    lines.length > MAX_LINES
      ? [
          ...lines.slice(0, MAX_LINES - 1),
          `…（続きは ${command} show ${first!.message_id} ${first!.sender_id} で読めます）`,
        ]
      : lines;
  shown.push(
    `選択: ${command} decide ${first!.message_id} accept|later|decline ${first!.sender_id}`,
  );
  if (rest.length) shown.push(`ほかに ${rest.length} 件の選択待ちがあります。`);
  return shown.join("\n");
}
