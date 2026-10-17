import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { RelayHttpGateway } from "../src/relay/http.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { executeRelayMcpOperation } from "../src/relay/mcp.ts";
import { createHabMcpServer } from "../src/hab/mcp.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import {
  parseHabResolveInput,
  parseHabResolution,
} from "../src/hab/directory.ts";
import { fixture, code, operations } from "./hab-registry-fixtures.js";
import {
  limits,
  policy,
  request,
  decode,
  tick,
} from "./relay-http-fixtures.js";

function gateway(
  f,
  patch = {},
  service = f.hab,
  audit = f.audit,
  verify = f.verifier,
) {
  return new HabHttpGateway(service, { ...policy, ...patch }, audit, verify);
}
function client(f, a, g, patch = {}, fetch) {
  return new HabMcpClient({
    policy: {
      resource_url: policy.resource_url,
      agent_id: a.agent_id,
      max_request_bytes: 65536,
      max_response_bytes: 131072,
      timeout_ms: 2000,
      max_active_requests: 2,
      max_sse_events: 16,
      max_sse_lines: 128,
      max_json_depth: 64,
      max_json_nodes: 10000,
      ...patch,
    },
    limits,
    authorization: () => "Bearer fixture-a",
    fetch: fetch ?? ((url, init) => g.fetch(new Request(url, init))),
  });
}
function decorated(f, resolve) {
  return {
    submit: f.hab.submit.bind(f.hab),
    status: f.hab.status.bind(f.hab),
    poll: f.hab.poll.bind(f.hab),
    ack: f.hab.ack.bind(f.hab),
    resolve,
  };
}
async function call(g, args, patch = {}) {
  return decode(
    await g.fetch(
      request("tools/call", { name: "relay_resolve", arguments: args }, patch),
    ),
  );
}
function rpc(id, value) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

test("HAB opts into exactly five tools; standalone Relay remains four even with a HAB service", async (t) => {
  const f = fixture(t),
    a = f.enroll("a");
  const hab = await decode(await gateway(f).fetch(request()));
  assert.deepEqual(hab.result.tools.map((v) => v.name).sort(), [
    "relay_ack",
    "relay_poll",
    "relay_resolve",
    "relay_status",
    "relay_submit",
  ]);
  const tool = hab.result.tools.find((v) => v.name === "relay_resolve");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["address"]);
  assert.equal(typeof tool.inputSchema.properties.address.pattern, "string");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  const relay = new RelayHttpGateway(f.hab, policy, f.audit, f.verifier);
  const base = await decode(await relay.fetch(request()));
  assert.deepEqual(base.result.tools.map((v) => v.name).sort(), [
    "relay_ack",
    "relay_poll",
    "relay_status",
    "relay_submit",
  ]);
  await assert.rejects(
    client(f, a, relay).resolve(a.address),
    code("relay_transport_failed"),
  );
  assert.throws(
    () => gateway(f, {}, f.service),
    code("invalid_hab_mcp_service"),
  );
});

test("authenticated resolve returns only fixed recipient/address/version and changes no registry or Relay data", async (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  const epoch = f.registryRaw
    .prepare("SELECT epoch FROM hab_registry_meta")
    .get().epoch;
  const audits = f.registryRaw
    .prepare("SELECT count(*) n FROM hab_registry_audit")
    .get().n;
  const result = await client(f, a, gateway(f)).resolve(b.address);
  assert.deepEqual(result, {
    recipient_id: b.agent_id,
    address: b.address,
    normalization_version: 1,
  });
  const response = await call(gateway(f), { address: b.address });
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    response.result.structuredContent,
  );
  assert.deepEqual(response.result.structuredContent, result);
  assert.equal(
    f.registryRaw.prepare("SELECT epoch FROM hab_registry_meta").get().epoch,
    epoch,
  );
  assert.equal(
    f.registryRaw.prepare("SELECT count(*) n FROM hab_registry_audit").get().n,
    audits,
  );
  assert.equal(f.count(), 0);
});

test("pure directory contract rejects foreign fields/accessors and preserves canonical exact intent", () => {
  assert.deepEqual(parseHabResolveInput({ address: "a@grok-bot.hab" }), {
    address: "a@grok-bot.hab",
  });
  let accessed = 0;
  const getter = {
    get address() {
      accessed++;
      return "a@grok-bot.hab";
    },
  };
  for (const input of [
    getter,
    null,
    [],
    { address: "A@grok-bot.hab" },
    { address: "a@grok-bot.hab\n" },
    { address: "a\n@grok-bot.hab" },
    { address: "a@grok-bot.hab", sender_id: "other" },
    { address: "a@grok-bot.hab", agent_id: "other" },
    { address: "a@grok-bot.hab", recipient_id: "other" },
  ])
    assert.throws(() => parseHabResolveInput(input), code("invalid_request"));
  assert.equal(accessed, 0);
  const valid = {
    recipient_id: "opaque-b",
    address: "a@grok-bot.hab",
    normalization_version: 1,
  };
  assert.deepEqual(parseHabResolution(valid, valid.address), valid);
  for (const patch of [
    { normalization_version: 2 },
    { recipient_id: "bad@name.hab" },
    { recipient_id: "opaque-b\n" },
    { address: "b@grok-bot.hab" },
    { binding: "extra" },
  ])
    assert.throws(
      () => parseHabResolution({ ...valid, ...patch }, valid.address),
      code("relay_transport_failed"),
    );
});

test("SDK refuses malformed address/foreign identity arguments before invoking directory", async (t) => {
  const f = fixture(t);
  f.enroll("a");
  let calls = 0;
  const g = gateway(
    f,
    {},
    decorated(f, (ctx, address) => {
      calls++;
      return f.hab.resolve(ctx, address);
    }),
  );
  for (const args of [
    {},
    { address: "A@grok-bot.hab" },
    { address: "a@grok-bot.hab\n" },
    { address: "a@grok-bot.hab", sender_id: "other" },
    { address: "a@grok-bot.hab", agent_id: "other" },
    { address: "a@grok-bot.hab", recipient_id: "other" },
    { address: "a@grok-bot.hab", url: "https://other.example" },
  ]) {
    const result = await call(g, args);
    assert.ok(result.error || result.result?.isError);
  }
  assert.equal(calls, 0);
  assert.equal(f.count(), 0);
});

test("missing/throwing resolver, unverifiable context and absent HTTP verification all deny", async (t) => {
  const f = fixture(t);
  const a = f.enroll("a"),
    b = f.enroll("b");
  for (const resolver of [
    undefined,
    () => null,
    () => "a",
    () => ({ agent_id: a.agent_id }),
    () => {
      throw Error("synthetic private error");
    },
  ]) {
    const handler = createMcpHandler(() => createHabMcpServer(f.hab, resolver));
    try {
      const body = await decode(
        await handler.fetch(
          request("tools/call", {
            name: "relay_resolve",
            arguments: { address: b.address },
          }),
        ),
      );
      assert.deepEqual(body.result.structuredContent, { error: "forbidden" });
    } finally {
      await handler.close();
    }
  }
  const missing = new HabHttpGateway(f.hab, policy, f.audit);
  assert.equal(
    (
      await missing.fetch(
        request("tools/call", {
          name: "relay_resolve",
          arguments: { address: b.address },
        }),
      )
    ).status,
    401,
  );
  f.mutable.individual = false;
  await assert.rejects(
    client(f, a, gateway(f)).resolve(b.address),
    code("forbidden"),
  );
});

test("unknown/stopped/retired/blocked targets share refusal and rights are current on each resolve", async (t) => {
  const f = fixture(t);
  let a = f.enroll("a"),
    b = f.enroll("b");
  const c = client(f, a, gateway(f));
  await assert.rejects(c.resolve("missing@grok-bot.hab"), code("forbidden"));
  b = f.registry.setAccess(f.admin, {
    request_id: "stop-b",
    agent_id: b.agent_id,
    expected_epoch: b.epoch,
    state: "stopped",
    operations: [],
  });
  await assert.rejects(c.resolve(b.address), code("forbidden"));
  b = f.registry.setAccess(f.admin, {
    request_id: "resume-b",
    agent_id: b.agent_id,
    expected_epoch: b.epoch,
    state: "active",
    operations,
  });
  assert.equal((await c.resolve(b.address)).recipient_id, b.agent_id);
  f.registry.setBlock(f.admin, {
    request_id: "block",
    sender_id: a.agent_id,
    recipient_id: b.agent_id,
    sender_epoch: a.epoch,
    recipient_epoch: b.epoch,
    blocked: true,
  });
  await assert.rejects(c.resolve(b.address), code("forbidden"));
  a = f.registry.inspect(f.admin, a.agent_id);
  b = f.registry.inspect(f.admin, b.agent_id);
  f.registry.setBlock(f.admin, {
    request_id: "unblock",
    sender_id: a.agent_id,
    recipient_id: b.agent_id,
    sender_epoch: a.epoch,
    recipient_epoch: b.epoch,
    blocked: false,
  });
  a = f.registry.inspect(f.admin, a.agent_id);
  b = f.registry.inspect(f.admin, b.agent_id);
  f.registry.setAccess(f.admin, {
    request_id: "retire-b",
    agent_id: b.agent_id,
    expected_epoch: b.epoch,
    state: "retired",
    operations: [],
  });
  await assert.rejects(c.resolve(b.address), code("forbidden"));
  a = f.registry.setAccess(f.admin, {
    request_id: "no-resolve",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    state: "active",
    operations: ["submit", "status"],
  });
  await assert.rejects(c.resolve(a.address), code("forbidden"));
  f.registry.setAccess(f.admin, {
    request_id: "resolve-only",
    agent_id: a.agent_id,
    expected_epoch: a.epoch,
    state: "active",
    operations: ["resolve"],
  });
  await assert.rejects(c.resolve(a.address), code("forbidden"));
  assert.equal(f.count(), 0);
});

test("revoking caller binding or setting durable emergency stop invalidates a previously working client", async (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b"),
    c = client(f, a, gateway(f));
  assert.equal((await c.resolve(b.address)).recipient_id, b.agent_id);
  f.registry.revoke(f.admin, {
    request_id: "revoke-a",
    binding_id: f.bindings.get("a").binding_id,
    expected_epoch: a.epoch,
  });
  await assert.rejects(c.resolve(b.address), code("forbidden"));
  f.registry.emergencyStop(f.admin);
  await assert.rejects(
    client(f, b, gateway(f), {}, (url, init) => {
      init.headers.Authorization = "Bearer fixture-b";
      return gateway(f).fetch(new Request(url, init));
    }).resolve(b.address),
    code("forbidden"),
  );
});

test("unexpected directory failures and malformed results are redacted, never redirected or retried", async (t) => {
  const f = fixture(t);
  f.enroll("a");
  const b = f.enroll("b");
  let calls = 0;
  for (const result of [
    () => {
      throw Error("synthetic private directory failure");
    },
    () => ({
      recipient_id: b.agent_id,
      address: "other@grok-bot.hab",
      normalization_version: 1,
    }),
    () => ({
      recipient_id: b.agent_id,
      address: b.address,
      normalization_version: 1,
      principal: "synthetic private principal",
    }),
  ]) {
    const g = gateway(
      f,
      {},
      decorated(f, () => {
        calls++;
        return result();
      }),
    );
    const body = await call(g, { address: b.address });
    assert.deepEqual(body.result.structuredContent, {
      error: "relay_operation_failed",
    });
    assert.equal(JSON.stringify(body).includes("synthetic private"), false);
  }
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(f.events).includes(b.address), false);
  const rejected = await executeRelayMcpOperation(
    () => f.contexts.a,
    undefined,
    () => Promise.reject(Error("synthetic private async failure")),
  );
  assert.deepEqual(rejected.structuredContent, {
    error: "relay_operation_failed",
  });
});

test("directory client validates before fetch and accepts bounded JSON/SSE on fixed metadata only", async (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  let calls = 0;
  for (const sse of [false, true]) {
    const c = client(f, a, null, {}, async (url, init) => {
      calls++;
      assert.equal(url, policy.resource_url);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers["Mcp-Name"], "relay_resolve");
      const body = JSON.parse(init.body);
      assert.deepEqual(body.params.arguments, { address: b.address });
      const wire = rpc(body.id, {
        recipient_id: b.agent_id,
        address: b.address,
        normalization_version: 1,
      });
      return new Response(
        sse
          ? `: keepalive\r\nevent: message\r\ndata: ${JSON.stringify(wire)}\r\n\r\n`
          : JSON.stringify(wire),
        {
          headers: {
            "Content-Type": sse ? "text/event-stream" : "application/json",
          },
        },
      );
    });
    assert.equal((await c.resolve(b.address)).recipient_id, b.agent_id);
    await assert.rejects(c.resolve("B@grok-bot.hab"), code("invalid_request"));
    await assert.rejects(
      c.resolve({ address: b.address }),
      code("invalid_request"),
    );
  }
  assert.equal(calls, 2);
});

test("directory client rejects changed addresses, versions, IDs and unknown fields in otherwise valid replies", async (t) => {
  const f = fixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  for (const patch of [
    { address: a.address },
    { normalization_version: 2 },
    { normalization_version: "1" },
    { recipient_id: "bad@name.hab" },
    { recipient_id: "" },
    { sender_id: "a" },
    { alias: b.address },
  ]) {
    let calls = 0;
    const c = client(f, a, null, {}, async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify(
          rpc(body.id, {
            recipient_id: b.agent_id,
            address: b.address,
            normalization_version: 1,
            ...patch,
          }),
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    await assert.rejects(c.resolve(b.address), code("relay_transport_failed"));
    assert.equal(calls, 1);
  }
});

test(
  "resolve shares request/response caps and the same active-request counter with delivery calls",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b");
    let calls = 0,
      release;
    const small = client(
      f,
      a,
      gateway(f),
      { max_request_bytes: 10 },
      async () => {
        calls++;
      },
    );
    await assert.rejects(small.resolve(b.address), code("capacity_exceeded"));
    assert.equal(calls, 0);
    await assert.rejects(
      client(f, a, gateway(f), { max_response_bytes: 10 }).resolve(b.address),
      code("relay_transport_failed"),
    );
    const c = client(
      f,
      a,
      null,
      { timeout_ms: 250, max_active_requests: 1 },
      (_url, init) =>
        new Promise((r) => {
          release = () =>
            r(
              new Response(
                JSON.stringify(
                  rpc(JSON.parse(init.body).id, {
                    recipient_id: b.agent_id,
                    address: b.address,
                    normalization_version: 1,
                  }),
                ),
                { headers: { "Content-Type": "application/json" } },
              ),
            );
        }),
    );
    await assert.rejects(c.resolve(b.address), code("relay_transport_failed"));
    await assert.rejects(c.poll(), code("relay_client_busy"));
    release();
    await tick();
  },
);

test(
  "resolve cannot dispatch after late tool-start audit, and stalled audit retains HTTP admission",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    f.enroll("a");
    const b = f.enroll("b");
    let calls = 0,
      release,
      entered,
      held = false;
    const ready = new Promise((r) => {
      entered = r;
    });
    const g = gateway(
      f,
      { timeout_ms: 250, max_active_requests: 1 },
      decorated(f, (ctx, address) => {
        calls++;
        return f.hab.resolve(ctx, address);
      }),
      {
        async record(category) {
          if (category === "tool_started" && !held) {
            held = true;
            entered();
            await new Promise((r) => {
              release = r;
            });
          }
        },
      },
    );
    const pending = g.fetch(
      request("tools/call", {
        name: "relay_resolve",
        arguments: { address: b.address },
      }),
    );
    await ready;
    assert.equal((await pending).status, 504);
    await tick();
    assert.equal((await g.fetch(request())).status, 503);
    assert.equal(calls, 0);
    release();
    await tick();
    assert.equal((await g.fetch(request())).status, 200);
    assert.equal(calls, 0);
  },
);
