import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HabNotifierClient, SQLiteNotices } from "../src/agent-notify/index.ts";
import { bindingIdentity } from "../src/agent-notify/binding.ts";
import { main, tokenProblem } from "../scripts/hab-notify.ts";

test("hab-notify prints usage, lists no notices and refuses a decision it never showed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
    }),
  );
  const lines = [];
  const out = (line) => lines.push(line);
  assert.equal(await main([], out), 2);
  assert.match(lines.at(-1), /^usage:/);
  assert.equal(await main(["--config", config, "list"], out), 0);
  assert.equal(lines.at(-1), "[]");
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "maybe"], out),
    2,
  );
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "accept"], out),
    1,
  );
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "invalid_request" });
  // No token configured: the check fails without printing anything secret.
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_unavailable" });
  assert.equal(lines.at(-1).includes("Bearer"), false);
});

test("hab-notify names an expired or missing file token instead of a transport failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "hab.json");
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      // Nothing listens here: a call that went out would end as transport_failed.
      hab_url: "http://127.0.0.1:9/mcp",
      agent_id: "agent-b",
      token: {
        file: tokenFile,
        field: "access_token",
        expires_at_field: "expires_at",
      },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
    }),
  );
  const lines = [];
  const out = (line) => lines.push(line);
  const now = Date.now() / 1000;
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: "synthetic-expired", expires_at: now - 1 }),
  );
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_expired" });
  // A choice for a notice never shown is still refused for that reason, before any call.
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "accept"], out),
    1,
  );
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "invalid_request" });
  assert.equal(lines.join("\n").includes("synthetic-expired"), false);
  writeFileSync(tokenFile, JSON.stringify({ expires_at: now + 600 }));
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_unavailable" });
  // A current token is sent, so an unreachable host is still a transport failure.
  writeFileSync(
    tokenFile,
    JSON.stringify({
      access_token: "synthetic-current",
      expires_at: now + 600,
    }),
  );
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "transport_failed" });
});

const jwt = (payload) =>
  [
    "e30",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

test("an expired or missing token is named, and HAB is not called", async (t) => {
  const config = {
    token: { env: "HAB_NOTIFY_TEST_TOKEN_EXP" },
  };
  t.after(() => delete process.env.HAB_NOTIFY_TEST_TOKEN_EXP);
  const now = Date.parse("2026-11-14T13:00:00Z");
  assert.equal(tokenProblem(config, now), "token_unavailable");
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 - 1 });
  assert.equal(tokenProblem(config, now), "token_expired");
  // Expiring within the 5 s margin counts as expired.
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 + 3 });
  assert.equal(tokenProblem(config, now), "token_expired");
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 + 600 });
  assert.equal(tokenProblem(config, now), undefined);
  // An opaque token, or a JWT without exp, is left to HAB to judge.
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = "opaque-token";
  assert.equal(tokenProblem(config, now), undefined);
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ sub: "agent-b" });
  assert.equal(tokenProblem(config, now), undefined);

  let fetched = 0;
  const hab = new HabNotifierClient(
    {
      policy: {
        resource_url: "https://hab.example/mcp/delivery",
        agent_id: "agent-b",
        max_request_bytes: 65536,
        max_response_bytes: 65536,
        timeout_ms: 1000,
        max_active_requests: 1,
        max_sse_events: 4,
        max_sse_lines: 64,
        max_json_depth: 16,
        max_json_nodes: 1000,
      },
      limits: {
        envelope_bytes: 65536,
        text_bytes: 32768,
        data_bytes: 32768,
        parts: 4,
        json_depth: 16,
        json_nodes: 1000,
      },
      authorization: () => "Bearer x",
      fetch: async () => {
        fetched++;
        return new Response(null, { status: 401 });
      },
    },
    () => "token_expired",
  );
  await assert.rejects(hab.peek(10), { code: "token_expired" });
  await assert.rejects(hab.markRead("rm1.x", "agent-a"), {
    code: "token_expired",
  });
  assert.equal(fetched, 0);
});

test("run logs a repeating error once, not on every check", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-run-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAB_NOTIFY_TEST_TOKEN_RUN;
  });
  process.env.HAB_NOTIFY_TEST_TOKEN_RUN = jwt({ exp: 1 });
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN_RUN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
      interval_ms: 1000,
    }),
  );
  const lines = [];
  const running = main(["--config", config, "run"], (line) => lines.push(line));
  await new Promise((done) => setTimeout(done, 2500));
  process.emit("SIGTERM");
  assert.equal(await running, 0);
  assert.equal(lines.length, 1);
  const failure = JSON.parse(lines[0]);
  assert.equal(failure.error, "token_expired");
  assert.equal(new Date(failure.at).toISOString(), failure.at);
  assert.ok(Date.parse(failure.at) <= Date.now());
  assert.deepEqual(Object.keys(failure).sort(), ["at", "error"]);
});

test("generic states API is cursor independent and fenced by connection, recipient and session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-adapter-states-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notify.json");
  const config = {
    hab_url: "https://hab.example/mcp",
    agent_id: "agent-b",
    token: { env: "MISSING_SYNTHETIC_TOKEN" },
    store: join(dir, "state.sqlite"),
    screen: {
      type: "jsonl",
      path: join(dir, "screen.jsonl"),
      target: "future-product:session",
    },
  };
  writeFileSync(path, JSON.stringify(config));
  const output = [];
  const run = (cmd, request) =>
    main(
      ["--config", path, cmd],
      (s) => output.push(JSON.parse(s)),
      () => JSON.stringify(request),
    );
  assert.equal(await run("binding"), 0);
  const binding = output.at(-1).binding_id;
  assert.equal(bindingIdentity(output.at(-1).destination_binding), binding);
  assert.equal(await run("states", { binding_id: binding }), 0);
  assert.deepEqual(output.at(-1), { binding_id: binding, states: [] });
  assert.equal(await run("states", { binding_id: "another-session" }), 1);
  assert.equal(output.at(-1).error, "binding_mismatch");
  const store = new SQLiteNotices(config.store, binding);
  const message = {
    sender_id: "sender",
    message_id: "m-action",
    from: "sender@example.hab",
    kind: "question",
    thread_id: "thread",
    in_reply_to: null,
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    display: "Synthetic notice",
    handoff_prompt: "Synthetic prompt",
  };
  store.insertShowing(message, Date.now());
  store.transition(message, ["showing"], "shown", Date.now());
  store.close();
  assert.equal(
    await run("adapter-action", {
      binding_id: binding,
      sender_id: "sender",
      message_id: "m-action",
      choice: "later",
    }),
    0,
  );
  const acted = output.at(-1);
  assert.equal(acted.changed, true);
  assert.equal(acted.state, "later");
  assert.equal(acted.binding_id, binding);
  assert.equal(acted.scope, "requested");
  assert.deepEqual(acted.keys, [
    { sender_id: "sender", message_id: "m-action" },
  ]);
  assert.ok(acted.states[0].revision > 0);
  assert.equal(await run("states", { binding_id: binding }), 0);
  assert.deepEqual(
    output
      .at(-1)
      .states.map(({ sender_id, message_id, state, revision }) => ({
        sender_id,
        message_id,
        state,
        revision,
      })),
    acted.states,
  );
  assert.deepEqual(
    output.at(-1).states[0].choices.map((x) => x.choice),
    ["accept", "later", "decline"],
  );
  assert.equal("choices" in acted.states[0], false);
  // No token or network is needed. Reusing a decision store after recipient replacement is refused.
  config.agent_id = "different-recipient";
  writeFileSync(path, JSON.stringify(config));
  assert.equal(await run("binding"), 0);
  const next = output.at(-1).binding_id;
  assert.notEqual(next, binding);
  assert.equal(await run("states", { binding_id: next }), 1);
  assert.equal(output.at(-1).error, "notices_target_mismatch");
});

test("requested state keys stay bounded and scoped with 3000 retained records", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-bounded-states-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notify.json");
  const config = {
    hab_url: "https://hab.invalid/mcp",
    agent_id: "recipient",
    token: { env: "UNSET_SYNTHETIC_TOKEN" },
    store: join(dir, "notices.sqlite"),
    screen: {
      type: "hermes-desktop",
      path: join(dir, "screen.jsonl"),
      session_id: "session",
      profile: "profile",
      backend_namespace: "namespace",
      profile_scope: "scope",
    },
  };
  writeFileSync(path, JSON.stringify(config));
  const output = [];
  const run = (command, request) =>
    main(
      ["--config", path, command],
      (s) => output.push(s),
      () => JSON.stringify(request),
    );
  await run("binding");
  const binding_id = JSON.parse(output.at(-1)).binding_id;
  const base = {
    binding_id,
    action: "states",
    backend_namespace: "namespace",
    profile_scope: "scope",
    receiver_id: "recipient",
    stored_session_id: "session",
  };
  const template = {
    sender_id: "sender".repeat(6),
    from: null,
    kind: "question",
    thread_id: "t",
    in_reply_to: null,
    sent_at: "2026-01-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    display: "private body",
    handoff_prompt: "private prompt",
  };
  const store = new SQLiteNotices(config.store, binding_id);
  const keys = [];
  for (let i = 0; i < 3000; i++) {
    const message = { ...template, message_id: String(i).padStart(40, "0") };
    store.insertShowing(message, i);
    store.transition(message, ["showing"], "later", i);
    keys.push({ sender_id: message.sender_id, message_id: message.message_id });
  }
  const huge = {
    ...template,
    message_id: "huge",
    choices: [{ choice: "accept", label: "界".repeat(22000) }],
  };
  store.insertShowing(huge, 1000);
  const reply = {
    ...template,
    message_id: "reply",
    in_reply_to: "earlier",
    choices: [
      { choice: "accept", label: "会話に渡す" },
      { choice: "later", label: "あとで" },
    ],
  };
  store.insertShowing(reply, 1001);
  store.close();
  for (const command of ["states", "action"]) {
    const envelope = command === "action" ? base : { binding_id };
    assert.equal(await run(command, envelope), 1);
    assert.deepEqual(JSON.parse(output.at(-1)), {
      error: "state_response_too_large",
    });
    const requested = [
      ...keys.slice(0, 49),
      { sender_id: "missing", message_id: "absent" },
    ];
    const originalAll = SQLiteNotices.prototype.all;
    SQLiteNotices.prototype.all = () => {
      throw new Error("subset must not scan all records");
    };
    try {
      assert.equal(await run(command, { ...envelope, keys: requested }), 0);
    } finally {
      SQLiteNotices.prototype.all = originalAll;
    }
    const result = JSON.parse(output.at(-1));
    assert.equal(result.scope, "requested");
    assert.deepEqual(result.keys, requested);
    assert.equal(result.states.length, 49);
    assert.deepEqual(
      result.states.map(({ sender_id, message_id }) => ({
        sender_id,
        message_id,
      })),
      requested.slice(0, 49),
    );
    assert.ok(
      result.states.every(
        (x) => x.state === "later" && Number.isSafeInteger(x.revision),
      ),
    );
    assert.ok(Buffer.byteLength(output.at(-1), "utf8") + 1 <= 60 * 1024);
    assert.ok(!output.at(-1).includes("private body"));
    assert.equal(await run(command, { ...envelope, keys: [keys[2999]] }), 0);
    assert.equal(JSON.parse(output.at(-1)).states.length, 1);
    assert.deepEqual(JSON.parse(output.at(-1)).keys, [keys[2999]]);
    assert.ok(Buffer.byteLength(output.at(-1), "utf8") + 1 <= 60 * 1024);
    assert.notEqual(
      await run(command, {
        ...envelope,
        binding_id: "界".repeat(22000),
        keys: [],
      }),
      0,
    );
    assert.equal(JSON.parse(output.at(-1)).error, "invalid_request");
    assert.equal(await run(command, { ...envelope, keys: [] }), 0);
    assert.deepEqual(JSON.parse(output.at(-1)).states, []);
    for (const bad of [
      keys.slice(0, 51),
      keys.slice(0, 250),
      [keys[0], keys[0]],
      [{ sender_id: "界".repeat(171), message_id: "x" }],
    ]) {
      assert.notEqual(await run(command, { ...envelope, keys: bad }), 0);
      assert.equal(JSON.parse(output.at(-1)).error, "invalid_request");
    }
    assert.equal(
      await run(command, {
        ...envelope,
        binding_id: "foreign",
        keys: [keys[0]],
      }),
      1,
    );
    assert.equal(JSON.parse(output.at(-1)).error, "binding_mismatch");
  }
  const originalAll = SQLiteNotices.prototype.all;
  SQLiteNotices.prototype.all = () => {
    throw new Error("action must not scan the DB");
  };
  try {
    assert.equal(
      await run("adapter-action", { binding_id, ...keys[0], choice: "later" }),
      0,
    );
  } finally {
    SQLiteNotices.prototype.all = originalAll;
  }
  const decision = JSON.parse(output.at(-1));
  assert.equal(decision.scope, "requested");
  assert.deepEqual(decision.keys, [keys[0]]);
  assert.equal(decision.states.length, 1);
  assert.equal(decision.revision, decision.states[0].revision);
  assert.ok(Buffer.byteLength(output.at(-1), "utf8") + 1 <= 60 * 1024);
  const { NoticeStateProjection } =
    await import("../src/agent-notify/state-sync.ts");
  const projection = new NoticeStateProjection(binding_id);
  projection.merge({
    binding_id,
    states: [{ ...keys[1], state: "declined", revision: 1 }],
  });
  projection.merge(decision);
  assert.equal(
    projection.state(keys[1].sender_id, keys[1].message_id).state,
    "declined",
  );
  assert.notEqual(
    await run("adapter-action", {
      binding_id,
      sender_id: "界".repeat(171),
      message_id: "x",
      choice: "later",
    }),
    0,
  );
  assert.equal(JSON.parse(output.at(-1)).error, "invalid_request");
  assert.equal(
    await run("action", {
      ...base,
      keys: [{ sender_id: huge.sender_id, message_id: huge.message_id }],
    }),
    1,
  );
  assert.deepEqual(JSON.parse(output.at(-1)), {
    error: "state_response_too_large",
  });
  assert.equal(
    await run("states", {
      binding_id,
      keys: [{ sender_id: huge.sender_id, message_id: huge.message_id }],
    }),
    1,
  );
  assert.deepEqual(JSON.parse(output.at(-1)), {
    error: "state_response_too_large",
  });
  assert.equal(
    await run("states", {
      binding_id,
      keys: [{ sender_id: reply.sender_id, message_id: reply.message_id }],
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output.at(-1)).states[0].choices, reply.choices);
  const corrupt = new SQLiteNotices(config.store, binding_id);
  corrupt.insertShowing(
    {
      ...template,
      message_id: "malformed",
      choices: [{ choice: "execute", label: "private invalid choice" }],
    },
    1002,
  );
  corrupt.close();
  assert.equal(
    await run("states", {
      binding_id,
      keys: [{ sender_id: template.sender_id, message_id: "malformed" }],
    }),
    1,
  );
  assert.deepEqual(JSON.parse(output.at(-1)), { error: "invalid_request" });
  assert.ok(!output.at(-1).includes("private"));
});

async function runWithProbe(t, result) {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-probe-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAB_NOTIFY_TEST_TOKEN_PROBE;
  });
  // A check fails with token_expired, so its log line shows that a check ran.
  process.env.HAB_NOTIFY_TEST_TOKEN_PROBE = jwt({ exp: 1 });
  const secret = "whsec_" + Buffer.alloc(32, 5).toString("base64");
  const secretFile = join(dir, "wake.secret");
  writeFileSync(secretFile, secret, { mode: 0o600 });
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  if (JSON.parse(raw).session_id !== "bound-session") process.exit(9);
  console.log(JSON.stringify({ result: ${JSON.stringify(result)} }));
});`,
  );
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN_PROBE" },
      as_address: "hermes@hermes.hab",
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "hermes-desktop",
        path: join(dir, "screen.jsonl"),
        session_id: "bound-session",
        profile: "profile",
        backend_namespace: "namespace",
        profile_scope: "scope",
        session_probe: { command: [process.execPath, probe], cwd: dir },
      },
      interval_ms: 1000,
      wake: { port, secret_file: secretFile },
    }),
  );
  const once = [];
  await main(["--config", config, "check"], (line) => once.push(line));
  const lines = [];
  const running = main(["--config", config, "run"], (line) => lines.push(line));
  await new Promise((done) => setTimeout(done, 700));
  const { HAB_EVENT_NAME, signWebhook } = await import("../src/hab/events.ts");
  const body = JSON.stringify({
    name: HAB_EVENT_NAME,
    data: { to: "hermes@hermes.hab", session: "bound-session" },
  });
  const ts = Math.floor(Date.now() / 1000);
  const answer = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "webhook-id": "msg_probe",
      "webhook-timestamp": String(ts),
      "webhook-signature": signWebhook(secret, "msg_probe", ts, body),
    },
    body,
  });
  const answered = { status: answer.status, body: await answer.text() };
  await new Promise((done) => setTimeout(done, 1500));
  process.emit("SIGTERM");
  assert.equal(await running, 0);
  return {
    answered,
    once: JSON.parse(once.at(-1)),
    logged: lines.map((line) => JSON.parse(line)),
  };
}

test("run answers HAB 410 session_gone and checks nothing while the Hermes conversation is gone", async (t) => {
  const { answered, once, logged } = await runWithProbe(t, "gone");
  // The one-shot check does not reach HAB either (no token_expired).
  assert.deepEqual(once, { shown: [], session: "gone" });
  assert.equal(answered.status, 410);
  assert.deepEqual(JSON.parse(answered.body), { reason: "session_gone" });
  assert.deepEqual(
    logged.map((line) => line.session ?? line.error),
    ["gone"],
  );
});

test("run answers 200 unconfirmed and leaves the inbox alone when the probe cannot tell", async (t) => {
  const { answered, once, logged } = await runWithProbe(t, "unknown");
  assert.deepEqual(once, { shown: [], session: "unknown" });
  assert.equal(answered.status, 200);
  assert.deepEqual(JSON.parse(answered.body), { reason: "session_unconfirmed" });
  assert.deepEqual(logged.map((line) => line.session ?? line.error), ["unknown"]);
});

test("run and one-shot check reach HAB when the bound Hermes session is present", async (t) => {
  const { answered, once, logged } = await runWithProbe(t, "present");
  assert.deepEqual(once, { error: "token_expired" });
  assert.equal(answered.status, 200);
  assert.deepEqual(JSON.parse(answered.body), {});
  assert.deepEqual(
    logged.map((line) => line.session ?? line.error),
    ["present", "token_expired"],
  );
});
