import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AutoAcceptPolicy,
  AutoAudit,
  ReceiptNotifier,
  SQLiteNotices,
  autoAcceptConfigSchema,
} from "../src/agent-notify/index.ts";
import {
  antigravityHandoff,
  spawnAgy,
} from "../src/agent-notify/antigravity.ts";
import { formatHandoffPrompt } from "../src/messaging/incoming-notice.ts";
import { boundScreen, main } from "../scripts/hab-notify.ts";
import { sessionLabel } from "../scripts/lib/notify-product.ts";

const CONVERSATION = "055a398f-7c1e-4f0b-9d55-3b7f0a1c2e44";

function message(id, patch = {}) {
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
      text: `本文 ${id}`,
      reply_by: base.expires_at,
      in_reply_to: null,
    }),
  };
}

/**
 * A stand-in `agy` that logs its argv and cwd, then answers as answer.json says:
 * `init` (the conversation_id it reports, or null for none), `code`, `turn_ms` (time between
 * init and result; a file `turn-done` is written when the turn finishes).
 */
function fakeAgy(dir) {
  const bin = join(dir, "agy");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const answer = ${JSON.stringify(join(dir, "answer.json"))};
const asked = argv[argv.indexOf("--conversation") + 1];
const { init = asked, code = 0, turn_ms = 0, before_ms = 0 } =
  fs.existsSync(answer) ? JSON.parse(fs.readFileSync(answer, "utf8")) : {};
setTimeout(() => {
  if (init === null) { process.stderr.write("conversation not found"); process.exit(code || 1); }
  process.stdout.write(JSON.stringify({ type: "init", conversation_id: init, cwd: process.cwd(), permission_mode: "request-review" }) + "\\n");
  setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(join(dir, "turn-done"))}, "1");
    process.stdout.write(JSON.stringify({ type: "result", conversation_id: init, status: "SUCCESS", response: "秘密の返答", num_turns: 1 }) + "\\n");
    process.exit(code);
  }, turn_ms);
}, before_ms);
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
    turnDone: () => existsSync(join(dir, "turn-done")),
  };
}

function setup(t, { unread = [], auto } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hab-antigravity-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agy = fakeAgy(dir);
  const config = {
    hab_url: "https://hab.example/mcp",
    agent_id: "agent-antigravity",
    token: { env: "MISSING_SYNTHETIC_TOKEN" },
    store: join(dir, "notices.sqlite"),
    screen: {
      type: "antigravity",
      path: join(dir, "antigravity.jsonl"),
      conversation_id: CONVERSATION,
      cli: {
        agy_bin: agy.bin,
        cwd: dir,
        log_file: join(dir, "runs.jsonl"),
      },
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
  return { dir, agy, config, hab, read, make };
}

/** A scripted run: emits the given lines, then exits with `code` (or never, if undefined). */
function scripted(lines, code) {
  const runs = [];
  const run = (argv, cwd) => {
    const record = { argv, cwd, killed: false };
    runs.push(record);
    return {
      listen(receive) {
        Promise.resolve().then(() => {
          for (const line of lines) receive(line);
          if (code !== undefined) receive(null, code);
        });
      },
      kill() {
        record.killed = true;
      },
    };
  };
  return { run, runs };
}

const binding = {
  conversation_id: CONVERSATION,
  cli: { agy_bin: "/opt/agy", cwd: "/work/hab", timeout_ms: 1000 },
};

test("agy gets the approved prompt and the bound conversation as separate argv entries", async () => {
  const { run, runs } = scripted([
    JSON.stringify({ type: "init", conversation_id: CONVERSATION }),
  ]);
  const m = message("m1");
  assert.equal(await antigravityHandoff(binding, m, run), "started");
  assert.deepEqual(runs[0].argv, [
    "/opt/agy",
    "-p",
    m.handoff_prompt,
    "--conversation",
    CONVERSATION,
    "--output-format",
    "stream-json",
  ]);
  assert.equal(runs[0].cwd, "/work/hab");
  assert.equal(runs[0].killed, false);
});

test("an init for another conversation is killed before its turn and is unsupported", async () => {
  const { run, runs } = scripted([
    "not json",
    JSON.stringify({ type: "init", conversation_id: "another" }),
  ]);
  assert.equal(
    await antigravityHandoff(binding, message("m1"), run),
    "unsupported",
  );
  assert.equal(runs[0].killed, true);
});

test("an exit before init is unsupported; no init before the deadline is unknown", async () => {
  assert.equal(
    await antigravityHandoff(binding, message("m1"), scripted([], 1).run),
    "unsupported",
  );
  const stalled = scripted([]);
  await assert.rejects(
    antigravityHandoff(
      { ...binding, cli: { ...binding.cli, timeout_ms: 50 } },
      message("m1"),
      stalled.run,
    ),
    /antigravity_timeout/,
  );
  assert.equal(stalled.runs[0].killed, true);
  assert.equal(
    await antigravityHandoff(
      { conversation_id: CONVERSATION },
      message("m1"),
      stalled.run,
    ),
    "unsupported",
  );
  assert.equal(stalled.runs.length, 1);
});

test("spawnAgy answers started at init, lets the turn finish and logs only its status", async (t) => {
  const f = setup(t);
  f.agy.answer({ turn_ms: 300 });
  const cli = f.config.screen.cli;
  assert.equal(
    await antigravityHandoff(
      { conversation_id: CONVERSATION, cli },
      message("m1"),
      spawnAgy,
    ),
    "started",
  );
  assert.equal(f.agy.turnDone(), false);
  for (let i = 0; i < 50 && !existsSync(cli.log_file); i++) await delay(50);
  await delay(100);
  assert.equal(f.agy.turnDone(), true);
  const log = readFileSync(cli.log_file, "utf8");
  assert.doesNotMatch(log, /秘密の返答|本文 m1/);
  const entries = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries[0].status, "SUCCESS");
  assert.equal(entries[0].message_id, "m1");
  assert.equal(lstatSync(cli.log_file).mode & 0o777, 0o600);
  assert.equal(f.agy.calls()[0].cwd, f.dir);
});

test("spawnAgy: a missing binary is unsupported; a mismatched init never reaches its turn", async (t) => {
  const f = setup(t);
  const cli = f.config.screen.cli;
  assert.equal(
    await antigravityHandoff(
      {
        conversation_id: CONVERSATION,
        cli: { ...cli, agy_bin: join(f.dir, "missing") },
      },
      message("m1"),
    ),
    "unsupported",
  );
  f.agy.answer({ init: "another", turn_ms: 300 });
  assert.equal(
    await antigravityHandoff(
      { conversation_id: CONVERSATION, cli },
      message("m1"),
    ),
    "unsupported",
  );
  await delay(500);
  assert.equal(f.agy.turnDone(), false);
});

test("showing, showing again and later never run agy and keep the mail unread", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  assert.deepEqual(await n.check(), ["m1"]);
  await n.check();
  assert.equal((await n.decide("m1", "later")).state, "later");
  await n.check();
  assert.deepEqual(f.agy.calls(), []);
  assert.deepEqual(f.read, []);
  assert.equal(f.hab.unread.length, 1);
});

test("対応する marks the mail read, then starts one turn in the bound conversation", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "started",
  });
  assert.deepEqual(f.read, ["m1"]);
  const calls = f.agy.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[0], "-p");
  assert.match(calls[0].argv[1], /本文 m1/);
  assert.deepEqual(calls[0].argv.slice(2), [
    "--conversation",
    CONVERSATION,
    "--output-format",
    "stream-json",
  ]);
  assert.equal((await n.decide("m1", "accept")).changed, false);
  await n.check();
  await f.make().check();
  assert.equal(f.agy.calls().length, 1);
});

test("nothing runs when HAB cannot be told the mail was read", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  f.hab.failRead = true;
  assert.equal((await n.decide("m1", "accept")).state, "accept_waiting");
  assert.deepEqual(f.agy.calls(), []);
});

test("a stalled run is unknown and is not resent; a gone conversation is unsupported", async (t) => {
  const f = setup(t, { unread: [message("m1"), message("m2")] });
  f.config.screen.cli.timeout_ms = 1000;
  const n = f.make();
  await n.check();
  f.agy.answer({ before_ms: 5000 });
  assert.equal((await n.decide("m1", "accept")).state, "unknown");
  f.agy.answer({ init: null });
  assert.equal((await n.decide("m2", "accept")).state, "unsupported");
  await n.check();
  await f.make().check();
  assert.equal(f.agy.calls().length, 2);
});

test("an auto_accept rule starts a turn for a matching message once; others wait", async (t) => {
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
  const calls = f.agy.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0].argv[1], /ルール「claude」により自動で受け付けました/);
  assert.equal(n.get("allowed").state, "started");
  assert.equal(n.get("other").state, "shown");
  assert.deepEqual(f.read, ["allowed"]);
});

test("the CLI route is fenced apart from display only and from another agy", async (t) => {
  const f = setup(t);
  const cli = boundScreen(f.config);
  assert.equal(cli.capabilities.handoff, "bound-session");
  const displayOnly = { ...f.config.screen };
  delete displayOnly.cli;
  const display = boundScreen({ ...f.config, screen: displayOnly });
  assert.equal(display.capabilities.handoff, "unsupported");
  const otherAgy = boundScreen({
    ...f.config,
    screen: {
      ...f.config.screen,
      cli: { ...f.config.screen.cli, agy_bin: join(f.dir, "other-agy") },
    },
  });
  assert.equal(new Set([cli, display, otherAgy].map((s) => s.target)).size, 3);
  assert.equal(sessionLabel(f.config), CONVERSATION);
});

test("the config refuses relative agy and workspace paths", async (t) => {
  const f = setup(t);
  const write = (screen) => {
    const path = join(f.dir, "notify.json");
    writeFileSync(path, JSON.stringify({ ...f.config, screen }));
    return main(["--config", path, "binding"], () => {});
  };
  await assert.rejects(
    write({
      ...f.config.screen,
      cli: { ...f.config.screen.cli, agy_bin: "agy" },
    }),
    /absolute agy_bin/,
  );
  await assert.rejects(
    write({
      ...f.config.screen,
      cli: { ...f.config.screen.cli, cwd: "work" },
    }),
    /absolute cwd/,
  );
  assert.equal(await write(f.config.screen), 0);
});

test("a configured session_probe asks about the bound conversation", async (t) => {
  const f = setup(t);
  const probe = join(f.dir, "probe.js");
  writeFileSync(
    probe,
    `let input = ""; process.stdin.on("data", (c) => (input += c)).on("end", () => {
  const { session_id } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ result: session_id === ${JSON.stringify(CONVERSATION)} ? "gone" : "present" }));
});`,
  );
  const { configuredProbe } = await import("../scripts/lib/notify-config.ts");
  assert.equal(configuredProbe(f.config), undefined);
  const ask = configuredProbe({
    ...f.config,
    screen: {
      ...f.config.screen,
      session_probe: { command: [process.execPath, probe], cwd: f.dir },
    },
  });
  assert.equal(await ask(), "gone");
});
