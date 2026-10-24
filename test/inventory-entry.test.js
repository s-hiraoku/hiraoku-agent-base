import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  realpathSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { inspectWorkerIdentity } from "../src/worker-identity.ts";
import { startInventoryBootstrap } from "../src/inventory-bootstrap.ts";
import { DatabaseSync } from "node:sqlite";
import { startInventoryEntry } from "../src/inventory-entry.ts";
import { InventoryChild } from "../src/inventory-factory.ts";
import { measureCodeTree } from "../src/inventory-inspector.ts";
import {
  INVENTORY_ONE_SHOT_KEY,
  InventoryMCPClient,
} from "../src/mcp-worker-client.ts";
import { skipAsRoot } from "./non-root.js";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-entry-")));
  const profile = join(root, ".hermes/profiles/hub-inventory-once");
  mkdirSync(join(profile, "empty-workdir"), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, "config.yaml"), "fixture-only\n", {
    mode: 0o600,
  });
  const sourceRoot = join(root, "reviewed/source"),
    guard = join(root, "reviewed/guard"),
    dependencyRoot = join(root, "reviewed/dependencies");
  for (const path of [sourceRoot, guard, dependencyRoot])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const wrapperPath = join(guard, "serve_inventory.py");
  // This is deliberately a Node fixture, not a substituted production bridge.
  writeFileSync(
    wrapperPath,
    readFileSync(new URL("./inventory-child-fixture.js", import.meta.url)),
    { mode: 0o400 },
  );
  for (const path of [sourceRoot, guard, dependencyRoot])
    chmodSync(path, 0o500);
  const pythonPath =
    process.platform === "darwin"
      ? join(root, "fixture-python")
      : realpathSync("/usr/bin/true");
  if (process.platform === "darwin")
    writeFileSync(pythonPath, "fixture-interpreter\n", { mode: 0o400 });
  const trees = [
    { root: sourceRoot },
    { root: guard },
    {
      root: pythonPath,
      ...(process.platform === "darwin" ? {} : { systemRuntime: true }),
    },
    { root: dependencyRoot, fixedDependencies: true },
  ];
  for (const tree of trees) {
    const { root: path, ...options } = tree;
    tree.sha256 = await measureCodeTree(path, Infinity, options);
  }
  const reviewed = {
    manifestPath: join(profile, "inventory-manifest.json"),
    endpoint: "http://127.0.0.1:8645/",
    namespaceLabel: "fixture",
    profileRoot: profile,
    sourceRoot,
    dependencyRoot,
    pythonIsolation: "isolated-no-site-v1",
    wrapperPath,
    pythonPath,
    codeTrees: trees,
    pythonSHA256: sha(readFileSync(pythonPath)),
    wrapperSHA256: sha(readFileSync(wrapperPath)),
    configSHA256: sha("fixture-only\n"),
    sourceCommit: "f97608f178d1ffeca59860195ab7da295f7c8e5f",
    storeRelativePath: "runs_idempotency.db",
  };
  const config = {
    version: 1,
    mode: "inventory-one-shot",
    enabled: true,
    oauth: {
      issuer: "https://fixture.us.auth0.com/",
      resource: "https://hub.example/hab/mcp",
    },
    requester: {
      subject: "fixture-requester",
      clientId: "fixture-user-client",
    },
    worker: { subject: "fixture-worker", clientId: "fixture-worker-client" },
    reviewed,
  };
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
  const enc = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = async (kind = "requester", claims = {}) => {
    const text = `${enc({ alg: "RS256", kid: "fixture" })}.${enc({ iss: config.oauth.issuer, aud: config.oauth.resource, sub: config[kind].subject, azp: config[kind].clientId, exp: Math.floor(Date.now() / 1000) + 600, scope: kind === "worker" ? "hub:claim hub:get hub:heartbeat hub:complete" : "hub:submit hub:get", ...claims })}`;
    return `Bearer ${text}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(text))).toString("base64url")}`;
  };
  const state = { launches: 0, entropy: 0 };
  const dependencies = {
    fetch: async (url) => {
      assert.equal(url, "https://fixture.us.auth0.com/.well-known/jwks.json");
      return Response.json({ keys: [jwk] });
    },
    lifetimeMs: 15000,
    factory: {
      checkPreparation: async () => {}, // Synthetic fixture, not a live Inspector grant.
      entropy: () => {
        state.entropy++;
        return Buffer.alloc(32, 9);
      },
      child: (launch) => {
        state.launches++;
        assert.deepEqual(launch.args, ["-I", "-S", wrapperPath]);
        const startedAt = Math.floor(Date.now() / 1000) * 1000;
        const child = new InventoryChild({
          ...launch,
          executable: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            readFileSync(wrapperPath, "utf8"),
          ],
        });
        state.child = child;
        state.startedAt = startedAt;
        return child;
      },
      // Only OS process observation is synthetic: the child really exists and
      // listens. Inspector filesystem/hash/scope checks and Runs HTTP are real.
      probe: async (pid) => ({
        pid,
        uid: process.getuid(),
        startedAt: state.startedAt,
        command: `${pythonPath} -I -S ${wrapperPath}`,
        listeners: ["127.0.0.1:8645"],
        sourceCommit: reviewed.sourceCommit,
      }),
    },
  };
  return {
    root,
    profile,
    config,
    sign,
    dependencies,
    state,
    cleanup: () => {
      for (const path of [sourceRoot, guard, dependencyRoot])
        chmodSync(path, 0o700);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const args = {
  task_type: "shift_log_inventory",
  request_key: INVENTORY_ONE_SHOT_KEY,
};
test("default preparation failure precedes Hub database, token callback, key and listener", async (t) => {
  if (skipAsRoot(t)) return;
  const f = await fixture();
  try {
    writeFileSync(join(f.profile, "config.yaml"), "dummy configuration drift", {
      mode: 0o600,
    });
    const before = readdirSync(f.profile).sort();
    const deps = { ...f.dependencies, factory: { ...f.dependencies.factory } };
    delete deps.factory.checkPreparation;
    let tokens = 0,
      fetches = 0;
    deps.fetch = async () => {
      fetches++;
      throw Error("must not fetch");
    };
    await assert.rejects(
      startInventoryEntry(
        f.config,
        {
          workerAuthorization: async () => {
            tokens++;
            return "unused-dummy";
          },
        },
        deps,
      ),
      /integrity_rejected/,
    );
    assert.equal(tokens, 0);
    assert.equal(fetches, 0);
    assert.equal(f.state.entropy, 0);
    assert.equal(f.state.launches, 0);
    assert.deepEqual(readdirSync(f.profile).sort(), before);
  } finally {
    f.cleanup();
  }
});

test("manual active CLI rejects preparation before accessing token stdin", async (t) => {
  if (skipAsRoot(t)) return;
  const f = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const previous = process.env.HAB_INVENTORY_CONFIG;
  try {
    writeFileSync(join(f.profile, "config.yaml"), "dummy configuration drift", {
      mode: 0o600,
    });
    const configPath = join(f.root, "active.local.json");
    writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
    process.env.HAB_INVENTORY_CONFIG = configPath;
    const { inventoryMain } = await import("../src/inventory-server.ts");
    let reads = 0;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get() {
        reads++;
        throw Error("must not read token input");
      },
    });
    await assert.rejects(inventoryMain(), /integrity_rejected/);
    assert.equal(reads, 0);
    assert.equal(f.state.entropy, 0);
    assert.equal(f.state.launches, 0);
  } finally {
    Object.defineProperty(process, "stdin", descriptor);
    if (previous === undefined) delete process.env.HAB_INVENTORY_CONFIG;
    else process.env.HAB_INVENTORY_CONFIG = previous;
    f.cleanup();
  }
});
const principal = { subject: "unused-local-label", operations: [] };
const rawCall = async (entry, authorization, name, input) => {
  const response = await globalThis.fetch(entry.endpoint, {
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
        arguments: input,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
test(
  "actual dedicated HTTP entry/auth/factory/child/Runs/result/stop round trip",
  { timeout: 20000, skip: process.getuid?.() === 0 },
  async () => {
    const f = await fixture();
    const workerToken = await f.sign("worker", {
      iat: Math.floor(Date.now() / 1000),
      gty: "client-credentials",
    });
    const candidate = await inspectWorkerIdentity(
      {
        version: 1,
        mode: "verify-worker-identity",
        oauth: f.config.oauth,
        workerClientId: f.config.worker.clientId,
      },
      workerToken,
      { fetch: f.dependencies.fetch },
    );
    assert.equal(candidate.enrolled, false);
    assert.equal(candidate.subject, f.config.worker.subject);
    assert.equal(f.state.entropy, 0);
    assert.equal(f.state.launches, 0);
    // Explicit operator decision after verification; the helper never writes config.
    f.config.worker = {
      subject: candidate.subject,
      clientId: candidate.clientId,
    };
    let entry;
    let workerReady;
    const ready = new Promise((resolve) => {
      workerReady = resolve;
    });
    let releaseAck;
    const ack = new Promise((resolve) => {
      releaseAck = resolve;
    });
    const forward = (url, init) =>
      new Promise((resolve, reject) => {
        const req = request(
          new URL(url),
          {
            method: init.method,
            signal: init.signal,
            headers: { ...init.headers, Host: "hub.example" },
          },
          (res) => {
            let body = "";
            res.on("data", (part) => {
              body += part;
            });
            res.once("end", () =>
              resolve(
                new Response(body, {
                  status: res.statusCode,
                  headers: res.headers,
                }),
              ),
            );
          },
        );
        req.once("error", reject);
        req.end(init.body);
      });
    f.dependencies.workerFetch = async (url, init) => {
      const response = await forward(url, init);
      const name = JSON.parse(init.body).params.name;
      if (name === "claim" && response.status === 200) workerReady();
      if (name === "complete") await ack;
      return response;
    };
    try {
      entry = await startInventoryEntry(
        f.config,
        { workerAuthorization: async () => workerToken },
        f.dependencies,
      );
      const client = new InventoryMCPClient({
        endpoint: entry.endpoint,
        authorization: () => f.sign(),
        fetch: forward,
      });
      const task = await client.submit(args);
      // Worker enrollment intentionally fences the previous verifier. Observe its
      // first authenticated claim before issuing more requester calls; otherwise
      // this round-trip fixture races that handoff under parallel CI load.
      await ready;
      const duplicates = await Promise.all([
        client.submit(args),
        client.submit(args),
      ]);
      assert.ok(duplicates.every((copy) => copy.id === task.id));
      let result;
      for (let i = 0; i < 100; i++) {
        result = await client.get(principal, { id: task.id });
        if (result.state === "succeeded") break;
        await pause(50);
      }
      assert.equal(result.state, "succeeded");
      assert.equal(JSON.parse(result.result).status, "unknown");
      assert.equal(f.state.child.exited, false);
      let closed = false;
      void entry.closed.then(() => {
        closed = true;
      });
      await pause(30);
      assert.equal(
        closed,
        false,
        "terminal result must wait for worker ACK before stopping",
      );
      releaseAck();
      await entry.closed;
      assert.equal(f.state.entropy, 1);
      assert.equal(f.state.launches, 1);
      assert.equal(f.state.child.exited, true);
      const db = new DatabaseSync(join(f.profile, "runs_idempotency.db"));
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM fixture_runs").get().n,
        1,
      );
      db.close();
      const record = JSON.parse(
        readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
      );
      assert.equal(record.state, "revoked");
      assert.equal("key" in record, false);
      await assert.rejects(
        startInventoryEntry(
          f.config,
          { workerAuthorization: () => f.sign("worker") },
          f.dependencies,
        ),
        /reconciliation/,
      );
    } finally {
      releaseAck();
      if (entry) await entry.close();
      f.cleanup();
    }
  },
);
test(
  "explicit settings and requester scope fail closed before child/key",
  { timeout: 12000, skip: process.getuid?.() === 0 },
  async () => {
    const f = await fixture();
    let entry;
    try {
      for (const input of [
        undefined,
        { ...f.config, enabled: false },
        { ...f.config, mode: "auth0" },
        { ...f.config, worker: f.config.requester },
        { ...f.config, extra: true },
      ])
        await assert.rejects(
          startInventoryEntry(
            input,
            { workerAuthorization: () => f.sign("worker") },
            f.dependencies,
          ),
          /config_rejected/,
        );
      assert.equal(existsSync(join(f.profile, "inventory-hub.sqlite")), false);
      entry = await startInventoryEntry(
        f.config,
        { workerAuthorization: () => f.sign("worker") },
        f.dependencies,
      );
      for (const claims of [
        { sub: "outsider" },
        { azp: "wrong-client" },
        { aud: "https://wrong.example/mcp" },
        { scope: "hub:claim" },
      ]) {
        const client = new InventoryMCPClient({
          endpoint: entry.endpoint,
          authorization: () => f.sign("requester", claims),
        });
        await assert.rejects(client.submit(args));
      }
      const client = new InventoryMCPClient({
        endpoint: entry.endpoint,
        authorization: () => f.sign(),
      });
      await assert.rejects(
        client.submit({ ...args, request_key: "different" }),
      );
      await assert.rejects(client.claim(principal, {}));
      for (const input of [
        { ...args, request_key: "different" },
        { ...args, task_type: "connectivity_check" },
        { ...args, agent: "hermes" },
        { ...args, destination: "elsewhere" },
      ]) {
        const denied = await rawCall(entry, await f.sign(), "submit", input);
        assert.ok(
          denied.status !== 200 ||
            denied.body.error ||
            denied.body.result?.isError,
        );
      }
      assert.equal(
        (await rawCall(entry, "Bearer invalid", "submit", args)).status,
        401,
      );
      assert.equal(f.state.launches, 0);
      assert.equal(f.state.entropy, 0);
      await entry.close();
      await entry.closed;
    } finally {
      if (entry) await entry.close();
      f.cleanup();
    }
  },
);

test("manual CLI without explicit config does not bind, start or acquire credentials", () => {
  const result = spawnSync(process.execPath, ["src/inventory-server.ts"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "inventory_entry_failed_requires_review\n");
});
test(
  "wrong worker authorization cannot claim or run; child stops with evidence retained",
  { timeout: 18000, skip: process.getuid?.() === 0 },
  async () => {
    const f = await fixture();
    let entry;
    try {
      entry = await startInventoryEntry(
        f.config,
        {
          workerAuthorization: () => f.sign("worker", { azp: "wrong-client" }),
        },
        f.dependencies,
      );
      const client = new InventoryMCPClient({
        endpoint: entry.endpoint,
        authorization: () => f.sign(),
      });
      await client.submit(args);
      await assert.rejects(entry.closed, /reconciliation/);
      assert.equal(f.state.launches, 1);
      assert.equal(f.state.child.exited, true);
      const db = new DatabaseSync(join(f.profile, "runs_idempotency.db"));
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM fixture_runs").get().n,
        0,
      );
      db.close();
      const hub = new DatabaseSync(join(f.profile, "inventory-hub.sqlite"));
      assert.equal(
        hub.prepare("SELECT state FROM tasks").get().state,
        "queued",
      );
      hub.close();
      assert.equal(
        JSON.parse(
          readFileSync(join(f.profile, "inventory-key-record.json"), "utf8"),
        ).state,
        "revoked",
      );
    } finally {
      if (entry) await entry.close();
      f.cleanup();
    }
  },
);
test(
  "idle deadline closes the authenticated entry without generating a local key",
  { timeout: 8000, skip: process.getuid?.() === 0 },
  async () => {
    const f = await fixture();
    let entry;
    try {
      entry = await startInventoryEntry(
        f.config,
        { workerAuthorization: () => f.sign("worker") },
        { ...f.dependencies, lifetimeMs: 1000 },
      );
      await entry.closed;
      assert.equal(f.state.entropy, 0);
      assert.equal(f.state.launches, 0);
      assert.equal(existsSync(join(f.profile, "credential.scope")), false);
    } finally {
      if (entry) await entry.close();
      f.cleanup();
    }
  },
);

const bootstrapConfig = () => ({
  version: 1,
  mode: "inventory-metadata",
  enabled: false,
  oauth: {
    issuer: "https://fixture.us.auth0.com/",
    resource: "https://hub.example/hab/mcp",
  },
});
const bootstrapRequest = (path, options = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: 8789,
        path,
        method: options.method ?? "GET",
        headers: { Host: "hub.example", ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (part) => {
          body += part;
        });
        res.once("end", () =>
          resolve({
            status: res.statusCode,
            challenge: res.headers["www-authenticate"] ?? null,
            body,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(options.body);
  });
const duplicateRequest = (headers) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: 8789,
        path: "/hab/mcp",
        method: "POST",
        headers,
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      },
    );
    req.once("error", reject);
    req.end();
  });
test(
  "explicit metadata-only CLI serves planned Host/path and denies every task with zero effects",
  { timeout: 12000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hab-bootstrap-")));
    const path = join(root, "bootstrap.local.json"),
      receipt = join(root, "effect-counts.json");
    const config = bootstrapConfig();
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./bootstrap-guard-fixture.js", import.meta.url)),
        fileURLToPath(new URL("../src/inventory-server.ts", import.meta.url)),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HAB_INVENTORY_CONFIG: path,
          HAB_BOOTSTRAP_TEST_RECEIPT: receipt,
        },
        stdio: "ignore",
        shell: false,
      },
    );
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      let metadata;
      for (let i = 0; i < 60; i++) {
        try {
          metadata = await bootstrapRequest(
            "/.well-known/oauth-protected-resource/hab/mcp",
          );
          break;
        } catch {
          await pause(25);
        }
      }
      assert.equal(metadata?.status, 200);
      assert.deepEqual(JSON.parse(metadata.body), {
        resource: config.oauth.resource,
        authorization_servers: [config.oauth.issuer],
        scopes_supported: ["hub:submit", "hub:get"],
        bearer_methods_supported: ["header"],
      });
      assert.equal(
        (
          await bootstrapRequest(
            "/.well-known/oauth-protected-resource/hab/mcp",
            { headers: { Host: "127.0.0.1:8789" } },
          )
        ).status,
        200,
      );
      const post = {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "submit", arguments: args },
        }),
        headers: { "Content-Type": "application/json" },
      };
      for (const authorization of [
        undefined,
        "Bearer invalid",
        "Bearer synthetically.valid.token",
      ]) {
        const denied = await bootstrapRequest("/hab/mcp", {
          ...post,
          headers: {
            ...post.headers,
            ...(authorization ? { Authorization: authorization } : {}),
          },
        });
        assert.equal(denied.status, 401);
        assert.equal(
          denied.challenge,
          'Bearer resource_metadata="https://hub.example/.well-known/oauth-protected-resource/hab/mcp", scope="hub:submit hub:get"',
        );
      }
      for (const headers of [
        { Host: "evil.example" },
        { Origin: "https://evil.example" },
        { Host: "evil.example", "X-Forwarded-Host": "hub.example" },
      ])
        assert.equal(
          (await bootstrapRequest("/hab/mcp", { ...post, headers })).status,
          403,
        );
      assert.equal(
        (
          await bootstrapRequest("/hab/mcp", {
            ...post,
            headers: { Origin: "https://hub.example" },
          })
        ).status,
        401,
      );
      assert.equal(
        await duplicateRequest(["Host", "hub.example", "Host", "evil.example"]),
        403,
      );
      assert.equal(
        await duplicateRequest([
          "Host",
          "hub.example",
          "Authorization",
          "Bearer invalid",
          "Authorization",
          "Bearer other",
        ]),
        403,
      );
      assert.equal(
        (await bootstrapRequest("/.well-known/oauth-protected-resource"))
          .status,
        401,
      );
      assert.equal(
        (
          await bootstrapRequest(
            "/.well-known/oauth-protected-resource/hab/mcp?extra=1",
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await bootstrapRequest(
            "/.well-known/oauth-protected-resource/hab/mcp",
            { method: "POST" },
          )
        ).status,
        405,
      );
      // File edits do not promote a running bootstrap; another validated process
      // invocation is required, with explicit confirmed subjects and authorization.
      writeFileSync(
        path,
        JSON.stringify({
          ...config,
          mode: "inventory-one-shot",
          enabled: true,
          requester: { subject: "fixture", clientId: "fixture" },
        }),
      );
      for (const name of [
        "submit",
        "claim",
        "heartbeat",
        "complete",
        "get",
        "cancel",
      ])
        assert.equal(
          (
            await bootstrapRequest("/hab/mcp", {
              ...post,
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name, arguments: args },
              }),
            })
          ).status,
          401,
        );
      child.kill("SIGTERM");
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
        sqlite: 0,
        randomBytes: 0,
        spawn: 0,
        outboundFetch: 0,
      });
      const { readdirSync } = await import("node:fs");
      assert.deepEqual(readdirSync(root).sort(), [
        "bootstrap.local.json",
        "effect-counts.json",
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("bootstrap rejects authority fields, enabled=true and malformed mode before binding", async () => {
  const config = bootstrapConfig();
  for (const input of [
    undefined,
    { ...config, enabled: true },
    { ...config, mode: "inventory-one-shot" },
    { ...config, worker: {} },
    { ...config, subjects: [] },
    { ...config, reviewed: {} },
    { ...config, oauth: { ...config.oauth, scopes: ["hub:complete"] } },
  ])
    await assert.rejects(startInventoryBootstrap(input), /config_rejected/);
});
test(
  "bootstrap reaches a finite idle deadline without credentials or task setup",
  { timeout: 5000 },
  async () => {
    const entry = await startInventoryBootstrap(bootstrapConfig(), {
      lifetimeMs: 1000,
    });
    assert.equal(
      (await bootstrapRequest("/hab/mcp", { method: "POST" })).status,
      401,
    );
    await entry.closed;
    await assert.rejects(bootstrapRequest("/hab/mcp"));
  },
);
