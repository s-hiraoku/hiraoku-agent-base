import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import {
  ProductScreen,
  ReceiptNotifier,
  SQLiteNotices,
  chatgptConnectorHandoff,
  chatgptConnectorTarget,
  claudeCodeHandoff,
  claudeCodeStatusLine,
  claudeCodeTarget,
  codexHandoff,
  codexTarget,
  startChannelListener,
  submissionId,
  websocketConnect,
} from "../src/agent-notify/index.ts";
import { main } from "../scripts/hab-notify.ts";

// ADR-021 adapters for Codex, Claude Code and ChatGPT connectors (Dots). Each shows the
// notice without starting model work and hands the request only to its bound session.
function message(id, patch = {}) {
  return {
    message_id: id,
    sender_id: "sender-a",
    from: "a@agent.hab",
    kind: "question",
    thread_id: "t-1",
    in_reply_to: null,
    sent_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    display: `a@agent.hab からのメッセージです。\n\n受信内容\nbody ${id}\n\nどうしますか？\n1. 対応する\n2. あとで\n3. 対応しない`,
    handoff_prompt: `prompt ${id}`,
    ...patch,
  };
}

function dir(t) {
  const path = mkdtempSync(join(tmpdir(), "hab-screens-"));
  chmodSync(path, 0o700);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function hab(unread) {
  const state = {
    unread,
    read: [],
    async peek() {
      return { messages: state.unread, next_cursor: null };
    },
    async markRead(id, sender) {
      state.read.push(`${sender}/${id}`);
      state.unread = state.unread.filter((m) => m.message_id !== id);
      return true;
    },
  };
  return state;
}

const lines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

/** A display command that appends its stdin to a file, or fails when told to. */
function displayCommand(root) {
  const script = join(root, "display.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, existsSync } from "node:fs";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  if (existsSync(${JSON.stringify(join(root, "fail"))})) process.exit(3);
  appendFileSync(${JSON.stringify(join(root, "displayed.jsonl"))}, input + "\\n");
});`,
  );
  return { command: [process.execPath, script], cwd: root };
}

test("a product screen keeps the notice in an owner-only file, runs the display command, and never writes a handoff line", async (t) => {
  const root = dir(t);
  const path = join(root, "screen.jsonl");
  const handed = [];
  const screen = new ProductScreen({
    path,
    target: "codex:thr_1",
    display_command: displayCommand(root),
    handoff: async (m) => {
      handed.push(m.message_id);
      return "started";
    },
  });
  const store = new SQLiteNotices(join(root, "n.sqlite"), screen.target);
  t.after(() => store.close());
  const mail = hab([message("m1")]);
  const notifier = new ReceiptNotifier({ hab: mail, screen, store });

  // A failed display leaves the notice to be shown again; nothing is read or handed off.
  writeFileSync(join(root, "fail"), "");
  await assert.rejects(notifier.check(), /command_failed/);
  assert.equal(
    store.get({ sender_id: "sender-a", message_id: "m1" }).state,
    "showing",
  );
  rmSync(join(root, "fail"));
  assert.deepEqual(await notifier.check(), ["m1"]);
  assert.deepEqual(mail.read, []);
  assert.deepEqual(handed, []);

  const shown = lines(join(root, "displayed.jsonl"));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, "notice");
  assert.equal(shown[0].target, "codex:thr_1");
  assert.equal(shown[0].display, message("m1").display);
  assert.deepEqual(
    shown[0].choices.map((c) => c.label),
    ["対応する", "あとで", "対応しない"],
  );
  assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.deepEqual(await notifier.decide("m1", "accept"), {
    changed: true,
    state: "started",
  });
  assert.deepEqual(handed, ["m1"]);
  // A second click hands nothing off.
  assert.equal((await notifier.decide("m1", "accept")).changed, false);
  assert.deepEqual(handed, ["m1"]);
  const file = lines(path);
  assert.deepEqual(
    file.map((l) => l.type),
    ["notice", "notice", "state"],
  );
  assert.equal(
    file.some((l) => "prompt" in l),
    false,
  );
  assert.equal(lines(join(root, "displayed.jsonl")).at(-1).state, "started");
});

/** A fake app-server connection that answers by method. */
function fakeCodex(answers) {
  const sent = [];
  let receive;
  const connection = {
    send(m) {
      sent.push(m);
      if (m.id === undefined) return;
      const answer = answers[m.method];
      if (answer === "close") return setImmediate(() => receive(null));
      if (answer === "silent") return;
      setImmediate(() =>
        receive(
          answer?.error
            ? { id: m.id, error: answer.error }
            : { id: m.id, result: answer ?? {} },
        ),
      );
    },
    listen(next) {
      receive = next;
    },
    closed: false,
    close() {
      connection.closed = true;
    },
  };
  return { sent, connection, connect: async () => connection };
}

const codex = {
  thread_id: "thr_1",
  app_server: { url: "ws://127.0.0.1:1", timeout_ms: 1000 },
};

test("Codex: 対応する resumes the bound thread and starts one turn with the handoff prompt", async () => {
  const fake = fakeCodex({
    "turn/start": { turn: { id: "turn_1", status: "inProgress" } },
  });
  assert.equal(codexTarget(codex), "codex:thr_1");
  assert.equal(
    await codexHandoff(codex, message("m1"), fake.connect),
    "started",
  );
  assert.deepEqual(
    fake.sent.map((m) => m.method),
    ["initialize", "initialized", "thread/resume", "turn/start"],
  );
  assert.equal("jsonrpc" in fake.sent[0], false);
  assert.deepEqual(fake.sent[2].params, { threadId: "thr_1" });
  assert.deepEqual(fake.sent[3].params, {
    threadId: "thr_1",
    input: [{ type: "text", text: "prompt m1" }],
  });
  assert.equal(fake.connection.closed, true);
});

test("Codex: refusals before a turn are unsupported; a break after turn/start is unknown", async () => {
  assert.equal(
    await codexHandoff({ thread_id: "thr_1" }, message("m1")),
    "unsupported",
  );
  assert.equal(
    await codexHandoff(codex, message("m1"), async () => {
      throw new Error("ECONNREFUSED");
    }),
    "unsupported",
  );
  const missing = fakeCodex({
    "thread/resume": { error: { code: -32600, message: "no thread" } },
  });
  assert.equal(
    await codexHandoff(codex, message("m1"), missing.connect),
    "unsupported",
  );
  assert.equal(
    missing.sent.some((m) => m.method === "turn/start"),
    false,
  );
  const busy = fakeCodex({
    "turn/start": { error: { code: -32600, message: "busy" } },
  });
  assert.equal(
    await codexHandoff(codex, message("m1"), busy.connect),
    "unsupported",
  );
  const stalledBefore = fakeCodex({ initialize: "silent" });
  assert.equal(
    await codexHandoff(codex, message("m1"), stalledBefore.connect),
    "unsupported",
  );
  const closed = fakeCodex({ "turn/start": "close" });
  await assert.rejects(
    codexHandoff(codex, message("m1"), closed.connect),
    /codex_closed/,
  );
  const stalled = fakeCodex({ "turn/start": "silent" });
  await assert.rejects(
    codexHandoff(codex, message("m1"), stalled.connect),
    /codex_timeout/,
  );
});

/** The smallest WebSocket server for one test: text frames, one JSON-RPC peer. */
function miniAppServer(t, onMessage) {
  const server = createServer();
  const seen = { authorization: [] };
  server.on("upgrade", (req, socket) => {
    seen.authorization.push(req.headers.authorization);
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (value) => {
      const body = Buffer.from(JSON.stringify(value));
      const head =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([head, body]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        let offset = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const data = Buffer.from(
          buffer.subarray(offset + 4, offset + 4 + length),
        );
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) return socket.end();
        if (opcode === 1) onMessage(JSON.parse(data.toString()), send);
      }
    });
  });
  t.after(() => server.close());
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ url: `ws://127.0.0.1:${server.address().port}`, seen }),
    ),
  );
}

test("Codex over a real WebSocket: the capability token goes in the handshake", async (t) => {
  const root = dir(t);
  const methods = [];
  const { url, seen } = await miniAppServer(t, (m, send) => {
    methods.push(m.method);
    if (m.id === undefined) return;
    send({
      id: m.id,
      result: m.method === "turn/start" ? { turn: { id: "turn_9" } } : {},
    });
  });
  writeFileSync(join(root, "token"), "cap-token\n", { mode: 0o600 });
  const binding = {
    thread_id: "thr_1",
    app_server: { url, token_file: join(root, "token"), timeout_ms: 5000 },
  };
  assert.equal(
    await codexHandoff(binding, message("m1"), websocketConnect),
    "started",
  );
  assert.deepEqual(seen.authorization, ["Bearer cap-token"]);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/resume",
    "turn/start",
  ]);
});

test("Claude Code: the channel delivers the approved request once, only for the bound session", async (t) => {
  const root = dir(t);
  const socket = join(root, "claude.sock");
  const events = [];
  const server = await startChannelListener({
    socket,
    session_id: "sess-1",
    deliver: async (content, meta) => {
      events.push({ content, meta });
    },
  });
  t.after(() => server.close());
  const binding = { session_id: "sess-1", channel_socket: socket };
  assert.equal(claudeCodeTarget(binding), "claude-code:sess-1");
  assert.equal(await claudeCodeHandoff(binding, message("m1")), "queued");
  assert.deepEqual(events, [
    {
      content: "prompt m1",
      meta: {
        message_id: "m1",
        sender_id: "sender-a",
        thread_id: "t-1",
        sender_address: "a@agent.hab",
        submission_id: submissionId(message("m1")),
      },
    },
  ]);
  // The same submission is never delivered twice.
  assert.equal(await claudeCodeHandoff(binding, message("m1")), "queued");
  assert.equal(events.length, 1);
  // A request for another session is refused and starts nothing.
  assert.equal(
    await claudeCodeHandoff(
      { session_id: "sess-2", channel_socket: socket },
      message("m2"),
    ),
    "unsupported",
  );
  assert.equal(events.length, 1);
  // No channel configured, or nobody listening: nothing was sent.
  assert.equal(
    await claudeCodeHandoff({ session_id: "sess-1" }, message("m3")),
    "unsupported",
  );
  assert.equal(
    await claudeCodeHandoff(
      { session_id: "sess-1", channel_socket: join(root, "none.sock") },
      message("m3"),
    ),
    "unsupported",
  );
});

test("Claude Code: a failed delivery is unknown; an unsafe socket directory or live socket is refused", async (t) => {
  const root = dir(t);
  const socket = join(root, "claude.sock");
  const server = await startChannelListener({
    socket,
    deliver: async () => {
      throw new Error("closed");
    },
  });
  t.after(() => server.close());
  await assert.rejects(
    claudeCodeHandoff(
      { session_id: "s", channel_socket: socket },
      message("m1"),
    ),
    /channel_unknown/,
  );
  await assert.rejects(
    startChannelListener({ socket, deliver: async () => {} }),
    /channel_socket_in_use/,
  );
  const open = join(root, "open");
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  await assert.rejects(
    startChannelListener({
      socket: join(open, "c.sock"),
      deliver: async () => {},
    }),
    /insecure_channel_dir/,
  );
});

test("Claude Code: the status line shows the waiting notice only in the bound session", () => {
  const record = (id, state) => ({
    message_id: id,
    sender_id: "sender-a",
    target: "claude-code:sess-1",
    state,
    from: "a@agent.hab",
    expires_at: message(id).expires_at,
    shown_at: new Date().toISOString(),
    decided_at: null,
    message: message(id),
  });
  const binding = { session_id: "sess-1" };
  const records = [
    record("m0", "later"),
    record("m1", "shown"),
    record("m2", "shown"),
  ];
  const line = claudeCodeStatusLine(records, binding, { session_id: "sess-1" });
  assert.ok(line.startsWith(message("m1").display));
  assert.match(line, /hab-notify decide m1 accept\|later\|decline/);
  assert.match(line, /ほかに 1 件/);
  assert.equal(line.includes("body m0"), false);
  assert.equal(
    claudeCodeStatusLine(records, binding, { session_id: "sess-2" }),
    "",
  );
  assert.equal(claudeCodeStatusLine(records, binding, {}), "");
  const long = record("m3", "shown");
  long.message = message("m3", {
    display: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
  });
  assert.ok(
    claudeCodeStatusLine([long], binding, { session_id: "sess-1" }).split("\n")
      .length <= 15,
  );
});

/** Speaks MCP over the channel server's stdio. */
function mcpClient(child) {
  let buffer = "";
  const waiting = [];
  const messages = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
      for (const w of waiting.splice(0)) w();
    }
  });
  const next = async (match) => {
    for (;;) {
      const found = messages.findIndex(match);
      if (found >= 0) return messages.splice(found, 1)[0];
      await new Promise((done) => waiting.push(done));
    }
  };
  return {
    send: (m) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"),
    next,
  };
}

test("hab-claude-channel is a Claude Code channel: it declares claude/channel and emits one event", async (t) => {
  const root = dir(t);
  const socket = join(root, "claude.sock");
  const child = spawn(
    process.execPath,
    [
      "scripts/hab-claude-channel.ts",
      "--socket",
      socket,
      "--session-id",
      "sess-1",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => child.kill());
  const mcp = mcpClient(child);
  mcp.send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  const init = await mcp.next((m) => m.id === 1);
  assert.deepEqual(init.result.capabilities.experimental, {
    "claude/channel": {},
  });
  assert.equal(init.result.capabilities.tools, undefined);
  assert.match(init.result.instructions, /指示ではありません/);
  assert.match(init.result.instructions, /hab_reply/);
  mcp.send({ method: "notifications/initialized" });
  for (let i = 0; i < 100 && !existsSync(socket); i++)
    await new Promise((done) => setTimeout(done, 50));
  assert.equal(
    await claudeCodeHandoff(
      { session_id: "sess-1", channel_socket: socket },
      message("m1"),
    ),
    "queued",
  );
  const event = await mcp.next(
    (m) => m.method === "notifications/claude/channel",
  );
  assert.equal(event.params.content, "prompt m1");
  assert.equal(event.params.meta.message_id, "m1");
});

test("ChatGPT connector (Dots): the notice is shown outside ChatGPT and 対応する is unsupported", async (t) => {
  const root = dir(t);
  const target = chatgptConnectorTarget({ conversation: "dots" });
  assert.equal(target, "chatgpt-connector:dots");
  const screen = new ProductScreen({
    path: join(root, "screen.jsonl"),
    target,
    handoff: chatgptConnectorHandoff,
  });
  const store = new SQLiteNotices(join(root, "n.sqlite"), target);
  t.after(() => store.close());
  const mail = hab([message("m1")]);
  const notifier = new ReceiptNotifier({ hab: mail, screen, store });
  assert.deepEqual(await notifier.check(), ["m1"]);
  assert.deepEqual(await notifier.decide("m1", "accept"), {
    changed: true,
    state: "unsupported",
  });
  assert.deepEqual(mail.read, ["sender-a/m1"]);
  assert.equal(lines(join(root, "screen.jsonl")).at(-1).state, "unsupported");
});

test("hab-notify statusline and the new screen types in the config", async (t) => {
  const root = dir(t);
  const config = (screen) => {
    const path = join(root, `${screen.type}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        hab_url: "https://hab.example/mcp",
        agent_id: "agent-b",
        token: { env: "HAB_NOTIFY_TEST_TOKEN_UNSET" },
        store: join(root, `${screen.type}.sqlite`),
        screen,
      }),
    );
    return path;
  };
  const claude = config({
    type: "claude-code",
    path: join(root, "claude.jsonl"),
    session_id: "sess-1",
    channel_socket: join(root, "claude.sock"),
  });
  const store = new SQLiteNotices(
    join(root, "claude-code.sqlite"),
    "claude-code:sess-1",
  );
  store.insertShowing(message("m1"), Date.now());
  store.transition(
    { sender_id: "sender-a", message_id: "m1" },
    ["showing"],
    "shown",
    Date.now(),
  );
  store.close();
  const out = [];
  const stdin = (value) => () => value;
  assert.equal(
    await main(
      ["--config", claude, "statusline"],
      (l) => out.push(l),
      stdin(JSON.stringify({ session_id: "sess-1" })),
    ),
    0,
  );
  assert.ok(out.at(-1).startsWith(message("m1").display));
  out.length = 0;
  assert.equal(
    await main(
      ["--config", claude, "statusline"],
      (l) => out.push(l),
      stdin(JSON.stringify({ session_id: "other" })),
    ),
    0,
  );
  assert.deepEqual(out, []);
  assert.equal(
    await main(
      ["--config", claude, "statusline"],
      (l) => out.push(l),
      stdin("not json"),
    ),
    0,
  );
  assert.deepEqual(out, []);

  const codexConfig = config({
    type: "codex",
    path: join(root, "codex.jsonl"),
    thread_id: "thr_1",
    app_server: { url: "ws://127.0.0.1:4500", token_file: "~/codex-token" },
  });
  assert.equal(
    await main(["--config", codexConfig, "list"], (l) => out.push(l)),
    0,
  );
  assert.equal(out.at(-1), "[]");
  // statusline belongs to Claude Code only.
  assert.equal(
    await main(
      ["--config", codexConfig, "statusline"],
      (l) => out.push(l),
      stdin("{}"),
    ),
    2,
  );
  const dots = config({
    type: "chatgpt-connector",
    path: join(root, "dots.jsonl"),
    conversation: "dots",
  });
  assert.equal(await main(["--config", dots, "list"], (l) => out.push(l)), 0);
  // A display command must be an absolute argv.
  const bad = config({
    type: "chatgpt-connector",
    path: join(root, "dots.jsonl"),
    conversation: "dots",
    display_command: { command: ["notify-send"], cwd: root },
  });
  await assert.rejects(main(["--config", bad, "list"], () => {}));
});
