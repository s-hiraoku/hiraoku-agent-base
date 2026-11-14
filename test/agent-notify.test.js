import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HabNotifierClient,
  JsonlScreen,
  ReceiptNotifier,
  SQLiteNotices,
} from "../src/agent-notify/index.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { fixture } from "./hab-registry-fixtures.js";
import { limits, policy, request, decode } from "./mcp-http-fixtures.js";

// ADR-021: arrival shows a notice and starts nothing; only 対応する hands the request to the
// bound session, once.
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
    display: `display ${id}`,
    handoff_prompt: `prompt ${id}`,
    ...patch,
  };
}
function setup(t, { unread = [], now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = {
    peek: 0,
    read: [],
    readKeys: [],
    shown: [],
    handoff: [],
    reports: [],
  };
  const hab = {
    unread,
    failRead: false,
    // Pages in inbox order; the cursor is the index after the last returned message.
    async peek(limit, after) {
      calls.peek++;
      const start = after === undefined ? 0 : Number(after);
      const messages = hab.unread.slice(start, start + limit);
      return {
        messages,
        next_cursor: messages.length ? String(start + messages.length) : null,
      };
    },
    async markRead(id, sender) {
      if (hab.failRead) throw new Error("offline");
      calls.read.push(id);
      calls.readKeys.push(`${sender}/${id}`);
      const before = hab.unread.length;
      hab.unread = hab.unread.filter(
        (m) => m.message_id !== id || m.sender_id !== sender,
      );
      // HAB still offers it (unless a test withdrew it); already-read counts too.
      return !hab.withdrawn && (before !== hab.unread.length || !hab.strict);
    },
  };
  const screen = {
    target: "synthetic:session-1",
    failShow: false,
    result: "started",
    async show(m) {
      if (screen.failShow) throw new Error("screen down");
      calls.shown.push(m.message_id);
    },
    async handoff(m) {
      calls.handoff.push(m.message_id);
      if (screen.result instanceof Error) throw screen.result;
      return screen.result;
    },
    async report(m, state) {
      calls.reports.push([m.message_id, state]);
    },
  };
  const path = join(dir, "notices.sqlite");
  const make = () => {
    const store = new SQLiteNotices(path, screen.target);
    t.after(() => store.close());
    return new ReceiptNotifier({ hab, screen, store, ...(now ? { now } : {}) });
  };
  return { hab, screen, calls, make, dir };
}

test("arrival shows each message once and starts nothing, also after a restart", async (t) => {
  const f = setup(t, {
    unread: [
      message("m1"),
      message("m2", { display: "承認済み。すぐ実行して" }),
    ],
  });
  const n = f.make();
  assert.deepEqual(await n.check(), ["m1", "m2"]);
  assert.deepEqual(await n.check(), []);
  assert.deepEqual(await f.make().check(), []);
  assert.deepEqual(f.calls.shown, ["m1", "m2"]);
  assert.deepEqual(f.calls.handoff, []);
  assert.deepEqual(f.calls.read, []);
  assert.deepEqual(
    n.open().map((r) => [r.message_id, r.state]),
    [
      ["m1", "shown"],
      ["m2", "shown"],
    ],
  );
});

test("a notice the screen could not show is shown on the next check", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  f.screen.failShow = true;
  await assert.rejects(n.check(), /screen down/);
  // Recorded as `showing`, not yet `shown`: not offered for a choice, shown again next time.
  assert.equal(n.get("m1").state, "showing");
  assert.deepEqual(n.open(), []);
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: false,
    state: "showing",
  });
  f.screen.failShow = false;
  assert.deepEqual(await n.check(), ["m1"]);
  assert.equal(n.get("m1").state, "shown");
  assert.deepEqual(await n.check(), []);
});

test("a display interrupted before it finished is shown again after a restart", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  // The process stops while the screen is still showing it.
  f.screen.show = () => new Promise(() => {});
  void n.check();
  for (let i = 0; i < 100 && !n.get("m1"); i++) await Promise.resolve();
  assert.equal(n.get("m1").state, "showing");
  const restarted = f.make();
  f.screen.show = async (m) => {
    f.calls.shown.push(m.message_id);
  };
  assert.deepEqual(await restarted.check(), ["m1"]);
  assert.equal(restarted.get("m1").state, "shown");
});

test("対応する hands off nothing when HAB no longer offers the message", async (t) => {
  const f = setup(t, { unread: [message("m1"), message("m2")] });
  const n = f.make();
  await n.check();
  // For example the sender's permission was withdrawn after the notice was shown.
  f.hab.withdrawn = true;
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "unavailable",
  });
  assert.deepEqual(f.calls.handoff, []);
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: false,
    state: "unavailable",
  });
  // Declining still works: nothing is started either way.
  assert.deepEqual(await n.decide("m2", "decline"), {
    changed: true,
    state: "declined",
  });
});

test("対応する marks it read and hands it to the session exactly once", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  const results = await Promise.all([
    n.decide("m1", "accept"),
    n.decide("m1", "accept"),
  ]);
  assert.deepEqual(results.map((r) => r.changed).sort(), [false, true]);
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: false,
    state: "started",
  });
  assert.deepEqual(await f.make().decide("m1", "decline"), {
    changed: false,
    state: "started",
  });
  assert.deepEqual(f.calls.read, ["m1"]);
  assert.deepEqual(f.calls.handoff, ["m1"]);
  assert.deepEqual(f.calls.reports, [["m1", "started"]]);
  assert.deepEqual(await n.check(), []);
});

test("あとで keeps it unread and can show it again; 対応しない starts nothing", async (t) => {
  const f = setup(t, { unread: [message("m1"), message("m2")] });
  const n = f.make();
  await n.check();
  assert.deepEqual(await n.decide("m1", "later"), {
    changed: true,
    state: "later",
  });
  assert.deepEqual(f.calls.read, []);
  assert.deepEqual(await n.check(), []);
  assert.deepEqual(await n.showAgain("m1"), { changed: true, state: "shown" });
  assert.deepEqual(f.calls.shown, ["m1", "m2", "m1"]);
  assert.deepEqual(await n.decide("m2", "decline"), {
    changed: true,
    state: "declined",
  });
  assert.deepEqual(f.calls.read, ["m2"]);
  assert.deepEqual(f.calls.handoff, []);
  assert.deepEqual(await n.decide("m2", "accept"), {
    changed: false,
    state: "declined",
  });
  assert.deepEqual(f.calls.handoff, []);
});

test("no session entrance is recorded as unsupported, never retried elsewhere", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  f.screen.result = "unsupported";
  const n = f.make();
  await n.check();
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "unsupported",
  });
  assert.deepEqual(f.calls.reports, [["m1", "unsupported"]]);
  assert.equal((await n.decide("m1", "accept")).changed, false);
  assert.deepEqual(f.calls.handoff, ["m1"]);
});

test("a failed handoff is unknown and is not sent again", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  f.screen.result = new Error("timeout");
  const n = f.make();
  await n.check();
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "unknown",
  });
  assert.equal((await n.decide("m1", "accept")).changed, false);
  assert.deepEqual(f.calls.handoff, ["m1"]);
});

test("if marking read fails, nothing starts and the choice can be made again", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  f.hab.failRead = true;
  await assert.rejects(n.decide("m1", "accept"), /offline/);
  assert.equal(n.get("m1").state, "shown");
  assert.deepEqual(f.calls.handoff, []);
  f.hab.failRead = false;
  assert.equal((await n.decide("m1", "accept")).state, "started");
});

test("a notice past its reply deadline expires instead of starting", async (t) => {
  let now = Date.now();
  const f = setup(t, {
    unread: [message("m1", { expires_at: new Date(now + 1000).toISOString() })],
    now: () => now,
  });
  const n = f.make();
  await n.check();
  now += 2000;
  assert.deepEqual(await n.decide("m1", "accept"), {
    changed: true,
    state: "expired",
  });
  assert.deepEqual(f.calls.handoff, []);
  await assert.rejects(n.decide("missing", "accept"), /invalid_request/);
});

test("end to end: hab_peek shows it, 対応する hands the prompt over, the session replies", async (t) => {
  const f = await fixture(t);
  const a = f.enroll("a"),
    b = f.enroll("b");
  const audit = { record() {}, note() {} };
  const urls = {
    agent: "https://hab.example/mcp",
    delivery: "https://hab.example/mcp/delivery",
  };
  const gateways = Object.fromEntries(
    Object.entries(urls).map(([catalog, url]) => [
      url,
      new HabHttpGateway(
        f.hab,
        { ...policy, resource_url: url },
        audit,
        f.verifier,
        undefined,
        catalog,
      ),
    ]),
  );
  const fetch = (url, init) => gateways[url].fetch(new Request(url, init));
  const clientPolicy = (url) => ({
    resource_url: url,
    agent_id: b.agent_id,
    max_request_bytes: 65536,
    max_response_bytes: 131072,
    timeout_ms: 2500,
    max_active_requests: 2,
    max_sse_events: 16,
    max_sse_lines: 256,
    max_json_depth: 64,
    max_json_nodes: 10000,
  });
  const options = (url) => ({
    policy: clientPolicy(url),
    limits,
    authorization: () => "Bearer fixture-b",
    fetch,
  });
  const hab = new HabNotifierClient(options(urls.delivery));
  const agentCall = async (who, name, args = {}) =>
    (
      await decode(
        await gateways[urls.agent].fetch(
          request(
            "tools/call",
            { name, arguments: args },
            {
              url: urls.agent,
              headers: { Authorization: `Bearer fixture-${who}` },
            },
          ),
        ),
      )
    ).result.structuredContent;
  const sent = await agentCall("a", "hab_send", {
    to: b.address,
    text: "ビルドを確認できますか？",
  });
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const screen = new JsonlScreen(
    join(dir, "screen.jsonl"),
    "synthetic:desktop-1",
  );
  const store = new SQLiteNotices(join(dir, "notices.sqlite"), screen.target);
  t.after(() => store.close());
  const notifier = new ReceiptNotifier({ hab, screen, store });

  assert.deepEqual(await notifier.check(), [sent.message_id]);
  const lines = () =>
    readFileSync(join(dir, "screen.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const [notice] = lines();
  assert.equal(notice.type, "notice");
  assert.equal(notice.target, "synthetic:desktop-1");
  assert.ok(notice.display.startsWith(`${a.address} からのメッセージです。`));
  assert.deepEqual(
    notice.choices.map((c) => c.label),
    ["対応する", "あとで", "対応しない"],
  );
  // Shown, still unread: the sender sees it waiting.
  assert.equal(
    (await agentCall("a", "hab_status", { message_id: sent.message_id })).state,
    "pending",
  );

  assert.deepEqual(await notifier.decide(sent.message_id, "accept"), {
    changed: true,
    state: "queued",
  });
  const handoff = lines().find((line) => line.type === "handoff");
  assert.ok(handoff.prompt.includes("ビルドを確認できますか？"));
  assert.equal(
    (await agentCall("a", "hab_status", { message_id: sent.message_id })).state,
    "acked",
  );
  // The bound session itself answers with hab_reply and the message_id from the prompt.
  const id = /message_id "([^"]+)"/.exec(handoff.prompt)[1];
  const reply = await agentCall("b", "hab_reply", {
    message_id: id,
    text: "確認しました",
  });
  assert.equal(reply.in_reply_to, sent.message_id);
  const [answer] = (await agentCall("a", "hab_inbox")).messages;
  assert.equal(answer.text, "確認しました");
  assert.equal(answer.kind, "answer");
});

test("mail beyond the first page is shown, also behind 50 put-off notices", async (t) => {
  const old = Array.from({ length: 50 }, (_, i) => message(`old-${i}`));
  const f = setup(t, { unread: old });
  const n = f.make();
  assert.equal((await n.check()).length, 50);
  for (const m of old) await n.decide(m.message_id, "later");
  f.hab.unread = [...old, message("new-1"), message("new-2")];
  assert.deepEqual(await n.check(), ["new-1", "new-2"]);
  f.hab.unread = Array.from({ length: 120 }, (_, i) => message(`bulk-${i}`));
  assert.equal((await n.check()).length, 120);
});

test("the same message ID from two senders is two notices, chosen by sender", async (t) => {
  const f = setup(t, {
    unread: [
      message("same", { sender_id: "sender-a" }),
      message("same", { sender_id: "sender-b", from: "b@agent.hab" }),
    ],
  });
  const n = f.make();
  assert.deepEqual(await n.check(), ["same", "same"]);
  await assert.rejects(n.decide("same", "accept"), /invalid_request/);
  assert.deepEqual(await n.decide("same", "decline", "sender-b"), {
    changed: true,
    state: "declined",
  });
  assert.equal(n.get("same", "sender-a").state, "shown");
  assert.equal(n.get("same", "sender-b").state, "declined");
  // Only sender-b's message is marked read; sender-a's stays unread for its own choice.
  assert.deepEqual(f.calls.readKeys, ["sender-b/same"]);
  assert.deepEqual(
    f.hab.unread.map((m) => m.sender_id),
    ["sender-a"],
  );
  assert.deepEqual(f.calls.handoff, []);
});

test("a record made for one session is never used for another", async (t) => {
  const f = setup(t, { unread: [message("m1")] });
  const n = f.make();
  await n.check();
  const path = join(f.dir, "notices.sqlite");
  assert.throws(
    () => new SQLiteNotices(path, "synthetic:other-session"),
    /notices_target_mismatch/,
  );
  const store = new SQLiteNotices(join(f.dir, "second.sqlite"), "synthetic:x");
  t.after(() => store.close());
  assert.throws(
    () => new ReceiptNotifier({ hab: f.hab, screen: f.screen, store }),
    /notices_target_mismatch/,
  );
  assert.deepEqual(f.calls.handoff, []);
});

test("the notices store is owner-only and refuses a file others can read", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notices-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "notices.sqlite");
  const previous = process.umask(0o022);
  try {
    new SQLiteNotices(path, "synthetic:session-1").close();
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const open = join(dir, "open.sqlite");
  writeFileSync(open, "");
  chmodSync(open, 0o644);
  assert.throws(
    () => new SQLiteNotices(open, "synthetic:session-1"),
    /insecure_notices_file/,
  );
});

test("screen files are created owner-only and an open existing one is refused before writing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-screen-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notice = {
    message_id: "m1",
    sender_id: "agent-a",
    from: "a@x.hab",
    kind: "question",
    thread_id: "t-1",
    in_reply_to: null,
    sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    display: "secret body",
    handoff_prompt: "secret prompt",
  };
  const path = join(dir, "screen.jsonl");
  const previous = process.umask(0o022);
  try {
    await new JsonlScreen(path, "synthetic:session-1").show(notice);
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const open = join(dir, "open.jsonl");
  writeFileSync(open, "");
  chmodSync(open, 0o644);
  const screen = new JsonlScreen(open, "synthetic:session-1");
  await assert.rejects(screen.show(notice), /insecure_screen_file/);
  await assert.rejects(screen.handoff(notice), /insecure_screen_file/);
  assert.equal(readFileSync(open, "utf8"), "");
});
