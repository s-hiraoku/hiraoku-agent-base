import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HermesDesktopScreen,
  ReceiptNotifier,
  SQLiteNotices,
  hermesDesktopPage,
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
