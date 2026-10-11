import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { ReadableStream } from "node:stream/web";
import {
  McpServer,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { handler } from "../src/mcp.ts";
import { fetchMCP } from "../src/mcp-core.ts";
import {
  SecurityMonitor,
  guardedResponse,
  boundedBody,
  exchangeResponse,
} from "../src/security.ts";
import { MemoryAudit } from "../src/local-audit.ts";
import { Hub, owner, submit } from "./fixtures.js";
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const listenHeaders = {
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  "Mcp-Method": "subscriptions/listen",
  "MCP-Protocol-Version": "2026-07-28",
};
const listenBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "subscriptions/listen",
  params: {
    notifications: { toolsListChanged: true },
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
  },
};
async function fixture(hub, monitor, limits) {
  const serve = handler(
    hub,
    async () => owner,
    undefined,
    undefined,
    undefined,
    monitor,
    limits,
  );
  const server = createServer((req, res) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}
test("SDK baseline opens a listener; Node and portable dispatch explicitly reject it without consuming four slots", async () => {
  const raw = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool("fixture", { inputSchema: z.strictObject({}) }, () => ({
      content: [{ type: "text", text: "fixed" }],
    }));
    return server;
  });
  const baseline = await raw.fetch(
    new Request("https://fixture.example/mcp", {
      method: "POST",
      headers: listenHeaders,
      body: JSON.stringify(listenBody),
    }),
  );
  assert.equal(baseline.status, 200);
  const reader = baseline.body.getReader();
  assert.equal(
    await Promise.race([
      reader.closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ]),
    false,
  );
  await reader.cancel();
  await raw.close();
  const hub = new Hub(),
    audit = new MemoryAudit(),
    monitor = new SecurityMonitor(audit);
  const { server, url } = await fixture(hub, monitor);
  try {
    for (let i = 0; i < 4; i++) {
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: listenHeaders,
        body: JSON.stringify(listenBody),
      });
      assert.equal(response.status, 405);
      await response.text();
      const context = await monitor.enter();
      const portable = await fetchMCP(
        hub,
        new Request("https://hub.example/mcp", {
          method: "POST",
          headers: listenHeaders,
          body: JSON.stringify(listenBody),
        }),
        async () => owner,
        undefined,
        undefined,
        undefined,
        context,
      );
      assert.equal(portable.status, 405);
      await portable.text();
      context.release();
    }
    const response = await globalThis.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(audit.counts.get("resource_rejected"), 8);
  } finally {
    server.close();
    await once(server, "close");
    hub.close();
  }
});
test("Node and portable SDK pre-callback failures are audited without retaining payloads", async () => {
  const hub = new Hub(),
    audit = new MemoryAudit(),
    monitor = new SecurityMonitor(audit);
  const { server, url } = await fixture(hub, monitor);
  try {
    for (const body of [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get", arguments: { id: "PRIVATE malformed UUID" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "unknown_PRIVATE", arguments: {} },
      }),
      "{PRIVATE",
    ]) {
      const node = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body,
      });
      if (body === "{PRIVATE") assert(node.status >= 400);
      else {
        assert.equal(node.status, 200);
        assert.match(await node.text(), /isError|"error"/);
      }
      const context = await monitor.enter();
      const portable = await fetchMCP(
        hub,
        new Request("https://hub.example/mcp", {
          method: "POST",
          headers,
          body,
        }),
        async () => owner,
        undefined,
        undefined,
        undefined,
        context,
      );
      if (body === "{PRIVATE") assert.equal(portable.status, 400);
      else {
        assert.equal(portable.status, 200);
        assert.match(await portable.text(), /isError|"error"/);
      }
      context.release();
    }
    assert.equal(audit.counts.get("tool_error"), 4);
    assert.equal(audit.counts.get("tool_started"), undefined);
    assert.equal(audit.counts.get("transport_error"), 2);
  } finally {
    server.close();
    await once(server, "close");
    hub.close();
  }
});
test("Node byte/body/exchange limits and portable stalled responses release only settled work", async () => {
  const hub = new Hub(),
    audit = new MemoryAudit(),
    monitor = new SecurityMonitor(audit);
  const task = await submit(hub);
  const original = hub.view.bind(hub);
  const { server, url } = await fixture(hub, monitor, {
    bodyMs: 10,
    responseMs: 10,
  });
  try {
    hub.view = async () => ({ result: "x".repeat(65537) });
    const call = () =>
      globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get", arguments: { id: task.id } },
        }),
      });
    let response = await call();
    assert.equal(response.status, 503);
    await response.text();
    let finish;
    hub.view = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    response = await call();
    assert.equal(response.status, 503);
    await response.text();
    finish({ result: "fixed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    hub.view = original;
    response = await globalThis.fetch(url, {
      method: "POST",
      headers,
      body: "x".repeat(32769),
    });
    assert.equal(response.status, 413);
    await response.text();
    await assert.rejects(
      globalThis.fetch(url, {
        method: "POST",
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
        duplex: "half",
      }),
    );
    await assert.rejects(
      boundedBody(
        new Request("https://hub.example/mcp", {
          method: "POST",
          body: new ReadableStream(),
          duplex: "half",
        }),
        5,
      ),
    );
    const context = await monitor.enter();
    await assert.rejects(
      guardedResponse(new Response(new ReadableStream()), context, 5).text(),
    );
    await assert.rejects(exchangeResponse(new Promise(() => {}), 5));
  } finally {
    server.close();
    await once(server, "close");
    hub.close();
  }
});
test(
  "disconnect during request-audit ACK releases all four native slots before ACK and never dispatches",
  { timeout: 3000 },
  async () => {
    const { request } = await import("node:http");
    const hub = new Hub();
    const acknowledgements = [];
    let delayed = true,
      admittedResolve,
      closedResolve,
      settledResolve;
    const admitted = new Promise((resolve) => {
      admittedResolve = resolve;
    });
    const closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    const settled = new Promise((resolve) => {
      settledResolve = resolve;
    });
    let closes = 0,
      settlements = 0,
      authenticated = 0;
    const monitor = new SecurityMonitor({
      record(category) {
        if (category === "request" && delayed)
          return new Promise((resolve) => {
            acknowledgements.push(resolve);
            if (acknowledgements.length === 4) admittedResolve();
          });
      },
    });
    const serve = handler(
      hub,
      async () => {
        authenticated++;
        return owner;
      },
      undefined,
      undefined,
      undefined,
      monitor,
    );
    const server = createServer((req, res) => {
      res.once("close", () => {
        if (++closes === 4) closedResolve();
      });
      void serve(req, res).finally(() => {
        if (++settlements === 4) settledResolve();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) {
        const client = request(url, { method: "POST", headers });
        client.on("error", () => {});
        client.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "submit",
              arguments: {
                task_type: "connectivity_check",
                request_key: `disconnect-fixture-${i}`,
              },
            },
          }),
        );
        clients.push(client);
      }
      await admitted;
      clients.forEach((client) => client.destroy());
      await closed;
      delayed = false;
      const recovered = await Promise.all(
        Array.from({ length: 4 }, () => monitor.enter()),
      );
      recovered.forEach((context) => context.release());
      acknowledgements.forEach((resolve) => resolve());
      await settled;
      assert.equal(authenticated, 0);
      assert.equal(
        hub.sqlite.db.prepare("SELECT count(*) AS count FROM tasks").get()
          .count,
        0,
      );
      const recoveredAfterAck = await Promise.all(
        Array.from({ length: 4 }, () => monitor.enter()),
      );
      recoveredAfterAck.forEach((context) => context.release());
    } finally {
      clients.forEach((client) => client.destroy());
      acknowledgements.forEach((resolve) => resolve());
      server.close();
      await once(server, "close");
      hub.close();
    }
  },
);
test("native and portable SDK media-type/version/envelope/header rejection outcomes have safe audit", async () => {
  const hub = new Hub(),
    audit = new MemoryAudit(),
    monitor = new SecurityMonitor(audit);
  const { server, url } = await fixture(hub, monitor);
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  try {
    const cases = [
      { headers: { ...headers, "Content-Type": "text/plain" }, body },
      {
        headers: {
          ...headers,
          "MCP-Protocol-Version": "PRIVATE-invalid-version",
        },
        body,
      },
      { headers, body: { ...body, jsonrpc: "PRIVATE-invalid-envelope" } },
      { headers: { ...headers, Accept: "text/plain" }, body },
    ];
    for (const value of cases) {
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify(value.body),
      });
      assert(response.status >= 400);
      await response.text();
      const context = await monitor.enter();
      try {
        const portable = await fetchMCP(
          hub,
          new Request("https://hub.example/mcp", {
            method: "POST",
            headers: value.headers,
            body: JSON.stringify(value.body),
          }),
          async () => owner,
          undefined,
          undefined,
          undefined,
          context,
        );
        assert(portable.status >= 400);
        await portable.text();
      } finally {
        context.release();
      }
    }
    assert.equal(audit.counts.get("transport_error"), 8);
    assert.equal(audit.counts.get("tool_started"), undefined);
  } finally {
    server.close();
    await once(server, "close");
    hub.close();
  }
});
