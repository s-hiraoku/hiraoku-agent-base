/**
 * The arrival notifier CLI (ADR-021). Shows new HAB mail in the agent's own screen through
 * a configured adapter and applies the user's choice. Prints no tokens. Only `events` (the
 * Hermes Desktop reader), `statusline` (the Claude Code status line) and `show` (one notice
 * for its recipient) print message text, and only to the recipient's own screen.
 *
 *   hab-notify --product <product.json> run|units    every session in sessions_dir, one doorbell
 *       (docs/receiver/session-routing.md; `units` prints each session and its ledger line)
 *   hab-notify --config <notify.json> run|units      the same, as a product of one session
 *   hab-notify --config <notify.json> check          check once
 *   hab-notify --config <notify.json> list           notices waiting for a choice
 *   hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
 *   hab-notify --config <notify.json> show-again <message_id> [sender_id]
  hab-notify --config <notify.json> show <message_id> [sender_id]
 *   hab-notify --config <notify.json> show <message_id> [sender_id]
 *       (prints one notice's full display from the local choice record, for a screen that
 *       could show only part of it, such as the Claude Code status line)
 *   hab-notify --config <notify.json> events [--limit N] [--after CURSOR] [--presentation]
 *       (screen type hermes-desktop: one cursor-v1 page for Hermes Desktop; reads only the
 *       local screen file, never HAB. --presentation adds the ADR-026 fields for the plugin)
 *   hab-notify --config <notify.json> action
 *       (screen type hermes-desktop: Hermes Desktop's actions_command. Reads one request on
 *       stdin: {action: "decide", ...} from a card's button, printing {changed, state}, or
 *       {action: "states", ...}, printing {states: [{sender_id, message_id, state}]})
 *   hab-notify --config <notify.json> statusline
 *       (screen type claude-code: the Claude Code status line command; reads the session
 *       JSON on stdin and only the local choice record, never HAB)
 *
 *   hab-notify --config <notify.json> login
 *       (token.oauth only: one browser sign-in that gives the notifier its own grant; after
 *       it the notifier refreshes its token itself)
 *
 * Screen types: jsonl, hermes-desktop, codex, claude-code, chatgpt-connector (Dots).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  SQLiteNotices,
  choicesOf,
  peekedMessageSchema,
  claudeCodeStatusLine,
  hermesDesktopPage,
} from "../src/agent-notify/index.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";
import { login } from "../src/agent-notify/oauth-token.ts";

import {
  boundScreen,
  claudeBinding,
  configSchema,
  configuredProbe,
  createNotifier,
  errorCode,
  expand,
  hermesBinding,
  oauthOptions,
  oauthSource,
  oauthToken,
  readToken,
  readWakeSecret,
  shellWord,
  tokenProblem,
  tokenSource,
  type NotifyConfig,
  type TokenSource,
} from "./lib/notify-config.ts";
// Kept for callers that imported these from the CLI before they moved.
export {
  boundScreen,
  configSchema,
  createNotifier,
  errorCode,
  expand,
  oauthOptions,
  oauthSource,
  readToken,
  readWakeSecret,
  shellWord,
  tokenProblem,
  tokenSource,
};
export type { NotifyConfig, TokenSource };

/** Commands that build the product's session units (scripts/lib/notify-product.ts). */
const isProductCommand = (
  command: string | undefined,
): command is "run" | "units" => command === "run" || command === "units";

const usage = `usage:
  hab-notify --product <product.json> run|units
  hab-notify --config <notify.json> run|units|check|list
  hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
  hab-notify --config <notify.json> show-again <message_id> [sender_id]
  hab-notify --config <notify.json> events [--limit N] [--after CURSOR] [--presentation]
  hab-notify --config <notify.json> action   (one decision as JSON on stdin)
  hab-notify --config <notify.json> statusline
  hab-notify --config <notify.json> binding|states|adapter-action
  hab-notify --config <notify.json> login    (token.oauth: one browser sign-in)`;

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

/**
 * `events [--limit N] [--after CURSOR] [--presentation]`: the Hermes Desktop reader page, as
 * one JSON line. `--presentation` (the HAB plugin's backend) adds `presentation` and `body`
 * to the events that have them (ADR-026); Desktop's own reader refuses unknown fields.
 */
function events(config: NotifyConfig, args: string[]) {
  const screen = config.screen;
  if (screen.type !== "hermes-desktop") return null;
  let limit = 100;
  let after: string | undefined;
  const presentation = args.includes("--presentation");
  args = args.filter((arg) => arg !== "--presentation");
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
    presentation,
  });
}

/**
 * `login`: one browser sign-in that gives the notifier its own grant. Prints the URL to
 * open (no secret), then whether a refresh token came back; never a token.
 */
async function loginCommand(
  config: NotifyConfig,
  out: (line: string) => void,
): Promise<number> {
  if (!("oauth" in config.token)) {
    out(JSON.stringify({ error: "oauth_not_configured" }));
    return 2;
  }
  const oauth = config.token.oauth;
  if (!oauth.authorization_endpoint || !oauth.redirect_uri) {
    out(JSON.stringify({ error: "oauth_not_configured" }));
    return 2;
  }
  try {
    const result = await login(
      oauthToken(config, oauth),
      {
        authorization_endpoint: oauth.authorization_endpoint,
        redirect_uri: oauth.redirect_uri,
        client_id: oauth.client_id,
        resource: oauth.resource ?? config.hab_url,
        ...(oauth.audience ? { audience: oauth.audience } : {}),
        ...(oauth.scope ? { scope: oauth.scope } : {}),
      },
      (url) => out(JSON.stringify({ open: url })),
    );
    out(JSON.stringify({ logged_in: true, ...result }));
    return 0;
  } catch (error) {
    out(
      JSON.stringify({
        error: error instanceof MessagingError ? error.code : "login_failed",
      }),
    );
    return 1;
  }
}

export async function main(
  args: string[],
  out = console.log,
  input: () => string = () => readFileSync(0, "utf8"),
) {
  const productPath = args[0] === "--product" ? args[1] : undefined;
  if (productPath && isProductCommand(args[2]) && args.length === 3) {
    const product = await import("./lib/notify-product.ts");
    return product.productCommand(
      () => product.readProduct(productPath),
      args[2],
      out,
    );
  }
  if (args[0] !== "--config" || !args[1] || !args[2]) {
    out(usage);
    return 2;
  }
  const config = configSchema.parse(
    JSON.parse(readFileSync(expand(args[1]), "utf8")),
  );
  const [command, id, choice, sender] = args.slice(2);
  if (isProductCommand(command)) {
    // notify-product builds on this module, so it is loaded only when needed.
    const product = await import("./lib/notify-product.ts");
    return product.productCommand(
      () => product.productOfOne(config),
      command,
      out,
    );
  }
  if (command === "login") return loginCommand(config, out);
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
      case "check": {
        const presence = await configuredProbe(config)?.();
        if (presence !== undefined && presence !== "present") {
          out(JSON.stringify({ shown: [], session: presence }));
          return 0;
        }
        out(JSON.stringify({ shown: await notifier.check() }));
        return 0;
      }
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
