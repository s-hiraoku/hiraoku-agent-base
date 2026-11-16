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
  signWebhook,
} from "../src/hab/events.ts";
import { fixture } from "./hab-registry-fixtures.js";
import { policy, request, decode } from "./mcp-http-fixtures.js";

// ADR-022: a cloud agent (ChatGPT/Dots) subscribes over its MCP connection and the host
// POSTs a signed doorbell when mail waits. The doorbell has no body, sender, kind or IDs.

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const URL_A = "https://hooks.example.com/cb/a";

/** A fake callback that answers verification challenges and records deliveries. */
function hooks(status = () => 200) {
  const seen = [];
  const post = async (url, body, headers) => {
    const parsed = JSON.parse(body);
    seen.push({ url, body, parsed, headers });
    if (parsed.type === "verification")
      return {
        status: 200,
        body: JSON.stringify({ challenge: parsed.challenge }),
      };
    return { status: status(parsed), body: "" };
  };
  return {
    seen,
    post,
    events: () => seen.filter((s) => s.parsed.type !== "verification"),
  };
}

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "events.sqlite");
}

async function setup(t, options = {}) {
  const f = await fixture(t);
  const a = f.enroll("a"),
    b = f.enroll("b");
  const h = hooks(options.status);
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
  return { ...f, a, b, h, events, gateway, rpc, send, subscribe };
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
  now += 60_001;
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
