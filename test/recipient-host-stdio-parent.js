/** Own every subprocess resource outside the killable synthetic MCP fixture. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function recipientStdio(t, { blockCleanup = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hab-recipient-stdio-"));
  let client, stderrDone, closing;
  let diagnostics = "";
  const close = () => closing ??= (async () => {
    try {
      await client?.close();
      if (stderrDone) {
        let timer;
        try {
          await Promise.race([stderrDone, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("recipient_stderr_timeout")), 5000);
          })]);
        } finally { clearTimeout(timer); }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  t.after(close);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./recipient-host-stdio-fixture.js", import.meta.url))],
    env: { TMPDIR: directory, NODE_NO_WARNINGS: "1",
      HAB_TEST_BLOCK_CLEANUP: blockCleanup ? "1" : "0" },
    stderr: "pipe",
  });
  // Register before spawn, then drain even when SDK close returns at its kill deadline.
  stderrDone = new Promise((resolve) => transport.stderr.once("end", resolve));
  transport.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  client = new Client({ name: "synthetic-stdio-recipient", version: "1" });
  await client.connect(transport);
  return { client, close, diagnostics: () => diagnostics, directory };
}
