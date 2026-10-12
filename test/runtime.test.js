import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, journal, RESPONSE } from "./fixtures.js";
import { createRuntime } from "../src/runtime.ts";
import { readRuntimeConfig } from "../src/runtime-config.ts";
import { MCPWorkerClient } from "../src/mcp-worker-client.ts";
import { Adapter, MockRuns } from "../src/adapter.ts";
import { OAuthResource } from "../src/oauth.ts";

const pingOps = ["ping_submit", "ping_get", "ping_reply", "ping_pending"];
const config = () => ({
  version: 1,
  mode: "auth0",
  enabled: true,
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example:8443/hab/mcp",
    scopes: [
      "hub:submit",
      "hub:get",
      "hub:cancel",
      ...pingOps.map((op) => `hub:${op}`),
    ],
  },
  subjects: [
    {
      subject: "fixture-grok",
      kind: "user",
      clientId: "fixture-grok-client",
      destination: "hermes",
      operations: ["submit", "get", "cancel", ...pingOps],
    },
    {
      subject: "fixture-dots",
      kind: "user",
      clientId: "fixture-dots-client",
      operations: pingOps,
    },
    {
      subject: "fixture-worker",
      kind: "service",
      clientId: "fixture-worker-client",
      worker: "hermes",
      runnerScope: "fixture-runs",
      operations: ["get", "claim", "heartbeat", "complete"],
    },
  ],
  ping: {
    dots: { subject: "fixture-dots", clientId: "fixture-dots-client" },
    grok: { subject: "fixture-grok", clientId: "fixture-grok-client" },
  },
});
async function fixture() {
  const hub = new Hub();
  const settings = config();
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  let jwksCalls = 0;
  const runtime = createRuntime(hub, settings, {
    fetch: async (url) => {
      assert.equal(url, "https://fixture.us.auth0.com/.well-known/jwks.json");
      jwksCalls++;
      return Response.json({ keys: [jwk] });
    },
  });
  const token = async (index = 0, overrides = {}) => {
    const policy = settings.subjects[index];
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const text = `${encode({ alg: "RS256", kid: "fixture" })}.${encode({ iss: settings.oauth.issuer, aud: settings.oauth.resource, sub: policy.subject, azp: policy.clientId, exp: Math.floor(Date.now() / 1000) + 300, scope: policy.operations.map((op) => `hub:${op}`).join(" "), ...overrides })}`;
    return `Bearer ${text}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(text))).toString("base64url")}`;
  };
  const call = async (
    authorization,
    name,
    args = {},
    url = settings.oauth.resource,
  ) =>
    runtime.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
  const value = async (authorization, name, args) => {
    const response = await call(authorization, name, args);
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.result.isError, undefined);
    return JSON.parse(envelope.result.content[0].text);
  };
  return {
    hub,
    settings,
    runtime,
    token,
    call,
    value,
    jwksCalls: () => jwksCalls,
  };
}

test("runtime defaults deny; malformed, unenrolled ping and broader rollout fail closed", async () => {
  const hub = new Hub();
  try {
    const runtime = createRuntime(hub);
    assert.equal(
      (
        await runtime.fetch(
          new Request("http://127.0.0.1:8787/mcp", { method: "POST" }),
        )
      ).status,
      401,
    );
    for (const mutate of [
      (c) => (c.mode = "public"),
      (c) => delete c.enabled,
      (c) => (c.subjects = []),
      (c) => (c.extra = "forbidden"),
      (c) => (c.ping.grok.clientId = "unapproved"),
      (c) => c.subjects[0].operations.push("events"),
      (c) => (c.subjects[2].taskTypes = ["shift_log_inventory"]),
      (c) => delete c.ping,
      (c) => delete c.subjects[2].runnerScope,
      (c) => delete c.subjects[2].worker,
    ]) {
      const c = config();
      mutate(c);
      assert.throws(() => createRuntime(hub, c), {
        message: "runtime_config_rejected",
      });
    }
  } finally {
    hub.close();
  }
});
test("explicitly disabled runtime denies tokens without JWKS egress", async () => {
  const hub = new Hub();
  const settings = config();
  settings.enabled = false;
  let calls = 0;
  try {
    const runtime = createRuntime(hub, settings, {
      fetch: async () => {
        calls++;
        throw Error();
      },
    });
    const response = await runtime.fetch(
      new Request(settings.oauth.resource, {
        method: "POST",
        headers: {
          Authorization:
            "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUifQ.e30.Zml4dHVyZQ",
        },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally {
    hub.close();
  }
});
test("explicit canonical HTTPS port/path drive audience, endpoint and metadata consistently", async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.workerEndpoint, "http://127.0.0.1:8787/hab/mcp");
    const metadata = await f.runtime.fetch(
      new Request(
        "https://hub.example:8443/.well-known/oauth-protected-resource/hab/mcp",
      ),
    );
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).resource, f.settings.oauth.resource);
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/hab/mcp?x=1",
      "/.well-known/oauth-protected-resource/hab/mcp#fragment",
    ])
      assert.equal(
        (await f.runtime.fetch(new Request(`https://hub.example:8443${path}`)))
          .status,
        401,
      );
    const denied = await f.runtime.fetch(
      new Request(f.settings.oauth.resource, { method: "POST" }),
    );
    assert.equal(denied.status, 401);
    assert.match(
      denied.headers.get("www-authenticate"),
      /:8443\/\.well-known\/oauth-protected-resource\/hab\/mcp/,
    );
    assert.equal(f.jwksCalls(), 0);
    const bearer = await f.token();
    for (const path of [
      "/mcp",
      "/hab/mcp?other=1",
      "/hab/mcp/",
      "/different/mcp",
    ])
      assert.equal(
        (
          await f.call(
            bearer,
            "tools/list",
            {},
            `https://hub.example:8443${path}`,
          )
        ).status,
        405,
      );
    assert.equal(
      (
        await f.call(
          await f.token(0, { aud: "https://hub.example/mcp" }),
          "submit",
        )
      ).status,
      401,
    );
  } finally {
    f.hub.close();
  }
  for (const url of [
    "https://hub.example//mcp",
    "https://hub.example/x/../mcp",
    "https://hub.example/%6dcp",
    "https://hub.example/mcp?x=1",
    "https://hub.example/mcp#fragment",
    "https://user@hub.example/mcp",
    "http://hub.example/mcp",
  ])
    assert.throws(
      () => new OAuthResource({ issuer: config().oauth.issuer, resource: url }),
    );
});
test("runtime host/origin guard denies before verification and ignores forwarded identity", async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
      { Origin: "null" },
    ]) {
      const response = await f.runtime.fetch(
        new Request(f.settings.oauth.resource, { headers }),
      );
      assert.equal(response.status, 403);
    }
    const spoofed = await f.runtime.fetch(
      new Request(f.settings.oauth.resource, {
        method: "POST",
        headers: {
          "X-Forwarded-Host": "hub.example:8443",
          "oai-authenticated-user-id": "fixture-grok",
          "X-Agent": "grok",
        },
      }),
    );
    assert.equal(spoofed.status, 401);
    assert.equal(f.jwksCalls(), 0);
  } finally {
    f.hub.close();
  }
});
test("configured Node boundary serves metadata, verifies tokens and denies duplicate auth without sockets", async () => {
  const f = await fixture();
  async function node(url, headers, rawHeaders) {
    const response = {
      status: null,
      headers: null,
      body: null,
      setHeader() {},
      once(name, work) {
        if (name === "finish") this.finish = work;
      },
      writeHead(status, fields) {
        this.status = status;
        this.headers = fields;
      },
      end(body) {
        this.body = body;
        this.finish?.();
      },
    };
    await f.runtime.handle(
      {
        url,
        method: "GET",
        headers,
        rawHeaders: rawHeaders ?? Object.entries(headers).flat(),
      },
      response,
    );
    return response;
  }
  try {
    assert.equal(
      (
        await node("/.well-known/oauth-protected-resource/hab/mcp", {
          host: "hub.example:8443",
        })
      ).status,
      200,
    );
    assert.equal(
      (await node("/hab/mcp", { host: "127.0.0.1:8787" })).status,
      401,
    );
    assert.equal(
      (
        await node("/hab/mcp", {
          host: "127.0.0.1:8787",
          authorization: await f.token(),
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await node("/hab/mcp", { host: "127.0.0.1:8787" }, [
          "Host",
          "127.0.0.1:8787",
          "Authorization",
          "dummy",
          "authorization",
          "dummy",
        ])
      ).status,
      403,
    );
  } finally {
    f.hub.close();
  }
});
test("authenticated MCP submit → outbound MCP adapter → mock Runs → get; no label-based authority", async () => {
  const f = await fixture();
  const runs = new MockRuns();
  runs.boundaryId = "fixture-runs";
  const receipt = journal();
  const calls = [];
  try {
    const user = await f.token();
    const bearer = await f.token(2);
    const args = {
      task_type: "connectivity_check",
      request_key: "runtime-roundtrip",
    };
    const submitted = await f.value(user, "submit", args);
    assert.equal((await f.value(user, "submit", args)).id, submitted.id);
    const client = new MCPWorkerClient({
      endpoint: f.runtime.workerEndpoint,
      authorization: async () => bearer,
      fetch: async (url, init) => {
        calls.push(JSON.parse(init.body));
        assert.equal(init.redirect, "error");
        return f.runtime.fetch(new Request(url, init));
      },
    });
    const worker = {
      subject: "not-used-for-auth",
      worker: "hermes",
      runnerScope: runs.boundaryId,
      operations: [],
    };
    await new Adapter(client, worker, runs, receipt).run();
    const result = await f.value(user, "get", { id: submitted.id });
    assert.equal(result.state, "succeeded");
    assert.equal(result.result, RESPONSE);
    assert.equal(result.runner_subject, "fixture-worker");
    assert.equal(receipt.load(), null);
    assert.equal(runs.calls, 1);
    assert.ok(
      calls.every(
        (c) =>
          !JSON.stringify(c.params.arguments).includes("not-used-for-auth"),
      ),
    );
    assert.equal(await client.claim(worker, {}), null);
    await f.hub.authorization.setStopped(
      { kind: "client", id: "fixture-worker-client" },
      true,
      await f.hub.authorization.epoch(),
      "fixture-operator",
    );
    await assert.rejects(client.claim(worker, {}), /requires_reconciliation/);
    assert.equal(runs.calls, 1);
  } finally {
    f.hub.close();
  }
});
test("entrypoint-wired ping/pong is reciprocal, idempotent and never submits a task", async () => {
  const f = await fixture();
  try {
    const grok = await f.token(0);
    const dots = await f.token(1);
    for (const [sender, recipient, key] of [
      [grok, dots, "grok-ping"],
      [dots, grok, "dots-ping"],
    ]) {
      const ping = await f.value(sender, "ping_submit", {
        request_key: key,
        payload: "ping",
      });
      assert.equal(
        (
          await f.value(sender, "ping_submit", {
            request_key: key,
            payload: "ping",
          })
        ).id,
        ping.id,
      );
      assert.equal(
        (await f.value(recipient, "ping_pending", {}))[0].id,
        ping.id,
      );
      await f.value(recipient, "ping_reply", {
        correlation_id: ping.correlation_id,
        in_reply_to: ping.id,
        payload: "pong",
      });
      assert.equal(
        (await f.value(sender, "ping_get", { id: ping.id })).state,
        "replied",
      );
    }
    assert.equal(
      f.hub.sqlite.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,
      0,
    );
    await f.hub.authorization.setStopped(
      { kind: "global", id: "*" },
      true,
      await f.hub.authorization.epoch(),
      "fixture-operator",
    );
    assert.equal((await f.call(grok, "ping_pending")).status, 401);
  } finally {
    f.hub.close();
  }
});
test("private runtime config rejects public permissions, symlink, oversized input and invalid JSON", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-runtime-config-")));
  const file = join(root, "runtime.local.json");
  try {
    writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
    assert.deepEqual(readRuntimeConfig(file), config());
    chmodSync(file, 0o644);
    assert.throws(
      () => readRuntimeConfig(file),
      /runtime_config_file_rejected/,
    );
    chmodSync(file, 0o600);
    symlinkSync(file, join(root, "link.local.json"));
    assert.throws(
      () => readRuntimeConfig(join(root, "link.local.json")),
      /runtime_config_file_rejected/,
    );
    writeFileSync(file, "{");
    assert.throws(
      () => readRuntimeConfig(file),
      /runtime_config_file_rejected/,
    );
    writeFileSync(file, " ".repeat(65537));
    assert.throws(
      () => readRuntimeConfig(file),
      /runtime_config_file_rejected/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("worker client rejects external endpoints and errors without retries or provider details", async () => {
  for (const endpoint of [
    "https://evil.example/mcp",
    "http://localhost:8787/mcp",
    "http://127.0.0.1:8765/mcp",
    "http://user@127.0.0.1:8787/mcp",
    "http://127.0.0.1:8787/mcp?x=1",
  ])
    assert.throws(
      () =>
        new MCPWorkerClient({
          endpoint,
          authorization: async () => "Bearer dummy",
        }),
    );
  for (const response of [
    () => new Response("provider-private-detail", { status: 401 }),
    () => new Response(null, { status: 302 }),
    () => Response.json({ error: "provider-private-detail" }),
    () => new Response("x".repeat(65537)),
  ]) {
    let calls = 0;
    const client = new MCPWorkerClient({
      endpoint: "http://127.0.0.1:8787/mcp",
      authorization: async () => "Bearer dummy",
      fetch: async () => {
        calls++;
        return response();
      },
    });
    await assert.rejects(client.claim({}, {}), {
      message: "worker_mcp_rejected_requires_reconciliation",
    });
    assert.equal(calls, 1);
  }
});
test("worker timeout stops even an uncooperative transport or credential supplier", async () => {
  const client = new MCPWorkerClient({
    endpoint: "http://127.0.0.1:8787/mcp",
    timeoutMs: 10,
    authorization: async () => "Bearer dummy",
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(client.claim({}, {}), /requires_reconciliation/);
  const hungCredential = new MCPWorkerClient({
    endpoint: "http://127.0.0.1:8787/mcp",
    timeoutMs: 10,
    authorization: async () => new Promise(() => {}),
  });
  await assert.rejects(hungCredential.claim({}, {}), /requires_reconciliation/);
  let fetched = false;
  const badCredential = new MCPWorkerClient({
    endpoint: "http://127.0.0.1:8787/mcp",
    authorization: async () => "bad\r\nvalue",
    fetch: async () => {
      fetched = true;
    },
  });
  await assert.rejects(badCredential.claim({}, {}), /requires_reconciliation/);
  assert.equal(fetched, false);
});

test("lost completion acknowledgement preserves receipt; reopen observes terminal task without another run", async () => {
  const f = await fixture();
  const runs = new MockRuns();
  runs.boundaryId = "fixture-runs";
  const receipt = journal();
  let drop = true;
  try {
    const user = await f.token();
    const bearer = await f.token(2);
    const submitted = await f.value(user, "submit", {
      task_type: "connectivity_check",
      request_key: "lost-complete",
    });
    const client = new MCPWorkerClient({
      endpoint: f.runtime.workerEndpoint,
      authorization: async () => bearer,
      fetch: async (url, init) => {
        const response = await f.runtime.fetch(new Request(url, init));
        if (JSON.parse(init.body).params.name === "complete" && drop) {
          drop = false;
          throw Error("fixture lost acknowledgement");
        }
        return response;
      },
    });
    const worker = {
      subject: "fixture-worker",
      worker: "hermes",
      runnerScope: runs.boundaryId,
      operations: ["get", "claim", "heartbeat", "complete"],
    };
    await assert.rejects(
      new Adapter(client, worker, runs, receipt).run(),
      /requires_reconciliation/,
    );
    assert.equal(receipt.load().run_id, "mock-1");
    assert.equal(
      (await f.value(user, "get", { id: submitted.id })).state,
      "succeeded",
    );
    await new Adapter(client, worker, runs, receipt).run();
    assert.equal(receipt.load(), null);
    assert.equal(runs.calls, 1);
    assert.equal(
      f.hub.sqlite.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n,
      1,
    );
  } finally {
    f.hub.close();
  }
});

test("unknown claim acknowledgement never admits a model run or reclaims the open execution", async () => {
  const f = await fixture();
  const runs = new MockRuns();
  runs.boundaryId = "fixture-runs";
  const receipt = journal();
  let drop = true;
  try {
    const user = await f.token();
    const bearer = await f.token(2);
    const submitted = await f.value(user, "submit", {
      task_type: "connectivity_check",
      request_key: "lost-claim",
    });
    const client = new MCPWorkerClient({
      endpoint: f.runtime.workerEndpoint,
      authorization: async () => bearer,
      fetch: async (url, init) => {
        const response = await f.runtime.fetch(new Request(url, init));
        if (drop) {
          drop = false;
          throw Error();
        }
        return response;
      },
    });
    const worker = {
      subject: "fixture-worker",
      worker: "hermes",
      runnerScope: runs.boundaryId,
      operations: [],
    };
    await assert.rejects(
      new Adapter(client, worker, runs, receipt).run(),
      /requires_reconciliation/,
    );
    assert.equal(await new Adapter(client, worker, runs, receipt).run(), null);
    assert.equal(runs.calls, 0);
    assert.equal(
      (await f.value(user, "get", { id: submitted.id })).execution_open,
      1,
    );
  } finally {
    f.hub.close();
  }
});

test("a boundary-bearing Runs rejects missing server scope before admission and retains receipt", async () => {
  const hub = new Hub();
  const runs = new MockRuns();
  runs.boundaryId = "fixture-runs";
  const receipt = journal();
  try {
    await hub.submit(
      {
        subject: "fixture-owner",
        destination: "hermes",
        operations: ["submit"],
      },
      { task_type: "connectivity_check", request_key: "scope-check" },
    );
    const unscopedWorker = {
      subject: "fixture-worker",
      worker: "hermes",
      operations: ["get", "claim", "heartbeat", "complete"],
    };
    const transport = {
      claim: (_p, a) => hub.claim(unscopedWorker, a),
      get: (_p, a) => hub.get(unscopedWorker, a),
      heartbeat: (_p, a) => hub.heartbeat(unscopedWorker, a),
      complete: (_p, a) => hub.complete(unscopedWorker, a),
    };
    await assert.rejects(
      new Adapter(
        transport,
        { ...unscopedWorker, runnerScope: runs.boundaryId },
        runs,
        receipt,
      ).run(),
      /runner_scope_requires_reconciliation/,
    );
    assert.equal(runs.calls, 0);
    assert.ok(receipt.load());
  } finally {
    hub.close();
  }
});
