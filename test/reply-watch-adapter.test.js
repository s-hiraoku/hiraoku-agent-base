import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { ReplyWatchAdapter } from "../src/reply-watch/adapter.ts";
import { ReplyWatchClient } from "../src/reply-watch/client.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";
import { AuthenticationRecoveryError } from "../src/agent-sdk/authentication-recovery.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { createMcpNodeHandler } from "../src/host/mcp/http-node.ts";
import { fixture } from "./hab-registry-fixtures.js";
import { limits, policy, request, decode } from "./mcp-http-fixtures.js";
import { main } from "../scripts/hab-reply-watch.ts";
const start = Date.parse("2026-01-01T00:00:00.000Z");
const sent = {
  message_id: "original-1",
  accepted_at: new Date(start).toISOString(),
  expires_at: new Date(start + 3600_000).toISOString(),
};
const scope = {
  resource_url: "https://hab.example/mcp",
  connection_id: "owner-a",
  agent_id: "a",
  session_id: "session-a",
  as_address: "a@grok-bot.hab",
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-reply-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = start,
    calls = 0;
  const transport = {
    send: async () => sent,
    status: async () => {
      calls++;
      return { ...sent, reply_state: "waiting", replies: [] };
    },
  };
  const path = join(dir, "watches.sqlite");
  const open = (patch = {}) => {
    const watcher = new ReplyWatchAdapter(
      path,
      { ...scope, ...patch },
      transport,
      () => now,
    );
    t.after(() => watcher.close());
    return watcher;
  };
  return {
    dir,
    path,
    open,
    transport,
    setNow: (n) => {
      now = n;
    },
    calls: () => calls,
  };
}
test("successful question sends persist; duplicates, notices and lost sends never resend", async (t) => {
  const f = setup(t),
    w = f.open();
  assert.equal(
    (await w.send({ to: "b@agent.hab", text: "question" })).monitoring,
    "saved",
  );
  assert.equal(w.nextDelay(), 15000);
  w.watch({ ...sent, expires_at: new Date(start + 7200_000).toISOString() });
  assert.equal(w.records().length, 1);
  assert.equal(w.records()[0].expires_at, sent.expires_at);
  await w.send({ to: "b@agent.hab", text: "notice", kind: "notice" });
  f.transport.send = async () => {
    throw new MessagingError("transport_failed");
  };
  await assert.rejects(w.send({ to: "b@agent.hab", text: "lost" }));
  w.cancel(sent.message_id);
  w.watch(sent);
  assert.equal(w.records()[0].state, "stopped");
  assert.equal(w.nextDelay(), 60000);
});
test("due checks survive reopen, back off by age and return to normal on reply without reading it", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  const reopened = f.open();
  await reopened.checkDue();
  assert.equal(f.calls(), 0);
  f.setNow(start + 15000);
  await reopened.checkDue();
  assert.equal(w.records()[0].next_at, start + 30000);
  f.setNow(start + 120000);
  await w.checkDue();
  assert.equal(w.nextDelay(), 60000);
  f.setNow(start + 600000);
  await w.checkDue();
  assert.equal(w.records()[0].next_at, start + 900000);
  f.transport.status = async () => ({
    ...sent,
    reply_state: "replied",
    replies: [{ message_id: "answer-1" }],
  });
  f.setNow(start + 900000);
  await w.checkDue();
  assert.equal(w.records()[0].state, "replied");
  assert.deepEqual(JSON.parse(w.records()[0].reply_ids), ["answer-1"]);
  assert.equal(w.nextDelay(), 60000);
  await w.checkDue();
});
test("connection, agent, session, address and resource changes cannot claim another watch", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  f.setNow(start + 15000);
  for (const patch of [
    { connection_id: "other" },
    { agent_id: "b" },
    { session_id: "other" },
    { resource_url: "https://other.example/mcp" },
    { as_address: "other@agent.hab" },
  ]) {
    const other = f.open(patch);
    assert.deepEqual(other.records(), []);
    await other.checkDue();
    other.cancel(sent.message_id);
  }
  assert.equal(f.calls(), 0);
  await w.checkDue();
  assert.equal(f.calls(), 1);
});
test("two SQLite owners suppress overlapping checks and cancellation fences an in-flight result", async (t) => {
  const f = setup(t),
    w = f.open(),
    other = f.open();
  w.watch(sent);
  f.setNow(start + 15000);
  let finish, entered;
  const began = new Promise((r) => {
    entered = r;
  });
  f.transport.status = () => {
    entered();
    return new Promise((r) => {
      finish = r;
    });
  };
  const running = w.checkDue();
  await began;
  await other.checkDue();
  assert.ok(other.records()[0].claim);
  other.cancel(sent.message_id);
  finish({
    ...sent,
    reply_state: "replied",
    replies: [{ message_id: "late" }],
  });
  await running;
  assert.equal(w.records()[0].state, "stopped");
  assert.equal(w.records()[0].reply_ids, "[]");
});
test("original stop time bounds network backoff, deadlines and idle recovery", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch({ ...sent, expires_at: new Date(start + 100000).toISOString() });
  f.transport.status = async () => {
    throw new MessagingError("transport_failed");
  };
  f.setNow(start + 15000);
  await w.checkDue();
  assert.equal(w.records()[0].next_at, start + 45000);
  f.setNow(start + 45000);
  await w.checkDue();
  assert.equal(w.records()[0].state, "stopped");
  assert.equal(w.nextDelay(), 60000);
  const f2 = setup(t),
    w2 = f2.open();
  w2.watch(sent);
  f2.setNow(start + 1800000);
  await w2.checkDue();
  assert.equal(f2.calls(), 0);
  assert.equal(w2.records()[0].state, "stopped");
});
for (const code of [
  "forbidden",
  "token_expired",
  "token_unavailable",
  "reauthentication_required",
])
  test(`authentication ${code} stops without repeated checks`, async (t) => {
    const f = setup(t),
      w = f.open();
    w.watch(sent);
    f.setNow(start + 15000);
    let calls = 0;
    f.transport.status = async () => {
      calls++;
      throw code === "reauthentication_required"
        ? new AuthenticationRecoveryError(code)
        : new MessagingError(code);
    };
    await w.checkDue();
    await w.checkDue();
    assert.equal(calls, 1);
    assert.equal(w.records()[0].state, "auth_required");
  });
test("mismatched original times and permanent refusal fail closed", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  f.setNow(start + 15000);
  f.transport.status = async () => ({
    ...sent,
    expires_at: new Date(start + 7200000).toISOString(),
    reply_state: "waiting",
    replies: [],
  });
  await w.checkDue();
  assert.equal(w.records()[0].failures, 1);
  assert.equal(w.records()[0].expires_at, sent.expires_at);
  f.setNow(start + 45000);
  f.transport.status = async () => {
    throw new MessagingError("not_found");
  };
  await w.checkDue();
  assert.equal(w.records()[0].state, "stopped");
});
test("real owned HTTP/SQLite agent path sends, checks original reply and leaves sender inbox unread", async (t) => {
  const f = await fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  const calls = [];
  let handle;
  const server = createServer((req, res) => {
    calls.push([req.headers.authorization, req.headers["mcp-name"]]);
    void handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  handle = createMcpNodeHandler(
    new HabHttpGateway(
      f.hab,
      { ...policy, resource_url: url },
      { record() {}, note() {} },
      f.verifier,
      undefined,
      "agent",
    ),
  );
  const options = (agent, token) => ({
    policy: {
      resource_url: url,
      agent_id: agent.agent_id,
      max_request_bytes: 65536,
      max_response_bytes: 131072,
      timeout_ms: 2000,
      max_active_requests: 1,
      max_sse_events: 16,
      max_sse_lines: 128,
      max_json_depth: 32,
      max_json_nodes: 10000,
    },
    limits,
    authorization: () => `Bearer fixture-${token}`,
    as_address: agent.address,
  });
  let now = Date.now();
  const w = new ReplyWatchAdapter(
    join(f.dir, "watch.sqlite"),
    { ...scope, resource_url: url, agent_id: a.agent_id },
    new ReplyWatchClient(options(a, "a")),
    () => now,
  );
  t.after(() => w.close());
  const result = await w.send({
    to: b.address,
    text: "Synthetic reply requested",
  });
  assert.equal(result.monitoring, "saved");
  async function callAsB(name, args) {
    const response = await globalThis.fetch(
      request(
        "tools/call",
        { name, arguments: args },
        { url, headers: { Authorization: "Bearer fixture-b" } },
      ),
    );
    const result = (await decode(response)).result;
    assert.notEqual(result.isError, true);
    return result.structuredContent;
  }
  await callAsB("hab_inbox", {});
  const answer = await callAsB("hab_reply", {
    message_id: result.message_id,
    text: "Synthetic answer",
  });
  now = w.records()[0].next_at;
  await w.checkDue();
  assert.equal(w.records()[0].state, "replied");
  assert.deepEqual(JSON.parse(w.records()[0].reply_ids), [answer.message_id]);
  assert.deepEqual(
    calls
      .filter(([auth]) => auth === "Bearer fixture-a")
      .map(([, name]) => name),
    ["hab_send", "hab_status"],
  );
  const status = await new ReplyWatchClient(options(a, "a")).status(
    result.message_id,
  );
  assert.equal(status.replies[0].read, false);
});
test("shipped CLI send automatically saves a watch and local list/cancel make no network calls", async (t) => {
  const f = setup(t),
    config = join(f.dir, "config.json"),
    output = [];
  const key = "HAB_REPLY_WATCH_SYNTHETIC_TOKEN";
  process.env[key] = "synthetic";
  t.after(() => delete process.env[key]);
  writeFileSync(
    config,
    JSON.stringify({ ...scope, store: f.path, token: { env: key } }),
  );
  let calls = 0;
  const rpc = async (_url, init) => {
    calls++;
    const req = JSON.parse(init.body);
    assert.equal(req.params.name, "hab_send");
    const value = {
      ...sent,
      accepted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const run = (cmd, input, extra = []) =>
    main(
      ["--config", config, cmd, ...extra],
      (line) => output.push(JSON.parse(line)),
      () => JSON.stringify(input),
      rpc,
    );
  assert.equal(await run("send", { to: "b@agent.hab", text: "synthetic" }), 0);
  assert.equal(output.at(-1).monitoring, "saved");
  await run("list");
  assert.equal(output.at(-1)[0].message_id, sent.message_id);
  await run("cancel", undefined, [sent.message_id]);
  await run("check");
  assert.equal(output.at(-1)[0].state, "stopped");
  assert.equal(calls, 1);
});

test(
  "resident CLI run consumes a saved watch on its timer and idles after reply",
  { timeout: 30000 },
  async (t) => {
    const f = setup(t),
      config = join(f.dir, "resident.json"),
      output = [];
    const key = "HAB_REPLY_WATCH_RESIDENT_SYNTHETIC";
    process.env[key] = "synthetic";
    t.after(() => delete process.env[key]);
    writeFileSync(
      config,
      JSON.stringify({
        ...scope,
        store: f.path,
        token: { env: key },
        normal_interval_ms: 1000,
      }),
    );
    const at = Date.now();
    const value = {
      ...sent,
      accepted_at: new Date(at).toISOString(),
      expires_at: new Date(at + 3600000).toISOString(),
    };
    let checks = 0,
      finish;
    const checked = new Promise((r) => {
      finish = r;
    });
    const rpc = async (_url, init) => {
      const req = JSON.parse(init.body);
      assert.equal(req.params.name, "hab_status");
      assert.equal(req.params.arguments.message_id, sent.message_id);
      assert.equal(req.params.arguments.expected_agent_id, scope.agent_id);
      checks++;
      finish();
      const data = {
        ...value,
        reply_state: "replied",
        replies: [{ message_id: "answer-resident" }],
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    // Reopened schedule, due after a real short wait; only the scheduler clock is substituted.
    const seed = new ReplyWatchAdapter(
      f.path,
      scope,
      f.transport,
      () => at - 14900,
    );
    seed.watch(value);
    seed.close();
    const running = main(
      ["--config", config, "run"],
      (s) => output.push(s),
      () => "",
      rpc,
    );
    try {
      await checked;
      await new Promise((r) => setTimeout(r, 1250));
      assert.equal(checks, 1);
      const records = f.open().records();
      assert.equal(records[0].state, "replied");
      assert.deepEqual(JSON.parse(records[0].reply_ids), ["answer-resident"]);
    } finally {
      process.emit("SIGTERM");
      assert.equal(await running, 0);
    }
    assert.deepEqual(output, []);
  },
);

test("abandoned bounded request claims recover after lease without moving the original stop time", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(f.path);
  raw
    .prepare("UPDATE reply_watches SET claim='abandoned', lease_until=?")
    .run(start + 75000);
  raw.close();
  f.setNow(start + 15000);
  await w.checkDue();
  assert.equal(f.calls(), 0);
  f.setNow(start + 75000);
  await w.checkDue();
  assert.equal(f.calls(), 1);
  assert.equal(w.records()[0].stop_at, start + 1800000);
  assert.equal(w.records()[0].claim, null);
});

for (const status of [401, 403])
  test(`HTTP ${status} stops the actual client path`, async (t) => {
    const f = setup(t);
    let calls = 0;
    const options = {
      policy: {
        resource_url: scope.resource_url,
        agent_id: scope.agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2000,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 32,
        max_json_nodes: 10000,
      },
      limits,
      as_address: scope.as_address,
      authorization: () => "Bearer synthetic",
      fetch: async () => {
        calls++;
        return new Response(null, { status });
      },
    };
    const w = new ReplyWatchAdapter(
      join(f.dir, "http-auth.sqlite"),
      scope,
      new ReplyWatchClient(options),
      () => start + 15000,
    );
    t.after(() => w.close());
    const seed = new ReplyWatchAdapter(
      join(f.dir, "http-auth.sqlite"),
      scope,
      f.transport,
      () => start,
    );
    seed.watch(sent);
    seed.close();
    await w.checkDue();
    await w.checkDue();
    assert.equal(calls, 1);
    assert.equal(w.records()[0].state, "auth_required");
  });

test("local watch-save failure preserves accepted ID and never repeats the send", async (t) => {
  const f = setup(t),
    w = f.open();
  let sends = 0;
  f.transport.send = async () => {
    sends++;
    return sent;
  };
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(f.path);
  raw.exec(
    "CREATE TRIGGER fail_watch_save BEFORE INSERT ON reply_watches BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
  );
  raw.close();
  const result = await w.send({ to: "b@agent.hab", text: "synthetic" });
  assert.equal(result.message_id, sent.message_id);
  assert.equal(result.monitoring, "save_failed");
  assert.equal(sends, 1);
  assert.deepEqual(w.records(), []);
});

test("transient failures cap backoff and successful status resets it within the original bound", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  f.transport.status = async () => {
    throw new MessagingError("transport_failed");
  };
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const at = w.records()[0].next_at;
    f.setNow(at);
    await w.checkDue();
    assert.equal(w.records()[0].next_at - at, delay);
    assert.equal(w.records()[0].stop_at, start + 1800000);
  }
  f.transport.status = async () => ({
    ...sent,
    reply_state: "waiting",
    replies: [],
  });
  f.setNow(w.records()[0].next_at);
  await w.checkDue();
  assert.equal(w.records()[0].failures, 0);
  assert.equal(w.records()[0].state, "waiting");
});

test("shutdown finishes the current check and never claims the remaining batch", async (t) => {
  const f = setup(t),
    w = f.open();
  w.watch(sent);
  w.watch({ ...sent, message_id: "original-2" });
  f.setNow(start + 15000);
  const controller = new AbortController();
  let finish,
    entered,
    calls = 0;
  const began = new Promise((r) => {
    entered = r;
  });
  f.transport.status = async (messageId) => {
    calls++;
    entered();
    await new Promise((r) => {
      finish = r;
    });
    return {
      ...sent,
      message_id: messageId,
      reply_state: "waiting",
      replies: [],
    };
  };
  const running = w.checkDue(controller.signal);
  await began;
  controller.abort();
  finish();
  await running;
  assert.equal(calls, 1);
  assert.equal(
    w.records().find((r) => r.message_id === "original-2").lease_until,
    0,
  );
  await w.checkDue(controller.signal);
  assert.equal(calls, 1);
});
