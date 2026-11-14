/**
 * The arrival notifier CLI (ADR-021). Shows new HAB mail in the agent's own screen through
 * a configured adapter and applies the user's choice. Prints no tokens. Only `events`
 * prints message text: it is the Hermes Desktop reader, and Hermes shows that text.
 *
 *   hab-notify --config <notify.json> run            keep checking every interval_ms
 *   hab-notify --config <notify.json> check          check once
 *   hab-notify --config <notify.json> list           notices waiting for a choice
 *   hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
 *   hab-notify --config <notify.json> show-again <message_id> [sender_id]
 *   hab-notify --config <notify.json> events [--limit N] [--after CURSOR]
 *       (screen type hermes-desktop: one cursor-v1 page for Hermes Desktop; reads only the
 *       local screen file, never HAB)
 *   hab-notify --config <notify.json> statusline
 *       (screen type claude-code: the Claude Code status line command; reads the session
 *       JSON on stdin and only the local choice record, never HAB)
 *
 * Screen types: jsonl, hermes-desktop, codex, claude-code, chatgpt-connector (Dots).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  HabNotifierClient,
  HermesDesktopScreen,
  JsonlScreen,
  ProductScreen,
  ReceiptNotifier,
  SQLiteNotices,
  chatgptConnectorHandoff,
  chatgptConnectorTarget,
  claudeCodeHandoff,
  claudeCodeStatusLine,
  claudeCodeTarget,
  codexHandoff,
  codexTarget,
  hermesDesktopPage,
} from "../src/agent-notify/index.ts";
import type { AgentScreen } from "../src/agent-notify/index.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";

const usage = `usage:
  hab-notify --config <notify.json> run|check|list
  hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
  hab-notify --config <notify.json> show-again <message_id> [sender_id]
  hab-notify --config <notify.json> events [--limit N] [--after CURSOR]
  hab-notify --config <notify.json> statusline`;

/** A trusted command from this config: absolute argv[0] and cwd. */
const commandSchema = z.strictObject({
  command: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(32)
    .refine((argv) => isAbsolute(argv[0]!), "absolute command"),
  cwd: z.string().refine((path) => isAbsolute(path), "absolute cwd"),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().min(1000).max(300_000).optional(),
});
const label = z.string().min(1).max(2048);

const configSchema = z.strictObject({
  /** The agent endpoint, such as https://host/hab/mcp; the delivery endpoint is <hab_url>/delivery. */
  hab_url: z.url(),
  agent_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  as_address: z.string().optional(),
  /** Where the recipient's bearer token is read before every call. */
  token: z.union([
    z.strictObject({
      file: z.string().min(1),
      field: z.string().min(1).default("access_token"),
    }),
    z.strictObject({ env: z.string().min(1) }),
  ]),
  store: z.string().min(1),
  screen: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("jsonl"),
      path: z.string().min(1),
      /** The one session this notifier serves, such as hermes-desktop:<session id>. */
      target: z.string().min(1),
    }),
    z.strictObject({
      type: z.literal("hermes-desktop"),
      path: z.string().min(1),
      /** The saved Hermes conversation that shows the notices. */
      session_id: z.string().min(1).max(2048),
      profile: z.string().min(1).max(2048),
      /** Both must equal the reader's values in the Hermes profile config. */
      backend_namespace: z.string().min(1).max(2048),
      profile_scope: z.string().min(1).max(2048),
      /** Optional: hands the request to the conversation after 対応する (hermes_bridge.desktop_handoff). */
      handoff: commandSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("codex"),
      path: z.string().min(1),
      /** The Codex thread the user works in. */
      thread_id: label,
      /** Optional: the running app-server that serves the thread; without it, unsupported. */
      app_server: z
        .strictObject({
          url: z.string().regex(/^wss?:\/\/[^\s]+$/),
          token_file: z.string().min(1).optional(),
          timeout_ms: z.number().int().min(1000).max(300_000).optional(),
        })
        .optional(),
      display_command: commandSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("claude-code"),
      path: z.string().min(1),
      /** The Claude Code session (the status line's session_id). */
      session_id: label,
      /** Optional: the hab-claude-channel socket; without it, unsupported. */
      channel_socket: z.string().min(1).optional(),
      display_command: commandSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("chatgpt-connector"),
      path: z.string().min(1),
      /** A label for the ChatGPT conversation or project, such as dots. */
      conversation: label,
      display_command: commandSchema.optional(),
    }),
  ]),
  interval_ms: z.number().int().min(1000).max(3_600_000).default(15_000),
});
export type NotifyConfig = z.infer<typeof configSchema>;

const expand = (path: string) =>
  resolve(path.startsWith("~/") ? homedir() + path.slice(1) : path);

function readToken(config: NotifyConfig): string {
  let token: unknown;
  if ("env" in config.token) token = process.env[config.token.env];
  else {
    const file = JSON.parse(
      readFileSync(expand(config.token.file), "utf8"),
    ) as Record<string, unknown>;
    token = file[config.token.field];
  }
  if (typeof token !== "string" || token.length === 0)
    throw new MessagingError("token_unavailable");
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

const hermesBinding = (
  config: NotifyConfig,
  screen: Extract<NotifyConfig["screen"], { type: "hermes-desktop" }>,
) => ({
  session_id: screen.session_id,
  profile: screen.profile,
  backend_namespace: screen.backend_namespace,
  profile_scope: screen.profile_scope,
  receiver_id: config.agent_id,
});

type ScreenConfig = NotifyConfig["screen"];
const claudeBinding = (
  screen: Extract<ScreenConfig, { type: "claude-code" }>,
) => ({
  session_id: screen.session_id,
  ...(screen.channel_socket
    ? { channel_socket: expand(screen.channel_socket) }
    : {}),
});

function configuredScreen(config: NotifyConfig): AgentScreen {
  const screen = config.screen;
  const path = expand(screen.path);
  const display =
    "display_command" in screen && screen.display_command
      ? { display_command: screen.display_command }
      : {};
  switch (screen.type) {
    case "jsonl":
      return new JsonlScreen(path, screen.target);
    case "hermes-desktop":
      return new HermesDesktopScreen(
        path,
        hermesBinding(config, screen),
        screen.handoff ? { handoff: screen.handoff } : {},
      );
    case "codex": {
      const binding = {
        thread_id: screen.thread_id,
        ...(screen.app_server
          ? {
              app_server: {
                ...screen.app_server,
                ...(screen.app_server.token_file
                  ? { token_file: expand(screen.app_server.token_file) }
                  : {}),
              },
            }
          : {}),
      };
      return new ProductScreen({
        path,
        target: codexTarget(binding),
        ...display,
        handoff: (message) => codexHandoff(binding, message),
      });
    }
    case "claude-code": {
      const binding = claudeBinding(screen);
      return new ProductScreen({
        path,
        target: claudeCodeTarget(binding),
        ...display,
        handoff: (message) => claudeCodeHandoff(binding, message),
      });
    }
    case "chatgpt-connector":
      return new ProductScreen({
        path,
        target: chatgptConnectorTarget(screen),
        ...display,
        handoff: chatgptConnectorHandoff,
      });
  }
}

/** `statusline`: the Claude Code status line for the bound session; never calls HAB. */
async function statusline(config: NotifyConfig, input: string) {
  const screen = config.screen;
  if (screen.type !== "claude-code") return null;
  let session: { session_id?: unknown } = {};
  try {
    session = JSON.parse(input) as { session_id?: unknown };
  } catch {
    // No session JSON: show nothing.
  }
  const binding = claudeBinding(screen);
  const store = new SQLiteNotices(
    expand(config.store),
    claudeCodeTarget(binding),
  );
  try {
    return claudeCodeStatusLine(store.open(), binding, session);
  } finally {
    store.close();
  }
}

async function readStdin(stdin: NodeJS.ReadableStream) {
  let text = "";
  for await (const chunk of stdin) {
    text += String(chunk);
    if (text.length > 1024 * 1024) break;
  }
  return text;
}

/** `events [--limit N] [--after CURSOR]`: the Hermes Desktop reader page, as one JSON line. */
function events(config: NotifyConfig, args: string[]) {
  const screen = config.screen;
  if (screen.type !== "hermes-desktop") return null;
  let limit = 100;
  let after: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined) return null;
    if (args[i] === "--limit") limit = Number(value);
    else if (args[i] === "--after") after = value;
    else return null;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return hermesDesktopPage(expand(screen.path), hermesBinding(config, screen), {
    limit,
    ...(after !== undefined ? { after } : {}),
  });
}

export function createNotifier(config: NotifyConfig, screen?: AgentScreen) {
  const base = {
    agent_id: config.agent_id,
    max_request_bytes: 65536,
    max_response_bytes: 4 * 1024 * 1024,
    timeout_ms: 30_000,
    max_active_requests: 4,
    max_sse_events: 16,
    max_sse_lines: 4096,
    max_json_depth: 32,
    max_json_nodes: 100_000,
  };
  const limits = {
    envelope_bytes: 1024 * 1024,
    text_bytes: 512 * 1024,
    data_bytes: 512 * 1024,
    parts: 32,
    json_depth: 32,
    json_nodes: 100_000,
  };
  const common = {
    limits,
    authorization: () => readToken(config),
    ...(config.as_address ? { as_address: config.as_address } : {}),
  };
  const url = config.hab_url.replace(/\/+$/, "");
  const hab = new HabNotifierClient({
    ...common,
    policy: { ...base, resource_url: `${url}/delivery` },
  });
  const target = screen ?? configuredScreen(config);
  const store = new SQLiteNotices(expand(config.store), target.target);
  return {
    notifier: new ReceiptNotifier({ hab, screen: target, store }),
    store,
  };
}

const errorCode = (error: unknown) =>
  error instanceof MessagingError ? error.code : "failed";

export async function main(
  args: string[],
  out = console.log,
  stdin: NodeJS.ReadableStream = process.stdin,
) {
  if (args[0] !== "--config" || !args[1] || !args[2]) {
    out(usage);
    return 2;
  }
  const config = configSchema.parse(
    JSON.parse(readFileSync(expand(args[1]), "utf8")),
  );
  const [command, id, choice, sender] = args.slice(2);
  if (command === "events") {
    // Reads only the local screen file: no token, store or HAB call.
    try {
      const page = events(config, args.slice(3));
      if (page === null) {
        out(usage);
        return 2;
      }
      out(JSON.stringify(page));
      return 0;
    } catch {
      out(JSON.stringify({ error: "failed" }));
      return 1;
    }
  }
  if (command === "statusline") {
    // A failed status line prints nothing: it must never break the Claude Code screen.
    try {
      const line = await statusline(config, await readStdin(stdin));
      if (line === null) {
        out(usage);
        return 2;
      }
      if (line) out(line);
    } catch {
      // Nothing to show.
    }
    return 0;
  }
  let created: ReturnType<typeof createNotifier>;
  try {
    created = createNotifier(config);
  } catch (error) {
    out(JSON.stringify({ error: errorCode(error) }));
    return 1;
  }
  const { notifier, store } = created;
  try {
    switch (command) {
      case "check":
        out(JSON.stringify({ shown: await notifier.check() }));
        return 0;
      case "list":
        out(
          JSON.stringify(
            notifier.open().map((record) => ({
              message_id: record.message_id,
              sender_id: record.sender_id,
              from: record.from,
              state: record.state,
              expires_at: record.expires_at,
            })),
          ),
        );
        return 0;
      case "decide":
        if (!id || !["accept", "later", "decline"].includes(choice ?? ""))
          break;
        out(
          JSON.stringify(
            await notifier.decide(
              id,
              choice as "accept" | "later" | "decline",
              sender,
            ),
          ),
        );
        return 0;
      case "show-again":
        if (!id) break;
        // The optional third argument is the sender_id.
        out(JSON.stringify(await notifier.showAgain(id, choice)));
        return 0;
      case "run": {
        let stopped = false;
        const stop = () => {
          stopped = true;
        };
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        while (!stopped) {
          try {
            const shown = await notifier.check();
            if (shown.length) out(JSON.stringify({ shown }));
          } catch (error) {
            out(JSON.stringify({ error: errorCode(error) }));
          }
          await new Promise((done) => setTimeout(done, config.interval_ms));
        }
        return 0;
      }
    }
    out(usage);
    return 2;
  } catch (error) {
    out(JSON.stringify({ error: errorCode(error) }));
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main(process.argv.slice(2));
