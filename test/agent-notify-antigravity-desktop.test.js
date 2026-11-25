import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ANTIGRAVITY_REQUEST_BYTES,
  AntigravityRelay,
  AutoAcceptPolicy,
  AutoAudit,
  ReceiptNotifier,
  SQLiteNotices,
  autoAcceptConfigSchema,
  runAgentapi,
  runRelay,
} from "../src/agent-notify/index.ts";
import { formatHandoffPrompt } from "../src/messaging/incoming-notice.ts";
import { boundScreen, configSchema, main } from "../scripts/hab-notify.ts";
import { configuredProbe } from "../scripts/lib/notify-config.ts";
import { sessionLabel } from "../scripts/lib/notify-product.ts";

const CONVERSATION = "dfb67f60-1c2e-4f0b-9d55-3b7f0a1c2e44";

function message(id, patch = {}, text = `本文 ${id}`) {
  const base = {
    message_id: id,
    sender_id: "sender-claude",
    from: "claude@claude.hab",
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
      text,
      reply_by: base.expires_at,
      in_reply_to: null,
    }),
  };
}

/** A stand-in agentapi: logs its argv, then exits as answer.json says ({code, wait_ms}). */
function fakeAgentapi(dir) {
  const bin = join(dir, "agentapi");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const answer = ${JSON.stringify(join(dir, "answer.json"))};
const { code = 0, wait_ms = 0 } = fs.existsSync(answer) ? JSON.parse(fs.readFileSync(answer, "utf8")) : {};
setTimeout(() => process.exit(code), wait_ms);
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hab-agy-desktop-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentapi = fakeAgentapi(dir);
  const spool = join(dir, "spool");
  const conversations = join(dir, "conversations");
  mkdirSync(conversations);
  writeFileSync(join(conversations, `${CONVERSATION}.db`), "");
  const config = configSchema.parse({
    hab_url: "https://hab.example/mcp",
    agent_id: "agent-antigravity",
    token: { env: "MISSING_SYNTHETIC_TOKEN" },
    store: join(dir, "notices.sqlite"),
    screen: {
      type: "antigravity-desktop",
      path: join(dir, "antigravity.jsonl"),
      conversation_id: CONVERSATION,
      spool_dir: spool,
      conversations_dir: conversations,
    },
  });
  const read = [];
  const hab = {
    unread,
    async peek(limit, after) {
      const start = after === undefined ? 0 : Number(after);
      const messages = hab.unread.slice(start, start + limit);
      return {
        messages,
        next_cursor: messages.length ? String(start + messages.length) : null,
      };
    },
    async markRead(id, sender) {
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
  const relay = (options = {}) =>
    new AntigravityRelay({
      spool,
      log: join(dir, "relay.jsonl"),
      agentapi: agentapi.bin,
      ...options,
    });
  const waiting = () =>
    existsSync(spool)
      ? readdirSync(spool).filter((name) => name.endsWith(".json"))
      : [];
  const inDir = (name) =>
    existsSync(join(spool, name)) ? readdirSync(join(spool, name)) : [];
  const log = () =>
    existsSync(join(dir, "relay.jsonl"))
      ? readFileSync(join(dir, "relay.jsonl"), "utf8")
      : "";
  return {
    dir,
    spool,
    conversations,
    agentapi,
    config,
    hab,
    read,
    make,
    relay,
    waiting,
    inDir,
    log,
  };
}

test("対応する marks the mail read and leaves one owner-only request; the relay sends it once", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  assert.deepEqual(f.waiting(), []);
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "queued",
  });
  assert.deepEqual(f.read, ["m1"]);
  const [name] = f.waiting();
  assert.ok(name);
  assert.equal(lstatSync(f.spool).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.spool, name)).mode & 0o777, 0o600);
  const request = JSON.parse(readFileSync(join(f.spool, name), "utf8"));
  assert.equal(request.conversation_id, CONVERSATION);
  assert.equal(request.message_id, "m1");
  assert.equal(request.title, "HAB: claude@claude.hab");
  assert.match(request.prompt, /本文 m1/);

  const relay = f.relay();
  relay.start();
  assert.equal(await relay.drain(), 1);
  assert.equal(await relay.drain(), 0);
  const calls = f.agentapi.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, [
    "send-message",
    "--title=HAB: claude@claude.hab",
    CONVERSATION,
    request.prompt,
  ]);
  assert.deepEqual(f.inDir("done"), [name]);
  assert.deepEqual(f.waiting(), []);
  const log = f.log();
  assert.doesNotMatch(log, /本文 m1/);
  const entry = JSON.parse(log.trim());
  assert.equal(entry.outcome, "done");
  assert.equal(entry.exit_code, 0);
  assert.equal(entry.message_id, "m1");
  assert.equal(lstatSync(join(f.dir, "relay.jsonl")).mode & 0o777, 0o600);

  // A repeated choice, a later check and a new notifier write nothing more.
  assert.equal((await n.decide("m1", "accept")).changed, false);
  await n.check();
  await f.make().check();
  assert.deepEqual(f.waiting(), []);
});

test("showing, showing again and later write nothing and keep the mail unread", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  assert.deepEqual(await n.check(), ["m1"]);
  await n.check();
  assert.equal((await n.decide("m1", "later")).state, "later");
  await n.showAgain("m1");
  await n.check();
  assert.deepEqual(f.waiting(), []);
  assert.deepEqual(f.read, []);
});

test("a request too large for one argument is refused before it is marked read", async (t) => {
  const big = message(
    "big",
    {},
    "あ".repeat(ANTIGRAVITY_REQUEST_BYTES / 3 + 1),
  );
  const f = setup(t, { unread: [big] });
  const n = f.make();
  await n.check();
  assert.equal((await n.decide("big", "accept")).state, "unsupported");
  assert.deepEqual(f.read, []);
  assert.equal(f.hab.unread.length, 1);
  assert.deepEqual(f.waiting(), []);
  await n.check();
  assert.equal(n.get("big").state, "unsupported");
});

test("an unsafe spool is refused before the mail is marked read", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  chmodSync(f.spool, 0o755);
  assert.equal((await n.decide("m1", "accept")).state, "unsupported");
  assert.deepEqual(f.read, []);
  assert.deepEqual(f.waiting(), []);
});

test("an auto_accept rule queues the automatic prompt once; others wait", async (t) => {
  const f = setup(t, {
    unread: [
      message("allowed"),
      message("other", { from: "someone@else.hab", sender_id: "x" }),
    ],
    auto: {
      rules: [
        { name: "claude", from: ["claude@claude.hab"], kinds: ["question"] },
      ],
    },
  });
  const n = f.make();
  await n.check();
  await n.check();
  await f.make().check();
  const names = f.waiting();
  assert.equal(names.length, 1);
  const request = JSON.parse(readFileSync(join(f.spool, names[0]), "utf8"));
  assert.match(request.prompt, /ルール「claude」により自動で受け付けました/);
  assert.equal(n.get("allowed").state, "queued");
  assert.equal(n.get("other").state, "shown");
  assert.deepEqual(f.read, ["allowed"]);
});

test("the relay never resends: failed, timed out, interrupted, expired and invalid requests", async (t) => {
  const f = setup(t, { unread: [message("m1"), message("m2")] });
  const n = f.make();
  await n.check();
  await n.decide("m1", "accept");
  f.agentapi.answer({ code: 3 });
  const relay = f.relay({ send_timeout_ms: 300 });
  relay.start();
  await relay.drain();
  assert.equal(f.inDir("failed").length, 1);
  await relay.drain();
  assert.equal(f.agentapi.calls().length, 1);

  await n.decide("m2", "accept");
  f.agentapi.answer({ wait_ms: 3000 });
  await relay.drain();
  assert.equal(f.inDir("unknown").length, 1);
  assert.equal(f.agentapi.calls().length, 2);

  // Left in sending/ by a relay that stopped mid-send: moved to unknown/, never sent.
  writeFileSync(join(f.spool, "sending", "000000000000001-left.json"), "{}", {
    mode: 0o600,
  });
  // Older than a day.
  const old = {
    version: 1,
    message_id: "old",
    sender_id: "s",
    from: null,
    conversation_id: CONVERSATION,
    title: "HAB: s",
    prompt: "古い依頼",
    written_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
  };
  writeFileSync(
    join(f.spool, "000000000000002-old.json"),
    JSON.stringify(old),
    { mode: 0o600 },
  );
  // Not a request, an option for a conversation ID, and a file others may read.
  writeFileSync(
    join(f.spool, "000000000000003-bad.json"),
    JSON.stringify({
      ...old,
      written_at: new Date().toISOString(),
      conversation_id: "--help",
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(f.spool, "000000000000004-open.json"),
    JSON.stringify({ ...old, written_at: new Date().toISOString() }),
    { mode: 0o644 },
  );
  // A half-written temporary file is not a request.
  writeFileSync(join(f.spool, ".000000000000005-tmp.json.abc.tmp"), "{", {
    mode: 0o600,
  });
  const restarted = f.relay();
  restarted.start();
  assert.deepEqual(f.inDir("sending"), []);
  assert.ok(f.inDir("unknown").includes("000000000000001-left.json"));
  await restarted.drain();
  assert.deepEqual(f.inDir("expired"), ["000000000000002-old.json"]);
  assert.ok(f.inDir("failed").includes("000000000000003-bad.json"));
  assert.ok(f.inDir("failed").includes("000000000000004-open.json"));
  assert.equal(f.agentapi.calls().length, 2);
  assert.ok(existsSync(join(f.spool, ".000000000000005-tmp.json.abc.tmp")));
  assert.doesNotMatch(f.log(), /古い依頼|本文/);
  const outcomes = f
    .log()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).outcome);
  assert.deepEqual(outcomes, [
    "failed",
    "unknown",
    "unknown",
    "expired",
    "failed",
    "failed",
  ]);
});

test("two relays on one spool send a request once", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  await n.decide("m1", "accept");
  f.agentapi.answer({ wait_ms: 200 });
  const a = f.relay();
  const b = f.relay();
  a.start();
  const counts = await Promise.all([a.drain(), b.drain()]);
  assert.equal(counts[0] + counts[1], 1);
  assert.equal(f.agentapi.calls().length, 1);
});

test("finished requests are removed after the keep time", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  await n.decide("m1", "accept");
  const relay = f.relay({ keep_ms: 60_000 });
  relay.start();
  await relay.drain();
  const [name] = f.inDir("done");
  const past = new Date(Date.now() - 120_000);
  utimesSync(join(f.spool, "done", name), past, past);
  await relay.drain();
  assert.deepEqual(f.inDir("done"), []);
});

test("runRelay sends with the agentapi the app names and stops on abort", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  await n.decide("m1", "accept");
  const controller = new AbortController();
  const before = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  process.env.ANTIGRAVITY_AGENTAPI_EXE = f.agentapi.bin;
  t.after(() => {
    if (before === undefined) delete process.env.ANTIGRAVITY_AGENTAPI_EXE;
    else process.env.ANTIGRAVITY_AGENTAPI_EXE = before;
  });
  const running = runRelay(
    { spool: f.spool, log: join(f.dir, "relay.jsonl") },
    controller.signal,
  );
  for (let i = 0; i < 50 && !f.inDir("done").length; i++) await delay(50);
  assert.equal(f.inDir("done").length, 1);
  controller.abort();
  await running;
  assert.equal(f.agentapi.calls().length, 1);
});

test("runAgentapi: a missing binary fails, a hung one is killed at the deadline", async (t) => {
  const f = setup(t);
  assert.equal(await runAgentapi([join(f.dir, "missing")], 1000), 127);
  f.agentapi.answer({ wait_ms: 5000 });
  assert.equal(await runAgentapi([f.agentapi.bin], 200), null);
});

test("hab-notify antigravity-relay needs absolute --spool and --log", async () => {
  const out = [];
  assert.equal(
    await main(["antigravity-relay", "--spool", "spool", "--log", "/l"], (l) =>
      out.push(l),
    ),
    2,
  );
  assert.equal(
    await main(["antigravity-relay", "--spool", "/s"], (l) => out.push(l)),
    2,
  );
  assert.equal(
    await main(["antigravity-relay", "--spool", "/s", "--other", "/x"], (l) =>
      out.push(l),
    ),
    2,
  );
});

test("config: the conversation ID is never a path or an option; the spool is absolute", () => {
  const base = {
    hab_url: "https://hab.example/mcp",
    agent_id: "a",
    token: { env: "X" },
    store: "/tmp/s",
  };
  const screen = {
    type: "antigravity-desktop",
    path: "/tmp/p",
    conversation_id: CONVERSATION,
    spool_dir: "/tmp/spool",
  };
  assert.ok(configSchema.safeParse({ ...base, screen }).success);
  for (const bad of [
    { conversation_id: "../x" },
    { conversation_id: "--help" },
    { spool_dir: "spool" },
    { conversations_dir: "conversations" },
  ])
    assert.equal(
      configSchema.safeParse({ ...base, screen: { ...screen, ...bad } })
        .success,
      false,
    );
  assert.equal(sessionLabel({ ...base, screen }), CONVERSATION);
});

test("the binding names the conversation and the spool's real path", async (t) => {
  const f = setup(t);
  const screen = boundScreen(f.config);
  assert.equal(screen.capabilities.handoff, "bound-session");
  assert.equal(screen.binding.product, "antigravity-desktop");
  const otherSpool = boundScreen({
    ...f.config,
    screen: { ...f.config.screen, spool_dir: join(f.dir, "other-spool") },
  });
  const otherConversation = boundScreen({
    ...f.config,
    screen: {
      ...f.config.screen,
      conversation_id: "0f0f0f0f-0000-4000-8000-000000000000",
    },
  });
  assert.equal(
    new Set([screen.target, otherSpool.target, otherConversation.target]).size,
    3,
  );
  assert.equal(boundScreen(f.config).target, screen.target);
});

test("ADR-032: the conversation file says present or gone; no directory, no probe", async (t) => {
  const f = setup(t);
  assert.equal(await configuredProbe(f.config)(), "present");
  rmSync(join(f.conversations, `${CONVERSATION}.db`));
  assert.equal(await configuredProbe(f.config)(), "gone");
  const missing = {
    ...f.config,
    screen: { ...f.config.screen, conversations_dir: join(f.dir, "nowhere") },
  };
  assert.equal(configuredProbe(missing), undefined);
});
