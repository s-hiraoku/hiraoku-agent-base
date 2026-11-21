import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { test } from "node:test";
import {
  AutoAcceptPolicy,
  AutoAudit,
  ReceiptNotifier,
  SQLiteNotices,
  autoAcceptConfigSchema,
} from "../src/agent-notify/index.ts";
import { codexQueueHandoff, execArgv } from "../src/agent-notify/codex.ts";
import { formatHandoffPrompt } from "../src/messaging/incoming-notice.ts";
import { boundScreen, main } from "../scripts/hab-notify.ts";

const THREAD = "01a1fc9c-04ea-7770-8dda-1d1d98a9c1bb";

function message(id, patch = {}) {
  const base = {
    message_id: id,
    sender_id: "sender-dots",
    from: "stallone@dot.hab",
    kind: "question",
    thread_id: "t-1",
    in_reply_to: null,
    sent_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    display: `display ${id}`,
    ...patch,
  };
  return {
    ...base,
    handoff_prompt: formatHandoffPrompt({
      message_id: id,
      from: base.from,
      kind: base.kind,
      text: `本文 ${id}`,
      reply_by: base.expires_at,
      in_reply_to: null,
    }),
  };
}

/** A stand-in `codex` that logs its argv and answers as told by files beside it. */
function fakeCodex(dir) {
  const bin = join(dir, "codex");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const answer = ${JSON.stringify(join(dir, "answer.json"))};
const { code = 0, output = "Queued message q1 for thread ${THREAD}.", sleep = 0 } =
  fs.existsSync(answer) ? JSON.parse(fs.readFileSync(answer, "utf8")) : {};
setTimeout(() => { process.stderr.write(output); process.exit(code); }, sleep);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    answer: (value) =>
      writeFileSync(join(dir, "answer.json"), JSON.stringify(value)),
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
  };
}

function setup(t, { unread = [], auto } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-codex-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = fakeCodex(dir);
  const socket = join(dir, "app-server-control.sock");
  const config = {
    hab_url: "https://hab.example/mcp",
    agent_id: "agent-codex",
    token: { env: "MISSING_SYNTHETIC_TOKEN" },
    store: join(dir, "notices.sqlite"),
    screen: {
      type: "codex",
      path: join(dir, "codex.jsonl"),
      thread_id: THREAD,
      queue: { codex_bin: codex.bin, daemon_socket: socket },
    },
  };
  const read = [];
  const hab = {
    unread,
    failRead: false,
    async peek(limit, after) {
      const start = after === undefined ? 0 : Number(after);
      const messages = hab.unread.slice(start, start + limit);
      return {
        messages,
        next_cursor: messages.length ? String(start + messages.length) : null,
      };
    },
    async markRead(id, sender) {
      if (hab.failRead) throw new Error("offline");
      read.push(id);
      hab.unread = hab.unread.filter(
        (m) => m.message_id !== id || m.sender_id !== sender,
      );
      return true;
    },
  };
  const policy =
    auto &&
    new AutoAcceptPolicy(
      autoAcceptConfigSchema.parse({
        audit: join(dir, "audit.jsonl"),
        ...auto,
      }),
    );
  const make = () => {
    const screen = boundScreen(config);
    const store = new SQLiteNotices(config.store, screen.target);
    t.after(() => store.close());
    return new ReceiptNotifier({
      hab,
      screen,
      store,
      ...(policy
        ? {
            autoAccept: {
              policy,
              audit: new AutoAudit(join(dir, "audit.jsonl"), {
                rename: renameSync,
                size: (path) =>
                  existsSync(path) ? lstatSync(path).size : undefined,
              }),
            },
          }
        : {}),
    });
  };
  return { dir, codex, socket, config, hab, read, make };
}

test("codex queue gets the approved prompt and the bound thread as separate argv entries", async () => {
  const runs = [];
  const run = async (argv, timeout) => {
    runs.push([argv, timeout]);
    return { code: 0, output: "Queued message q1." };
  };
  const binding = {
    thread_id: THREAD,
    queue: { codex_bin: "/opt/codex", daemon_socket: "/tmp/d.sock" },
  };
  const m = message("m1");
  assert.equal(await codexQueueHandoff(binding, m, run), "queued");
  assert.deepEqual(runs, [
    [
      [
        "/opt/codex",
        "queue",
        "--thread",
        THREAD,
        "--message",
        m.handoff_prompt,
        "--remote",
        "unix:///tmp/d.sock",
      ],
      20_000,
    ],
  ]);
});

test("only output that says nothing was queued is unsupported; any other failure is unknown", async () => {
  const binding = {
    thread_id: THREAD,
    queue: { codex_bin: "/opt/codex", daemon_socket: "/tmp/d.sock" },
  };
  const answer =
    (output, code = 1) =>
    async () => ({ code, output });
  for (const output of [
    `No active session found matching '${THREAD}'.`,
    `thread/queue/add failed: no rollout found for thread id ${THREAD}`,
    "the local app-server daemon does not support thread/queue/add; update or restart the local app-server daemon",
    "cannot queue through an embedded app server while a local app-server daemon is running; remove configuration overrides or use --remote",
  ])
    assert.equal(
      await codexQueueHandoff(binding, message("m1"), answer(output)),
      "unsupported",
    );
  await assert.rejects(
    codexQueueHandoff(
      binding,
      message("m1"),
      answer("failed to queue session message"),
    ),
    /codex_queue_failed/,
  );
  await assert.rejects(
    codexQueueHandoff(binding, message("m1"), async () => {
      throw new Error("codex_timeout");
    }),
    /codex_timeout/,
  );
});

test("execArgv reports the exit code, the output and a deadline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-codex-exec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = fakeCodex(dir);
  assert.deepEqual(await execArgv([codex.bin, "queue"], 5000), {
    code: 0,
    output: `Queued message q1 for thread ${THREAD}.`,
  });
  codex.answer({ code: 3, output: "broken" });
  assert.deepEqual(await execArgv([codex.bin], 5000), {
    code: 3,
    output: "broken",
  });
  codex.answer({ sleep: 5000 });
  await assert.rejects(execArgv([codex.bin], 300), /codex_timeout/);
  await assert.rejects(
    execArgv([join(dir, "missing")], 1000),
    /codex_unreachable/,
  );
});

test("showing, showing again and later never run codex and keep the mail unread", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  assert.deepEqual(await n.check(), ["m1"]);
  await n.check();
  assert.equal((await n.decide("m1", "later")).state, "later");
  await n.check();
  assert.deepEqual(f.codex.calls(), []);
  assert.deepEqual(f.read, []);
  assert.equal(f.hab.unread.length, 1);
});

test("対応する marks the mail read, then queues it into the bound thread once", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "queued",
  });
  assert.deepEqual(f.read, ["m1"]);
  const calls = f.codex.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["queue", "--thread", THREAD]);
  assert.match(calls[0][4], /本文 m1/);
  assert.deepEqual(calls[0].slice(5), ["--remote", `unix://${f.socket}`]);
  assert.equal((await n.decide("m1", "accept")).changed, false);
  await n.check();
  await f.make().check();
  assert.equal(f.codex.calls().length, 1);
});

test("nothing runs when HAB cannot be told the mail was read", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  f.hab.failRead = true;
  assert.equal((await n.decide("m1", "accept")).state, "accept_waiting");
  assert.deepEqual(f.codex.calls(), []);
});

test("a failed or timed out queue is unknown and is not resent, even after a restart", async (t) => {
  const f = setup(t, { unread: [message("m1"), message("m2")] });
  const n = f.make();
  await n.check();
  f.codex.answer({ code: 1, output: "failed to queue session message" });
  assert.equal((await n.decide("m1", "accept")).state, "unknown");
  f.codex.answer({ code: 1, output: "No active session found matching 'x'." });
  assert.equal((await n.decide("m2", "accept")).state, "unsupported");
  await n.check();
  await f.make().check();
  assert.equal(f.codex.calls().length, 2);
});

test("an auto_accept rule queues a matching message once; others wait for the user", async (t) => {
  const f = setup(t, {
    unread: [
      message("allowed"),
      message("other", { from: "someone@else.hab", sender_id: "x" }),
    ],
    auto: {
      rules: [
        { name: "dots", from: ["stallone@dot.hab"], kinds: ["question"] },
      ],
    },
  });
  const n = f.make();
  await n.check();
  await n.check();
  await f.make().check();
  const calls = f.codex.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0][4], /ルール「dots」により自動で受け付けました/);
  assert.equal(n.get("allowed").state, "queued");
  assert.equal(n.get("other").state, "shown");
  assert.deepEqual(f.read, ["allowed"]);
});

test("the queue route is fenced apart from the WebSocket route and from display only", async (t) => {
  const f = setup(t);
  const queue = boundScreen(f.config);
  assert.equal(queue.capabilities.handoff, "bound-session");
  const displayOnly = { ...f.config.screen };
  delete displayOnly.queue;
  const display = boundScreen({ ...f.config, screen: displayOnly });
  assert.equal(display.capabilities.handoff, "unsupported");
  const websocket = boundScreen({
    ...f.config,
    screen: { ...displayOnly, app_server: { url: "ws://127.0.0.1:4500" } },
  });
  const otherSocket = boundScreen({
    ...f.config,
    screen: {
      ...f.config.screen,
      queue: { ...f.config.screen.queue, daemon_socket: join(f.dir, "other") },
    },
  });
  const targets = [queue, display, websocket, otherSocket].map((s) => s.target);
  assert.equal(new Set(targets).size, 4);
});

test("the config refuses both routes at once and relative queue paths", async (t) => {
  const f = setup(t);
  const write = (screen) => {
    const path = join(f.dir, "notify.json");
    writeFileSync(path, JSON.stringify({ ...f.config, screen }));
    return main(["--config", path, "binding"], () => {});
  };
  await assert.rejects(
    write({
      ...f.config.screen,
      app_server: { url: "ws://127.0.0.1:4500" },
    }),
    /set app_server or queue, not both/,
  );
  await assert.rejects(
    write({
      ...f.config.screen,
      queue: { codex_bin: "codex", daemon_socket: f.socket },
    }),
    /absolute codex_bin/,
  );
  await assert.rejects(
    write({
      ...f.config.screen,
      queue: { codex_bin: f.codex.bin, daemon_socket: "d.sock" },
    }),
    /absolute daemon_socket/,
  );
  assert.equal(await write(f.config.screen), 0);
});
