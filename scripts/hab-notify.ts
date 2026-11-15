/**
 * The arrival notifier CLI (ADR-021). Shows new HAB mail in the agent's own screen through
 * a configured adapter and applies the user's choice. Prints no tokens. Only `events` (the
 * Hermes Desktop reader), `statusline` (the Claude Code status line) and `show` (one notice
 * for its recipient) print message text, and only to the recipient's own screen.
 *
 *   hab-notify --config <notify.json> run            keep checking every interval_ms
 *   hab-notify --config <notify.json> check          check once
 *   hab-notify --config <notify.json> list           notices waiting for a choice
 *   hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
 *   hab-notify --config <notify.json> show-again <message_id> [sender_id]
  hab-notify --config <notify.json> show <message_id> [sender_id]
 *   hab-notify --config <notify.json> show <message_id> [sender_id]
 *       (prints one notice's full display from the local choice record, for a screen that
 *       could show only part of it, such as the Claude Code status line)
 *   hab-notify --config <notify.json> events [--limit N] [--after CURSOR]
 *       (screen type hermes-desktop: one cursor-v1 page for Hermes Desktop; reads only the
 *       local screen file, never HAB)
 *   hab-notify --config <notify.json> action
 *       (screen type hermes-desktop: Hermes Desktop's actions_command. Reads one request on
 *       stdin: {action: "decide", ...} from a card's button, printing {changed, state}, or
 *       {action: "states", ...}, printing {states: [{sender_id, message_id, state}]})
 *   hab-notify --config <notify.json> statusline
 *       (screen type claude-code: the Claude Code status line command; reads the session
 *       JSON on stdin and only the local choice record, never HAB)
 *
 * Screen types: jsonl, hermes-desktop, codex, claude-code, chatgpt-connector (Dots).
 */
import { createNotifyCheckLog } from "./lib/notify-check-log.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  HabNotifierClient,
  HermesDesktopScreen,
  JsonlScreen,
  ProductScreen,
  ReceiptNotifier,
  SQLiteNotices,
  chatgptConnectorHandoff,
  choicesOf,
  peekedMessageSchema,
  chatgptConnectorTarget,
  claudeCodeHandoff,
  claudeCodeStatusLine,
  claudeCodeTarget,
  codexHandoff,
  codexTarget,
  hermesDesktopPage,
} from "../src/agent-notify/index.ts";
import { hermesDesktopAgentBinding } from "../src/agent-notify/hermes-desktop.ts";
import { bindingIdentity } from "../src/agent-notify/binding.ts";
import type { AgentScreen } from "../src/agent-notify/index.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";

const usage = `usage:
  hab-notify --config <notify.json> run|check|list
  hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
  hab-notify --config <notify.json> show-again <message_id> [sender_id]
  hab-notify --config <notify.json> events [--limit N] [--after CURSOR]
  hab-notify --config <notify.json> action   (one decision as JSON on stdin)
  hab-notify --config <notify.json> statusline
  hab-notify --config <notify.json> binding|states|adapter-action`;

/** Requested state authority is scoped to these exact keys, never a whole-store snapshot. */
export const STATE_KEYS_MAX = 50;
export const STATE_REQUEST_BYTES = 64 * 1024;
export const STATE_RESPONSE_BYTES = 60 * 1024;
const stateKeySchema = z.strictObject({
  sender_id: z
    .string()
    .min(1)
    .refine((x) => Buffer.byteLength(x, "utf8") <= 512),
  message_id: z
    .string()
    .min(1)
    .refine((x) => Buffer.byteLength(x, "utf8") <= 512),
});
const stateKeysSchema = z
  .array(stateKeySchema)
  .max(STATE_KEYS_MAX)
  .refine(
    (keys) =>
      new Set(
        keys.map((key) => JSON.stringify([key.sender_id, key.message_id])),
      ).size === keys.length,
  );
type StateKeys = z.infer<typeof stateKeysSchema>;
function selectedStates(store: SQLiteNotices, keys?: StateKeys) {
  return keys === undefined
    ? store.all()
    : keys.flatMap((key) => {
        const record = store.get(key);
        return record ? [record] : [];
      });
}
function stateResponse(
  out: (value: string) => void,
  response: unknown,
): number {
  const text = JSON.stringify(response);
  if (Buffer.byteLength(text, "utf8") + 1 > STATE_RESPONSE_BYTES) {
    out(JSON.stringify({ error: "state_response_too_large" }));
    return 1;
  }
  out(text);
  return 0;
}

/** The card's binding, sent with every request from Hermes Desktop's actions_command. */
const cardBinding = {
  binding_id: z.string().min(1),
  backend_namespace: z.string().min(1),
  profile_scope: z.string().min(1),
  receiver_id: z.string().min(1),
  stored_session_id: z.string().min(1),
};
/**
 * What Hermes Desktop sends: `decide` for a button press on one card, `states` to ask what
 * each card of this conversation became (so a reopened conversation shows the choice made,
 * not the buttons again).
 */
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("decide"),
    ...cardBinding,
    sender_id: z.string().min(1),
    message_id: z.string().min(1),
    choice: z.enum(["accept", "later", "decline"]),
  }),
  z.strictObject({
    action: z.literal("states"),
    ...cardBinding,
    keys: stateKeysSchema.optional(),
  }),
]);

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
      /**
       * Optional: the field holding the token's absolute expiry in epoch seconds (Hermes writes
       * `expires_at`). Past it, a call is not made and the notifier reports token_expired.
       */
      expires_at_field: z.string().min(1).optional(),
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

export function readToken(config: Pick<NotifyConfig, "token">): string {
  let token: unknown;
  if ("env" in config.token) token = process.env[config.token.env];
  else {
    const file = JSON.parse(
      readFileSync(expand(config.token.file), "utf8"),
    ) as Record<string, unknown>;
    token = file[config.token.field];
    const expiresAt = config.token.expires_at_field
      ? file[config.token.expires_at_field]
      : undefined;
    // The agent refreshes its own token; until it does, sending the old one is only refused.
    if (
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt * 1000 <= Date.now()
    )
      throw new MessagingError("token_expired");
  }
  if (typeof token !== "string" || token.length === 0)
    throw new MessagingError("token_unavailable");
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

/** A token that expires within this many ms is treated as already expired. */
const TOKEN_SKEW_MS = 5_000;

/** The `exp` of a JWT access token, in ms. An opaque token gives undefined. Not verified:
 * it only saves calls HAB would refuse. HAB still checks every token itself. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checked before each call to HAB, so a call HAB would refuse is never sent. The agent
 * refreshes its own token; a missing or expired one is a wait, named as such, and the next
 * check tries again. Expiry comes from `expires_at_field` when configured, else from a JWT's
 * own `exp`; an opaque token without either is left to HAB.
 */
export function tokenProblem(
  config: Pick<NotifyConfig, "token">,
  now = Date.now(),
): string | undefined {
  let token: string;
  try {
    token = readToken(config);
  } catch (error) {
    return error instanceof MessagingError ? error.code : "token_unavailable";
  }
  const expiry = jwtExpiry(token.slice("Bearer ".length));
  return expiry !== undefined && expiry <= now + TOKEN_SKEW_MS
    ? "token_expired"
    : undefined;
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
  connection_id: config.hab_url.replace(/\/+$/, ""),
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
        handoff_capability: screen.app_server ? "bound-session" : "unsupported",
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

/** Connection + recipient + product session fence for every configured adapter. */
export function boundScreen(config: NotifyConfig): AgentScreen {
  const screen = configuredScreen(config);
  const product = config.screen;
  const connection = JSON.stringify([
    config.hab_url.replace(/\/+$/, ""),
    product.type === "codex" ? (product.app_server?.url ?? null) : null,
    product.type === "claude-code" ? (product.channel_socket ?? null) : null,
  ]);
  const binding =
    product.type === "hermes-desktop"
      ? hermesDesktopAgentBinding(hermesBinding(config, product))
      : {
          product: product.type,
          connection_id: connection,
          recipient_id: config.agent_id,
          session_id: screen.target,
        };
  return {
    ...(screen.capabilities ? { capabilities: screen.capabilities } : {}),
    binding,
    target: bindingIdentity(binding),
    show: (message) => screen.show(message),
    handoff: (message) => screen.handoff(message),
    report: (message, state) =>
      screen.report?.(message, state) ?? Promise.resolve(),
  };
}

/** `statusline`: the Claude Code status line for the bound session; never calls HAB. */
/** Quotes one shell word unless it is plainly safe. */
const shellWord = (word: string) =>
  /^[A-Za-z0-9_./:=@+-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

async function statusline(
  config: NotifyConfig,
  input: string,
  configPath: string,
) {
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
    boundScreen(config).target,
  );
  try {
    // The hints must run as shown: this node, this script and this config.
    const command = [
      process.execPath,
      fileURLToPath(import.meta.url),
      "--config",
      configPath,
    ]
      .map(shellWord)
      .join(" ");
    return claudeCodeStatusLine(store.open(), binding, session, command);
  } finally {
    store.close();
  }
}

/** Reads stdin through the injected reader, capped at 1 MiB. */
const readInput = (input: () => string) => input().slice(0, 1024 * 1024);

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
  const hab = new HabNotifierClient(
    { ...common, policy: { ...base, resource_url: `${url}/delivery` } },
    () => tokenProblem(config),
  );
  const target = screen ?? boundScreen(config);
  const store = new SQLiteNotices(expand(config.store), target.target);
  return {
    notifier: new ReceiptNotifier({ hab, screen: target, store }),
    store,
  };
}

/**
 * The MCP transport reports a credential that could not be read as transport_failed. When
 * the token itself is the cause (expired or missing), that is named instead.
 */
function errorCode(error: unknown, config?: NotifyConfig): string {
  const code = error instanceof MessagingError ? error.code : "failed";
  if (code !== "transport_failed" || !config) return code;
  try {
    readToken(config);
  } catch (tokenError) {
    if (tokenError instanceof MessagingError) return tokenError.code;
  }
  return code;
}

export async function main(
  args: string[],
  out = console.log,
  input: () => string = () => readFileSync(0, "utf8"),
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
      const line = await statusline(config, readInput(input), expand(args[1]));
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
  // Product-independent local API: snapshots are independent of notice pagination.
  // Clients retain this binding from initial setup and send it on every subsequent call.
  if (["binding", "states", "adapter-action"].includes(command!)) {
    let store: SQLiteNotices | undefined;
    try {
      const screen = boundScreen(config);
      if (command === "binding") {
        out(
          JSON.stringify({
            binding_id: screen.target,
            capabilities: screen.capabilities ?? null,
            destination_binding: screen.binding,
          }),
        );
        return 0;
      }
      const request = z
        .strictObject({
          binding_id: z.string().min(1).max(128),
          ...(command === "adapter-action"
            ? {
                ...stateKeySchema.shape,
                choice: z.enum(["accept", "later", "decline"]),
              }
            : { keys: stateKeysSchema.optional() }),
        })
        .parse(
          JSON.parse(
            (() => {
              const text = input();
              if (Buffer.byteLength(text, "utf8") > STATE_REQUEST_BYTES)
                throw new MessagingError("invalid_request");
              return text;
            })(),
          ),
        );
      if (request.binding_id !== screen.target) {
        out(JSON.stringify({ error: "binding_mismatch" }));
        return 1;
      }
      if (command === "states") {
        store = new SQLiteNotices(expand(config.store), screen.target);
        const keys = (request as { keys?: StateKeys }).keys;
        return stateResponse(out, {
          binding_id: screen.target,
          states: selectedStates(store, keys).map(
            ({ sender_id, message_id, state, revision, message }) => ({
              sender_id,
              message_id,
              state,
              revision,
              choices: choicesOf(peekedMessageSchema.parse(message)),
            }),
          ),
          ...(keys === undefined ? {} : { scope: "requested", keys }),
        });
      } else {
        const created = createNotifier(config);
        store = created.store;
        const decision = request as {
          sender_id: string;
          message_id: string;
          choice: "accept" | "later" | "decline";
        };
        const result = await created.notifier.decide(
          decision.message_id,
          decision.choice,
          decision.sender_id,
        );
        const key = {
          sender_id: decision.sender_id,
          message_id: decision.message_id,
        };
        const record = store.get(key)!;
        // IDs were bounded before the decision and the binding is an exact fixed hash.
        // Never serialize the retained DB or message/choices after a side effect.
        out(
          JSON.stringify({
            ...result,
            binding_id: screen.target,
            revision: record.revision,
            scope: "requested",
            keys: [key],
            states: [
              { ...key, state: record.state, revision: record.revision },
            ],
          }),
        );
      }
      return 0;
    } catch (error) {
      out(
        JSON.stringify({
          error:
            error instanceof z.ZodError
              ? "invalid_request"
              : errorCode(error, config),
        }),
      );
      return 1;
    } finally {
      store?.close();
    }
  }
  let action: z.infer<typeof actionSchema> | undefined;
  if (command === "action") {
    // The press must be for a card this notifier showed: the same conversation, reader and
    // recipient. Anything else is refused before the store or HAB is touched.
    const screen = config.screen;
    const parsed = actionSchema.safeParse(
      (() => {
        try {
          const text = input();
          if (Buffer.byteLength(text, "utf8") > STATE_REQUEST_BYTES)
            return null;
          return JSON.parse(text);
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      out(JSON.stringify({ error: "invalid_request" }));
      return 2;
    }
    if (
      parsed.data.binding_id !== boundScreen(config).target ||
      screen.type !== "hermes-desktop" ||
      parsed.data.stored_session_id !== screen.session_id ||
      parsed.data.backend_namespace !== screen.backend_namespace ||
      parsed.data.profile_scope !== screen.profile_scope ||
      parsed.data.receiver_id !== config.agent_id
    ) {
      out(JSON.stringify({ error: "binding_mismatch" }));
      return 1;
    }
    action = parsed.data;
  }
  let created: ReturnType<typeof createNotifier>;
  try {
    created = createNotifier(config);
  } catch (error) {
    out(JSON.stringify({ error: errorCode(error, config) }));
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
      case "action":
        if (action!.action === "states") {
          // Only the binding was checked; this reads the local record and never calls HAB.
          const keys = action!.keys;
          return stateResponse(out, {
            states: selectedStates(store, keys).map((record) => ({
              sender_id: record.sender_id,
              message_id: record.message_id,
              state: record.state,
              revision: record.revision,
              choices: choicesOf(record.message),
            })),
            ...(keys === undefined ? {} : { scope: "requested", keys }),
          });
        }
        {
          const result = await notifier.decide(
            action!.message_id,
            action!.choice,
            action!.sender_id,
          );
          const record = store.get({
            message_id: action!.message_id,
            sender_id: action!.sender_id,
          });
          out(
            JSON.stringify({
              ...result,
              state: record!.state,
              revision: record!.revision,
            }),
          );
        }
        return 0;
      case "show": {
        if (!id) break;
        // The optional third argument is the sender_id.
        const record = notifier.get(id, choice);
        if (!record) {
          out(JSON.stringify({ error: "invalid_request" }));
          return 1;
        }
        out(record.message.display);
        return 0;
      }
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
        // An error that repeats on every check, such as waiting for the agent to refresh its
        // token, is logged once when it starts and once when it ends.
        const checkLog = createNotifyCheckLog(out);
        while (!stopped) {
          try {
            const started = performance.now();
            const shown = await notifier.check();
            checkLog.succeeded(shown, Math.round(performance.now() - started));
          } catch (error) {
            const code = errorCode(error, config);
            checkLog.failed(code);
          }
          await new Promise((done) => setTimeout(done, config.interval_ms));
        }
        return 0;
      }
    }
    out(usage);
    return 2;
  } catch (error) {
    out(JSON.stringify({ error: errorCode(error, config) }));
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main(process.argv.slice(2));
