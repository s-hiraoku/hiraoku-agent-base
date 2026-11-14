/**
 * The receiving end of the Claude Code handoff, run inside Claude Code as its channel MCP
 * server (`scripts/hab-claude-channel.ts`). It listens on a Unix socket in an owner-only
 * directory, takes one request per connection from `claudeCodeHandoff`, and delivers its text
 * to the session as one channel event. Each submission is delivered at most once.
 */
import { lstatSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import { dirname } from "node:path";
import { MessagingError } from "../messaging/delivery-service.ts";
import type { ChannelRequest } from "./claude-code.ts";

import { CHANNEL_REQUEST_BYTES } from "./claude-code.ts";

const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const metaKey = /^[A-Za-z0-9_]{1,64}$/;

export interface ChannelListenerOptions {
  socket: string;
  /**
   * Required: only requests for this Claude Code session are delivered. Claude Code does not
   * tell a channel server its session ID, so the operator passes the one it started with
   * (`claude --session-id`). Without it nothing could be refused, so the listener does not start.
   */
  session_id: string;
  /** Sends one channel event; resolves once written to Claude Code. */
  deliver: (content: string, meta: Record<string, string>) => Promise<void>;
}

function parse(line: string): ChannelRequest | undefined {
  try {
    const value = JSON.parse(line) as Partial<ChannelRequest>;
    if (
      typeof value.session_id !== "string" ||
      typeof value.submission_id !== "string" ||
      !id.test(value.submission_id) ||
      typeof value.text !== "string" ||
      !value.text.length ||
      typeof value.meta !== "object" ||
      value.meta === null
    )
      return undefined;
    const meta: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.meta))
      if (metaKey.test(key) && typeof item === "string") meta[key] = item;
    return {
      session_id: value.session_id,
      submission_id: value.submission_id,
      text: value.text,
      meta,
    };
  } catch {
    return undefined;
  }
}

/** Refuses a socket directory that anyone but the owner can enter. */
function checkDirectory(socket: string) {
  const info = statSync(dirname(socket));
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new MessagingError("insecure_channel_dir");
}

/** A stale socket from a stopped server is removed; a live one is refused. */
async function clearStale(socket: string) {
  let info;
  try {
    info = lstatSync(socket);
  } catch {
    return;
  }
  if (!info.isSocket()) throw new MessagingError("channel_socket_in_use");
  const alive = await new Promise<boolean>((done) => {
    const probe = createConnection(socket);
    probe.on("connect", () => {
      probe.destroy();
      done(true);
    });
    probe.on("error", () => done(false));
  });
  if (alive) throw new MessagingError("channel_socket_in_use");
  unlinkSync(socket);
}

export async function startChannelListener(
  options: ChannelListenerOptions,
): Promise<Server> {
  if (typeof options.session_id !== "string" || !options.session_id.length)
    throw new MessagingError("channel_session_required");
  checkDirectory(options.socket);
  await clearStale(options.socket);
  const delivered = new Set<string>();
  const server = createServer((connection) => {
    // Counted in bytes, not string length, so the limit matches the request as written.
    const chunks: Buffer[] = [];
    let size = 0;
    let handled = false;
    const answer = (result: string) => {
      connection.end(JSON.stringify({ result }) + "\n");
    };
    connection.setTimeout(10_000, () => connection.destroy());
    connection.on("error", () => {});
    connection.on("data", async (chunk: Buffer) => {
      if (handled) return;
      const end = chunk.indexOf(0x0a);
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      size += part.length;
      if (size > CHANNEL_REQUEST_BYTES) {
        handled = true;
        return answer("refused");
      }
      chunks.push(part);
      if (end < 0) return;
      handled = true;
      const request = parse(Buffer.concat(chunks).toString("utf8"));
      if (!request || request.session_id !== options.session_id)
        return answer("refused");
      // A repeat is never delivered twice; it was queued the first time.
      if (delivered.has(request.submission_id)) return answer("queued");
      delivered.add(request.submission_id);
      try {
        await options.deliver(request.text, {
          ...request.meta,
          submission_id: request.submission_id,
        });
        answer("queued");
      } catch {
        // It may or may not have been written to Claude Code.
        answer("unknown");
      }
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.socket, () => done());
  });
  return server;
}
