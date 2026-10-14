import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  chmodSync,
  realpathSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hub } from "../src/sqlite.ts";
import {
  startPingRunner,
  pingRunnerSettings,
  PING_SCOPES,
} from "../src/ping-runner.ts";
const settings = () => ({
  version: 1,
  mode: "manual-ping-only",
  enabled: true,
  lifetimeMs: 10000,
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/hab/mcp",
  },
  peers: {
    dots: { subject: "fixture-owner", clientId: "fixture-dots" },
    grok: { subject: "fixture-owner", clientId: "fixture-grok" },
  },
});
test("manual CLI missing config or extra credential-shaped arguments fail without disclosure", () => {
  for (const args of [[], ["PRIVATE_SENTINEL"]]) {
    const result = spawnSync(
      process.execPath,
      ["src/ping-runner-cli.ts", ...args],
      {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes("ping_runner_rejected"));
    assert.ok(!result.stderr.includes("PRIVATE_SENTINEL"));
  }
});
class FakeServer extends EventEmitter {
  listening = false;
  listenCalls = 0;
  closeCalls = 0;
  listen(port, host, ready) {
    this.listenCalls++;
    assert.equal(port, 8789);
    assert.equal(host, "127.0.0.1");
    if (this.fail)
      globalThis.queueMicrotask(() =>
        this.emit("error", Error("dummy bind failure")),
      );
    else {
      this.listening = true;
      globalThis.queueMicrotask(ready);
    }
    return this;
  }
  close(done) {
    this.closeCalls++;
    this.listening = false;
    globalThis.queueMicrotask(() => done());
  }
  closeAllConnections() {
    this.connectionsClosed = true;
  }
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-ping-runner-")));
  chmodSync(root, 0o700);
  const server = new FakeServer(),
    state = { audits: 0, auditClosed: 0, hubs: 0, fetches: 0 };
  const records = [];
  const audit = {
    ready: async () => {},
    record: async (category, correlation) =>
      records.push({ category, correlation }),
    close: async () => {
      state.auditClosed++;
    },
  };
  const deps = {
    createHTTP: (handle) => {
      server.handle = handle;
      return server;
    },
    createHub: (path) => {
      state.hubs++;
      const hub = new Hub(path);
      state.hub = hub;
      return hub;
    },
    createAudit: () => {
      state.audits++;
      return audit;
    },
    fetch: async () => {
      state.fetches++;
      throw Error("no real network");
    },
  };
  return {
    root,
    server,
    state,
    audit,
    records,
    deps,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("invalid or widened config refuses before private DB/audit/listener/network", async () => {
  const f = fixture();
  try {
    for (const config of [
      undefined,
      { ...settings(), enabled: false },
      { ...settings(), lifetimeMs: 900001 },
      { ...settings(), scopes: ["hub:submit"] },
      {
        ...settings(),
        peers: { dots: settings().peers.dots, grok: settings().peers.dots },
      },
      {
        ...settings(),
        oauth: { ...settings().oauth, resource: "https://hub.example/mcp" },
      },
    ])
      await assert.rejects(startPingRunner(config, f.root, f.deps));
    assert.deepEqual(readdirSync(f.root), []);
    assert.equal(f.state.hubs, 0);
    assert.equal(f.state.audits, 0);
    assert.equal(f.server.listenCalls, 0);
    assert.equal(f.state.fetches, 0);
    assert.equal(
      pingRunnerSettings(settings()).runtimeConfig.subjects.length,
      2,
    );
  } finally {
    f.cleanup();
  }
});
test("dummy listener starts only after private DB/audit, closes at deadline without network", async () => {
  const f = fixture();
  try {
    const runner = await startPingRunner(
      { ...settings(), lifetimeMs: 1000 },
      f.root,
      f.deps,
    );
    assert.equal(statSync(join(f.root, "ping-hub.sqlite")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.root, "audit")).mode & 0o777, 0o700);
    await runner.closed;
    assert.equal(
      (await runner.fetch(new Request(settings().oauth.resource))).status,
      503,
    );
    assert.equal(f.server.listening, false);
    assert.equal(f.state.auditClosed, 1);
    assert.equal(f.state.fetches, 0);
    assert.throws(() => f.state.hub.sqlite.db.prepare("SELECT 1"));
    assert.ok(readdirSync(f.root).includes("ping-hub.sqlite"));
  } finally {
    f.cleanup();
  }
});
test("bind failure closes owned DB/audit/server and preserves evidence", async () => {
  const f = fixture();
  f.server.fail = true;
  try {
    await assert.rejects(
      startPingRunner(settings(), f.root, f.deps),
      /start_rejected/,
    );
    assert.equal(f.state.auditClosed, 1);
    assert.equal(f.server.listening, false);
    assert.throws(() => f.state.hub.sqlite.db.prepare("SELECT 1"));
    assert.ok(readdirSync(f.root).includes("ping-hub.sqlite"));
  } finally {
    f.cleanup();
  }
});
test("audit readiness failure never calls listen and cleans allocated resources", async () => {
  const f = fixture();
  f.audit.ready = async () => {
    throw Error("dummy audit failure");
  };
  try {
    await assert.rejects(
      startPingRunner(settings(), f.root, f.deps),
      /start_rejected/,
    );
    assert.equal(f.server.listenCalls, 0);
    assert.equal(f.state.auditClosed, 1);
    assert.throws(() => f.state.hub.sqlite.db.prepare("SELECT 1"));
  } finally {
    f.cleanup();
  }
});
test("duplicate raw Host is rejected before token verification", async () => {
  const f = fixture();
  let runner;
  try {
    runner = await startPingRunner(settings(), f.root, f.deps);
    const host = "hub.example";
    const req = {
      headers: { host },
      rawHeaders: ["Host", host, "Host", host],
      method: "POST",
      url: "/hab/mcp",
    };
    const res = new EventEmitter();
    const ended = new Promise((resolve) => {
      res.end = resolve;
    });
    res.writeHead = (status) => {
      res.statusCode = status;
    };
    f.server.handle(req, res);
    await ended;
    assert.equal(res.statusCode, 403);
    assert.equal(f.state.fetches, 0);
  } finally {
    if (runner) await runner.close();
    f.cleanup();
  }
});
test("unconfirmed server shutdown is explicitly uncertain but DB/audit still close", async () => {
  const f = fixture();
  let runner;
  try {
    runner = await startPingRunner(settings(), f.root, f.deps);
    f.server.close = () => {};
    await assert.rejects(runner.close(), /stop_uncertain/);
    await assert.rejects(runner.closed, /stop_uncertain/);
    assert.equal(f.state.auditClosed, 1);
    assert.throws(() => f.state.hub.sqlite.db.prepare("SELECT 1"));
  } finally {
    f.cleanup();
  }
});
test("in-process authenticated Grok/dots ping/pong exposes four tools only and rejects other clients/Host/Origin", async () => {
  const f = fixture();
  let runner;
  try {
    const pair = await crypto.subtle.generateKey(
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
      ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      kid: "fixture",
      alg: "RS256",
      use: "sig",
    };
    f.deps.fetch = async (url) => {
      assert.equal(url, "https://fixture.us.auth0.com/.well-known/jwks.json");
      return Response.json({ keys: [jwk] });
    };
    runner = await startPingRunner(settings(), f.root, f.deps);
    const enc = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const token = async (client) => {
      const now = Math.floor(Date.now() / 1000),
        data = `${enc({ alg: "RS256", kid: "fixture", typ: "JWT" })}.${enc({ iss: settings().oauth.issuer, aud: settings().oauth.resource, sub: "fixture-owner", azp: client, iat: now, exp: now + 120, scope: PING_SCOPES.join(" ") })}`;
      return `Bearer ${data}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data))).toString("base64url")}`;
    };
    const grok = await token("fixture-grok"),
      dots = await token("fixture-dots");
    let sequence = 0;
    const rpc = async (auth, method, name, args = {}) => {
      const params = method === "tools/call" ? { name, arguments: args } : {};
      params._meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      return runner.fetch(
        new Request(settings().oauth.resource, {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
            Accept: "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(name ? { "Mcp-Name": name } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++sequence,
            method,
            params,
          }),
        }),
      );
    };
    const tools = await (await rpc(grok, "tools/list")).json();
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), [
      "ping_get",
      "ping_pending",
      "ping_reply",
      "ping_submit",
    ]);
    const value = async (auth, name, args) => {
      const r = await rpc(auth, "tools/call", name, args);
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.result.isError, undefined);
      return JSON.parse(b.result.content[0].text);
    };
    const submitted = await value(grok, "ping_submit", {
      payload: "ping",
      ttl_ms: 300000,
      request_key: "dummy-unique",
    });
    const pending = await value(dots, "ping_pending", {});
    assert.equal(pending[0].id, submitted.id);
    await value(dots, "ping_reply", {
      in_reply_to: submitted.id,
      correlation_id: submitted.correlation_id,
      payload: "pong",
    });
    const got = await value(grok, "ping_get", { id: submitted.id });
    assert.equal(got.state, "replied");
    assert.equal(got.correlation_id, submitted.correlation_id);
    assert.equal(
      (await rpc(await token("wrong-client"), "tools/list")).status,
      401,
    );
    const refused = await (
      await rpc(grok, "tools/call", "submit", { request_key: "must-not-run" })
    ).json();
    assert.ok(refused.error || refused.result?.isError);
    assert.equal(
      (await runner.fetch(new Request("https://wrong.example/hab/mcp"))).status,
      403,
    );
    assert.equal(
      (
        await runner.fetch(
          new Request(settings().oauth.resource, {
            headers: { Origin: "https://wrong.example" },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      f.state.hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
      0,
    );
    assert.ok(f.records.length > 0);
    assert.ok(!JSON.stringify(f.records).includes(grok));
    assert.ok(!JSON.stringify(f.records).includes(dots));
  } finally {
    if (runner) await runner.close();
    f.cleanup();
  }
});
