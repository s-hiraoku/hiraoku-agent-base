import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadableStream } from "node:stream/web";
import { RelayMcpClient } from "../src/relay/mcp-client.ts";
import { limits, fixture, message, tick } from "./relay-http-fixtures.js";

const policy = {
  resource_url: "https://relay.example/mcp",
  agent_id: "a",
  max_request_bytes: 65536,
  max_response_bytes: 131072,
  timeout_ms: 2000,
  max_active_requests: 2,
  max_sse_events: 16,
  max_sse_lines: 128,
  max_json_depth: 64,
  max_json_nodes: 10000,
};
const expected =
  (code = "relay_transport_failed") =>
  (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  };
function receipt(m = message()) {
  return {
    sender_id: "a",
    message_id: m.message_id,
    recipient_id: "b",
    receipt_id: "receipt-1",
    accepted_at: m.first_sent_at,
    expires_at: m.expires_at,
    state: "pending",
  };
}
function rpc(id, data, isError) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
      ...(isError === undefined ? {} : { isError }),
    },
  };
}
const json = (data, headers = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...headers },
  });
function client(transport, patch = {}, extra = {}) {
  return new RelayMcpClient({
    policy: { ...policy, ...patch },
    limits,
    authorization: () => "Bearer fixture-a",
    fetch: async (url, init) => transport(JSON.parse(init.body), url, init),
    ...extra,
  });
}
const ready = (r) => client(({ id }) => json(rpc(id, r)));

test("client policy rejects noncanonical/unsafe endpoints and missing/unbounded policy", () => {
  for (const url of [
    "http://relay.example/mcp",
    "https://u:p@relay.example/mcp",
    "https://relay.example/mcp?q=1",
    "https://relay.example/mcp#x",
    "https://relay.example/a/../mcp",
    "https://relay.example//mcp",
    "https://relay.example/%6dcp",
    "https://relay.example/mcp/",
  ]) {
    // A canonical trailing slash is valid; the path is pinned exactly.
    if (url.endsWith("/mcp/")) {
      assert.doesNotThrow(() => client(() => {}, { resource_url: url }));
      continue;
    }
    assert.throws(
      () => client(() => {}, { resource_url: url }),
      expected("invalid_relay_client_policy"),
    );
  }
  for (const patch of [
    { max_response_bytes: Infinity },
    { timeout_ms: 0 },
    { max_json_depth: 129 },
    { max_active_requests: 1001 },
    { max_sse_lines: undefined },
    { agent_id: "agent@product.hab" },
  ]) {
    assert.throws(
      () => client(() => {}, patch),
      expected("invalid_relay_client_policy"),
    );
  }
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    assert.doesNotThrow(() =>
      client(() => {}, { resource_url: `http://${host}:9000/mcp` }),
    );
  }
});

test("fixed tool POST mirrors metadata, omits cookies and sends no identity labels", async () => {
  const m = message(),
    calls = [],
    config = { ...policy },
    caps = { ...limits };
  const c = new RelayMcpClient({
    policy: config,
    limits: caps,
    authorization: ({ resource, signal }) => {
      assert.equal(resource, policy.resource_url);
      assert.equal(signal.aborted, false);
      return "Bearer fixture-a";
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      assert.equal(url, policy.resource_url);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.method, "POST");
      assert.equal(init.cache, "no-store");
      assert.deepEqual(init.headers, {
        Authorization: "Bearer fixture-a",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Accept-Encoding": "identity",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "relay_submit",
      });
      assert.deepEqual(body.params.arguments, m);
      assert.deepEqual(body.params._meta, {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      });
      return json(rpc(body.id, receipt(m)));
    },
  });
  config.resource_url = "https://other.example/mcp";
  config.agent_id = "c";
  caps.parts = 0;
  assert.deepEqual(await c.submit(m), receipt(m));
  assert.deepEqual(await c.submit(m), receipt(m));
  assert.notEqual(calls[0].id, calls[1].id);
});

test("input is validated and privately snapshotted before awaiting credentials", async () => {
  const m = message(),
    original = structuredClone(m);
  let resume,
    calls = 0;
  const credentials = new Promise((r) => {
    resume = r;
  });
  const c = client(
    (body) => {
      calls++;
      assert.deepEqual(body.params.arguments, original);
      return json(rpc(body.id, receipt(original)));
    },
    {},
    { authorization: () => credentials },
  );
  const pending = c.submit(m);
  m.body.parts[0].text = "changed";
  resume("Bearer fixture-a");
  await pending;
  await assert.rejects(
    c.submit({ ...m, sender_id: "a" }),
    expected("invalid_contract"),
  );
  await assert.rejects(c.status("a@other.hab"), expected("invalid_request"));
  await assert.rejects(c.ack({ sender_id: "a" }), expected("invalid_contract"));
  assert.equal(calls, 1);
});

test("missing or malformed credentials fail closed before any fetch", async () => {
  let calls = 0;
  for (const authorization of [
    undefined,
    () => "",
    () => "Bearer bad\nheader",
    () => "Basic fixture",
    () => "Bearer " + "x".repeat(8192),
    () => null,
  ]) {
    const c = client(
      () => {
        calls++;
      },
      {},
      { authorization },
    );
    await assert.rejects(c.poll(), expected("forbidden"));
  }
  await assert.rejects(
    client(
      () => {
        calls++;
      },
      {},
      {
        authorization: () => {
          throw Error("synthetic sensitive error");
        },
      },
    ).poll(),
    expected(),
  );
  assert.equal(calls, 0);
});

test("request byte cap refuses before credentials or network", async () => {
  let calls = 0;
  const c = client(
    () => {
      calls++;
    },
    { max_request_bytes: 10 },
    {
      authorization: () => {
        calls++;
        return "Bearer fixture-a";
      },
    },
  );
  await assert.rejects(c.submit(message()), expected("capacity_exceeded"));
  assert.equal(calls, 0);
});

test(
  "real SDK gateway supplies all four client operations with scoped identities and exact receipts",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      gateway = f.gateway(),
      m = message();
    const a = client((_body, url, init) =>
      gateway.fetch(new Request(url, init)),
    );
    const b = client(
      (_body, url, init) => gateway.fetch(new Request(url, init)),
      { agent_id: "b" },
      { authorization: () => "Bearer fixture-b" },
    );
    const accepted = await a.submit(m);
    assert.equal(accepted.sender_id, "a");
    assert.deepEqual(await a.submit(m), accepted);
    assert.deepEqual(await a.status(m.message_id), accepted);
    await assert.rejects(b.status(m.message_id), expected("not_found"));
    const delivery = await b.poll();
    assert.deepEqual(delivery.message, { ...m, sender_id: "a" });
    assert.equal(await b.poll(), null);
    const ack = {
      sender_id: "a",
      message_id: m.message_id,
      generation: delivery.generation,
      lease_token: delivery.lease_token,
      request_id: "stable-ack-1",
    };
    const confirmed = await b.ack(ack);
    assert.deepEqual(await b.ack(ack), confirmed);
    assert.equal((await a.status(m.message_id)).state, "acked");
    f.active.delete("a");
    await assert.rejects(a.status(m.message_id), expected("forbidden"));
  },
);

test("only equivalent text/structured fixed tool errors retain semantic codes", async () => {
  for (const code of [
    "not_found",
    "invalid_ack",
    "forbidden",
    "idempotency_conflict",
    "attachment_store_unavailable",
    "expired_before_acceptance",
    "ack_idempotency_conflict",
  ]) {
    await assert.rejects(
      client(({ id }) => json(rpc(id, { error: code }, true))).status("m-1"),
      expected(code),
    );
  }
  for (const data of [
    { error: "synthetic sensitive failure" },
    { error: "forbidden", detail: "synthetic private payload" },
  ]) {
    await assert.rejects(
      client(({ id }) => json(rpc(id, data, true))).poll(),
      expected(),
    );
  }
  await assert.rejects(
    client(() => {
      const e = Error("synthetic private failure");
      e.code = "forbidden";
      throw e;
    }).poll(),
    expected(),
  );
});

test("HTTP failures and redirects never become success or leak response details", async () => {
  for (const status of [
    200, 202, 301, 307, 400, 401, 403, 413, 429, 500, 504,
  ]) {
    const c = client(
      () =>
        new Response("synthetic private failure", {
          status,
          headers: {
            "Content-Type": "text/plain",
            Location: "https://other.example/mcp",
          },
        }),
    );
    await assert.rejects(c.poll(), expected());
  }
  for (const patch of [
    { redirected: true },
    { url: "https://other.example/mcp" },
  ]) {
    await assert.rejects(
      client(({ id }) => {
        const response = json(rpc(id, { delivery: null }));
        for (const [key, value] of Object.entries(patch))
          Object.defineProperty(response, key, { value });
        return response;
      }).poll(),
      expected(),
    );
  }
});

test("malformed, unsupported and mismatched JSON-RPC/tool results fail without fallback", async () => {
  const make = (id) => rpc(id, { delivery: null });
  const mutations = [
    (v) => {
      v.id++;
    },
    (v) => {
      v.jsonrpc = "1.0";
    },
    (v) => {
      v.extra = 1;
    },
    (v) => {
      v.error = { code: -32600, message: "synthetic private error" };
    },
    (v) => {
      v.result.content[0].type = "image";
    },
    (v) => {
      v.result.content.push({ type: "text", text: "{}" });
    },
    (v) => {
      delete v.result.structuredContent;
    },
    (v) => {
      v.result.structuredContent.delivery = {};
    },
    (v) => {
      v.result.inputRequests = [];
    },
    (v) => {
      v.result.content[0].text = "{";
    },
    (v) => {
      v.result.isError = "false";
    },
    (v) => {
      v.result.content[0].text = JSON.stringify({});
      v.result.structuredContent = {};
    },
  ];
  for (const mutate of mutations) {
    const c = client(({ id }) => {
      const value = make(id);
      mutate(value);
      return json(value);
    });
    await assert.rejects(c.poll(), expected());
  }
  for (const value of [
    [],
    [{ jsonrpc: "2.0", id: 1, result: {} }],
    null,
    { jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} },
  ]) {
    await assert.rejects(client(() => json(value)).poll(), expected());
  }
});

test("response receipt validation rejects foreign identity, changed intent, unknown fields and invalid times", async () => {
  const m = message(),
    r = receipt(m);
  for (const patch of [
    { sender_id: "c" },
    { message_id: "other" },
    { recipient_id: "c" },
    { expires_at: m.first_sent_at },
    { accepted_at: m.expires_at },
    { accepted_at: "2026-02-30T00:00:00.000Z" },
    { state: "succeeded" },
    { body: "synthetic private payload" },
  ]) {
    await assert.rejects(
      ready({ ...r, ...patch }).submit(m),
      expected(patch.sender_id ? "forbidden" : undefined),
    );
  }
  await assert.rejects(
    ready({ ...r, sender_id: "c" }).status(m.message_id),
    expected("forbidden"),
  );
});

test("poll rejects foreign mailbox and unsafe delivery, validates bounded message contract", async () => {
  const m = message(),
    d = {
      message: { ...m, sender_id: "a" },
      generation: 1,
      lease_token: "x".repeat(43),
      lease_until: new Date(Date.parse(m.first_sent_at) + 10000).toISOString(),
    };
  for (const patch of [
    { generation: 0 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { lease_token: "bad" },
    { lease_until: new Date(Date.parse(m.expires_at) + 1).toISOString() },
    { lease_until: m.first_sent_at },
    { extra: true },
  ]) {
    const c = client(
      ({ id }) => json(rpc(id, { delivery: { ...d, ...patch } })),
      { agent_id: "b" },
    );
    await assert.rejects(c.poll(), expected());
  }
  for (const patch of [
    { recipient_id: "c" },
    { sender_id: undefined },
    { execute: "arbitrary" },
    { expires_at: m.first_sent_at },
    { version: 99 },
  ]) {
    const c = client(
      ({ id }) =>
        json(
          rpc(id, { delivery: { ...d, message: { ...d.message, ...patch } } }),
        ),
      { agent_id: "b" },
    );
    await assert.rejects(
      c.poll(),
      expected(patch.recipient_id ? "forbidden" : undefined),
    );
  }
});

test("ACK receipt must match journal sender/message/request and expected receiver", async () => {
  const ack = {
    sender_id: "a",
    message_id: "m-1",
    generation: 1,
    lease_token: "x".repeat(43),
    request_id: "ack-1",
  };
  const r = {
    sender_id: "a",
    message_id: "m-1",
    request_id: "ack-1",
    recipient_id: "b",
    receipt_id: "receipt-1",
    acked_at: new Date().toISOString(),
    state: "acked",
  };
  for (const patch of [
    { sender_id: "c" },
    { message_id: "m-2" },
    { request_id: "ack-2" },
    { recipient_id: "a" },
    { state: "pending" },
    { acked_at: "bad" },
    { extra: "bad" },
  ]) {
    const c = client(({ id }) => json(rpc(id, { ...r, ...patch })), {
      agent_id: "b",
    });
    await assert.rejects(
      c.ack(ack),
      expected(patch.recipient_id ? "forbidden" : undefined),
    );
  }
});

test("SSE parser handles comments, field folding, CR/LF variants and fragmented UTF-8", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const m = message();
    m.body.parts[0].text = "日本語🙂";
    const delivery = {
      message: { ...m, sender_id: "a" },
      generation: 1,
      lease_token: "x".repeat(43),
      lease_until: m.expires_at,
    };
    const c = client(
      ({ id }) => {
        const pretty = JSON.stringify(rpc(id, { delivery }), null, 2);
        const s = [
          ": heartbeat",
          "id: ignored",
          "retry: 1",
          "event: message",
          ...pretty.split("\n").map((line) => "data: " + line),
          "",
          "",
        ].join(newline);
        const bytes = new TextEncoder().encode(s);
        let offset = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array());
            controller.enqueue(bytes.subarray(offset, ++offset));
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      },
      { agent_id: "b", max_sse_lines: 256 },
    );
    assert.deepEqual((await c.poll()).message, delivery.message);
  }
});

test("SSE rejects extra responses, notifications, server requests, wrong events and truncated frames", async () => {
  for (const make of [
    (v) => `data: ${v}\n\ndata: ${v}\n\n`,
    (v) =>
      `data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\ndata: ${v}\n\n`,
    () =>
      'data: {"jsonrpc":"2.0","id":2,"method":"sampling/createMessage","params":{}}\n\n',
    (v) => `event: other\ndata: ${v}\n\n`,
    (v) => `data: ${v}\n`,
    (v) => `data: ${v}`,
    (v) => `data: ${v}\n\ndata: {`,
    () => ": comment\n\n",
  ]) {
    const c = client(
      ({ id }) =>
        new Response(make(JSON.stringify(rpc(id, { delivery: null }))), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await assert.rejects(c.poll(), expected());
  }
});

test("JSON and SSE enforce response bytes, framing, encoding, node and depth budgets", async () => {
  const responses = [
    () =>
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "99999999999999999999",
        },
      }),
    () =>
      new Response("{}", {
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
      }),
    () =>
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      new Response("{}", {
        headers: { "Content-Type": "application/json; charset=latin1" },
      }),
    () =>
      new Response(null, { headers: { "Content-Type": "application/json" } }),
    () =>
      new Response("{" + '"a":'.repeat(30), {
        headers: { "Content-Type": "application/json" },
      }),
  ];
  for (const respond of responses)
    await assert.rejects(client(respond).poll(), expected());
  for (const patch of [
    { max_response_bytes: 10 },
    { max_json_depth: 2 },
    { max_json_nodes: 4 },
  ]) {
    await assert.rejects(
      client(({ id }) => json(rpc(id, { delivery: null })), patch).poll(),
      expected(),
    );
  }
  for (const patch of [{ max_sse_events: 1 }, { max_sse_lines: 2 }]) {
    await assert.rejects(
      client(
        ({ id }) =>
          new Response(
            `:\n\n:\n\ndata: ${JSON.stringify(rpc(id, { delivery: null }))}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        patch,
      ).poll(),
      expected(),
    );
  }
  for (const text of [
    '{"a":1e999}',
    '{"a":' + "[".repeat(100) + "0" + "]".repeat(100) + "}",
  ]) {
    await assert.rejects(
      client(({ id }) =>
        json(rpc(id, { delivery: null, extra: JSON.parse(text) })),
      ).poll(),
      expected(),
    );
  }
});

test(
  "deadline covers credential wait, prevents late fetch and retains occupied slot until provider settles",
  { timeout: 10000 },
  async () => {
    let resume,
      calls = 0,
      signal;
    const c = client(
      () => {
        calls++;
      },
      { timeout_ms: 250, max_active_requests: 1 },
      {
        authorization: ({ signal: s }) => {
          signal = s;
          return new Promise((r) => {
            resume = r;
          });
        },
      },
    );
    await assert.rejects(c.poll(), expected());
    assert.equal(signal.aborted, true);
    await assert.rejects(c.poll(), expected("relay_client_busy"));
    resume("Bearer fixture-a");
    await tick();
    assert.equal(calls, 0);
  },
);

test(
  "deadline covers uncooperative fetch without releasing its concurrency slot early",
  { timeout: 10000 },
  async () => {
    let resume, signal;
    const c = client(
      (body, _url, init) => {
        signal = init.signal;
        return new Promise((r) => {
          resume = () => r(json(rpc(body.id, { delivery: null })));
        });
      },
      { timeout_ms: 250, max_active_requests: 1 },
    );
    await assert.rejects(c.poll(), expected());
    assert.equal(signal.aborted, true);
    await assert.rejects(c.poll(), expected("relay_client_busy"));
    resume();
    await tick();
  },
);

test(
  "deadline cancels stalled response input; failed input is cancelled too",
  { timeout: 10000 },
  async () => {
    let cancelled = 0;
    const c = client(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { timeout_ms: 250 },
    );
    await assert.rejects(c.poll(), expected());
    await tick();
    assert.equal(cancelled, 1);
    await assert.rejects(
      client(
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status: 401 },
          ),
      ).poll(),
      expected(),
    );
    assert.equal(cancelled, 2);
  },
);

test(
  "response cleanup failure cannot bypass admission, and calls never retry internally",
  { timeout: 10000 },
  async () => {
    let resume,
      calls = 0;
    const c = client(
      () => {
        calls++;
        return new Response(
          new ReadableStream({
            cancel() {
              return new Promise((r) => {
                resume = r;
              });
            },
          }),
          { status: 401 },
        );
      },
      { timeout_ms: 250, max_active_requests: 1 },
    );
    await assert.rejects(c.poll(), expected());
    await assert.rejects(c.poll(), expected("relay_client_busy"));
    assert.equal(calls, 1);
    resume();
    await tick();
  },
);

test(
  "parallel requests retain their own IDs and reject excess admission",
  { timeout: 10000 },
  async () => {
    const resolvers = [],
      calls = [];
    const c = client((body) => {
      calls.push(body);
      return new Promise((resolve) =>
        resolvers.push(() =>
          resolve(
            json(
              rpc(
                body.id,
                receipt({
                  ...message(),
                  message_id: body.params.arguments.message_id,
                }),
              ),
            ),
          ),
        ),
      );
    });
    const first = c.status("m-1"),
      second = c.status("m-2");
    await tick();
    await assert.rejects(c.status("m-3"), expected("relay_client_busy"));
    resolvers[1]();
    assert.equal((await second).message_id, "m-2");
    resolvers[0]();
    assert.equal((await first).message_id, "m-1");
    assert.notEqual(calls[0].id, calls[1].id);
    assert.equal(calls.length, 2);
  },
);

test("fixed profile accepts complete metadata and key order variation, rejects MRTR and missing completion", async () => {
  const c = client(({ id }) => {
    const value = rpc(id, { delivery: null });
    value.result._meta = {
      "io.modelcontextprotocol/serverInfo": {
        name: "hab-relay",
        version: "0.1.0",
      },
    };
    return json(value);
  });
  assert.equal(await c.poll(), null);
  const r = receipt();
  assert.deepEqual(
    await client(({ id }) => {
      const value = rpc(id, r);
      value.result.structuredContent = Object.fromEntries(
        Object.entries(r).reverse(),
      );
      return json(value);
    }).status(r.message_id),
    r,
  );
  for (const type of ["input_required", "task", undefined]) {
    let calls = 0;
    await assert.rejects(
      client(({ id }) => {
        calls++;
        const value = rpc(id, { delivery: null });
        if (type === undefined) delete value.result.resultType;
        else value.result.resultType = type;
        return json(value);
      }).poll(),
      expected(),
    );
    assert.equal(calls, 1);
  }
});

test("structured payload preserves arbitrary JSON keys, and unknown message fields cannot be stripped", async () => {
  const m = message();
  const value = JSON.parse(
    '{"__proto__":{"literal":true},"constructor":"data","ordered":[1,null,"日本語"]}',
  );
  m.body.parts.push({
    type: "data",
    schema_id: "sample",
    schema_version: 1,
    value,
  });
  const delivery = {
    message: { ...m, sender_id: "a" },
    generation: 1,
    lease_token: "x".repeat(43),
    lease_until: m.expires_at,
  };
  const c = client(({ id }) => json(rpc(id, { delivery })), { agent_id: "b" });
  assert.deepEqual(
    JSON.parse(JSON.stringify((await c.poll()).message)),
    delivery.message,
  );
  Object.defineProperty(delivery.message, "__proto__", {
    value: { unknown: true },
    enumerable: true,
  });
  await assert.rejects(c.poll(), expected());
});

test(
  "continuously empty stream chunks cannot starve the deadline timer",
  { timeout: 10000 },
  async () => {
    let cancelled = false;
    const c = client(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array());
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      { timeout_ms: 250 },
    );
    await assert.rejects(c.poll(), expected());
    assert.equal(cancelled, true);
  },
);
