/**
 * The Codex screen (ADR-021). Codex's public interface for other programs is the app-server
 * (`codex app-server`, JSON-RPC 2.0 without the `jsonrpc` field). It has no display-only
 * notice: `thread/inject_items` writes into the model-visible history, so an unapproved
 * message would become model context. The notice is therefore shown outside Codex (the
 * notice file and an optional display command), and only the handoff goes into Codex.
 *
 * After 対応する, `handoff` connects to the app-server that already serves the thread (its
 * WebSocket listener, `--listen ws://127.0.0.1:PORT`, with a capability token), then
 * `initialize` → `initialized` → `thread/resume {threadId}` → `turn/start {threadId, input}`.
 * It never spawns its own app-server or `codex exec`: that would run outside the session the
 * user is looking at.
 *
 * Answers: a `turn/start` result → `started`. Anything refused before the turn could start
 * (no listener, auth or JSON-RPC error on initialize, resume or turn/start) → `unsupported`.
 * A timeout or a closed connection after `turn/start` was sent → throws, and the notifier
 * records `unknown` and never resends.
 */
import { readFileSync } from "node:fs";
import type { HandoffResult, PeekedMessage } from "./contract.ts";

export interface CodexAppServer {
  /** The running app-server's WebSocket listener, such as ws://127.0.0.1:4500. */
  url: string;
  /** Owner-only file with the capability token given to `--ws-token-file`. */
  token_file?: string;
  timeout_ms?: number;
}

export interface CodexBinding {
  /** The Codex thread the user works in (shown by `thread/list`). */
  thread_id: string;
  app_server?: CodexAppServer;
}

export const codexTarget = (binding: CodexBinding) =>
  `codex:${binding.thread_id}`;

/** One JSON-RPC connection: send a message, receive messages, close. */
export interface RpcConnection {
  send(message: Record<string, unknown>): void;
  /** Called with each parsed message; `null` once the connection closed. */
  listen(receive: (message: Record<string, unknown> | null) => void): void;
  close(): void;
}

export type RpcConnect = (server: CodexAppServer) => Promise<RpcConnection>;

/** Connects with Node's WebSocket; the token goes in the handshake as a bearer header. */
export const websocketConnect: RpcConnect = (server) =>
  new Promise((done, fail) => {
    const headers: Record<string, string> = {};
    if (server.token_file)
      headers.authorization = `Bearer ${readFileSync(server.token_file, "utf8").trim()}`;
    // Node's WebSocket (undici) takes handshake headers as a non-standard option.
    const Socket = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    const socket = new Socket(server.url, { headers });
    let receive: (message: Record<string, unknown> | null) => void = () => {};
    let open = false;
    socket.addEventListener("open", () => {
      open = true;
      done({
        send: (message) => socket.send(JSON.stringify(message)),
        listen: (next) => {
          receive = next;
        },
        close: () => socket.close(),
      });
    });
    socket.addEventListener("message", (event) => {
      try {
        receive(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        // Not JSON: not an answer to us.
      }
    });
    socket.addEventListener("error", () => {
      if (!open) fail(new Error("codex_unreachable"));
    });
    socket.addEventListener("close", () => {
      if (open) receive(null);
      else fail(new Error("codex_unreachable"));
    });
  });

class Refused extends Error {}

/** Gives one request to the thread as a new turn. See the module comment for the answers. */
export async function codexHandoff(
  binding: CodexBinding,
  message: PeekedMessage,
  connect: RpcConnect = websocketConnect,
): Promise<HandoffResult> {
  const server = binding.app_server;
  if (!server) return "unsupported";
  let connection: RpcConnection;
  try {
    connection = await connect(server);
  } catch {
    return "unsupported";
  }
  const pending = new Map<
    number,
    (message: Record<string, unknown> | null) => void
  >();
  connection.listen((incoming) => {
    if (incoming === null) {
      for (const answer of pending.values()) answer(null);
      pending.clear();
      return;
    }
    const answer = pending.get(incoming.id as number);
    if (answer) {
      pending.delete(incoming.id as number);
      answer(incoming);
    }
  });
  let next = 1;
  let sentTurn = false;
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      const id = next++;
      pending.set(id, (answer) => {
        if (answer === null) fail(new Error("codex_closed"));
        else if (answer.error !== undefined) fail(new Refused(method));
        else done((answer.result ?? {}) as Record<string, unknown>);
      });
      connection.send({ id, method, params });
    });
  const timeout = server.timeout_ms ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<HandoffResult> => {
    await call("initialize", {
      clientInfo: {
        name: "hab_notify",
        title: "HAB arrival notifier",
        version: "1",
      },
    });
    connection.send({ method: "initialized" });
    await call("thread/resume", { threadId: binding.thread_id });
    sentTurn = true;
    const result = await call("turn/start", {
      threadId: binding.thread_id,
      input: [{ type: "text", text: message.handoff_prompt }],
    });
    const turn = result.turn as { id?: unknown } | undefined;
    if (typeof turn?.id !== "string") throw new Error("codex_turn_unknown");
    return "started";
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error("codex_timeout")), timeout);
      }),
    ]);
  } catch (error) {
    // Refused before any turn could start, or nothing reached turn/start: nothing was given.
    if (error instanceof Refused || !sentTurn) return "unsupported";
    throw error;
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
