import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HabHttpGateway } from "../src/hab/http.ts";
import {
  CALLBACK_ENDPOINT_ERROR,
  HAB_EVENT_NAME,
  HabEvents,
  callbackUrl,
  createHttpsPost,
  isPublicAddress,
  readDoorbells,
  signWebhook,
} from "../src/hab/events.ts";
import { fixture } from "./hab-registry-fixtures.js";
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
    return { status: status(parsed), body: "" };
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
  const f = await fixture(t);
  const a = f.enroll("a"),
    b = f.enroll("b");
  let self;
  const h = hooks(options.status, options.delayMs, (parsed) =>
    options.onEvent ? options.onEvent(self, parsed) : undefined,
  );
  const events = new HabEvents(f.hab, {
    store: temp(t),
    post: h.post,
    ...options.events,
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
  const f = await setup(t);
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
    events: { now: () => now },
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
  const f = await setup(t);
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
      until: null,
      lapsed_at: null,
      reason: null,
      rang_at: null,
      status: null,
      delivered_at: null,
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
    events: { poll_ms: 100, outage_after_ms: 800 },
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

// ADR-026: a doorbell that was accepted but not answered rings once more, and the
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
  // The ring again and a new message both succeed, moving the latest ring forward.
  await f.send("b", f.a.address, "second");
  await f.events.dispatch();
  assert.equal(f.h.events().length, 3);
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
