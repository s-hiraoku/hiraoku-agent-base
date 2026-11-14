import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  HermesDesktopScreen,
  ReceiptNotifier,
  SQLiteNotices,
  hermesDesktopPage,
  submissionId,
} from "../src/agent-notify/index.ts";
import { main } from "../scripts/hab-notify.ts";

// ADR-021, Hermes Desktop: notices reach a saved conversation through Desktop's
// display-only external-message reader (cursor-v1). Showing starts no model work.
const binding = {
  session_id: "20261114_101500_ab12cd",
  profile: "local-lab",
  backend_namespace: "hermes-local-mac-mini",
  profile_scope: "local-lab",
  receiver_id: "agent-b",
};

function message(id, patch = {}) {
  return {
    message_id: id,
    sender_id: "agent-a",
    from: "verify-a@grok-bot.hab",
    kind: "question",
    thread_id: "t-1",
    in_reply_to: null,
    sent_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    display: `verify-a@grok-bot.hab からのメッセージです。\n\n受信内容\n${id}\n\nどうしますか？`,
    handoff_prompt: `prompt ${id}`,
    ...patch,
  };
}

// The checks Hermes Desktop's route applies to every event and page
// (hermes_cli/web_routers/external_messages.py, _display_event and _run_reader).
const FIELDS = [
  "event_id",
  "source",
  "format",
  "sender_id",
  "receiver_id",
  "message_id",
  "address",
  "backend_namespace",
  "profile_scope",
  "owner_kind",
  "received_at",
  "text",
  "binding_id",
  "binding_generation",
  "logical_target",
  "stored_session_id",
  "handoff_state",
];
function assertHermesAccepts(page, after) {
  assert.equal(page.source, "external_agent");
  assert.ok(Array.isArray(page.events) && page.events.length <= 100);
  assert.match(page.next_cursor, /^[A-Za-z0-9_-]{1,2048}$/);
  assert.equal(typeof page.has_more, "boolean");
  if (page.has_more || page.events.length)
    assert.notEqual(page.next_cursor, after);
  for (const event of page.events) {
    assert.deepEqual(Object.keys(event).sort(), [...FIELDS].sort());
    assert.equal(event.source, "external_agent");
    assert.equal(event.format, "plain_text");
    assert.equal(event.owner_kind, "session");
    assert.equal(event.handoff_state, "pending");
    assert.ok(Number.isInteger(event.binding_generation));
    for (const key of FIELDS)
      if (key !== "text" && key !== "binding_generation") {
        assert.equal(typeof event[key], "string", key);
        assert.ok(event[key].length > 0 && event[key].length <= 2048, key);
      }
    assert.ok(Buffer.byteLength(event.text) <= 131072);
    assert.equal(event.backend_namespace, binding.backend_namespace);
    assert.equal(event.profile_scope, binding.profile_scope);
    assert.equal(event.stored_session_id, binding.session_id);
  }
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-hermes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "screen.jsonl") };
}

test("Hermes Desktop pages show each notice once, in order, in Hermes's event shape", async (t) => {
  const { path } = setup(t);
  assert.deepEqual(hermesDesktopPage(path, binding, { limit: 100 }), {
    source: "external_agent",
    events: [],
    next_cursor: "0",
    has_more: false,
  });
  const screen = new HermesDesktopScreen(path, binding);
  assert.equal(
    screen.target,
    "hermes-desktop:local-lab:20261114_101500_ab12cd",
  );
  for (const id of ["m1", "m2", "m3"]) await screen.show(message(id));
  const first = hermesDesktopPage(path, binding, { limit: 2 });
  assertHermesAccepts(first);
  assert.deepEqual(
    first.events.map((e) => e.message_id),
    ["m1", "m2"],
  );
  assert.equal(first.has_more, true);
  assert.equal(first.events[0].text, message("m1").display);
  assert.equal(first.events[0].address, "verify-a@grok-bot.hab");
  const second = hermesDesktopPage(path, binding, {
    limit: 2,
    after: first.next_cursor,
  });
  assertHermesAccepts(second, first.next_cursor);
  assert.deepEqual(
    second.events.map((e) => e.message_id),
    ["m3"],
  );
  assert.equal(second.has_more, false);
  const end = hermesDesktopPage(path, binding, {
    limit: 2,
    after: second.next_cursor,
  });
  assertHermesAccepts(end, second.next_cursor);
  assert.equal(end.events.length, 0);
  assert.equal(end.next_cursor, second.next_cursor);
  // Showing again is a new event with its own ID, never a conflicting duplicate.
  await screen.show(message("m1"));
  const again = hermesDesktopPage(path, binding, {
    limit: 100,
    after: end.next_cursor,
  });
  assert.equal(again.events.length, 1);
  assert.notEqual(again.events[0].event_id, first.events[0].event_id);
  assert.throws(
    () => hermesDesktopPage(path, binding, { limit: 1, after: "x;" }),
    /invalid_cursor/,
  );
});

test("対応する on Hermes Desktop is reported unsupported and starts nothing elsewhere", async (t) => {
  const { dir, path } = setup(t);
  const screen = new HermesDesktopScreen(path, binding);
  const store = new SQLiteNotices(join(dir, "notices.sqlite"), screen.target);
  t.after(() => store.close());
  const read = [];
  const hab = {
    unread: [message("m1")],
    async peek() {
      return { messages: hab.unread, next_cursor: null };
    },
    async markRead(id, sender) {
      read.push(`${sender}/${id}`);
      hab.unread = [];
      return true;
    },
  };
  const notifier = new ReceiptNotifier({ hab, screen, store });
  assert.deepEqual(await notifier.check(), ["m1"]);
  assert.deepEqual(read, []);
  assert.deepEqual(await notifier.decide("m1", "accept"), {
    changed: true,
    state: "unsupported",
  });
  assert.deepEqual(read, ["agent-a/m1"]);
  assert.equal(
    hermesDesktopPage(path, binding, { limit: 100 }).events.length,
    1,
  );
});

test("hab-notify events is the Hermes reader: one JSON page, no store, no HAB", async (t) => {
  const { dir, path } = setup(t);
  const config = join(dir, "notify.json");
  const store = join(dir, "notices.sqlite");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.invalid/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN_UNSET" },
      store,
      screen: {
        type: "hermes-desktop",
        path,
        session_id: binding.session_id,
        profile: binding.profile,
        backend_namespace: binding.backend_namespace,
        profile_scope: binding.profile_scope,
      },
    }),
  );
  await new HermesDesktopScreen(path, binding).show(message("m1"));
  const lines = [];
  const out = (line) => lines.push(line);
  // Hermes appends --limit 100, then --after <cursor> once it has one.
  assert.equal(
    await main(["--config", config, "events", "--limit", "100"], out),
    0,
  );
  const page = JSON.parse(lines.at(-1));
  assertHermesAccepts(page);
  assert.equal(page.events[0].receiver_id, "agent-b");
  assert.equal(
    await main(
      [
        "--config",
        config,
        "events",
        "--limit",
        "100",
        "--after",
        page.next_cursor,
      ],
      out,
    ),
    0,
  );
  assert.equal(JSON.parse(lines.at(-1)).events.length, 0);
  assert.equal(existsSync(store), false);
  assert.equal(
    await main(["--config", config, "events", "--limit", "101"], out),
    2,
  );
  assert.equal(
    await main(["--config", config, "events", "--after", "bad;"], out),
    1,
  );
});

test("対応する runs the configured handoff once and maps its answer", async (t) => {
  const { dir, path } = setup(t);
  const seen = join(dir, "seen.jsonl");
  // A stand-in for hermes_bridge.desktop_handoff: records its stdin, answers ANSWER.
  const script = [
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{",
    "require('fs').appendFileSync(process.env.SEEN,s+'\\n');",
    "if(process.env.ANSWER==='exit')process.exit(3);",
    "console.log(JSON.stringify({result:process.env.ANSWER}));});",
  ].join("");
  const screenWith = (answer) =>
    new HermesDesktopScreen(path, binding, {
      handoff: {
        command: [process.execPath, "-e", script],
        cwd: dir,
        env: { SEEN: seen, ANSWER: answer },
      },
    });
  assert.equal(await screenWith("queued").handoff(message("m1")), "queued");
  const [request] = readFileSync(seen, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(request, {
    session_id: binding.session_id,
    text: "prompt m1",
    submission_id: submissionId({ sender_id: "agent-a", message_id: "m1" }),
  });
  assert.equal(
    await screenWith("refused").handoff(message("m2")),
    "unsupported",
  );
  await assert.rejects(
    screenWith("unknown").handoff(message("m3")),
    /handoff_unknown/,
  );
  await assert.rejects(
    screenWith("exit").handoff(message("m4")),
    /handoff_failed/,
  );

  // Through the notifier: an unknown answer is recorded and never resent.
  const screen = screenWith("unknown");
  const store = new SQLiteNotices(join(dir, "n.sqlite"), screen.target);
  t.after(() => store.close());
  const hab = {
    async peek() {
      return { messages: [message("m5")], next_cursor: null };
    },
    async markRead() {
      return true;
    },
  };
  const notifier = new ReceiptNotifier({ hab, screen, store });
  await notifier.check();
  assert.deepEqual(await notifier.decide("m5", "accept"), {
    changed: true,
    state: "unknown",
  });
  assert.deepEqual(await notifier.decide("m5", "accept"), {
    changed: false,
    state: "unknown",
  });
  assert.equal(readFileSync(seen, "utf8").trim().split("\n").length, 5);
});

test("submission IDs never collide across sender/message splits", () => {
  const a = submissionId({ sender_id: "agent-a", message_id: "b-c" });
  const b = submissionId({ sender_id: "agent-a-b", message_id: "c" });
  assert.notEqual(a, b);
  assert.match(a, /^hab-[0-9a-f]{32}$/);
});

test("a handoff command that exits without reading a large prompt is a failure, not a crash", async (t) => {
  const { dir, path } = setup(t);
  const screen = new HermesDesktopScreen(path, binding, {
    handoff: { command: [process.execPath, "-e", "process.exit(0)"], cwd: dir },
  });
  await assert.rejects(
    screen.handoff(
      message("m1", { handoff_prompt: "x".repeat(4 * 1024 * 1024) }),
    ),
  );
});

test("a screen file reused under another binding never relabels old notices", async (t) => {
  const { path } = setup(t);
  await new HermesDesktopScreen(path, binding).show(message("m1"));
  const other = { ...binding, session_id: "20261114_other" };
  await new HermesDesktopScreen(path, other).show(message("m2"));
  const forOther = hermesDesktopPage(path, other, { limit: 100 });
  assert.deepEqual(
    forOther.events.map((e) => [e.message_id, e.stored_session_id]),
    [["m2", "20261114_other"]],
  );
  assert.equal(forOther.next_cursor, "2");
  const forOriginal = hermesDesktopPage(path, binding, { limit: 1 });
  assert.deepEqual(
    forOriginal.events.map((e) => e.message_id),
    ["m1"],
  );
  // A page of only foreign notices still moves the cursor, as Hermes requires.
  const skipped = hermesDesktopPage(path, binding, { limit: 1, after: "1" });
  assert.deepEqual(skipped, {
    source: "external_agent",
    events: [],
    next_cursor: "2",
    has_more: false,
  });
});

test("an existing screen file others can read is refused before any notice is written", async (t) => {
  const { path } = setup(t);
  writeFileSync(path, "");
  chmodSync(path, 0o644);
  await assert.rejects(
    new HermesDesktopScreen(path, binding).show(message("m1")),
    /insecure_screen_file/,
  );
  assert.equal(readFileSync(path, "utf8"), "");
});

test("hab-notify action records a Desktop button press only for this card's binding", async (t) => {
  const { dir, path } = setup(t);
  const config = join(dir, "notify.json");
  const storePath = join(dir, "notices.sqlite");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.invalid/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN_UNSET" },
      store: storePath,
      screen: {
        type: "hermes-desktop",
        path,
        session_id: binding.session_id,
        profile: binding.profile,
        backend_namespace: binding.backend_namespace,
        profile_scope: binding.profile_scope,
      },
    }),
  );
  // Show m1 through the same store and screen the CLI will open.
  const screen = new HermesDesktopScreen(path, binding);
  const store = new SQLiteNotices(storePath, screen.target);
  const hab = {
    async peek() {
      return { messages: [message("m1")], next_cursor: null };
    },
    async markRead() {
      throw new Error("not called");
    },
  };
  await new ReceiptNotifier({ hab, screen, store }).check();
  store.close();

  const press = {
    action: "decide",
    backend_namespace: binding.backend_namespace,
    profile_scope: binding.profile_scope,
    receiver_id: "agent-b",
    sender_id: "agent-a",
    message_id: "m1",
    stored_session_id: binding.session_id,
    choice: "later",
  };
  const lines = [];
  const run = (body) =>
    main(
      ["--config", config, "action"],
      (line) => lines.push(line),
      () => (typeof body === "string" ? body : JSON.stringify(body)),
    );
  for (const wrong of [
    { stored_session_id: "20261114_other" },
    { backend_namespace: "other" },
    { profile_scope: "other" },
    { receiver_id: "agent-c" },
  ]) {
    assert.equal(await run({ ...press, ...wrong }), 1);
    assert.deepEqual(JSON.parse(lines.at(-1)), { error: "binding_mismatch" });
  }
  for (const bad of [
    "",
    "{",
    { ...press, choice: "run" },
    { ...press, x: 1 },
  ]) {
    assert.equal(await run(bad), 2);
    assert.deepEqual(JSON.parse(lines.at(-1)), { error: "invalid_request" });
  }
  assert.equal(await run(press), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)), { changed: true, state: "later" });
  assert.equal(await run(press), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)), {
    changed: false,
    state: "later",
  });
});

test("a notice that does not fit is not half written, and a broken last line is never read", async (t) => {
  const { dir, path } = setup(t);
  await new HermesDesktopScreen(path, binding).show(message("m1"));
  const before = readFileSync(path);
  // Under a 1 KiB file-size limit the write is cut short without throwing.
  const script = [
    `import { HermesDesktopScreen } from ${JSON.stringify(new URL("../src/agent-notify/index.ts", import.meta.url).href)};`,
    `const binding = ${JSON.stringify(binding)};`,
    `const m = ${JSON.stringify(message("m2", { display: "x".repeat(10_000) }))};`,
    `try { await new HermesDesktopScreen(${JSON.stringify(path)}, binding).show(m); console.log("ok"); }`,
    `catch (e) { console.log("failed"); }`,
  ].join("\n");
  const run = spawnSync(
    "bash",
    [
      "-c",
      'ulimit -f 1 && exec "$0" --input-type=module -e "$1"',
      process.execPath,
      script,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(run.stdout.trim(), "failed");
  assert.deepEqual(readFileSync(path), before);
  // A line still being written (no newline yet) is left for the next page.
  writeFileSync(
    path,
    before.toString() + '{"type":"notice","message_id":"m3"',
    {
      mode: 0o600,
    },
  );
  assert.deepEqual(
    hermesDesktopPage(path, binding, { limit: 100 }).events.map(
      (e) => e.message_id,
    ),
    ["m1"],
  );
});
