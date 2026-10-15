import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  createPingDiscovery,
  startPingDiscovery,
} from "../src/ping-discovery.ts";
const settings = () => ({
  version: 1,
  mode: "ping-discovery",
  enabled: false,
  lifetimeMs: 10000,
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/hab/mcp",
  },
});
const metadata = "/.well-known/oauth-protected-resource/hab/mcp";
class Server extends EventEmitter {
  listens = 0;
  closes = 0;
  listen(port, host, ready) {
    this.listens++;
    assert.equal(port, 8789);
    assert.equal(host, "127.0.0.1");
    globalThis.queueMicrotask(() =>
      this.failure ? this.emit("error", Error("PRIVATE_FAILURE")) : ready(),
    );
    return this;
  }
  close(done) {
    this.closes++;
    if (!this.stall) globalThis.queueMicrotask(() => done(this.closeError));
  }
  closeAllConnections() {
    this.destroyed = true;
  }
}
function fixture() {
  const server = new Server();
  return {
    server,
    dependencies: {
      createHTTP(handle) {
        server.handle = handle;
        return server;
      },
    },
  };
}
async function request(app, path = "/hab/mcp", init) {
  return app.fetch(new Request("https://hub.example" + path, init));
}
test("discovery config has no peer/activation path and rejects widened settings before listener allocation", async () => {
  for (const config of [
    undefined,
    { ...settings(), enabled: true },
    { ...settings(), peers: {} },
    { ...settings(), mode: "manual-ping-only" },
    { ...settings(), lifetimeMs: 900001 },
    {
      ...settings(),
      oauth: { ...settings().oauth, resource: "https://hub.example/mcp" },
    },
  ]) {
    const f = fixture();
    await assert.rejects(
      startPingDiscovery(config, f.dependencies),
      /^Error: ping_discovery_config_rejected$/,
    );
    assert.equal(f.server.listens, 0);
  }
});
test("only fixed metadata and 401 are exposed; every MCP operation and Bearer is refused with zero network", async () => {
  const app = createPingDiscovery(settings());
  let network = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    network++;
    throw Error("network forbidden");
  };
  try {
    const response = await request(app, metadata);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: settings().oauth.resource,
      authorization_servers: [settings().oauth.issuer],
      scopes_supported: [
        "hub:ping_submit",
        "hub:ping_get",
        "hub:ping_reply",
        "hub:ping_pending",
      ],
      bearer_methods_supported: ["header"],
    });
    for (const authorization of [undefined, "Bearer dummy.jwt.signature"]) {
      for (const name of [
        "initialize",
        "tools/list",
        "submit",
        "claim",
        "complete",
        "ping_submit",
        "ping_get",
        "ping_reply",
        "ping_pending",
        "grants",
        "reconcile",
      ]) {
        const reply = await request(app, "/hab/mcp", {
          method: "POST",
          headers: authorization ? { Authorization: authorization } : {},
          body: JSON.stringify({ method: "tools/call", params: { name } }),
        });
        assert.equal(reply.status, 401);
        assert.equal(await reply.text(), "");
        assert.match(
          reply.headers.get("www-authenticate"),
          /resource_metadata="https:\/\/hub.example\/\.well-known\/oauth-protected-resource\/hab\/mcp"/,
        );
        assert.equal(reply.headers.get("cache-control"), "no-store");
      }
    }
    assert.equal(
      (await request(app, metadata, { method: "POST" })).status,
      405,
    );
    assert.equal((await request(app, "/mcp")).status, 404);
    assert.equal((await request(app, "/hab/mcp?other=1")).status, 404);
    assert.equal(network, 0);
  } finally {
    globalThis.fetch = original;
    app.stop();
  }
});
test("exact public Host/Origin only; forwarding headers confer no authority and oversized bodies fail", async () => {
  const app = createPingDiscovery(settings());
  for (const host of ["wrong.example", "127.0.0.1:8787", "127.0.0.1:8789"]) {
    assert.equal(
      (
        await request(app, "/hab/mcp", {
          headers: { Host: host, "X-Forwarded-Host": "hub.example" },
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await request(app, "/hab/mcp", {
        headers: { Origin: "https://wrong.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app, "/hab/mcp", {
        headers: { Origin: "https://hub.example" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app, "/hab/mcp", {
        method: "POST",
        body: "x".repeat(32769),
      })
    ).status,
    413,
  );
  app.stop();
  assert.equal((await request(app, metadata)).status, 503);
});
test("raw duplicate security headers are refused; Node path returns the same metadata/challenge", async () => {
  const f = fixture(),
    runner = await startPingDiscovery(settings(), f.dependencies);
  const dispatch = async (path, rawHeaders, chunks = [], method = "POST") => {
    const req = Readable.from(chunks);
    req.url = path;
    req.method = method;
    req.headers = { host: "hub.example" };
    req.rawHeaders = rawHeaders;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
        this.writableEnded = true;
        resolveDone();
      },
    };
    f.server.handle(req, res);
    await done;
    return res;
  };
  try {
    for (const name of ["Host", "Origin", "Authorization"]) {
      const res = await dispatch("/hab/mcp", [
        "Host",
        "hub.example",
        name,
        "a",
        name.toLowerCase(),
        "b",
      ]);
      assert.equal(res.status, 403);
    }
    const res = await dispatch(
      "/hab/mcp",
      ["Host", "hub.example"],
      ["invalid JSON, never parsed"],
    );
    assert.equal(res.status, 401);
    assert.ok(res.headers["www-authenticate"]);
    const meta = await dispatch(metadata, ["Host", "hub.example"]);
    assert.equal(meta.status, 405);
    const get = await dispatch(metadata, ["Host", "hub.example"], [], "GET");
    assert.equal(get.status, 200);
    assert.equal(JSON.parse(get.body).scopes_supported.length, 4);
    const oversized = await dispatch(
      "/hab/mcp",
      ["Host", "hub.example"],
      ["x".repeat(32769)],
    );
    assert.equal(oversized.status, 413);
  } finally {
    await runner.close();
  }
});
test("finite dummy listener closes at deadline and repeated close is idempotent", async () => {
  const f = fixture(),
    runner = await startPingDiscovery(
      { ...settings(), lifetimeMs: 1000 },
      f.dependencies,
    );
  assert.equal(f.server.maxConnections, 32);
  assert.equal(f.server.maxRequestsPerSocket, 60);
  await runner.closed;
  await runner.close();
  assert.equal(f.server.closes, 1);
  assert.equal(f.server.destroyed, true);
  assert.equal(
    (await runner.fetch(new Request(settings().oauth.resource))).status,
    503,
  );
});
test("startup error closes owned server and sanitizes details", async () => {
  const f = fixture();
  f.server.failure = true;
  await assert.rejects(
    startPingDiscovery(settings(), f.dependencies),
    /^Error: ping_discovery_start_rejected$/,
  );
  assert.equal(f.server.closes, 1);
  assert.equal(f.server.destroyed, true);
});
test("callback rejection and stalled shutdown remain explicitly uncertain", async () => {
  for (const mode of ["rejected", "stalled"]) {
    const f = fixture();
    if (mode === "stalled") f.server.stall = true;
    else f.server.closeError = Error("PRIVATE_STOP");
    const runner = await startPingDiscovery(settings(), f.dependencies);
    await assert.rejects(
      runner.close(),
      /^Error: ping_discovery_stop_uncertain$/,
    );
    await assert.rejects(runner.closed, /ping_discovery_stop_uncertain/);
    assert.equal(f.server.destroyed, true);
    assert.equal(f.server.closes, 1);
  }
});
test("request count is bounded even when no tools or auth verifier exist", async () => {
  const app = createPingDiscovery(settings());
  for (let i = 0; i < 120; i++) assert.equal((await request(app)).status, 401);
  assert.equal((await request(app)).status, 503);
  app.stop();
});
test("CLI requires explicit private config and refuses extra arguments without disclosure", () => {
  for (const args of [[], ["PRIVATE_SENTINEL"]]) {
    const result = spawnSync(
      process.execPath,
      ["src/ping-discovery-cli.ts", ...args],
      { env: {}, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ping_discovery_rejected\n");
  }
});

test("post-start server error stops only the owned dummy listener", async () => {
  const f = fixture(),
    runner = await startPingDiscovery(settings(), f.dependencies);
  f.server.emit("error", Error("PRIVATE_RUNTIME_ERROR"));
  await runner.closed;
  assert.equal(f.server.closes, 1);
  assert.equal(
    (await runner.fetch(new Request(settings().oauth.resource))).status,
    503,
  );
});
