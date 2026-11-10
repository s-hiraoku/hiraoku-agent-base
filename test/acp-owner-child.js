/** Explicitly synthetic ACP executable. Never loads a product, model, profile or credentials. */
import process from "node:process";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync, existsSync } from "node:fs";
import { setInterval, clearInterval } from "node:timers";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const mode = process.argv[2], events = [];
const save = () => writeFileSync("synthetic-observations.json", JSON.stringify({ pid: process.pid,
  startedAt, cleanEnv: Object.keys(process.env).every(key => key === "__CF_USER_TEXT_ENCODING"), execArgv: process.execArgv, events }), { mode: 0o600 });
const startedAt = Date.now();
save();
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
if (mode === "hang-close") process.on("SIGTERM", () => {});
const input = createInterface({ input: process.stdin });
input.on("close", () => { if (mode === "hang-close") setInterval(() => {}, 1000); });
input.on("line", async line => {
  try {
    const request = JSON.parse(line);
    events.push(request.method ?? "permission-response"); save();
    if (!request.method) {
      assert.equal(mode, "permission");
      assert.deepEqual(request.result, { outcome: { outcome: "cancelled" } });
      return;
    }
    assert.equal(request.jsonrpc, "2.0");
    if (request.method === "initialize") {
      assert.equal(request.params.protocolVersion, 1);
      assert.deepEqual(request.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      if (mode === "timeout-init") return;
      if (mode === "malformed") { process.stdout.write("native secret text\n"); return; }
      if (mode === "invalid-utf8") { process.stdout.write(Buffer.from([0xff, 10])); return; }
      if (mode === "stderr-flood") { process.stderr.write("x".repeat(9 * 1024 * 1024)); return; }
      if (mode === "oversize") { process.stdout.write("x".repeat(300000)); return; }
      if (mode === "frame-flood" || mode === "byte-flood") {
        const message = { jsonrpc: "2.0", method: "session/update", params: { update: mode === "byte-flood" ? "x".repeat(200000) : "" } };
        for (let i = 0; i < (mode === "byte-flood" ? 45 : 2050); i++) send(message);
        return;
      }
      if (mode === "batch") { send([{ jsonrpc: "2.0", id: request.id, result: {} }]); return; }
      if (mode === "error") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "synthetic_secret_must_not_escape" } }); return; }
      const response = { jsonrpc: "2.0", id: mode === "wrong-id" ? 999 : request.id, result: {
        protocolVersion: mode === "version" ? 2 : 1,
        agentCapabilities: { mcpCapabilities: { http: mode !== "no-http" } },
        authMethods: [{ id: "do-not-authenticate", name: "Ignored" }],
      } };
      if (mode === "split") {
        const encoded = JSON.stringify(response) + "\r\n";
        process.stdout.write(encoded.slice(0, 17));
        setTimeout(() => process.stdout.write(encoded.slice(17)), 5);
      } else send(response);
      if (mode === "duplicate") send(response);
      return;
    }
    assert.equal(request.method, "session/new");
    assert.equal(realpathSync(request.params.cwd), process.cwd());
    const [mcp] = request.params.mcpServers;
    assert.equal(request.params.mcpServers.length, 1);
    assert.equal(mcp.type, "http"); assert.equal(mcp.headers.length, 1);
    assert.equal(mcp.headers[0].name, "Authorization");
    assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    if (mode === "permission" || mode === "filesystem") {
      send({ jsonrpc: "2.0", id: "synthetic-permission", method: mode === "permission" ? "session/request_permission" : "fs/read_text_file", params: {} });
      return;
    }
    if (mode === "lost-response") return;
    if (mode === "partial-eof") { process.stdout.write('{"jsonrpc":'); process.stdout.end(); return; }
    if (mode === "raw-output") process.stderr.write("synthetic_secret_must_not_escape\n");
    if (mode === "discover" || mode === "discovery-lost-response" || mode.startsWith("discover-fault-")) {
      const client = new Client({ name: "synthetic-acp-child", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: mcp.headers[0].value } } });
      await client.connect(transport);
      const { tools } = await client.listTools(); assert.equal(tools.length, 6);
      for (const tool of tools) assert.equal((await client.callTool({ name: tool.name, arguments: {} })).isError, true);
      events.push("discovery-denied"); save();
      await transport.terminateSession(); await client.close();
      if (mode === "discovery-lost-response") return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "synthetic-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: mode === "invalid-session" ? "" : "synthetic-session" } });
    if (mode.startsWith("discover-fault-")) {
      const faultTimer = setInterval(() => {
        if (!existsSync("synthetic-release-fault")) return;
        clearInterval(faultTimer);
        if (mode === "discover-fault-malformed") process.stdout.write("synthetic-invalid-frame\n");
        else if (mode === "discover-fault-unmatched") send({ jsonrpc: "2.0", id: 999, result: {} });
        else process.stderr.write("x".repeat(9 * 1024 * 1024));
      }, 10);
      input.once("close", () => clearInterval(faultTimer));
    }
    if (mode === "eof-after") setTimeout(() => process.stdout.end(), 50);
  } catch {
    process.exitCode = 1; input.close(); process.stdin.destroy();
  }
});
