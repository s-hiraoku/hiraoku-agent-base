import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer as createHttpServer } from "node:http";
import { HabHttpGateway } from "../src/hab/http.ts";
import {
  CALLBACK_ENDPOINT_ERROR,
  HAB_EVENT_NAME,
  HabEvents,
  callbackUrl,
  createHttpsPost,
  createLoopbackPost,
  createWebhookPost,
  isPublicAddress,
  readDoorbells,
  signWebhook,
} from "../src/hab/events.ts";
import { fixture } from "./hab-registry-fixtures.js";
import { startWakeListener } from "../src/agent-notify/wake-listener.ts";
import { policy, request, decode } from "./mcp-http-fixtures.js";

// ADR-022: a cloud agent (ChatGPT/Dots) subscribes over its MCP connection and the host
// POSTs a signed doorbell when mail waits. The doorbell has no body, sender, kind or IDs.

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const URL_A = "https://hooks.example.com/cb/a";

/** A fake callback that answers verification challenges and records deliveries. */
function hooks(status = () => 200, delayMs = 0, onEvent = async () => {}) {
  const seen = [];
  const post = async (url, body, headers) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const parsed = JSON.parse(body);
    seen.push({ url, body, parsed, headers });
    if (parsed.type === "verification")
      return {
        status: 200,
        body: JSON.stringify({ challenge: parsed.challenge }),
      };
    await onEvent(parsed);
    const answer = status(parsed);
    return typeof answer === "object" ? answer : { status: answer, body: "" };
  };
  return {
    seen,
    post,
    events: () => seen.filter((s) => s.parsed.type !== "verification"),
  };
}

let lastStore;
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  lastStore = join(dir, "events.sqlite");
  return lastStore;
}

async function setup(t, options = {}) {
  const f = await fixture(t, options.registry);
  const a = f.enroll("a"),
    b = f.enroll("b");
  let self;
  const h = hooks(options.status, options.delayMs, (parsed) =>
    options.onEvent ? options.onEvent(self, parsed) : undefined,
  );
  const events = new HabEvents(f.hab, {
    store: temp(t),
    post: h.post,
    // The ADR-031 inbox check is off unless a test is about it.
    inbox_check_ms: 0,
    ...(typeof options.events === "function"
      ? options.events({ a, b })
      : options.events),
  });
  t.after(() => events.close());
  const audit = { record() {}, note() {} };
  const gateway = new HabHttpGateway(
    f.hab,
    policy,
    audit,
    f.verifier,
    undefined,
    "agent",
    events,
  );
  const rpc = async (who, method, params = {}) =>
    decode(
      await gateway.fetch(
        request(method, params, {
          headers: { Authorization: `Bearer fixture-${who}` },
        }),
      ),
    );
  const send = async (from, to, text) => {
    const body = await rpc(from, "tools/call", {
      name: "hab_send",
      arguments: { to, text },
    });
    assert.notEqual(body.result.isError, true, JSON.stringify(body));
    return body.result.structuredContent;
  };
  const subscribe = (who, extra = {}) =>
    rpc(who, "events/subscribe", {
      name: HAB_EVENT_NAME,
      arguments: {},
      delivery: { mode: "webhook", url: URL_A, secret: SECRET },
      cursor: null,
      ...extra,
    });
  self = {
    ...f,
    a,
    b,
    h,
    events,
    gateway,
    rpc,
    send,
    subscribe,
    store: lastStore,
  };
  return self;
}

test("Standard Webhooks signature matches the published test vector", () => {
  assert.equal(
    signWebhook(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    ),
    "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  );
  assert.throws(
    () => signWebhook("whsec_c2hvcnQ=", "m", 1, "{}"),
    /invalid_secret/,
  );
  assert.throws(() => signWebhook("secret", "m", 1, "{}"), /invalid_secret/);
});

test("callbacks must be public HTTPS; private, local and mapped addresses are refused", async () => {
  assert.equal(
    callbackUrl("https://hooks.example.com/x?y=1").hostname,
    "hooks.example.com",
  );
  for (const bad of [
    "http://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://hooks.example.com/x#frag",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://[::1]/x",
    "https://[::ffff:192.168.1.1]/x",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://mac-mini.local/x",
    "ftp://hooks.example.com/x",
    42,
  ])
    assert.throws(() => callbackUrl(bad), /invalid_callback_url/, String(bad));
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  for (const ip of [
    "100.100.1.1",
    "172.20.0.1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  // A public name that resolves to a private address never gets a connection.
  const post = createHttpsPost(async () => [
    { address: "10.0.0.5", family: 4 },
  ]);
  await assert.rejects(
    post("https://rebind.example.com/x", "{}", {}),
    /callback_not_public/,
  );
  const mixed = createHttpsPost(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    mixed("https://rebind.example.com/x", "{}", {}),
    /callback_not_public/,
  );
});

test("the agent endpoint advertises events and lists one doorbell event without content", async (t) => {
  const f = await setup(t);
  const init = await f.rpc("a", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic", version: "1" },
  });
  // Modern requests carry capabilities through server/discover; either way `events` is there.
  const discover = await f.rpc("a", "server/discover", {});
  const capabilities =
    discover.result?.capabilities ?? init.result?.capabilities;
  assert.ok(capabilities?.events, JSON.stringify({ init, discover }));
  const listed = await f.rpc("a", "events/list", {});
  assert.deepEqual(
    listed.result.events.map((e) => e.name),
    [HAB_EVENT_NAME],
  );
  const [event] = listed.result.events;
  assert.deepEqual(event.delivery, ["webhook"]);
  assert.deepEqual(Object.keys(event.payloadSchema.properties).sort(), [
    "arrived_at",
    "to",
  ]);
  // Without a valid credential nothing is listed.
  const anonymous = await f.gateway.fetch(
    request("events/list", {}, { headers: { Authorization: "Bearer nobody" } }),
  );
  assert.equal(anonymous.status, 401);
});

test("subscribe verifies the callback with a signed challenge and is idempotent", async (t) => {
  const f = await setup(t);
  const first = await f.subscribe("a");
  assert.equal(first.error, undefined, JSON.stringify(first));
  const { id, refreshBefore, cursor, truncated } = first.result;
  assert.match(id, /^hab_sub_[a-f0-9]{32}$/);
  assert.equal(cursor, null);
  assert.equal(truncated, false);
  const ttl = Date.parse(refreshBefore) - Date.now();
  assert.ok(ttl > 3_500_000 && ttl <= 3_600_000, String(ttl));
  const [verify] = f.h.seen;
  assert.equal(verify.url, URL_A);
  assert.equal(verify.parsed.type, "verification");
  assert.equal(verify.headers["X-MCP-Subscription-Id"], id);
  assert.equal(
    verify.headers["webhook-signature"],
    signWebhook(
      SECRET,
      verify.headers["webhook-id"],
      Number(verify.headers["webhook-timestamp"]),
      verify.body,
    ),
  );
  // Same identity → same ID, no second challenge within the cache period, one record.
  const again = await f.subscribe("a", { ttlMs: 120_000 });
  assert.equal(again.result.id, id);
  assert.equal(f.h.seen.length, 1);
  assert.equal(f.events.subscriptions().length, 1);
  // Another recipient on the same callback is a different subscription.
  const other = await f.subscribe("b");
  assert.notEqual(other.result.id, id);
  assert.equal(f.events.subscriptions().length, 2);
});

test("a callback that does not echo the challenge is refused with CallbackEndpointError", async (t) => {
  const f = await setup(t);
  const bad = new HabEvents(f.hab, {
    store: temp(t),
    post: async () => ({
      status: 200,
      body: JSON.stringify({ challenge: "nope" }),
    }),
  });
  t.after(() => bad.close());
  const gateway = new HabHttpGateway(
    f.hab,
    policy,
    { record() {}, note() {} },
    f.verifier,
    undefined,
    "agent",
    bad,
  );
  const body = await decode(
    await gateway.fetch(
      request("events/subscribe", {
        name: HAB_EVENT_NAME,
        arguments: {},
        delivery: { mode: "webhook", url: URL_A, secret: SECRET },
      }),
    ),
  );
  assert.equal(body.error.code, CALLBACK_ENDPOINT_ERROR);
  assert.equal(body.error.data.reason, "challenge_failed");
  assert.equal(bad.subscriptions().length, 0);
  for (const [patch, reason] of [
    [{ name: "other.event" }, "unknown_event"],
    [{ arguments: { x: 1 } }, "invalid_arguments"],
    [
      { delivery: { mode: "poll", url: URL_A, secret: SECRET } },
      "unsupported_delivery",
    ],
    [
      {
        delivery: {
          mode: "webhook",
          url: "https://10.0.0.1/x",
          secret: SECRET,
        },
      },
      "invalid_callback_url",
    ],
    [
      { delivery: { mode: "webhook", url: URL_A, secret: "whsec_c2hvcnQ=" } },
      "invalid_secret",
    ],
  ]) {
    const refused = await f.subscribe("a", patch);
    assert.equal(refused.error?.data?.reason, reason, JSON.stringify(refused));
  }
});

test("new mail rings the doorbell once per message, without content, and reading is still hab_inbox", async (t) => {
  // quiet: false rings every message (ADR-030 holds newer mail by default).
  const f = await setup(t, { events: { quiet: false } });
  const { result } = await f.subscribe("a");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 0);
  const one = await f.send("b", f.a.address, "secret body one");
  const two = await f.send("b", f.a.address, "secret body two");
  await f.events.dispatch();
  await f.events.dispatch();
  const delivered = f.h.events();
  assert.equal(delivered.length, 2);
  for (const d of delivered) {
    assert.equal(d.parsed.name, HAB_EVENT_NAME);
    assert.deepEqual(Object.keys(d.parsed.data).sort(), ["arrived_at", "to"]);
    assert.equal(d.parsed.data.to, f.a.address);
    assert.equal(d.parsed.cursor, null);
    assert.equal(d.headers["webhook-id"], d.parsed.eventId);
    assert.equal(d.headers["X-MCP-Subscription-Id"], result.id);
    for (const secret of [
      "secret body",
      one.message_id,
      two.message_id,
      f.b.address,
      "question",
    ])
      assert.ok(!d.body.includes(secret), secret);
  }
  assert.notEqual(delivered[0].parsed.eventId, delivered[1].parsed.eventId);
  // The doorbell reads nothing: both messages are still unread for hab_inbox.
  const inbox = await f.rpc("a", "tools/call", {
    name: "hab_inbox",
    arguments: {},
  });
  assert.equal(
    inbox.result.structuredContent.messages.filter((m) => m.new).length,
    2,
  );
  // Mail for b does not ring a's subscription.
  await f.send("a", f.b.address, "for b");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
});

test("failed deliveries retry with backoff and the same event ID; 410 ends the subscription", async (t) => {
  let now = Date.now();
  let answer = 500;
  const f = await setup(t, {
    status: () => answer,
    events: { now: () => now, quiet: false },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "hello");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  await f.events.dispatch(); // still backing off
  assert.equal(f.h.events().length, 1);
  now += 5000;
  answer = 202;
  await f.events.dispatch();
  const [first, retry] = f.h.events();
  assert.equal(retry.parsed.eventId, first.parsed.eventId);
  now += 5000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2, "a delivered event is not sent again");
  answer = 410;
  await f.send("b", f.a.address, "again");
  await f.events.dispatch();
  assert.equal(f.events.subscriptions().length, 0);
});

test("subscriptions expire at refreshBefore and unsubscribe stops delivery", async (t) => {
  let now = Date.now();
  const f = await setup(t, { events: { now: () => now } });
  const sub = await f.subscribe("a", { ttlMs: 60_000 });
  assert.equal(Date.parse(sub.result.refreshBefore), now + 60_000);
  // The dispatcher keeps ticking, so this is ordinary expiry, not an outage.
  now += 30_000;
  await f.events.dispatch();
  now += 30_001;
  await f.send("b", f.a.address, "late");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 0);
  assert.equal(f.events.subscriptions().length, 0);
  // Lifetimes are capped; null (no expiry) is never granted.
  const long = await f.subscribe("a", { ttlMs: null });
  assert.ok(Date.parse(long.result.refreshBefore) - now <= 3_600_000);
  const unsub = await f.rpc("a", "events/unsubscribe", {
    name: HAB_EVENT_NAME,
    arguments: {},
    delivery: { mode: "webhook", url: URL_A },
  });
  assert.equal(unsub.error, undefined);
  assert.equal(f.events.subscriptions().length, 0);
  // b cannot remove a's subscription: the identity is the caller's own.
  await f.subscribe("a");
  await f.rpc("b", "events/unsubscribe", {
    name: HAB_EVENT_NAME,
    arguments: {},
    delivery: { mode: "webhook", url: URL_A },
  });
  assert.equal(f.events.subscriptions().length, 1);
});

test("the subscription store is owner-only and endpoints without events reject the methods", async (t) => {
  const f = await setup(t);
  await f.subscribe("a");
  const store = f.events.subscriptions();
  assert.equal(store.length, 1);
  assert.equal("secret" in store[0], false);
  const plain = new HabHttpGateway(
    f.hab,
    policy,
    { record() {}, note() {} },
    f.verifier,
    undefined,
    "agent",
  );
  const refused = await plain.fetch(request("events/list", {}));
  assert.equal(refused.status, 405);
  const path = temp(t);
  const e = new HabEvents(f.hab, { store: path, post: f.h.post });
  t.after(() => e.close());
  assert.equal(statSync(path).mode & 0o077, 0);
});

test("a webhook POST has a wall-clock deadline that covers name resolution", async () => {
  const post = createHttpsPost(() => new Promise(() => {}), 50);
  const started = Date.now();
  await assert.rejects(
    post(URL_A, "{}", {}),
    (error) => error.reason === "timeout",
  );
  assert.ok(Date.now() - started < 2000);
});

test("an unsubscribe during a delivery stops the rest of that pass", async (t) => {
  const f = await setup(t, {
    onEvent: (self) =>
      self.rpc("a", "events/unsubscribe", {
        name: HAB_EVENT_NAME,
        arguments: {},
        delivery: { mode: "webhook", url: URL_A },
      }),
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "one");
  await f.send("b", f.a.address, "two");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  assert.equal(f.events.subscriptions().length, 0);
});

test("concurrent subscribes cannot together pass the per-recipient limit", async (t) => {
  const f = await setup(t, { delayMs: 20, events: { max_per_agent: 2 } });
  const answers = await Promise.all(
    ["x", "y", "z"].map((n) =>
      f.subscribe("a", {
        delivery: {
          mode: "webhook",
          url: `https://hooks.example.com/cb/${n}`,
          secret: SECRET,
        },
      }),
    ),
  );
  assert.equal(answers.filter((r) => r.result).length, 2);
  const refused = answers.find((r) => r.error);
  assert.equal(refused.error.data.reason, "too_many_subscriptions");
  assert.equal(f.events.subscriptions().length, 2);
});

test("renewing an expired subscription needs a free slot, like a new one", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, max_per_agent: 1, outage_after_ms: 3_600_000 },
  });
  const urlB = "https://hooks.example.com/cb/b";
  const at = (url) => ({
    delivery: { mode: "webhook", url, secret: SECRET },
  });
  assert.ok((await f.subscribe("a", { ttlMs: 60_000 })).result);
  now += 60_001; // A expired; its row waits for the next dispatch cleanup
  assert.ok((await f.subscribe("a", at(urlB))).result);
  const renewed = await f.subscribe("a");
  assert.equal(renewed.error.data.reason, "too_many_subscriptions");
});

test("a message leased to a delivery client is still announced, so an expired lease is not skipped", async (t) => {
  const f = await setup(t, { events: { quiet: false } });
  await f.subscribe("a");
  const older = await f.send("b", f.a.address, "older");
  await f.send("b", f.a.address, "newer");
  f.raw
    .prepare(
      "UPDATE delivery_messages SET state='leased', lease_until=? WHERE message_id=?",
    )
    .run(Date.now() + 60_000, older.message_id);
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
});

test("each message gets its own retry budget", async (t) => {
  let now = Date.now();
  let answer = 500;
  const f = await setup(t, {
    status: () => answer,
    events: { now: () => now },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  for (let i = 0; i < 7; i++) {
    await f.events.dispatch();
    now += 400_000;
  }
  assert.equal(f.h.events().length, 7);
  // The first message is read before its last attempt; the next one starts from zero.
  await f.rpc("a", "tools/call", { name: "hab_inbox", arguments: {} });
  await f.send("b", f.a.address, "second");
  await f.events.dispatch(); // one failure for the second message
  now += 400_000;
  answer = 202;
  await f.events.dispatch();
  const second = f.h.events().slice(7);
  assert.equal(second.length, 2);
  assert.equal(second[0].parsed.eventId, second[1].parsed.eventId);
});

// The host stopping or the Mac sleeping must not cost a subscriber its doorbell: it could
// not refresh while HAB was unreachable (2026-11-17: an hour of sleep dropped Dots).
test("time the host was stopped or asleep is not counted against live subscriptions", async (t) => {
  let now = Date.now();
  const f = await setup(t, { events: { now: () => now } });
  const sub = await f.subscribe("a", { ttlMs: 600_000 });
  const until = Date.parse(sub.result.refreshBefore);
  now += 3000;
  await f.events.dispatch(); // a normal tick
  now += 3_600_000; // an hour asleep, past the subscription's lifetime
  await f.send("b", f.a.address, "while asleep");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1, "the doorbell still rings");
  const [row] = f.events.subscriptions();
  assert.equal(row.expires_at, until + 3_600_000);
  // The subscriber's next refresh is an ordinary renewal of the same subscription.
  const renewed = await f.subscribe("a", { ttlMs: 600_000 });
  assert.equal(renewed.result.id, sub.result.id);
  assert.equal(readDoorbells(f.store, now).get(f.a.agent_id).live, 1);
});

test("the outage credit is capped and never revives a subscription that had already ended", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, max_ttl_ms: 120_000 },
  });
  await f.subscribe("a", { ttlMs: 60_000 });
  now += 3000;
  await f.events.dispatch();
  now += 36_000_000; // ten hours down: at most max_ttl_ms (2 min) comes back
  await f.events.dispatch();
  assert.equal(f.events.subscriptions().length, 0);
  const lapsed = readDoorbells(f.store, now).get(f.a.agent_id);
  assert.equal(lapsed.live, 0);
  assert.equal(lapsed.reason, "expired");

  // Expired while the dispatcher was still ticking: an outage afterwards changes nothing.
  await f.subscribe("a", { ttlMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    now += 30_000;
    await f.events.dispatch();
  }
  assert.equal(f.events.subscriptions().length, 0);
  now += 3_600_000;
  await f.events.dispatch();
  assert.equal(f.events.subscriptions().length, 0);
});

test("operators can see when and why a recipient's doorbell stopped; subscribing clears it", async (t) => {
  let now = Date.now();
  let answer = 200;
  const f = await setup(t, {
    status: () => answer,
    events: { now: () => now },
  });
  assert.equal(readDoorbells(f.store, now).size, 0);
  await f.subscribe("a");
  assert.deepEqual(
    { ...readDoorbells(f.store, now).get(f.a.agent_id), until: null },
    {
      live: 1,
      operator: 0,
      until: null,
      lapsed_at: null,
      reason: null,
      rang_at: null,
      status: null,
      delivered_at: null,
      inbox_read_at: null,
      absent_since: null,
    },
  );
  // The callback is gone (410).
  answer = 410;
  await f.send("b", f.a.address, "x");
  await f.events.dispatch();
  let bell = readDoorbells(f.store, now).get(f.a.agent_id);
  assert.equal(bell.live, 0);
  assert.equal(bell.reason, "gone");
  assert.equal(bell.lapsed_at, now);
  // Subscribing again clears the lapse; an explicit unsubscribe records its own reason.
  answer = 200;
  await f.subscribe("a");
  assert.equal(readDoorbells(f.store, now).get(f.a.agent_id).reason, null);
  await f.rpc("a", "events/unsubscribe", {
    name: HAB_EVENT_NAME,
    arguments: {},
    delivery: { mode: "webhook", url: URL_A },
  });
  bell = readDoorbells(f.store, now).get(f.a.agent_id);
  assert.equal(bell.reason, "unsubscribed");
  // A subscription past its lifetime reads as lapsed even before the dispatcher removes it.
  await f.subscribe("a", { ttlMs: 60_000 });
  bell = readDoorbells(f.store, now + 60_001).get(f.a.agent_id);
  assert.equal(bell.live, 0);
  assert.equal(bell.reason, "expired");
});

// 2026-11-19: Dots never read a message after its doorbell, and nothing showed whether
// ChatGPT had taken the ring. Each ring now leaves its time and the callback's answer.
test("operators can see the latest ring and how the callback answered it", async (t) => {
  let now = Date.now();
  let answer = 500;
  const f = await setup(t, {
    status: () => answer,
    events: { now: () => now },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "x");
  await f.events.dispatch();
  let bell = readDoorbells(f.store, now).get(f.a.agent_id);
  assert.equal(bell.rang_at, now);
  assert.equal(bell.status, 500);
  assert.equal(bell.delivered_at, null);
  // The retry is taken: the time of the last 2xx is kept until the next one.
  now += 5000;
  answer = 202;
  await f.events.dispatch();
  bell = readDoorbells(f.store, now).get(f.a.agent_id);
  assert.deepEqual(
    [bell.rang_at, bell.status, bell.delivered_at],
    [now, 202, now],
  );
  const taken = now;
  // No answer at all is recorded as 0, and the last delivery stays visible.
  now += 5000;
  answer = 202;
  const failing = await setup(t, {
    status: () => {
      throw new Error("connection reset");
    },
    events: { now: () => now },
  });
  await failing.subscribe("a");
  await failing.send("b", failing.a.address, "y");
  await failing.events.dispatch();
  bell = readDoorbells(failing.store, now).get(failing.a.agent_id);
  assert.deepEqual([bell.status, bell.delivered_at], [0, null]);
  assert.equal(
    readDoorbells(f.store, now).get(f.a.agent_id).delivered_at,
    taken,
  );
});

test("a slow delivery pass is not mistaken for an outage", async (t) => {
  // Each POST takes far longer than the outage threshold, while the threshold stays wide
  // enough that an ordinary timer stall on a busy CI runner (2026-11-19: about 200 ms) is
  // not one.
  const f = await setup(t, {
    delayMs: 1200,
    events: { poll_ms: 100, outage_after_ms: 800, quiet: false },
  });
  const sub = await f.subscribe("a", { ttlMs: 600_000 });
  const until = Date.parse(sub.result.refreshBefore);
  await f.send("b", f.a.address, "one");
  await f.send("b", f.a.address, "two");
  f.events.start();
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(f.h.events().length, 2);
  assert.equal(f.events.subscriptions()[0].expires_at, until);
});

test("an outage threshold below the poll interval cannot extend lifetimes on ordinary ticks", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, poll_ms: 3000, outage_after_ms: 1000 },
  });
  const sub = await f.subscribe("a", { ttlMs: 60_000 });
  const until = Date.parse(sub.result.refreshBefore);
  for (let i = 0; i < 10; i++) {
    now += 3000;
    await f.events.dispatch();
  }
  assert.equal(f.events.subscriptions()[0].expires_at, until);
  for (let i = 0; i < 11; i++) {
    now += 3000;
    await f.events.dispatch();
  }
  assert.equal(f.events.subscriptions().length, 0);
});

// ADR-027: a doorbell that was accepted but not answered rings once more, and the
// recipient's own next tool result says so.
test("an accepted doorbell left unread rings once more with a new event ID", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "x");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  now += 59_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  now += 1000;
  await f.events.dispatch();
  const [first, again] = f.h.events();
  assert.ok(again, "rang again");
  assert.notEqual(again.parsed.eventId, first.parsed.eventId);
  assert.deepEqual(again.parsed.data, first.parsed.data);
  assert.equal(
    again.headers["webhook-id"],
    again.parsed.eventId,
    "signed like any event",
  );
  // Only once per message.
  now += 600_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
});

test("mail read in time is not rung again, and rering can be turned off", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "x");
  await f.events.dispatch();
  await f.rpc("a", "tools/call", { name: "hab_inbox", arguments: {} });
  now += 120_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);

  const off = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000, rering: false },
  });
  await off.subscribe("a");
  await off.send("b", off.a.address, "x");
  await off.events.dispatch();
  now += 120_000;
  await off.events.dispatch();
  assert.equal(off.h.events().length, 1);
});

test("a failed doorbell is not counted as unanswered and is not rung again early", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    status: () => 503,
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "x");
  await f.events.dispatch();
  now += 61_000;
  const sent = await f.send("a", f.b.address, "hello");
  assert.ok(sent.inbox_reminder);
  assert.equal(sent.inbox_reminder.doorbell_unanswered, false);
  assert.equal(sent.inbox_reminder.doorbell_delivered_at, null);
});

test("the recipient's own tool results carry an inbox reminder that names an unanswered doorbell", async (t) => {
  // Messages are stamped by the real clock; the doorbell's clock runs ahead of it.
  let ahead = 0;
  const f = await setup(t, {
    events: {
      now: () => Date.now() + ahead,
      unanswered_after_ms: 60_000,
      rering: false,
    },
  });
  // No mail: no reminder.
  let sent = await f.send("a", f.b.address, "hi");
  assert.equal(sent.inbox_reminder, undefined);
  await f.subscribe("a");
  const message = await f.send("b", f.a.address, "secret body");
  // Unread but not rung yet: a plain reminder on other tools, nothing on hab_inbox.
  sent = await f.send("a", f.b.address, "hi again");
  assert.equal(sent.inbox_reminder.unread, 1);
  assert.equal(sent.inbox_reminder.doorbell_unanswered, false);
  assert.match(sent.inbox_reminder.explanation, /hab_inbox/);
  await f.events.dispatch();
  const rangAt = readDoorbells(f.store).get(f.a.agent_id).delivered_at;
  ahead += 60_000;
  sent = await f.send("a", f.b.address, "and again");
  const reminder = sent.inbox_reminder;
  assert.equal(reminder.doorbell_unanswered, true);
  assert.equal(reminder.doorbell_delivered_at, new Date(rangAt).toISOString());
  assert.match(reminder.explanation, /event task/);
  for (const secret of ["secret body", message.message_id, f.b.address])
    assert.ok(!JSON.stringify(reminder).includes(secret), secret);
  // hab_inbox reads the mail and still says the doorbell went unanswered, once.
  const inbox = await f.rpc("a", "tools/call", {
    name: "hab_inbox",
    arguments: {},
  });
  const read = inbox.result.structuredContent;
  assert.equal(read.messages.length, 1);
  assert.equal(read.inbox_reminder.doorbell_unanswered, true);
  assert.match(read.inbox_reminder.explanation, /^HAB rang your doorbell/);
  const again = await f.rpc("a", "tools/call", {
    name: "hab_inbox",
    arguments: {},
  });
  assert.equal(again.result.structuredContent.inbox_reminder, undefined);
  sent = await f.send("a", f.b.address, "done");
  assert.equal(sent.inbox_reminder, undefined);
  // b's results speak of b's own mail (a's four messages) and b's doorbell, never a's.
  const other = await f.send("b", f.a.address, "more");
  assert.equal(other.inbox_reminder.unread, 4);
  assert.equal(other.inbox_reminder.doorbell_delivered_at, null);
});

test("a second ring or newer mail does not hide that an earlier doorbell went unanswered", async (t) => {
  let ahead = 0;
  const f = await setup(t, {
    events: { now: () => Date.now() + ahead, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  await f.events.dispatch();
  const firstRing = readDoorbells(f.store).get(f.a.agent_id).delivered_at;
  ahead += 60_000;
  // The ring again succeeds, moving the latest ring forward; the new message waits behind
  // it (ADR-030).
  await f.send("b", f.a.address, "second");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
  const sent = await f.send("a", f.b.address, "hi");
  assert.equal(sent.inbox_reminder.doorbell_unanswered, true);
  assert.equal(
    sent.inbox_reminder.doorbell_delivered_at,
    new Date(firstRing).toISOString(),
  );
  const inbox = await f.rpc("a", "tools/call", {
    name: "hab_inbox",
    arguments: {},
  });
  assert.equal(
    inbox.result.structuredContent.inbox_reminder.doorbell_unanswered,
    true,
  );
});

test("mail the recipient may no longer read does not keep a reminder alive", async (t) => {
  let ahead = 0;
  const f = await setup(t, {
    events: {
      now: () => Date.now() + ahead,
      unanswered_after_ms: 60_000,
      rering: false,
    },
  });
  await f.subscribe("a");
  const mine = await f.send("a", f.b.address, "to b");
  await f.send("b", f.a.address, "from b");
  await f.events.dispatch();
  ahead += 60_000;
  let status = await f.rpc("a", "tools/call", {
    name: "hab_status",
    arguments: { message_id: mine.message_id },
  });
  assert.equal(
    status.result.structuredContent.inbox_reminder.doorbell_unanswered,
    true,
  );
  // b is stopped: hab_inbox no longer returns its message, so neither does the reminder.
  f.registry.setAccess(f.admin, {
    request_id: "stop-b",
    agent_id: f.b.agent_id,
    expected_epoch: f.b.epoch,
    state: "stopped",
    operations: [],
  });
  status = await f.rpc("a", "tools/call", {
    name: "hab_status",
    arguments: { message_id: mine.message_id },
  });
  assert.notEqual(status.result.isError, true, JSON.stringify(status));
  assert.equal(status.result.structuredContent.inbox_reminder, undefined);
});

// ADR-030: while an accepted doorbell's mail waits unread, newer mail does not ring; it
// waits behind the cursor and rings only if it is still unread when the quiet time ends.
test("newer mail waits quietly behind an unread accepted doorbell, and rings after it", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  await f.events.dispatch();
  await f.send("b", f.a.address, "second");
  await f.send("b", f.a.address, "third");
  for (let i = 0; i < 5; i++) {
    now += 10_000;
    await f.events.dispatch();
  }
  assert.equal(f.h.events().length, 1, "held while the first is unread");
  // The first ring again goes first and starts a new quiet time instead of sounding with
  // the newer mail.
  now += 10_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
  assert.equal(
    f.h.events()[1].parsed.data.arrived_at,
    f.h.events()[0].parsed.data.arrived_at,
  );
  now += 59_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
  // Still unread after the second quiet time: the held mail rings, once for all of it.
  now += 1000;
  await f.events.dispatch();
  const third = f.h.events()[2];
  assert.ok(third, "the held mail rang");
  assert.notEqual(
    third.parsed.data.arrived_at,
    f.h.events()[0].parsed.data.arrived_at,
  );
  assert.equal(f.h.events().length, 3);
  now += 30_000;
  await f.events.dispatch();
  assert.equal(
    f.h.events().length,
    3,
    "the third message is held behind the second",
  );
});

test("held mail that is read is never rung, and reading the rung mail ends the quiet", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  await f.events.dispatch();
  await f.send("b", f.a.address, "second");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  // hab_inbox reads everything: nothing is left to ring, now or later.
  await f.rpc("a", "tools/call", { name: "hab_inbox", arguments: {} });
  for (let i = 0; i < 4; i++) {
    now += 60_000;
    await f.events.dispatch();
  }
  assert.equal(f.h.events().length, 1);

  // Only the rung message is read (a delivery client ACKed it): the quiet ends at once
  // and the newer mail rings on the next pass.
  const g = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await g.subscribe("a");
  const one = await g.send("b", g.a.address, "one");
  await g.events.dispatch();
  await g.send("b", g.a.address, "two");
  await g.events.dispatch();
  assert.equal(g.h.events().length, 1);
  g.raw
    .prepare("UPDATE delivery_messages SET state='acked' WHERE message_id=?")
    .run(one.message_id);
  await g.events.dispatch();
  assert.equal(g.h.events().length, 2);
});

test("a refused doorbell does not start a quiet time, and quiet: false rings every message", async (t) => {
  let now = Date.now();
  let answer = 503;
  const f = await setup(t, {
    status: () => answer,
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  for (let i = 0; i < 8; i++) {
    await f.events.dispatch();
    now += 400_000;
  }
  assert.equal(f.h.events().length, 8, "the first message used its attempts");
  answer = 202;
  await f.send("b", f.a.address, "second");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 9, "nothing accepted, so nothing holds it");

  const g = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000, quiet: false },
  });
  await g.subscribe("a");
  await g.send("b", g.a.address, "one");
  await g.events.dispatch();
  await g.send("b", g.a.address, "two");
  await g.events.dispatch();
  assert.equal(g.h.events().length, 2);
});

test("new mail waits behind a ring again that is due but left for the next pass", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  // Eleven subscriptions; one pass rings at most ten again.
  for (let i = 0; i < 8; i++)
    await f.subscribe("a", {
      delivery: { mode: "webhook", url: `${URL_A}/${i}`, secret: SECRET },
    });
  for (let i = 8; i < 11; i++)
    await f.subscribe("b", {
      delivery: { mode: "webhook", url: `${URL_A}/${i}`, secret: SECRET },
    });
  await f.send("b", f.a.address, "for a");
  await f.send("a", f.b.address, "for b");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 11);
  now += 60_000;
  await f.send("b", f.a.address, "newer for a");
  await f.send("a", f.b.address, "newer for b");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 21, "ten rings again, no new mail");
  now += 3000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 22, "the eleventh ring again, no new mail");
  const urls = f.h.events().map((e) => e.url);
  for (let i = 0; i < 11; i++)
    assert.equal(urls.filter((u) => u === `${URL_A}/${i}`).length, 2);
});

// ADR-029: the operator registers a doorbell for an address in the host config, for agents
// such as Grok Bot whose routines are started by a webhook and cannot subscribe themselves.
const URL_G = "https://hooks.example.com/grok/routine";
const BEARER = "grok-routine-token-0123456789";

test("a doorbell to a Claude scheduled task's fire endpoint carries anthropic-version", async (t) => {
  const f = await setup(t, { events: { rering: false } });
  const fire =
    "https://api.anthropic.com/v1/claude_code/routines/trig_0123456789/fire";
  f.events.configureStatic([
    {
      agent_id: f.b.agent_id,
      url: fire,
      secret: "sk-ant-oat01-routine-token-0123",
    },
    { agent_id: f.a.agent_id, url: URL_G, secret: BEARER },
  ]);
  await f.send("a", f.b.address, "for the claude coordinator");
  await f.send("b", f.a.address, "for grok");
  await f.events.dispatch();
  const rings = f.h.events();
  const claude = rings.find((r) => r.url === fire);
  const grok = rings.find((r) => r.url === URL_G);
  assert.equal(
    claude.headers.Authorization,
    "Bearer sk-ant-oat01-routine-token-0123",
  );
  assert.equal(claude.headers["anthropic-version"], "2023-06-01");
  assert.equal(grok.headers["anthropic-version"], undefined);
});

test("an operator doorbell rings with a Bearer token for new mail only, and never expires", async (t) => {
  let now = Date.now();
  // Without the ADR-027 ring-again, so each ring below is one new message.
  const f = await setup(t, { events: { now: () => now, rering: false } });
  await f.send("a", f.b.address, "old mail before the doorbell");
  f.events.configureStatic([
    { agent_id: f.b.agent_id, url: URL_G, secret: BEARER },
  ]);
  await f.events.dispatch();
  assert.equal(f.h.events().length, 0, "mail waiting before setup is not rung");
  await f.send("a", f.b.address, "new mail");
  await f.events.dispatch();
  const [ring] = f.h.events();
  assert.equal(ring.url, URL_G);
  assert.equal(ring.headers.Authorization, `Bearer ${BEARER}`);
  assert.equal(ring.headers["webhook-signature"], undefined);
  assert.deepEqual(Object.keys(ring.parsed.data).sort(), ["arrived_at", "to"]);
  assert.equal(ring.parsed.data.to, f.b.address);
  assert.doesNotMatch(ring.body, /new mail/);
  // No verification challenge is sent for an operator doorbell.
  assert.equal(
    f.h.seen.filter((s) => s.parsed.type === "verification").length,
    0,
  );
  // Far past any subscription lifetime it still rings, and status shows it as operator.
  now += 30 * 86_400_000;
  await f.send("a", f.b.address, "a month later");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2);
  const bell = readDoorbells(f.store, now).get(f.b.agent_id);
  assert.equal(bell.live, 1);
  assert.equal(bell.operator, 1);
  assert.equal(bell.until, null);
});

test("an operator doorbell with a whsec_ secret is signed, takes no subscriber slot and is removed when unlisted", async (t) => {
  const f = await setup(t, { events: { max_per_agent: 1 } });
  f.events.configureStatic([
    { agent_id: f.b.agent_id, url: URL_G, secret: SECRET },
  ]);
  // The recipient's own subscription still fits within max_per_agent: 1.
  const subscribed = await f.subscribe("b");
  assert.equal(subscribed.error, undefined, JSON.stringify(subscribed));
  await f.send("a", f.b.address, "hello");
  await f.events.dispatch();
  const rings = f.h.events();
  assert.equal(rings.length, 2);
  const operator = rings.find((r) => r.url === URL_G);
  const ts = Number(operator.headers["webhook-timestamp"]);
  assert.equal(
    operator.headers["webhook-signature"],
    signWebhook(SECRET, operator.headers["webhook-id"], ts, operator.body),
  );
  assert.equal(operator.headers.Authorization, undefined);
  // Applying a config without it removes it; the MCP subscription stays.
  f.events.configureStatic([]);
  assert.deepEqual(
    f.events.subscriptions().map((s) => s.url),
    [URL_A],
  );
});

test("operator doorbells refuse private URLs and weak secrets", async (t) => {
  const f = await setup(t);
  for (const [url, secret] of [
    ["http://hooks.example.com/x", BEARER],
    ["https://127.0.0.1/x", BEARER],
    ["https://hooks.local/x", BEARER],
    [URL_G, "short"],
    [URL_G, "has space in the token value"],
    [URL_G, "whsec_tooshort"],
  ])
    assert.throws(() =>
      f.events.configureStatic([{ agent_id: f.b.agent_id, url, secret }]),
    );
  assert.deepEqual(f.events.subscriptions(), []);
});

test("an operator doorbell may ring a loopback notifier; agent subscriptions may not (ADR-032)", async (t) => {
  const f = await setup(t);
  const local = "http://127.0.0.1:8795/wake";
  f.events.configureStatic([
    { agent_id: f.b.agent_id, url: local, secret: SECRET },
  ]);
  await f.send("a", f.b.address, "hello");
  await f.events.dispatch();
  const ring = f.h.events().find((r) => r.url === local);
  assert.ok(ring, "the loopback doorbell rang");
  const ts = Number(ring.headers["webhook-timestamp"]);
  assert.equal(
    ring.headers["webhook-signature"],
    signWebhook(SECRET, ring.headers["webhook-id"], ts, ring.body),
  );
  for (const url of [
    "http://127.0.0.1/wake",
    "http://localhost:8795/wake",
    "http://192.168.1.2:8795/wake",
    "http://user:pw@127.0.0.1:8795/wake",
    "http://127.0.0.1:8795/wake#x",
  ])
    assert.throws(() =>
      f.events.configureStatic([
        { agent_id: f.b.agent_id, url, secret: SECRET },
      ]),
    );
  assert.throws(() => callbackUrl(local), /invalid_callback_url/);
});

test("new mail wakes a loopback notifier over real HTTP within one dispatch (ADR-032)", async (t) => {
  let wakes = 0;
  const listener = await startWakeListener({
    port: 0,
    secret: SECRET,
    onWake: () => wakes++,
  });
  t.after(() => listener.close());
  const f = await setup(t, { events: { post: createWebhookPost() } });
  f.events.configureStatic([
    {
      agent_id: f.b.agent_id,
      url: `http://127.0.0.1:${listener.port}/wake`,
      secret: SECRET,
    },
  ]);
  const started = Date.now();
  await f.send("a", f.b.address, "hello");
  await f.events.dispatch();
  assert.equal(wakes, 1);
  assert.ok(Date.now() - started < 2000, "woken within 2 seconds");
});

test("the webhook post sends loopback rings over plain HTTP and nothing else", async (t) => {
  const seen = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, body, sig: req.headers["webhook-signature"] });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address();
  const https = [];
  const post = createWebhookPost(async (url) => {
    https.push(url);
    return { status: 200, body: "" };
  });
  const answer = await post(`http://127.0.0.1:${port}/wake`, '{"to":"x"}', {
    "webhook-signature": "v1,abc",
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [
    { path: "/wake", body: '{"to":"x"}', sig: "v1,abc" },
  ]);
  await post("https://hooks.example.com/x", "{}", {});
  assert.deepEqual(https, ["https://hooks.example.com/x"]);
  await assert.rejects(
    createLoopbackPost()("http://192.168.1.2:80/x", "{}", {}),
    /callback_not_public|callback/,
  );
});

test("a ring again left over from before rering: false does not hold new mail", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000, rering: false },
  });
  const { result } = await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 1);
  // A row scheduled while rering was still on, before the restart.
  const db = new DatabaseSync(f.store);
  db.prepare(
    "INSERT INTO hab_event_rerings (subscription_id,sender_id,message_id,accepted_at,due_at) VALUES (?,?,?,?,?)",
  ).run(result.id, "s", "m", 0, 0);
  db.close();
  now += 60_000;
  await f.send("b", f.a.address, "second");
  await f.events.dispatch();
  assert.equal(
    f.h.events().length,
    2,
    "the quiet ended, so the new mail rings",
  );
});

// ADR-032 retired the ADR-031 inbox check: HAB rings for new mail and rings again once
// (ADR-027), and a polling product reads on its own clock.
test("unread mail is not rung again on a timer once the ring again has gone (ADR-032)", async (t) => {
  let now = Date.now();
  const f = await setup(t, {
    events: { now: () => now, unanswered_after_ms: 60_000 },
  });
  await f.subscribe("a");
  await f.send("b", f.a.address, "first");
  await f.events.dispatch();
  now += 60_000;
  await f.events.dispatch();
  assert.equal(f.h.events().length, 2, "the ring and one ring again");
  for (let i = 0; i < 6; i++) {
    now += 600_000;
    await f.events.dispatch();
  }
  assert.equal(f.h.events().length, 2, "no periodic rings");
});

test("reading the inbox with hab_inbox records when the recipient last looked", async (t) => {
  let now = Date.now();
  const f = await setup(t, { events: { now: () => now } });
  await f.send("b", f.a.address, "hello");
  assert.equal(
    readDoorbells(f.store).get(f.a.agent_id)?.inbox_read_at ?? null,
    null,
  );
  const read = await f.rpc("a", "tools/call", {
    name: "hab_inbox",
    arguments: {},
  });
  assert.notEqual(read.result.isError, true, JSON.stringify(read));
  assert.equal(readDoorbells(f.store).get(f.a.agent_id).inbox_read_at, now);
  now += 1000;
  // An empty inbox is still a look.
  await f.rpc("a", "tools/call", { name: "hab_inbox", arguments: {} });
  assert.equal(readDoorbells(f.store).get(f.a.agent_id).inbox_read_at, now);
  // Other tools are not a look at the inbox.
  await f.rpc("b", "tools/call", {
    name: "hab_status",
    arguments: { message_id: "nope" },
  });
  assert.equal(
    readDoorbells(f.store).get(f.b.agent_id)?.inbox_read_at ?? null,
    null,
  );
  // Without events the read is unaffected (noteInboxRead never throws on a bad context).
  f.events.noteInboxRead({ not: "a context" });
});

// ADR-032: the product says the session behind an address has ended.
const GONE = { status: 410, body: JSON.stringify({ reason: "session_gone" }) };

test("three session_gone answers make the address absent and hab_send refuses it", async (t) => {
  let answer = () => GONE;
  const f = await setup(t, { status: (p) => answer(p) });
  f.events.configureStatic([
    { agent_id: f.a.agent_id, url: URL_A, secret: SECRET },
  ]);
  for (const text of ["one", "two"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  assert.equal(f.events.isAbsent(f.a.address), false, "two is not enough");
  await f.send("b", f.a.address, "three");
  await f.events.dispatch();
  assert.equal(f.events.isAbsent(f.a.address), true);
  // The operator doorbell itself stays: the product is alive, only the session ended.
  assert.equal(f.events.subscriptions().length, 1);
  const refused = await f.rpc("b", "tools/call", {
    name: "hab_send",
    arguments: { to: f.a.address, text: "four" },
  });
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.error, "recipient_absent");
  assert.equal(
    readDoorbells(f.store).get(f.a.agent_id).absent_since !== null,
    true,
  );
});

test("no answer, 5xx, other refusals and a plain 410 never make an address absent", async (t) => {
  for (const answer of [
    { status: 0, body: "" },
    { status: 503, body: "" },
    { status: 404, body: JSON.stringify({ reason: "session_gone" }) },
    { status: 410, body: "gone" },
  ]) {
    const f = await setup(t, { status: () => answer });
    f.events.configureStatic([
      { agent_id: f.a.agent_id, url: URL_A, secret: SECRET },
    ]);
    for (const text of ["one", "two", "three", "four"]) {
      await f.send("b", f.a.address, text);
      await f.events.dispatch();
    }
    assert.equal(f.events.isAbsent(f.a.address), false, JSON.stringify(answer));
  }
});

test("an accepted doorbell or a new subscription clears the count and the absence", async (t) => {
  let answer = () => GONE;
  // Quiet time (ADR-030) would hold the rings after an accepted one; this test counts rings.
  const f = await setup(t, {
    status: (p) => answer(p),
    events: { quiet: false, rering: false },
  });
  f.events.configureStatic([
    { agent_id: f.a.agent_id, url: URL_A, secret: SECRET },
  ]);
  for (const text of ["one", "two"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  answer = () => 200;
  await f.send("b", f.a.address, "taken");
  await f.events.dispatch();
  answer = () => GONE;
  for (const text of ["x", "y"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  assert.equal(
    f.events.isAbsent(f.a.address),
    false,
    "the count started again",
  );
  await f.send("b", f.a.address, "z");
  await f.events.dispatch();
  assert.equal(f.events.isAbsent(f.a.address), true);
  answer = () => 200;
  const sub = await f.subscribe("a");
  assert.equal(sub.error, undefined, JSON.stringify(sub));
  assert.equal(
    f.events.isAbsent(f.a.address),
    false,
    "a new subscription brings it back",
  );
});

test("absence is only told to a caller that may resolve the recipient (ADR-032)", async (t) => {
  const f = await setup(t, { status: () => GONE });
  f.events.configureStatic([
    { agent_id: f.a.agent_id, url: URL_A, secret: SECRET },
  ]);
  for (const text of ["one", "two", "three"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  assert.equal(f.events.isAbsentAgent(f.a.agent_id), true);
  // Stopping a's connection makes it unresolvable: the caller learns nothing more.
  assert.equal(typeof f.revoke, "function", "fixture can stop an address");
  f.revoke("a");
  const masked = await f.rpc("b", "tools/call", {
    name: "hab_send",
    arguments: { to: f.a.address, text: "after stop" },
  });
  assert.equal(masked.result.isError, true);
  assert.notEqual(masked.result.structuredContent.error, "recipient_absent");
});

test("an agent endpoint without events (loopback) still refuses an absent recipient (ADR-032)", async (t) => {
  const f = await setup(t);
  const absent = new Set([f.a.agent_id]);
  const loopback = new HabHttpGateway(
    f.hab,
    policy,
    { record() {}, note() {} },
    f.verifier,
    undefined,
    "agent",
    undefined,
    { isAbsentAgent: (id) => absent.has(id) },
  );
  const rpc = async (who, method, params = {}) =>
    decode(
      await loopback.fetch(
        request(method, params, {
          headers: { Authorization: `Bearer fixture-${who}` },
        }),
      ),
    );
  const refused = await rpc("b", "tools/call", {
    name: "hab_send",
    arguments: { to: f.a.address, text: "hello" },
  });
  assert.equal(refused.result.structuredContent.error, "recipient_absent");
  absent.clear();
  const sent = await rpc("b", "tools/call", {
    name: "hab_send",
    arguments: { to: f.a.address, text: "hello again" },
  });
  assert.notEqual(sent.result.isError, true, JSON.stringify(sent));
});

test("a previous address in its rename grace period is refused like the current one (ADR-032)", async (t) => {
  const f = await setup(t, {
    status: () => GONE,
    registry: { agent_rename: true },
  });
  f.events.configureStatic([
    { agent_id: f.a.agent_id, url: URL_A, secret: SECRET },
  ]);
  for (const text of ["one", "two", "three"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  const current = f.registry.renameAgent(f.admin, {
    request_id: "rename-a",
    agent_id: f.a.agent_id,
    expected_epoch: f.a.epoch,
    expected_address: f.a.address,
    bot_name: "renamed",
  });
  for (const to of [f.a.address, current.address]) {
    const refused = await f.rpc("b", "tools/call", {
      name: "hab_send",
      arguments: { to, text: "still there?" },
    });
    assert.equal(
      refused.result.structuredContent?.error,
      "recipient_absent",
      to,
    );
  }
});

test("a newly registered static doorbell clears absence; the same one on restart keeps it (ADR-032)", async (t) => {
  const f = await setup(t, { status: () => GONE });
  const doorbell = { agent_id: f.a.agent_id, url: URL_A, secret: SECRET };
  f.events.configureStatic([doorbell]);
  for (const text of ["one", "two", "three"]) {
    await f.send("b", f.a.address, text);
    await f.events.dispatch();
  }
  assert.equal(f.events.isAbsentAgent(f.a.agent_id), true);
  f.events.configureStatic([doorbell]);
  assert.equal(
    f.events.isAbsentAgent(f.a.agent_id),
    true,
    "an unchanged doorbell is not a sign of recovery",
  );
  f.events.configureStatic([
    { ...doorbell, url: "http://127.0.0.1:8795/wake" },
  ]);
  assert.equal(
    f.events.isAbsentAgent(f.a.agent_id),
    false,
    "a replacement doorbell brings it back",
  );
});
