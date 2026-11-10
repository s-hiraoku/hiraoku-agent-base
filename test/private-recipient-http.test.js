import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPrivateRecipientHttp } from "../src/adapter-host/private-http.ts";
import { hostFixture, limits, deferred } from "./adapter-host-fixtures.js";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
const token = "synthetic_only_credential_not_native_proof_12345";
async function endpoint(t, extra = {}) {
  let api;
  const server = createServer((req, res) => void api.handleRequest(req, res));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const authority = `127.0.0.1:${server.address().port}`, signal = new AbortController();
  api = createPrivateRecipientHttp({ bearerToken: token, authority, ownerSignal: signal.signal,
    lifetimeMs: 10000, shutdownTimeoutMs: 500, ...extra });
  t.after(async () => {
    try { await api.stop(); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
  const url = `http://${authority}/mcp`;
  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "synthetic-private-http", version: "1" });
    await client.connect(transport);
    t.after(() => client.close());
    return { client, transport };
  };
  return { api, url, connect, signal };
}
async function stores(t) {
  const f = await hostFixture(t), { key } = f.submit();
  const owner = new SQLiteHostOwner(join(f.dir, "private-http-owner.sqlite"), { agent_id: "b", fingerprint_key: new Uint8Array(32).fill(71) });
  owner.migrate(); owner.acquire(() => {}); t.after(() => owner.close());
  const journal = new SQLiteAnswerJournal(join(f.dir, "private-http-answers.sqlite"), {
    agent_id: "b", fingerprint_key: new Uint8Array(32).fill(70), limits,
    max_records: 50, max_body_bytes: 1000000, max_clock_skew_ms: 1000,
  });
  journal.migrate(); t.after(() => journal.close());
  return { f, key, owner, binding: { hostOptions: f.hostOptions({ owner, answer_intents: journal }), actorId: "synthetic-owner",
    verifiedRecipientContext: {}, verifiedOperatorContext: {}, source: key } };
}
const call = (client, name, args = {}) => client.callTool({ name: `recipient_${name}`, arguments: args });
function activate(api, binding) {
  api.bindVerified(api.discoveryReceipt(), binding);
  api.updatePermission(api.status().epoch, true);
  api.resume(api.status().epoch);
}

test("private HTTP authenticates before metadata and rejects origins, wrong path and stale session IDs", async t => {
  const e = await endpoint(t);
  for (const method of ["HEAD", "GET", "POST", "DELETE"]) {
    const r = await globalThis.fetch(e.url, { method }); assert.equal(r.status, 401); assert.equal(r.headers.get("location"), null);
  }
  for (const [url, headers] of [[e.url, { Origin: "https://untrusted.invalid" }], [e.url + "/", {}]]) {
    const r = await globalThis.fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } }); assert.equal(r.status, 403);
  }
  const wrongHost = await new Promise(resolve => {
    const req = httpRequest(e.url, { headers: { Authorization: `Bearer ${token}`, Host: "foreign.invalid" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); req.end();
  });
  assert.equal(wrongHost, 403);
  const stale = await globalThis.fetch(e.url, { headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": "old" } });
  assert.equal(stale.status, 404); assert.equal(e.api.discoveryReceipt(), undefined);
});

test("precommit discovery is metadata only, reconnect receipt fenced, verified bind still deny/paused", async t => {
  const s = await stores(t), e = await endpoint(t);
  assert.throws(() => e.api.bindVerified({}, s.binding), /binding_rejected/);
  let c = await e.connect(); const manifest = await c.client.listTools(), old = e.api.discoveryReceipt();
  assert.equal(manifest.tools.length, 6);
  for (const [op, args] of [["receive", {}], ["send", {}], ["inbox_read", { source: s.key }], ["answer_inspect", { source: s.key }], ["answer_enqueue", { source: s.key }], ["answer_prepare", { source: s.key, body: { parts: [{ type: "text", text: "synthetic" }] } }]])
    assert.equal((await call(c.client, op, args)).isError, true);
  assert.equal(s.f.state.tools.length, 0);
  await c.transport.terminateSession(); await c.client.close();
  c = await e.connect(); assert.notEqual(e.api.discoveryReceipt(), old);
  assert.throws(() => e.api.bindVerified(old, s.binding), /binding_rejected/);
  e.api.bindVerified(e.api.discoveryReceipt(), s.binding);
  assert.deepEqual(await c.client.listTools(), manifest);
  assert.equal((await call(c.client, "receive")).isError, true);
  e.api.updatePermission(e.api.status().epoch, true);
  assert.equal((await call(c.client, "receive")).isError, true);
  e.api.resume(e.api.status().epoch);
  assert.equal((await call(c.client, "receive")).isError, false);
  assert.equal((await call(c.client, "inbox_read", { source: s.key })).isError, false);
  assert.equal((await call(c.client, "inbox_read", { source: { ...s.key, message_id: "different" } })).isError, true);
  const body = { parts: [{ type: "text", text: "synthetic exact persisted reply" }] };
  assert.equal((await call(c.client, "answer_prepare", { source: s.key, body })).isError, false);
  assert.equal((await call(c.client, "answer_enqueue", { source: s.key })).isError, false);
  assert.equal((await call(c.client, "answer_inspect", { source: s.key })).isError, false);
  e.api.updatePermission(e.api.status().epoch, false); e.api.resume(e.api.status().epoch);
  assert.equal((await call(c.client, "send")).isError, true);
  e.api.updatePermission(e.api.status().epoch, true); e.api.resume(e.api.status().epoch);
  assert.equal((await call(c.client, "send")).isError, false);
  assert.equal(s.f.queued().length, 1);
  assert.throws(() => e.api.bindVerified(e.api.discoveryReceipt(), s.binding), /binding_rejected/);
  await e.api.stop();
});

test("owner loss and bound transport DELETE terminally deny this generation", async t => {
  for (const mode of ["owner", "delete"]) {
    await t.test(mode, async t => {
      const s = await stores(t), e = await endpoint(t), c = await e.connect(); activate(e.api, s.binding);
      if (mode === "owner") e.signal.abort(); else await c.transport.terminateSession();
      await e.api.completion;
      assert.throws(() => e.api.resume(0), /stopping/);
      assert.equal((await globalThis.fetch(e.url, { headers: { Authorization: `Bearer ${token}` } })).status, 410);
    });
  }
});

test("finite metadata lifetime also expires without binding or receiving any tool", async t => {
  const e = await endpoint(t, { lifetimeMs: 30 }); await e.api.completion;
  assert.equal((await globalThis.fetch(e.url, { headers: { Authorization: `Bearer ${token}` } })).status, 410);
});

test("stop drain failure fences calls, retains ownership, then permits only cleanup retry", async t => {
  const s = await stores(t), e = await endpoint(t, { shutdownTimeoutMs: 20 }), c = await e.connect(); activate(e.api, s.binding);
  const wait = deferred(); s.f.state.timeout_ms = 10; s.f.state.credential = () => wait.promise;
  await call(c.client, "receive");
  await assert.rejects(e.api.stop(), /drain_timeout/);
  await assert.rejects(e.api.completion, /drain_timeout/);
  assert.throws(() => e.api.updatePermission(0, true), /stopping/);
  assert.equal((await globalThis.fetch(e.url, { headers: { Authorization: `Bearer ${token}` } })).status, 410);
  assert.equal(e.api.status().owner, "held");
  assert.equal(e.api.status().paused, true);
  wait.resolve("Bearer fixture-b"); await new Promise(r => setTimeout(r, 40));
  await e.api.stop();
  await assert.rejects(e.api.completion, /drain_timeout/);
  assert.equal(s.f.state.tools.length, 0);
});

// These deliberately partial HTTP bodies exercise admission/activation races, not native identity.
function partialPost(url, sessionId, body) {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const req = httpRequest(url, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    ...(sessionId ? { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-03-26" } : {}),
  } }, res => { res.resume(); res.on("end", () => finish(res.statusCode)); });
  req.write(body.slice(0, 1));
  return { finish: () => req.end(body.slice(1)), done };
}
test("prebind delayed POST cannot cross promotion; replacement initialize invalidates old receipt early", async t => {
  const s = await stores(t), e = await endpoint(t), c = await e.connect();
  const receipt = e.api.discoveryReceipt();
  const pending = partialPost(e.url, receipt.sessionId, JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "recipient_receive", arguments: {} } }));
  await new Promise(r => setTimeout(r, 30));
  assert.throws(() => e.api.bindVerified(receipt, s.binding), /binding_rejected/);
  pending.finish(); assert.equal(await pending.done, 200);
  assert.equal(s.f.state.tools.length, 0);
  await c.transport.terminateSession(); await c.client.close();
  const init = partialPost(e.url, undefined, JSON.stringify({ jsonrpc: "2.0", id: 71, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(e.api.discoveryReceipt(), undefined);
  assert.throws(() => e.api.bindVerified(receipt, s.binding), /binding_rejected/);
  init.finish(); assert.equal(await init.done, 200);
  assert.notEqual(e.api.discoveryReceipt(), receipt);
});
test("closed discovery can bind only by current owner receipt; next launch connection is deny until grant", async t => {
  const s = await stores(t), e = await endpoint(t), c = await e.connect();
  const receipt = e.api.discoveryReceipt(); await c.transport.terminateSession(); await c.client.close();
  e.api.bindVerified(receipt, s.binding);
  const next = await e.connect();
  assert.equal((await call(next.client, "receive")).isError, true);
  // New session IDs are routing only: an unauthenticated DELETE cannot close this binding.
  assert.equal((await globalThis.fetch(e.url, { method: "DELETE", headers: { "Mcp-Session-Id": e.api.discoveryReceipt().sessionId } })).status, 401);
  e.api.updatePermission(e.api.status().epoch, true); e.api.resume(e.api.status().epoch);
  assert.equal((await call(next.client, "receive")).isError, false);
  await e.api.stop();
});

test("stop during transport startup retains owner on SDK close failure and retries cleanup", async t => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const s = await stores(t), e = await endpoint(t), c = await e.connect();
  const receipt = e.api.discoveryReceipt(); await c.transport.terminateSession(); await c.client.close();
  e.api.bindVerified(receipt, s.binding);
  const entered = deferred(), release = deferred();
  const originalConnect = McpServer.prototype.connect, originalClose = McpServer.prototype.close;
  let failClose = true;
  t.mock.method(McpServer.prototype, "connect", async function (transport) {
    entered.resolve(); await release.promise; return originalConnect.call(this, transport);
  });
  t.mock.method(McpServer.prototype, "close", async function () {
    if (failClose) throw Error("synthetic_sdk_close_failure");
    return originalClose.call(this);
  });
  const request = globalThis.fetch(e.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 81, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } }) });
  await entered.promise;
  const rejected = assert.rejects(e.api.stop(), /synthetic_sdk_close_failure/);
  release.resolve(); await rejected;
  assert.equal((await request).status, 500);
  assert.equal(e.api.status().owner, "held"); assert.equal(e.api.status().paused, true);
  failClose = false; await e.api.stop();
  await assert.rejects(e.api.completion, /synthetic_sdk_close_failure/);
});

test("failed durable pause retains held owner and cannot reopen recipient access", async t => {
  const s = await stores(t), e = await endpoint(t); await e.connect(); activate(e.api, s.binding);
  const original = s.f.control.snapshot;
  s.f.control.snapshot = function () { s.f.control.snapshot = original; throw Error("synthetic_control_snapshot_failure"); };
  await assert.rejects(e.api.stop(), /synthetic_control_snapshot_failure/);
  assert.equal(e.api.status().owner, "held"); assert.equal(e.api.status().paused, false);
  assert.equal((await globalThis.fetch(e.url, { headers: { Authorization: `Bearer ${token}` } })).status, 410);
  assert.throws(() => e.api.resume(e.api.status().epoch), /stopping/);
  await e.api.stop();
  await assert.rejects(e.api.completion, /synthetic_control_snapshot_failure/);
});
