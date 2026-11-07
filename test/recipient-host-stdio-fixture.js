/** Isolated synthetic stdio acceptance child. Never load a product profile or live configuration. */
import process from "node:process";
import { setInterval } from "node:timers";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRecipientHostMcpServer } from "../src/adapter-host/mcp.ts";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { hostFixture, limits } from "./adapter-host-fixtures.js";
import { startBroker } from "./jetstream-delivery.js";
const cleanup = [];
let server, stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  setInterval(() => {}, 1000); // Keep cleanup alive after stdin EOF and unref workers.
  try {
    await server?.close();
    for (const action of cleanup.reverse()) await action();
    await (await startBroker()).stop();
    process.stderr.write("RECIPIENT_STDIO_CLEANUP_OK\n", () => process.exit(0));
  } catch {
    process.stderr.write("RECIPIENT_STDIO_CLEANUP_FAILED\n", () => process.exit(1));
  }
};
process.once("SIGTERM", stop);
process.stdin.once("end", stop);
// Bound a broken test child; the broker's existing exit hook stops only its owned child.
setTimeout(() => process.exit(2), 30000).unref();
const f = await hostFixture({ after: (action) => cleanup.push(action) });
const journal = new SQLiteAnswerJournal(join(f.dir, "recipient-answers.sqlite"), {
  agent_id: "b", fingerprint_key: new Uint8Array(32).fill(65), limits,
  max_records: 20, max_body_bytes: 100000, max_clock_skew_ms: 1000,
});
journal.migrate();
cleanup.push(() => journal.close());
const host = f.makeHost({ answer_intents: journal });
f.resume(host); // Synthetic test-only operator action; production wrapper cannot resume.
f.submit("question", { body: { parts: [{ type: "text", text: "Synthetic external question" }] } });
server = createRecipientHostMcpServer({ host, context: f.context,
  allowedOperations: ["receive", "inbox", "inbox_read", "answer_prepare", "answer_inspect", "answer_enqueue", "send"],
});
await server.connect(new StdioServerTransport());
