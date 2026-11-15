/** Run only in the sending owner's background process, using its existing token source.
 * send: one hab_send then durable registration; watch: register a retained send result;
 * check/run: read-only hab_status; list/cancel: local state. Never reads inbox or ACKs.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ReplyWatchAdapter } from "../src/reply-watch/adapter.ts";
import { ReplyWatchClient } from "../src/reply-watch/client.ts";
import { readToken, tokenProblem } from "./hab-notify.ts";

const configSchema = z.strictObject({
  resource_url: z.url(),
  connection_id: z.string().min(1).max(2048),
  agent_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  session_id: z.string().min(1).max(2048),
  as_address: z.string().min(1),
  store: z.string().refine(isAbsolute, "absolute private SQLite path"),
  token: z.union([
    z.strictObject({ env: z.string().min(1) }),
    z.strictObject({
      file: z.string().min(1),
      field: z.string().min(1).default("access_token"),
      expires_at_field: z.string().min(1).optional(),
    }),
  ]),
  normal_interval_ms: z.number().int().min(1000).max(3_600_000).default(60_000),
});
const sendSchema = z.strictObject({
  to: z.string().min(1),
  text: z.string().min(1),
  kind: z.string().optional(),
  thread_id: z.string().optional(),
});
const usage =
  "hab-reply-watch --config <owner-watch.json> send|watch|check|run|list|cancel [message_id] (send/watch take JSON on stdin)";
export async function main(
  args: string[],
  out = console.log,
  input = () => readFileSync(0, "utf8"),
  fetch?: typeof globalThis.fetch,
) {
  if (
    args[0] !== "--config" ||
    !args[1] ||
    !["send", "watch", "check", "run", "list", "cancel"].includes(
      args[2] ?? "",
    ) ||
    (args[2] === "cancel" && !args[3])
  ) {
    out(usage);
    return 2;
  }
  const config = configSchema.parse(JSON.parse(readFileSync(args[1], "utf8")));
  const client = new ReplyWatchClient(
    {
      policy: {
        resource_url: config.resource_url,
        agent_id: config.agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 1024 * 1024,
        timeout_ms: 30_000,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 4096,
        max_json_depth: 32,
        max_json_nodes: 100_000,
      },
      limits: {
        envelope_bytes: 1024 * 1024,
        text_bytes: 512 * 1024,
        data_bytes: 512 * 1024,
        parts: 32,
        json_depth: 32,
        json_nodes: 100_000,
      },
      authorization: () => readToken(config),
      as_address: config.as_address,
      ...(fetch ? { fetch } : {}),
    },
    () => tokenProblem(config),
  );
  const watcher = new ReplyWatchAdapter(config.store, config, client);
  try {
    switch (args[2]) {
      case "send":
        out(
          JSON.stringify(
            await watcher.send(sendSchema.parse(JSON.parse(input()))),
          ),
        );
        break;
      case "watch":
        watcher.watch(JSON.parse(input()));
        out(JSON.stringify({ monitoring: "saved" }));
        break;
      case "cancel":
        watcher.cancel(args[3]!);
        break;
      case "check":
        await watcher.checkDue();
        out(JSON.stringify(watcher.records()));
        break;
      case "list":
        out(JSON.stringify(watcher.records()));
        break;
      case "run": {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        try {
          while (!controller.signal.aborted) {
            await watcher.checkDue(controller.signal);
            await delay(
              watcher.nextDelay(config.normal_interval_ms),
              undefined,
              { signal: controller.signal },
            ).catch((error) => {
              if (!controller.signal.aborted) throw error;
            });
          }
        } finally {
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
        }
      }
    }
    return 0;
  } finally {
    watcher.close();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error(
      JSON.stringify({ error: "reply_watch_failed", retry_send: false }),
    );
    process.exitCode = 1;
  }
}
