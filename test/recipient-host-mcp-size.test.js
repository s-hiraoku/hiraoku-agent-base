import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRecipientHostMcpServer } from "../src/adapter-host/mcp.ts";

const source = { sender_id: "a", message_id: "m" };
const text = '🙂"\\\n'.repeat(2048);
const saved = { op: "inbox_read", state: "done", reason: null,
  value: { message: { body: { parts: [{ type: "text", text }] } } } };
const expected = { isError: false, content: [{ type: "text",
  text: JSON.stringify({ origin: "external_agent", result: saved }) }] };
const bytes = Buffer.byteLength(JSON.stringify(expected));

test("recipient read budget measures UTF-8 and escaped tool result without truncation or authority bypass", async (t) => {
  for (const invalid of [0, 1023, 1.5, Infinity, NaN])
    assert.throws(() => createRecipientHostMcpServer({ host: { stepOnce() {} },
      context: {}, allowedOperations: ["inbox_read"], maxInboxReadResultBytes: invalid }),
    /invalid_recipient_mcp_composition/);
  let enabled = true, calls = 0;
  const context = {};
  const host = { async stepOnce(ctx, command) {
    assert.equal(ctx, context);
    calls++;
    if (!enabled) throw Error("private policy detail");
    return command.op === "inbox_read" ? saved : { ...saved, op: command.op };
  } };
  for (const budget of [bytes - 1, bytes]) {
    const server = createRecipientHostMcpServer({ host, context,
      allowedOperations: ["inbox_read", "answer_prepare"], maxInboxReadResultBytes: budget });
    const client = new Client({ name: "size-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    t.after(async () => { await client.close(); await server.close(); });
    const response = await client.callTool({ name: "recipient_inbox_read", arguments: { source } });
    if (budget < bytes) {
      assert.deepEqual(JSON.parse(response.content[0].text), {
        error: "recipient_inbox_read_too_large", required_result_bytes: bytes,
      });
      assert.equal(response.isError, true);
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024);
    } else assert.deepEqual(response, expected);
    // Tool arguments cannot raise the owner-selected budget.
    const before = calls;
    assert.equal((await client.callTool({ name: "recipient_inbox_read",
      arguments: { source, maxInboxReadResultBytes: bytes + 1 } })).isError, true);
    assert.equal(calls, before);
    // A mutating operation's exact result must not be replaced with a size error.
    const write = await client.callTool({ name: "recipient_answer_prepare",
      arguments: { source, body: { parts: [{ type: "text", text: "chosen" }] } } });
    assert.equal(JSON.parse(write.content[0].text).result.op, "answer_prepare");
    enabled = false;
    assert.equal(JSON.parse((await client.callTool({ name: "recipient_inbox_read",
      arguments: { source } })).content[0].text).error, "recipient_host_unavailable");
    enabled = true;
  }
});

test("stdio read overflow keeps connection usable; owner-aligned transport retrieves the full same source", async (t) => {
  const moduleUrl = new URL("../src/adapter-host/mcp.ts", import.meta.url).href;
  const transportUrl = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const run = async (budget, maxBufferSize) => {
    // Separate synthetic process only, with no broker, storage, product profile or credentials.
    const code = `import { createRecipientHostMcpServer } from ${JSON.stringify(moduleUrl)};
      import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
      const source = ${JSON.stringify(source)};
      const saved = ${JSON.stringify(saved)};
      const server = createRecipientHostMcpServer({ context: {},
        allowedOperations: ["inbox_read"], maxInboxReadResultBytes: ${budget},
        host: { async stepOnce(_ctx, command) {
          if (JSON.stringify(command.source) !== JSON.stringify(source)) throw Error("wrong_source");
          return saved;
        } } });
      process.stdin.once("end", () => { server.close().then(() => process.exit(0)); });
      await server.connect(new StdioServerTransport());`;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--input-type=module", "-e", code], stderr: "pipe", maxBufferSize });
    const drained = new Promise((resolve) => transport.stderr.once("end", resolve));
    transport.stderr.resume();
    const client = new Client({ name: "size-stdio-test", version: "1" });
    t.after(async () => { await client.close(); });
    await client.connect(transport);
    const result = await client.callTool({ name: "recipient_inbox_read", arguments: { source } });
    assert.equal((await client.listTools()).tools.length, 1); // no lost connection
    await client.close();
    let timer;
    try {
      await Promise.race([drained, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("synthetic_stdio_drain_timeout")), 5000);
      })]);
    } finally { clearTimeout(timer); }
    return result;
  };
  const refused = await run(4096, 8192);
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).required_result_bytes, bytes);
  // The owner explicitly raises both budgets. This is not a retry with expanded authority.
  // Numeric IDs used by this SDK fit the reserved 4096-byte JSON-RPC framing allowance.
  assert.deepEqual(await run(bytes, bytes + 4096), expected);
});
