import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createRelayMcpServer } from "../src/relay/mcp.ts";
import { RelayService, makeReplayBoundMessageId } from "../src/relay/index.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  attachment_bytes: 1000,
  total_attachment_bytes: 1000,
  parts: 8,
  attachments: 3,
  json_depth: 20,
  json_nodes: 1000,
};
function message(at = Date.now() - 100, entropy = "1".repeat(32)) {
  const first = new Date(at).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(first, entropy),
    recipient_id: "b",
    kind: "question",
    body: {
      parts: [
        { type: "text", text: "synthetic private payload" },
        {
          type: "data",
          schema_id: "demo",
          schema_version: 1,
          value: { n: 1, ok: true },
        },
      ],
    },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-mcp-")),
    path = join(dir, "relay.sqlite");
  const store = new SQLiteRelayStore(path, {
    fingerprint_key: new Uint8Array(32).fill(42),
    max_pending: 10,
    max_records: 100,
    max_pending_per_recipient: 5,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 10,
    retry_cap_ms: 100,
    poll_scan_limit: 10,
  });
  store.migrate();
  const raw = new DatabaseSync(path),
    identities = new Map(),
    active = new Set(["a", "b", "c"]),
    denied = new Set();
  const contexts = {};
  for (const name of active) {
    const context = Symbol(`verified-${name}`);
    contexts[name] = context;
    identities.set(context, name);
  }
  const policy = {
    authorize(context, op) {
      const name = identities.get(context);
      return active.has(name) && !denied.has(op)
        ? { agent_id: name }
        : undefined;
    },
  };
  const service = new RelayService(store, limits, policy),
    handlers = [];
  t.after(async () => {
    for (const h of handlers) await h.close();
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const endpoint = (resolve, selectedService = service) => {
    const handler = createMcpHandler(() =>
      createRelayMcpServer(selectedService, resolve),
    );
    handlers.push(handler);
    return handler;
  };
  const a = endpoint(() => contexts.a),
    b = endpoint(() => contexts.b),
    c = endpoint(() => contexts.c);
  return {
    dir,
    store,
    raw,
    service,
    contexts,
    active,
    denied,
    endpoint,
    a,
    b,
    c,
  };
}
async function rpc(endpoint, method, params = {}, modern = true) {
  const headers = {
    "Content-Type": "application/json",
    Accept: modern ? "application/json" : "application/json, text/event-stream",
  };
  if (modern) {
    headers["MCP-Protocol-Version"] = "2026-07-28";
    headers["Mcp-Method"] = method;
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }
  const response = await endpoint.fetch(
    new Request("https://fixture.example/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  if (response.headers.get("content-type").startsWith("application/json"))
    return JSON.parse(text);
  const frames = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(frames.length, 1); // Test-only decoding of the SDK's single-result SSE fixture.
  return frames[0];
}
async function call(endpoint, name, args = {}, modern = true) {
  const body = await rpc(
    endpoint,
    "tools/call",
    { name, arguments: args },
    modern,
  );
  if (body.error) return { rejected: body.error };
  const result = body.result;
  if (result.structuredContent === undefined) {
    assert.equal(result.isError, true);
    return { rejected: result };
  }
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  return result;
}
function request(d) {
  return {
    sender_id: d.message.sender_id,
    message_id: d.message.message_id,
    generation: d.generation,
    lease_token: d.lease_token,
    request_id: randomUUID(),
  };
}
function count(f) {
  return f.raw.prepare("SELECT count(*) n FROM relay_messages").get().n;
}

test("standalone SDK catalog exposes exactly four delivery tools and no local admin, Task, shell or registration tools", async (t) => {
  const f = fixture(t),
    body = await rpc(f.a, "tools/list");
  assert.deepEqual(body.result.tools.map((x) => x.name).sort(), [
    "relay_ack",
    "relay_poll",
    "relay_status",
    "relay_submit",
  ]);
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, tool.name !== "relay_poll");
  }
  const schemas = Object.fromEntries(
    body.result.tools.map((x) => [x.name, x.inputSchema]),
  );
  assert.equal(
    Object.hasOwn(schemas.relay_submit.properties, "sender_id"),
    false,
  );
  assert.deepEqual(schemas.relay_poll.properties, {});
});

test("missing, throwing, unverified and policy-less auth fail closed even for an otherwise valid call", async (t) => {
  const f = fixture(t),
    unbound = new RelayService(f.store, limits);
  for (const e of [
    f.endpoint(),
    f.endpoint(() => {
      throw Error("private verifier detail");
    }),
    f.endpoint(() => "a"),
    f.endpoint(() => f.contexts.a, unbound),
  ]) {
    const result = await call(e, "relay_submit", message());
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: "forbidden" });
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  assert.equal(count(f), 0);
  for (const [name, args] of [
    ["relay_poll", {}],
    ["relay_status", { message_id: "unknown" }],
    [
      "relay_ack",
      request({
        message: { sender_id: "a", message_id: "unknown" },
        generation: 1,
        lease_token: "x".repeat(43),
      }),
    ],
  ]) {
    assert.deepEqual((await call(f.endpoint(), name, args)).structuredContent, {
      error: "forbidden",
    });
  }
});

test("SDK request/response path submits multipart data, durably receives before ACK and recovers exact ACK retries", async (t) => {
  const f = fixture(t),
    m = message(),
    accepted = await call(f.a, "relay_submit", m);
  assert.equal(accepted.structuredContent.sender_id, "a");
  assert.deepEqual(
    (await call(f.a, "relay_submit", m)).structuredContent,
    accepted.structuredContent,
  );
  const d = (await call(f.b, "relay_poll")).structuredContent.delivery;
  assert.deepEqual(d.message.body, m.body);
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
  const req = inbox.claimAck(),
    r = await call(f.b, "relay_ack", req);
  assert.equal(r.structuredContent.state, "acked");
  assert.deepEqual(
    (await call(f.b, "relay_ack", req)).structuredContent,
    r.structuredContent,
  );
  inbox.confirmAck(req, r.structuredContent);
  assert.equal(inbox.inbox()[0].receipt_confirmed, true);
  assert.equal(
    (await call(f.a, "relay_status", { message_id: m.message_id }))
      .structuredContent.state,
    "acked",
  );
  assert.equal(
    f.raw.prepare("SELECT body FROM relay_messages").get().body,
    null,
  );
  assert.equal(inbox.releaseBody("a", m.message_id), true);
  assert.equal(inbox.inbox().length, 0);
  assert.deepEqual((await call(f.b, "relay_poll")).structuredContent, {
    delivery: null,
  });
});

test("tool arguments cannot impersonate a sender or select a foreign mailbox and receipt ownership remains scoped", async (t) => {
  const f = fixture(t),
    m = message();
  for (const extra of [
    { sender_id: "c" },
    { agent_name: "grok-bot" },
    { agent_id: "c" },
  ])
    assert.ok((await call(f.a, "relay_submit", { ...m, ...extra })).rejected);
  assert.equal(count(f), 0);
  await call(f.a, "relay_submit", m);
  assert.ok((await call(f.c, "relay_poll", { recipient_id: "b" })).rejected);
  assert.deepEqual((await call(f.c, "relay_poll")).structuredContent, {
    delivery: null,
  });
  assert.deepEqual(
    (await call(f.c, "relay_status", { message_id: m.message_id }))
      .structuredContent,
    { error: "not_found" },
  );
  assert.equal(
    (await call(f.b, "relay_poll")).structuredContent.delivery.message
      .recipient_id,
    "b",
  );
});

test("each tool resolves current connection context and rechecks policy so revocation also blocks dedup retries", async (t) => {
  const f = fixture(t),
    m = message();
  let resolutions = 0;
  const a = f.endpoint(() => {
    resolutions++;
    return f.contexts.a;
  });
  await call(a, "relay_submit", m);
  f.active.delete("a");
  for (const [name, args] of [
    ["relay_submit", m],
    ["relay_status", { message_id: m.message_id }],
    ["relay_poll", {}],
  ])
    assert.deepEqual((await call(a, name, args)).structuredContent, {
      error: "forbidden",
    });
  assert.equal(resolutions, 4);
  assert.equal(count(f), 1);
});

test("operation-specific refusal remains enforced independently of a valid subject", async (t) => {
  const f = fixture(t),
    m = message();
  await call(f.a, "relay_submit", m);
  f.denied.add("poll");
  assert.deepEqual((await call(f.b, "relay_poll")).structuredContent, {
    error: "forbidden",
  });
  f.denied.delete("poll");
  const d = (await call(f.b, "relay_poll")).structuredContent.delivery;
  f.denied.add("ack");
  assert.deepEqual(
    (await call(f.b, "relay_ack", request(d))).structuredContent,
    { error: "forbidden" },
  );
  assert.equal(
    f.raw.prepare("SELECT state FROM relay_messages").get().state,
    "leased",
  );
});

test("concurrent SDK polls for the same individual grant exactly one active lease", async (t) => {
  const f = fixture(t);
  await call(f.a, "relay_submit", message());
  const other = f.endpoint(() => f.contexts.b);
  const results = await Promise.all([
    call(f.b, "relay_poll"),
    call(other, "relay_poll"),
  ]);
  assert.equal(
    results.filter((r) => r.structuredContent.delivery !== null).length,
    1,
  );
  assert.equal(
    f.raw
      .prepare("SELECT count(*) n FROM relay_deliveries WHERE state='leased'")
      .get().n,
    1,
  );
});

test("stale ACKs cannot consume new leases and exact committed ACK retry survives expiry", async (t) => {
  const f = fixture(t),
    m = message();
  await call(f.a, "relay_submit", m);
  const first = (await call(f.b, "relay_poll")).structuredContent.delivery,
    old = request(first);
  f.raw.exec("UPDATE relay_deliveries SET lease_until=0,next_visible_at=0");
  const second = (await call(f.b, "relay_poll")).structuredContent.delivery;
  assert.ok(second.generation > first.generation);
  assert.deepEqual((await call(f.b, "relay_ack", old)).structuredContent, {
    error: "invalid_ack",
  });
  const req = request(second),
    r = (await call(f.b, "relay_ack", req)).structuredContent;
  f.raw.exec("UPDATE relay_messages SET expires_at=0");
  assert.deepEqual((await call(f.b, "relay_ack", req)).structuredContent, r);
  assert.deepEqual(
    (await call(f.b, "relay_ack", { ...req, generation: req.generation + 1 }))
      .structuredContent,
    { error: "ack_idempotency_conflict" },
  );
});

test("core body and expiry limits reject invalid payloads with fixed errors and no committed messages", async (t) => {
  const f = fixture(t),
    oversized = message();
  oversized.body.parts[0].text = "private".repeat(3000);
  const huge = await call(f.a, "relay_submit", oversized);
  assert.deepEqual(huge.structuredContent, { error: "capacity_exceeded" });
  assert.equal(JSON.stringify(huge).includes("private"), false);
  assert.deepEqual(
    (await call(f.a, "relay_submit", message(Date.now() - 2 * 3600000)))
      .structuredContent,
    { error: "expired_before_acceptance" },
  );
  const invalid = message();
  invalid.expires_at = invalid.first_sent_at;
  assert.deepEqual(
    (await call(f.a, "relay_submit", invalid)).structuredContent,
    { error: "invalid_contract" },
  );
  assert.equal(count(f), 0);
});

test("managed attachments still fail closed instead of accepting an unverified manifest", async (t) => {
  const f = fixture(t),
    m = message();
  m.body.parts.push({
    type: "attachment",
    attachment_id: "file-1",
    media_type: "text/plain",
    size_bytes: 10,
    sha256: "a".repeat(64),
  });
  assert.deepEqual((await call(f.a, "relay_submit", m)).structuredContent, {
    error: "attachment_store_unavailable",
  });
  assert.equal(count(f), 0);
});

test("unexpected storage details are normalized and transaction failure cannot return acceptance", async (t) => {
  const f = fixture(t);
  f.raw.exec(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON relay_messages BEGIN SELECT RAISE(ABORT,'synthetic private storage detail'); END",
  );
  const r = await call(f.a, "relay_submit", message());
  assert.deepEqual(r.structuredContent, { error: "relay_operation_failed" });
  assert.equal(JSON.stringify(r).includes("private"), false);
  assert.equal(count(f), 0);
});

test("unknown/local-administration tools never reach Relay maintenance or execute a task", async (t) => {
  const f = fixture(t);
  for (const name of [
    "relay_maintain",
    "releaseBody",
    "submit",
    "claim",
    "complete",
    "shell",
    "register_agent",
  ])
    assert.ok((await call(f.a, name, {})).rejected);
  assert.equal(count(f), 0);
  assert.equal(
    f.raw.prepare("SELECT last_at FROM relay_maintenance_totals").get().last_at,
    0,
  );
});

test("legacy JSON-RPC/SSE clients use the same isolated four-tool contract", async (t) => {
  const f = fixture(t),
    m = message();
  assert.equal(
    (await rpc(f.a, "tools/list", {}, false)).result.tools.length,
    4,
  );
  assert.equal(
    (await call(f.a, "relay_submit", m, false)).structuredContent.sender_id,
    "a",
  );
  const d = (await call(f.b, "relay_poll", {}, false)).structuredContent
    .delivery;
  assert.equal(
    (await call(f.b, "relay_ack", request(d), false)).structuredContent.state,
    "acked",
  );
  assert.equal(
    (await call(f.a, "relay_status", { message_id: m.message_id }, false))
      .structuredContent.state,
    "acked",
  );
});
