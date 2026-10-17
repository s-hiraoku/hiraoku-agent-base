import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { RelayHttpGateway } from "../src/relay/http.ts";
import {
  fixture,
  policy,
  message,
  request,
  call,
  decode,
  tick,
} from "./relay-http-fixtures.js";

test(
  "HTTP policy/audit is explicit and bounded; host/origin lists are immutable private copies",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    for (const patch of [
      { resource_url: "http://relay.example/mcp" },
      { resource_url: "https://user:pass@relay.example/mcp" },
      { resource_url: "https://relay.example/mcp?q=1" },
      { resource_url: "https://relay.example//mcp" },
      { allowed_origins: ["null"] },
      { allowed_origins: ["https://console.example/"] },
      { max_request_bytes: Infinity },
      { max_response_bytes: 0 },
      { timeout_ms: 30001 },
      { max_active_requests: 0 },
      { window_ms: -1 },
      { requests_per_window: 0 },
    ])
      assert.throws(() => f.gateway(patch), /invalid_relay_http_policy/);
    assert.throws(
      () => new RelayHttpGateway(f.service, policy),
      /invalid_relay_http_policy/,
    );
    const origins = [],
      g = f.gateway({ allowed_origins: origins });
    origins.push("https://evil.example");
    assert.equal(
      (
        await g.fetch(
          request(
            "tools/list",
            {},
            { headers: { Origin: "https://evil.example" } },
          ),
        )
      ).status,
      403,
    );
    assert.throws(() => g.policy.allowed_origins.push("https://evil.example"));
  },
);

test(
  "unconfigured/throwing verifier and cookie/forwarded identity claims cannot enable anonymous delivery",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    for (const g of [
      new RelayHttpGateway(f.service, policy, f.audit),
      f.gateway({}, () => {
        throw Error("private verifier failure");
      }),
    ]) {
      const result = await call(g, "relay_submit", message());
      assert.equal(result.response.status, 401);
      assert.equal(result.body, "");
    }
    assert.equal(
      (
        await f.gateway().fetch(
          request(
            "tools/list",
            {},
            {
              headers: {
                Authorization: "",
                Cookie: "subject=b",
                "X-Agent-ID": "b",
                "X-Forwarded-For": "127.0.0.1",
              },
            },
          ),
        )
      ).status,
      401,
    );
    assert.equal(f.count(), 0);
  },
);

test(
  "unauthenticated malformed bodies are cancelled without parsing/reading their application stream",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let pulls = 0,
      cancelled = false;
    const body = new ReadableStream(
      {
        pull() {
          pulls++;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await f.gateway().fetch(
      new Request(policy.resource_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(pulls, 0);
    assert.equal(cancelled, true);
    assert.equal(f.count(), 0);
  },
);

test(
  "bounded HTTP modern and legacy MCP exchanges preserve identity, receipts and delivery-only semantics",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      g = f.gateway(),
      m = message();
    const a = await call(g, "relay_submit", m);
    assert.equal(a.response.status, 200);
    assert.equal(a.body.result.structuredContent.sender_id, "a");
    const duplicate = await call(g, "relay_submit", m, { modern: false });
    assert.deepEqual(
      duplicate.body.result.structuredContent,
      a.body.result.structuredContent,
    );
    const b = await call(
      g,
      "relay_poll",
      {},
      { headers: { Authorization: "Bearer fixture-b" } },
    );
    const d = b.body.result.structuredContent.delivery;
    assert.equal(d.message.body.parts[0].text, m.body.parts[0].text);
    // Simulate the host's separate durable-save step in the full socket fixture below.
    const ack = {
      sender_id: "a",
      message_id: m.message_id,
      generation: d.generation,
      lease_token: d.lease_token,
      request_id: "ack-dummy",
    };
    const r = await call(g, "relay_ack", ack, {
      headers: { Authorization: "Bearer fixture-b" },
    });
    assert.equal(r.body.result.structuredContent.state, "acked");
    assert.deepEqual(
      (
        await call(g, "relay_ack", ack, {
          headers: { Authorization: "Bearer fixture-b" },
        })
      ).body.result.structuredContent,
      r.body.result.structuredContent,
    );
    assert.equal(
      (await call(g, "relay_status", { message_id: m.message_id })).body.result
        .structuredContent.state,
      "acked",
    );
    assert.equal(
      f.raw.prepare("SELECT body FROM relay_messages").get().body,
      null,
    );
    assert.equal(a.response.headers.get("cache-control"), "no-store");
  },
);

test(
  "resource, Host, Origin and method checks reject aliases before invoking authentication",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let verified = 0;
    const g = f.gateway({}, (v) => {
      verified++;
      return f.verifier(v);
    });
    for (const [patch, expected] of [
      [{ url: "https://evil.example/mcp" }, 403],
      [{ headers: { Host: "evil.example" } }, 403],
      [{ headers: { Origin: "null" } }, 403],
      [{ headers: { Origin: "https://evil.example" } }, 403],
      [{ url: "https://relay.example/mcp?q=1" }, 405],
      [{ url: "https://relay.example/other" }, 405],
      [{ init: { method: "GET", body: undefined } }, 405],
    ])
      assert.equal(
        (await g.fetch(request("tools/list", {}, patch))).status,
        expected,
      );
    assert.equal(verified, 0);
    assert.equal(
      (
        await g.fetch(
          request(
            "tools/list",
            {},
            {
              headers: {
                Origin: "https://console.example",
                Host: "relay.example",
              },
            },
          ),
        )
      ).status,
      200,
    );
  },
);

test(
  "media type, compression, byte budgets, content length, invalid JSON/UTF-8 fail before any operation",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      g = f.gateway();
    for (const [patch, status] of [
      [{ headers: { "Content-Type": "text/plain" } }, 415],
      [{ headers: { "Content-Encoding": "gzip" } }, 415],
      [{ headers: { "Content-Length": "999999" } }, 413],
      [{ headers: { "Content-Length": "1" } }, 400],
      [{ init: { body: "{invalid" } }, 400],
      [{ init: { body: new Uint8Array([0xff]) } }, 400],
    ])
      assert.equal(
        (await g.fetch(request("tools/list", {}, patch))).status,
        status,
      );
    assert.equal(
      (await f.gateway({ max_request_bytes: 8 }).fetch(request())).status,
      413,
    );
    assert.equal(f.count(), 0);
    assert.equal((await g.fetch(request())).status, 200);
  },
);

test(
  "batch, listener and subscription requests cannot open SDK streams; header/body routing mismatches are rejected",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      g = f.gateway();
    for (const method of [
      "subscriptions/listen",
      "events/subscribe",
      "resources/read",
      "sampling/createMessage",
    ])
      assert.equal((await g.fetch(request(method))).status, 405);
    assert.equal(
      (await g.fetch(request("tools/list", {}, { init: { body: "[]" } })))
        .status,
      405,
    );
    assert.equal(
      (
        await g.fetch(
          request(
            "tools/list",
            {},
            { headers: { "Mcp-Method": "tools/call" } },
          ),
        )
      ).status,
      405,
    );
    const mismatch = await call(g, "relay_submit", message(), {
      headers: { "Mcp-Name": "relay_poll" },
    });
    assert.equal(mismatch.response.status, 400);
    assert.equal(f.count(), 0);
    assert.equal(
      f.events.some((e) => e.category === "tool_started"),
      false,
    );
  },
);

test(
  "raw streamed request overflow cancels input and releases admission for later requests",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull(c) {
          c.enqueue(new Uint8Array(9));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const g = f.gateway({ max_request_bytes: 8, max_active_requests: 1 });
    const response = await g.fetch(
      request("tools/list", {}, { init: { body, duplex: "half" } }),
    );
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(
      (await g.fetch(request("tools/list", {}, { init: { body: "{}" } })))
        .status,
      400,
    );
  },
);

test(
  "a stalled body is cancelled at the whole-request deadline without creating a message",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull() {},
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await f
      .gateway({ timeout_ms: 250 })
      .fetch(request("tools/list", {}, { init: { body, duplex: "half" } }));
    assert.equal(response.status, 504);
    assert.equal(cancelled, true);
    assert.equal(f.count(), 0);
  },
);

test(
  "timed-out verification retains admission until settlement and late identity cannot start work",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    let calls = 0,
      signal;
    const g = f.gateway(
      { timeout_ms: 250, max_active_requests: 1 },
      (input) => {
        calls++;
        if (calls > 1) return f.contexts.a;
        signal = input.signal;
        entered();
        return new Promise((r) => {
          release = r;
        });
      },
    );
    let cancelled = false;
    const input = new ReadableStream(
      {
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const pending = call(g, "relay_submit", message(), {
      init: { body: input, duplex: "half" },
    });
    await ready;
    assert.equal((await pending).response.status, 504);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal((await g.fetch(request())).status, 503);
    release(f.contexts.a);
    await tick();
    assert.equal(f.count(), 0);
    assert.equal((await g.fetch(request())).status, 200);
  },
);

test(
  "late tool-start audit cannot dispatch after timeout, and new requests cannot bypass the pending audit slot",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    const sink = {
      async record(category) {
        if (category === "tool_started") {
          entered();
          await new Promise((r) => {
            release = r;
          });
        }
      },
    };
    const g = f.gateway(
      { timeout_ms: 250, max_active_requests: 1 },
      f.verifier,
      sink,
    );
    const pending = call(g, "relay_submit", message());
    await ready;
    assert.equal((await pending).response.status, 504);
    await tick();
    assert.equal((await g.fetch(request())).status, 503);
    release();
    await tick();
    assert.equal(f.count(), 0);
    assert.equal((await g.fetch(request())).status, 200);
  },
);

test(
  "abort/disconnect is signalled to verification and a late result cannot create a delivery",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      abort = new AbortController();
    let release, entered, signal;
    const ready = new Promise((r) => {
      entered = r;
    });
    const g = f.gateway({}, (input) => {
      signal = input.signal;
      entered();
      return new Promise((r) => {
        release = r;
      });
    });
    const pending = call(g, "relay_submit", message(), {
      init: { signal: abort.signal },
    });
    await ready;
    abort.abort();
    assert.equal((await pending).response.status, 408);
    assert.equal(signal.aborted, true);
    release(f.contexts.a);
    await tick();
    assert.equal(f.count(), 0);
  },
);

test(
  "audit failures deny before dispatch; failure after commit returns uncertainty and exact replay recovers",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      m = message();
    const failing = (at) => ({
      record(category) {
        if (category === at) throw Error("private audit failure");
      },
    });
    assert.equal(
      (await f.gateway({}, f.verifier, failing("request")).fetch(request()))
        .status,
      503,
    );
    const before = await call(
      f.gateway({}, f.verifier, failing("tool_started")),
      "relay_submit",
      m,
    );
    assert.deepEqual(before.body.result.structuredContent, {
      error: "relay_operation_failed",
    });
    assert.equal(f.count(), 0);
    const after = await call(
      f.gateway({}, f.verifier, failing("tool_succeeded")),
      "relay_submit",
      m,
    );
    assert.deepEqual(after.body.result.structuredContent, {
      error: "relay_operation_failed",
    });
    assert.equal(f.count(), 1);
    const recovered = await call(f.gateway(), "relay_submit", m);
    assert.equal(recovered.body.result.structuredContent.sender_id, "a");
    assert.equal(f.count(), 1);
  },
);

test(
  "response byte cap returns no partial receipt and original intent can be reconciled without duplication",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      m = message();
    const result = await call(
      f.gateway({ max_response_bytes: 8 }),
      "relay_submit",
      m,
    );
    assert.equal(result.response.status, 503);
    assert.equal(result.body, "");
    assert.equal(f.count(), 1);
    const r = await call(f.gateway(), "relay_submit", m);
    assert.equal(r.body.result.structuredContent.message_id, m.message_id);
    assert.equal(f.count(), 1);
  },
);

test(
  "global admission uses no caller-controlled identity/IP keys and logs only fixed categories/correlations",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      g = f.gateway({ requests_per_window: 2 });
    const first = await g.fetch(
      request(
        "tools/list",
        {},
        { headers: { "X-Request-ID": "private request label" } },
      ),
    );
    assert.match(first.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    assert.equal((await g.fetch(request())).status, 200);
    assert.equal(
      (
        await g.fetch(
          request(
            "tools/list",
            {},
            { headers: { "X-Forwarded-For": "192.0.2.1" } },
          ),
        )
      ).status,
      429,
    );
    assert.deepEqual(f.notes, ["rate_limited"]);
    for (const e of f.events) {
      assert.deepEqual(Object.keys(e), ["category", "correlation"]);
      assert.match(e.correlation, /^[a-f0-9-]{36}$/);
    }
    assert.equal(JSON.stringify(f.events).includes("fixture-a"), false);
    assert.equal(JSON.stringify(f.events).includes("private"), false);
  },
);

test(
  "concurrent requests keep independent verified contexts and current service policy can revoke them",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    const g = f.gateway({}, (v) =>
      v.authorization === "Bearer fixture-a"
        ? (entered(),
          new Promise((r) => {
            release = r;
          }))
        : f.verifier(v),
    );
    const a = call(g, "relay_submit", message());
    await ready;
    const cMessage = message("2".repeat(32));
    cMessage.thread_id = "thread-cb";
    const c = await call(g, "relay_submit", cMessage, {
      headers: { Authorization: "Bearer fixture-c" },
    });
    release(f.contexts.a);
    const ar = await a;
    assert.equal(c.body.result.structuredContent.sender_id, "c");
    assert.equal(ar.body.result.structuredContent.sender_id, "a");
    f.active.delete("c");
    assert.deepEqual(
      (
        await call(
          f.gateway(),
          "relay_status",
          { message_id: cMessage.message_id },
          { headers: { Authorization: "Bearer fixture-c" } },
        )
      ).body.result.structuredContent,
      { error: "forbidden" },
    );
    assert.equal(f.count(), 2);
  },
);

test(
  "catalog requests work without manufacturing any task and valid HTTP results remain bounded",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      g = f.gateway();
    const r = await g.fetch(request());
    const decoded = await decode(r);
    assert.deepEqual(decoded.result.tools.map((v) => v.name).sort(), [
      "relay_ack",
      "relay_poll",
      "relay_status",
      "relay_submit",
    ]);
    assert.equal(f.count(), 0);
  },
);

test(
  "fragmented UTF-8 JSON and empty input chunks preserve exact message contents within the byte cap",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      m = message();
    m.body.parts[0].text = "合成の確認データ";
    const original = request("tools/call", {
      name: "relay_submit",
      arguments: m,
    });
    const encoded = new TextEncoder().encode(await original.clone().text());
    let at = 0,
      empty = true;
    const stream = new ReadableStream(
      {
        pull(c) {
          if (at === encoded.length) {
            c.close();
            return;
          }
          if (empty) c.enqueue(new Uint8Array());
          else c.enqueue(encoded.slice(at, ++at));
          empty = !empty;
        },
      },
      { highWaterMark: 0 },
    );
    const g = f.gateway({ max_request_bytes: encoded.length });
    const response = await g.fetch(
      new Request(original, { body: stream, duplex: "half" }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await decode(response)).result.structuredContent.sender_id,
      "a",
    );
    assert.equal(
      JSON.parse(f.raw.prepare("SELECT body FROM relay_messages").get().body)
        .body.parts[0].text,
      m.body.parts[0].text,
    );
  },
);

test(
  "post-commit audit still owns admission after deadline/SDK cleanup, and recovery uses the existing receipt",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      m = message();
    let entered,
      release,
      held = false;
    const ready = new Promise((r) => {
      entered = r;
    });
    const sink = {
      async record(category) {
        if (category === "tool_succeeded" && !held) {
          held = true;
          entered();
          await new Promise((r) => {
            release = r;
          });
        }
      },
    };
    const g = f.gateway(
      { timeout_ms: 250, max_active_requests: 1 },
      f.verifier,
      sink,
    );
    const pending = call(g, "relay_submit", m);
    await ready;
    assert.equal(f.count(), 1);
    assert.equal((await pending).response.status, 504);
    await tick();
    assert.equal((await g.fetch(request())).status, 503);
    release();
    await tick();
    assert.equal((await g.fetch(request())).status, 200);
    assert.equal(
      (await call(g, "relay_submit", m)).body.result.structuredContent
        .message_id,
      m.message_id,
    );
    assert.equal(f.count(), 1);
  },
);
