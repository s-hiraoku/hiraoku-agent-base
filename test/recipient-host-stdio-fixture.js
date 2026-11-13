/** Isolated synthetic stdio acceptance child. Never load a product profile or live configuration. */
import process from "node:process";
import { setInterval } from "node:timers";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRecipientHostMcpServer } from "../src/adapter-host/mcp.ts";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { hostFixture, limits } from "./adapter-host-fixtures.js";
// A private descriptor created by the owning test, never a product configuration.
if (process.env.HAB_TEST_COMPATIBILITY_PID_FILE)
  writeFileSync(process.env.HAB_TEST_COMPATIBILITY_PID_FILE, String(process.pid), { mode: 0o600, flag: "wx" });
const cleanup = [];
let server, stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  setInterval(() => {}, 1000); // Keep cleanup alive after stdin EOF and unref workers.
  try {
    await server?.close();
    if (process.env.HAB_TEST_BLOCK_CLEANUP === "1") {
      process.stderr.write("RECIPIENT_STDIO_CLEANUP_BLOCKED\n");
      await new Promise(() => {}); // Fault injection: SDK must terminate this owned child.
    }
    for (const action of cleanup.reverse()) await action();
    process.stderr.write("RECIPIENT_STDIO_CLEANUP_OK\n", () => process.exit(0));
  } catch {
    process.stderr.write("RECIPIENT_STDIO_CLEANUP_FAILED\n", () => process.exit(1));
  }
};
process.once("SIGTERM", stop);
process.stdin.once("end", stop);
// Bound a broken test child; the parent independently owns scratch cleanup.
setTimeout(() => process.exit(2), 30000).unref();
const f = await hostFixture({ after: (action) => cleanup.push(action) });
const journal = new SQLiteAnswerJournal(join(f.dir, "recipient-answers.sqlite"), {
  agent_id: "b", fingerprint_key: new Uint8Array(32).fill(65), limits,
  max_records: 20, max_body_bytes: 100000, max_clock_skew_ms: 1000,
});
journal.migrate();
cleanup.push(() => journal.close());
const host = f.makeHost({ answer_intents: journal });
const compatibility = process.env.HAB_TEST_COMPATIBILITY;
if (compatibility !== "paused")
  f.resume(host); // Synthetic test-only operator action; production wrapper cannot resume.
const submitted = f.submit("question", { body: { parts: [{ type: "text", text: "Synthetic external question" }] } });
// Test-controlled policy transition only, never native product authorization.
const testHost = compatibility ? { async stepOnce(context, command) {
  const result = await host.stepOnce(context, command);
  if (compatibility === "revoked" && command.op === "inbox_read" && result.state === "done")
    f.state.enabled = false;
  if (compatibility === "roundtrip" && command.op === "send" && result.state === "done") {
    const reply = await f.service.poll(f.contexts.a);
    if (reply?.message?.in_reply_to?.sender_id !== submitted.key.sender_id ||
        reply.message.in_reply_to.message_id !== submitted.key.message_id ||
        reply.message.body.parts[0].text !== "Synthetic stdio answer" || f.queued().length !== 1)
      throw Error("synthetic_reply_mismatch");
    process.stderr.write("RECIPIENT_PYTHON_REPLY_VERIFIED\n");
  }
  return result;
} } : host;
server = createRecipientHostMcpServer({ host: testHost, context: f.context,
  allowedOperations: ["receive", "inbox", "inbox_read", "answer_prepare", "answer_inspect", "answer_enqueue", "send"],
});
await server.connect(new StdioServerTransport());
