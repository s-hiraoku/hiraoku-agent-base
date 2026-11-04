import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Hub } from "../src/sqlite.ts";
import { Adapter } from "../src/adapter.ts";
import { GenericTextJobs, GENERIC_TEXT_PROFILE } from "../src/generic-jobs.ts";
import { createGenericTextMCPHTTP } from "../src/generic-mcp.ts";
import { identities } from "./generic-async/fixtures.js";
import { journal } from "./fixtures.js";

async function fixture(t) {
  const h = new Hub(":memory:", () => 100);
  const { sender, worker } = identities();
  const policies = new Map([
    ["synthetic-sender", sender],
    ["synthetic-submit", { ...sender, operations: ["submit"] }],
    ["synthetic-other-client", { ...sender, clientId: "other-client" }],
    [
      "synthetic-other-scope",
      {
        ...sender,
        textBinding: { ...sender.textBinding, ownerScope: "other-scope" },
      },
    ],
    ["synthetic-worker", worker],
  ]);
  const resolutions = [];
  let resolveOverride;
  const jobs = new GenericTextJobs(h, async (request, op) => {
    resolutions.push({ token: request.headers.get("authorization"), op });
    if (resolveOverride) return resolveOverride(request, op);
    return (
      policies.get(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
      ) ?? null
    );
  });
  let endpoint;
  const server = createServer((req, res) =>
    toNodeHandler(endpoint, { maxRequestBodySize: 262144 })(req, res),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  endpoint = createGenericTextMCPHTTP({ endpoint: url, jobs });
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await endpoint.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    h.close();
  });
  const connect = async (token = "synthetic-sender") => {
    const client = new Client({
      name: "synthetic-text-proof",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const raw = async (body, headers = {}, target = url, method = "POST") => {
    return endpoint.fetch(
      new Request(target, {
        method,
        headers: {
          host: new URL(url).host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer synthetic-sender",
          ...headers,
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  return {
    h,
    sender,
    worker,
    policies,
    resolutions,
    jobs,
    url,
    endpoint,
    connect,
    raw,
    override(fn) {
      resolveOverride = fn;
    },
    input(messageId = crypto.randomUUID(), text = "private input") {
      return {
        messageId,
        contextId: "synthetic-conversation",
        text,
        workDeadline: 100000,
      };
    },
  };
}
const unpack = (reply) => {
  assert.equal(reply.structuredContent, undefined);
  assert.equal(reply.content.length, 1);
  assert.equal(reply.content[0].type, "text");
  return JSON.parse(reply.content[0].text);
};
const call = async (client, name, args) => {
  const reply = await client.callTool({ name, arguments: args });
  assert.equal(reply.isError, undefined, JSON.stringify(reply));
  return unpack(reply);
};
const rpc = (method, params = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

test("official MCP client submits, lists, gets and cancels real persisted generic jobs", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ["text_cancel", "text_get", "text_list", "text_submit"],
  );
  assert.ok(
    (await client.listTools()).tools.every((tool) => tool._meta === undefined),
  );
  const input = f.input("same-message");
  const accepted = await call(client, "text_submit", input);
  assert.equal(accepted.profile, GENERIC_TEXT_PROFILE);
  assert.equal(accepted.state, "submitted");
  assert.equal((await call(client, "text_submit", input)).id, accepted.id);
  assert.equal(
    (await call(client, "text_get", { id: accepted.id })).sourceMessageId,
    "same-message",
  );
  const listing = await call(client, "text_list", {
    pageSize: 1,
    contextId: input.contextId,
  });
  assert.equal(listing.totalSize, 1);
  assert.equal(listing.jobs[0].id, accepted.id);
  assert.equal(listing.jobs[0].result, undefined);
  const canceled = await call(client, "text_cancel", { id: accepted.id });
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.cancellationConfirmed, true);
  assert.ok(f.resolutions.some(({ op }) => op === "submit"));
  assert.ok(f.resolutions.some(({ op }) => op === "cancel"));
});

test("submit-only official client handshakes and sees only its current tool catalog", async (t) => {
  const f = await fixture(t);
  const client = await f.connect("synthetic-submit");
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["text_submit"],
  );
  const job = await call(client, "text_submit", f.input());
  const reply = await client.callTool({
    name: "text_get",
    arguments: { id: job.id },
  });
  assert.equal(reply.isError, true);
  f.policies.set("synthetic-submit", f.sender);
  assert.equal((await client.listTools()).tools.length, 4);
  f.policies.set("synthetic-submit", null);
  await assert.rejects(client.listTools());
});

test("every tool call re-resolves authorization and rejects revocation after discovery", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  await client.listTools();
  f.policies.set("synthetic-sender", null);
  await assert.rejects(
    client.callTool({ name: "text_submit", arguments: f.input() }),
  );
  assert.equal((await f.h.listText(f.sender)).totalSize, 0);
});

test("foreign client and scope cannot get or cancel a sender's jobs", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const accepted = await call(client, "text_submit", f.input());
  for (const token of ["synthetic-other-client", "synthetic-other-scope"]) {
    const other = await f.connect(token);
    const list = await call(other, "text_list", {});
    assert.deepEqual(list.jobs, []);
    assert.equal(list.totalSize, 0);
    for (const name of ["text_get", "text_cancel"]) {
      const result = await other.callTool({
        name,
        arguments: { id: accepted.id },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(unpack(result), {
        error: "not_found",
        message: "Operation rejected",
      });
    }
  }
  assert.equal(
    (await call(client, "text_get", { id: accepted.id })).state,
    "submitted",
  );
});

test("escaped maximum input and result round trip through the official client", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const text = "\u0001".repeat(32768);
  const accepted = await call(client, "text_submit", f.input("escaped", text));
  const runs = {
    supportedTaskTypes: ["generic_text"],
    boundaryId: f.worker.runnerScope,
    admissionContract: "synthetic-text-v1",
    textBoundary: {
      version: 1,
      inputAuthority: "external_agent",
      effects: "none",
      automaticReply: false,
    },
    toolIsolationVerified: true,
    durableIdempotency: true,
    retentionMs: 200000,
    async create() {
      throw Error("fixed_path_forbidden");
    },
    async createText(value) {
      assert.equal(value.content.text, text);
      assert.deepEqual(value.tools, []);
      return { id: "synthetic-run", state: "succeeded", text };
    },
    async get() {
      return { id: "synthetic-run", state: "succeeded", text };
    },
  };
  await new Adapter(f.h, f.worker, runs, journal(), { now: () => 100 }).once();
  const result = await call(client, "text_get", { id: accepted.id });
  assert.equal(result.state, "completed");
  assert.equal(result.result.text, text);
  const submitOnly = await f.connect("synthetic-submit");
  const replay = await call(
    submitOnly,
    "text_submit",
    f.input("escaped", text),
  );
  assert.equal(replay.state, "completed");
  assert.equal(replay.result, undefined);
  const serialized = JSON.stringify(result);
  for (const privateField of [
    "ownerScope",
    "ownerClient",
    "textBinding",
    "runnerScope",
    "run_id",
    "fence",
    "private input",
  ])
    assert.equal(serialized.includes(privateField), false);
  assert.equal((await call(client, "text_list", {})).jobs[0].result, undefined);
});

test("raw MCP transport rejects authority injection, worker methods and malformed envelopes", async (t) => {
  const f = await fixture(t);
  for (const value of [
    [],
    [rpc("tools/list")],
    rpc("claim"),
    rpc("tasks/get"),
    rpc("tools/call", { name: "claim", arguments: {} }),
    rpc("tools/call", {
      name: "text_submit",
      arguments: { ...f.input(), owner: "forged" },
    }),
    rpc("tools/call", {
      name: "text_submit",
      arguments: { ...f.input(), textBinding: {} },
    }),
    rpc("tools/call", { name: "text_list", arguments: { pageSize: 21 } }),
    rpc("tools/call", { name: "text_get", arguments: { id: "invalid" } }),
    rpc("tools/list", { authorization: "forged" }),
    { ...rpc("tools/list"), principal: { subject: "forged" } },
  ])
    assert.equal((await f.raw(value)).status, 400, JSON.stringify(value));
  assert.equal(
    (await f.raw(rpc("tools/list"), { "mcp-method": "tools/call" })).status,
    400,
  );
  assert.equal(
    (
      await f.raw(rpc("tools/call", { name: "text_list", arguments: {} }), {
        "mcp-name": "text_submit",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.raw(rpc("tools/list"), {
        authorization: "Bearer synthetic-worker",
      })
    ).status,
    401,
  );
});

test("loopback endpoint rejects foreign authority, origins, sessions, paths and streams", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.connect("synthetic-unknown"));
  for (const endpoint of [
    "https://127.0.0.1:1234/mcp",
    "http://localhost:1234/mcp",
    "http://0.0.0.0:1234/mcp",
    "http://127.0.0.1:1234/mcp?x=1",
    "http://127.0.0.1:1234/mcp#x",
    "http://a:b@127.0.0.1:1234/mcp",
  ])
    assert.throws(
      () => createGenericTextMCPHTTP({ endpoint, jobs: f.jobs }),
      /invalid_generic_mcp_endpoint/,
    );
  assert.equal(
    (await f.raw(rpc("tools/list"), { host: "evil.example" })).status,
    403,
  );
  assert.equal(
    (await f.raw(rpc("tools/list"), { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await f.raw(rpc("tools/list"), {}, `${f.url}?x=1`)).status,
    403,
  );
  assert.equal(
    (await f.raw(rpc("tools/list"), {}, `${f.url}/extra`)).status,
    403,
  );
  assert.equal((await f.raw(null, {}, f.url, "GET")).status, 405);
  assert.equal(
    (await f.raw(rpc("tools/list"), { "mcp-session-id": "synthetic-session" }))
      .status,
    400,
  );
  assert.equal(
    (await f.raw(rpc("tools/list"), { "content-type": "text/plain" })).status,
    415,
  );
});

test("request boundary rejects overlarge encoded bodies before job submission", async (t) => {
  const f = await fixture(t);
  const response = await f.raw(
    rpc("tools/call", {
      name: "text_submit",
      arguments: f.input("oversize", "x".repeat(262144)),
    }),
  );
  assert.equal(response.status, 413);
  assert.equal((await f.h.listText(f.sender)).totalSize, 0);
});

test("concurrent HTTP calls retain their lexical authorization context", async (t) => {
  const f = await fixture(t);
  const a = await f.connect();
  const b = await f.connect("synthetic-other-client");
  const [first, second] = await Promise.all([
    call(a, "text_submit", f.input("concurrent-a")),
    call(b, "text_submit", f.input("concurrent-b")),
  ]);
  const [ownA, ownB] = await Promise.all([
    call(a, "text_list", {}),
    call(b, "text_list", {}),
  ]);
  assert.deepEqual(
    ownA.jobs.map(({ id }) => id),
    [first.id],
  );
  assert.deepEqual(
    ownB.jobs.map(({ id }) => id),
    [second.id],
  );
});

test("unknown internal failures are sanitized and factory close preserves injected storage", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  f.override((req, op) => {
    if (op === "submit") throw Error("SECRET_DATABASE_PATH_AND_TOKEN");
    return f.sender;
  });
  const result = await client.callTool({
    name: "text_submit",
    arguments: f.input(),
  });
  assert.equal(result.isError, true);
  assert.deepEqual(unpack(result), {
    error: "unavailable",
    message: "Operation rejected",
  });
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  await f.endpoint.close();
  assert.equal((await f.raw(rpc("tools/list"))).status, 503);
  assert.equal((await f.h.listText(f.sender)).totalSize, 0);
});

test("modern discovery and calls use the same authorized finite endpoint", async (t) => {
  const f = await fixture(t);
  const modern = (method, params = {}) =>
    f.raw(
      rpc(method, {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      }),
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
      },
    );
  const discovered = await modern("server/discover");
  assert.equal(discovered.status, 200);
  assert.deepEqual((await discovered.json()).result.supportedVersions, [
    "2026-07-28",
  ]);
  const listed = await modern("tools/list");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.tools.length, 4);
  const submitted = await modern("tools/call", {
    name: "text_submit",
    arguments: f.input("modern-input"),
  });
  assert.equal(submitted.status, 200);
  assert.equal(
    unpack((await submitted.json()).result).sourceMessageId,
    "modern-input",
  );
});

test("tool authorization is refreshed again after per-request discovery", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  f.override((_request, op) => (op === "submit" ? null : f.sender));
  const reply = await client.callTool({
    name: "text_submit",
    arguments: f.input(),
  });
  assert.equal(reply.isError, true);
  assert.deepEqual(unpack(reply), {
    error: "forbidden",
    message: "Operation rejected",
  });
  assert.equal((await f.h.listText(f.sender)).totalSize, 0);
});

test("list pagination preserves authorized totals and never includes result bodies", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  for (let i = 0; i < 3; i++)
    await call(client, "text_submit", f.input(`page-${i}`));
  const first = await call(client, "text_list", { pageSize: 2 });
  assert.equal(first.totalSize, 3);
  assert.equal(first.jobs.length, 2);
  assert.equal(typeof first.nextPageToken, "string");
  const last = await call(client, "text_list", {
    pageSize: 2,
    pageToken: first.nextPageToken,
  });
  assert.equal(last.totalSize, 3);
  assert.equal(last.jobs.length, 1);
  assert.equal(last.nextPageToken, undefined);
  assert.equal(
    new Set([...first.jobs, ...last.jobs].map(({ id }) => id)).size,
    3,
  );
  const empty = await call(client, "text_list", {
    contextId: "different-conversation",
  });
  assert.equal(empty.totalSize, 0);
  assert.deepEqual(empty.jobs, []);
});

test("running cancellation remains unconfirmed through the public MCP result", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const job = await call(client, "text_submit", f.input());
  await f.h.claim(f.worker, {}, { textRetentionMs: 200000 });
  const reply = await call(client, "text_cancel", { id: job.id });
  assert.equal(reply.state, "working");
  assert.equal(reply.outcome, "unknown");
  assert.equal(reply.cancellationRequested, true);
  assert.equal(reply.cancellationConfirmed, false);
  assert.equal(reply.waitReason, "cancellation_confirmation");
  assert.equal(reply.result, undefined);
});

test("public MCP input rejects NUL text before creating a task", async (t) => {
  const f = await fixture(t);
  const response = await f.raw(
    rpc("tools/call", {
      name: "text_submit",
      arguments: f.input("nul-input", "before\u0000after"),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await f.h.listText(f.sender)).totalSize, 0);
});
