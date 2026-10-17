import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as nodeRequest } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import {
  fixture,
  limits,
  envelope,
  request,
  decode,
  message,
  tick,
} from "./relay-http-fixtures.js";
async function listening(t, f, patch = {}, verify = f.verifier) {
  let handle;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 2000, headersTimeout: 2000 },
    (req, res) => {
      if (!handle) {
        res.writeHead(503);
        res.end();
        return;
      }
      void handle(req, res);
    },
  );
  server.maxConnections = 4;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  handle = createRelayNodeHandler(
    f.gateway({ ...patch, resource_url: url }, verify),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { url, server };
}
async function send(url, name, args = {}, patch = {}) {
  const r = request("tools/call", { name, arguments: args }, { url, ...patch });
  const response = await globalThis.fetch(r);
  return {
    response,
    body:
      response.status === 200 ? await decode(response) : await response.text(),
  };
}
function raw(
  url,
  {
    path = "/mcp",
    headers,
    method = "POST",
    body = JSON.stringify(envelope()),
  } = {},
) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path,
        method,
        headers: headers ?? {
          Host: u.host,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer fixture-a",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

test(
  "actual temporary loopback HTTP delivers only after durable inbox save, and exact retries recover receipts",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      { url } = await listening(t, f),
      m = message();
    const a = await send(url, "relay_submit", m);
    assert.equal(a.response.status, 200);
    assert.equal(a.body.result.structuredContent.sender_id, "a");
    const poll = await send(
      url,
      "relay_poll",
      {},
      { headers: { Authorization: "Bearer fixture-b" } },
    );
    const d = poll.body.result.structuredContent.delivery;
    const inbox = new SQLiteInbox(join(f.dir, "inbox.sqlite"), {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(43),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_ack_records: 30,
      ack_retry_ms: 86400000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_attempts: 5,
    });
    t.after(() => inbox.close());
    inbox.migrate();
    inbox.save(d);
    const req = inbox.claimAck();
    const r = await send(url, "relay_ack", req, {
      headers: { Authorization: "Bearer fixture-b" },
    });
    const repeated = await send(url, "relay_ack", req, {
      headers: { Authorization: "Bearer fixture-b" },
    });
    assert.deepEqual(
      repeated.body.result.structuredContent,
      r.body.result.structuredContent,
    );
    inbox.confirmAck(req, repeated.body.result.structuredContent);
    assert.equal(inbox.inbox()[0].receipt_confirmed, true);
    assert.equal(
      (await send(url, "relay_status", { message_id: m.message_id })).body
        .result.structuredContent.state,
      "acked",
    );
    assert.equal(
      f.raw.prepare("SELECT body FROM relay_messages").get().body,
      null,
    );
    assert.equal(a.response.headers.get("connection"), "close");
  },
);

test(
  "native unauthenticated and oversized-body refusals flush their HTTP status before cancelling unread input",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      { url } = await listening(t, f, { max_request_bytes: 1024 });
    const unauthorized = await send(url, "relay_submit", message(), {
      headers: { Authorization: "" },
    });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body, "");
    const large = message();
    large.body.parts[0].text = "x".repeat(32768);
    const response = await send(url, "relay_submit", large);
    assert.equal(response.response.status, 413);
    assert.equal(response.body, "");
    assert.equal(f.count(), 0);
    assert.equal(
      (await send(url, "relay_submit", message())).response.status,
      200,
    );
  },
);

test(
  "native Host, duplicate framing/auth headers and non-origin-form targets never reach verification",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let verified = 0;
    const { url } = await listening(t, f, {}, (v) => {
      verified++;
      return f.verifier(v);
    });
    const host = new URL(url).host;
    const duplicate = await raw(url, {
      headers: [
        "Host",
        host,
        "Content-Type",
        "application/json",
        "Authorization",
        "Bearer fixture-a",
        "Authorization",
        "Bearer fixture-b",
      ],
    });
    assert.equal(duplicate.status, 400);
    assert.equal(
      (await raw(url, { headers: { Host: "evil.example" } })).status,
      403,
    );
    assert.equal(
      (await raw(url, { path: "https://evil.example/mcp" })).status,
      400,
    );
    assert.equal((await raw(url, { path: "//evil.example/mcp" })).status, 400);
    assert.equal((await raw(url, { path: "/other/../mcp" })).status, 405);
    assert.equal((await raw(url, { path: "/mcp?alias=1" })).status, 405);
    assert.equal(verified, 0);
    assert.equal(f.count(), 0);
  },
);

test(
  "native deadline preserves bounded admission when verification ignores cancellation",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let release,
      entered,
      signal,
      calls = 0;
    const ready = new Promise((r) => {
      entered = r;
    });
    const { url } = await listening(
      t,
      f,
      { timeout_ms: 500, max_active_requests: 1 },
      (v) => {
        if (++calls > 1) return f.verifier(v);
        signal = v.signal;
        entered();
        return new Promise((r) => {
          release = r;
        });
      },
    );
    const pending = send(url, "relay_submit", message());
    await ready;
    assert.equal((await pending).response.status, 504);
    assert.equal(signal.aborted, true);
    assert.equal(
      (await send(url, "relay_submit", message())).response.status,
      503,
    );
    release(f.contexts.a);
    await tick();
    assert.equal(f.count(), 0);
    assert.equal(
      (await send(url, "relay_submit", message())).response.status,
      200,
    );
  },
);

test(
  "native client disconnect aborts pending verification and a late result cannot mutate storage",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let release, entered, signal;
    const ready = new Promise((r) => {
      entered = r;
    });
    const { url } = await listening(t, f, {}, (v) => {
      signal = v.signal;
      entered();
      return new Promise((r) => {
        release = r;
      });
    });
    const u = new URL(url),
      req = nodeRequest({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer fixture-a",
        },
      });
    req.on("error", () => {});
    req.end(
      JSON.stringify(
        envelope(
          "tools/call",
          { name: "relay_submit", arguments: message() },
          false,
        ),
      ),
    );
    await ready;
    const closed = new Promise((resolve) => req.once("close", resolve));
    req.destroy();
    await closed;
    // Wait for the server's close event to propagate to its own verification signal.
    for (let i = 0; i < 20 && !signal.aborted; i++) await tick();
    assert.equal(signal.aborted, true);
    release(f.contexts.a);
    await tick();
    assert.equal(f.count(), 0);
  },
);
