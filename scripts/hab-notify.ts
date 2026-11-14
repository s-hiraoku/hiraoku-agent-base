/**
 * The arrival notifier CLI (ADR-021). Shows new HAB mail in the agent's own screen through
 * a configured adapter and applies the user's choice. Prints no tokens or message bodies.
 *
 *   hab-notify --config <notify.json> run            keep checking every interval_ms
 *   hab-notify --config <notify.json> check          check once
 *   hab-notify --config <notify.json> list           notices waiting for a choice
 *   hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
 *   hab-notify --config <notify.json> show-again <message_id> [sender_id]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  HabNotifierClient,
  JsonlScreen,
  ReceiptNotifier,
  SQLiteNotices,
} from "../src/agent-notify/index.ts";
import type { AgentScreen } from "../src/agent-notify/index.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";

const usage = `usage:
  hab-notify --config <notify.json> run|check|list
  hab-notify --config <notify.json> decide <message_id> accept|later|decline [sender_id]
  hab-notify --config <notify.json> show-again <message_id> [sender_id]`;

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
  screen: z.strictObject({
    type: z.literal("jsonl"),
    path: z.string().min(1),
    /** The one session this notifier serves, such as hermes-desktop:<session id>. */
    target: z.string().min(1),
  }),
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
    { ...common, policy: { ...base, resource_url: url } },
  );
  const store = new SQLiteNotices(expand(config.store), config.screen.target);
  const target =
    screen ?? new JsonlScreen(expand(config.screen.path), config.screen.target);
  return {
    notifier: new ReceiptNotifier({ hab, screen: target, store }),
    store,
  };
}

const errorCode = (error: unknown) =>
  error instanceof MessagingError ? error.code : "failed";

export async function main(args: string[], out = console.log) {
  if (args[0] !== "--config" || !args[1] || !args[2]) {
    out(usage);
    return 2;
  }
  const config = configSchema.parse(
    JSON.parse(readFileSync(expand(args[1]), "utf8")),
  );
  const [command, id, choice, sender] = args.slice(2);
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
