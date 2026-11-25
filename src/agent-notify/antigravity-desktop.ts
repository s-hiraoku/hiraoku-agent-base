/**
 * The Antigravity desktop screen (docs/plans/antigravity-desktop.md). Conversations in the
 * Antigravity app (and IDE) can be given a message only by `agentapi send-message`, which the
 * app ships and which works only in processes the app itself started. The notifier runs under
 * launchd, outside the app, so it cannot call it. Instead, after 対応する (or an ADR-023
 * auto_accept) it leaves the request in an owner-only spool directory, and a small relay that
 * Antigravity runs as a sidecar (`hab-notify antigravity-relay`, ./antigravity-relay.ts)
 * gives it to the bound conversation once.
 *
 * Arrival alone never writes to the spool: the notice is shown outside Antigravity (the notice
 * file and an optional display command), as for Codex. The answer is `queued`: the request is
 * in the spool, and whether the conversation took it is in the relay's log.
 *
 * Before HAB is told the message was read, `precheck` refuses a request that could never be
 * handed off (too large for one argument, or an unsafe spool), so the message stays unread
 * and its body can still be read with hab_inbox.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { HandoffResult, PeekedMessage } from "./contract.ts";
import type { SessionPresence } from "./session-probe.ts";

/** The largest request handed to a conversation, in UTF-8 bytes (one argv entry). */
export const ANTIGRAVITY_REQUEST_BYTES = 256 * 1024;

/** An Antigravity conversation ID (a UUID today): never a path or an option. */
export const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "conversation id");

export interface AntigravityDesktopBinding {
  /** The app conversation the user works in ($ANTIGRAVITY_CONVERSATION_ID). */
  conversation_id: string;
  /** Absolute, owner-only directory the relay reads. */
  spool_dir: string;
}

export const antigravityDesktopTarget = (binding: AntigravityDesktopBinding) =>
  `antigravity-desktop:${binding.conversation_id}`;

/** Where the app keeps one file per conversation (Antigravity 2.35). */
export const defaultConversationsDir = () =>
  join(homedir(), ".gemini", "antigravity", "conversations");

/** The spool's real path, created owner-only if missing, so the binding names one place. */
export function spoolPath(dir: string): string {
  const path = resolve(dir);
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    // Reported by spoolProblem when a request is handed off.
  }
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Why the spool cannot take a request, or undefined when it is an owner-only directory. */
export function spoolProblem(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) return "spool_not_directory";
    if (stat.mode & 0o077) return "spool_unsafe";
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return "spool_unsafe";
    return undefined;
  } catch {
    return "spool_unavailable";
  }
}

/** One request in the spool. The relay reads nothing else. */
export const spoolRequestSchema = z.strictObject({
  version: z.literal(1),
  message_id: z.string().min(1).max(128),
  sender_id: z.string().min(1).max(128),
  from: z.string().max(2048).nullable(),
  conversation_id: conversationIdSchema,
  title: z.string().min(1).max(256),
  prompt: z
    .string()
    .min(1)
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <= ANTIGRAVITY_REQUEST_BYTES,
      "request too large",
    ),
  written_at: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "time"),
});
export type SpoolRequest = z.infer<typeof spoolRequestSchema>;

const titleOf = (message: PeekedMessage) =>
  `HAB: ${message.from ?? message.sender_id}`.slice(0, 256);

/**
 * Checked before the message is marked read. `unsupported` keeps the message unread: the
 * request is too large for one argument, or the spool is not an owner-only directory.
 */
export function antigravityDesktopPrecheck(
  binding: AntigravityDesktopBinding,
  message: PeekedMessage,
): "unsupported" | undefined {
  if (
    Buffer.byteLength(message.handoff_prompt, "utf8") >
    ANTIGRAVITY_REQUEST_BYTES
  )
    return "unsupported";
  return spoolProblem(binding.spool_dir) === undefined
    ? undefined
    : "unsupported";
}

/**
 * Leaves one approved request in the spool, whole or not at all: it is written to a hidden
 * temporary file (which the relay ignores) and renamed into place. Names sort oldest first.
 */
export function antigravityDesktopHandoff(
  binding: AntigravityDesktopBinding,
  message: PeekedMessage,
  now: () => number = Date.now,
): Promise<HandoffResult> {
  if (antigravityDesktopPrecheck(binding, message))
    return Promise.resolve("unsupported");
  const at = now();
  const request: SpoolRequest = {
    version: 1,
    message_id: message.message_id,
    sender_id: message.sender_id,
    from: message.from,
    conversation_id: binding.conversation_id,
    title: titleOf(message),
    prompt: message.handoff_prompt,
    written_at: new Date(at).toISOString(),
  };
  const key = createHash("sha256")
    .update(JSON.stringify([message.sender_id, message.message_id]))
    .digest("hex")
    .slice(0, 24);
  const name = `${String(at).padStart(15, "0")}-${key}.json`;
  const temporary = join(
    binding.spool_dir,
    `.${name}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      for (let done = 0; done < bytes.length;) {
        const wrote = writeSync(fd, bytes, done, bytes.length - done);
        if (wrote <= 0) throw new Error("spool_write_failed");
        done += wrote;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(binding.spool_dir, name));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
    throw error;
  }
  return Promise.resolve("queued");
}

/**
 * ADR-032 without a configured probe: the app keeps `<conversations>/<id>.db` for each
 * conversation. Missing file → `gone`; a missing directory (another version or home) →
 * `unknown`, so a layout change never makes the address absent.
 */
export function conversationFileProbe(
  conversationId: string,
  dir: string = defaultConversationsDir(),
): () => Promise<SessionPresence> {
  return () => {
    try {
      if (!lstatSync(dir).isDirectory()) return Promise.resolve("unknown");
    } catch {
      return Promise.resolve("unknown");
    }
    return Promise.resolve(
      existsSync(join(dir, `${conversationId}.db`)) ? "present" : "gone",
    );
  };
}
