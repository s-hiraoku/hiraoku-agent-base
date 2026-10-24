import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  chmodSync,
  rmSync,
  readdirSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { startLocalRelay } from "../src/relay-host/local.ts";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import {
  options as registryOptions,
  principal,
  operations,
} from "./hab-registry-fixtures.js";
import { limits, policy, message, envelope } from "./relay-http-fixtures.js";

function fixture(t, enroll = true) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "local-relay-host-")),
  );
  chmodSync(directory, 0o700);
  const admin = Symbol("synthetic-admin"),
    contexts = { a: Symbol("a"), b: Symbol("b") },
    agents = {};
  let permitted = true;
  const authority = {
    administrator: (ctx) =>
      ctx === admin ? { actor_id: "synthetic-admin" } : undefined,
    individual: (ctx) => {
      const name = Object.keys(contexts).find((n) => contexts[n] === ctx);
      return name && permitted
        ? {
            principal: principal(name),
            expires_at: new Date(Date.now() + 30000).toISOString(),
          }
        : undefined;
    },
  };
  if (enroll) {
    const registry = new SQLiteHabRegistry(
      join(directory, "registry.sqlite"),
      registryOptions,
      authority,
    );
    try {
      registry.migrate();
      const product = registry.registerProduct(admin, {
        request_id: "product",
        agent_name: "synthetic",
      });
      for (const name of Object.keys(contexts)) {
        const agent = registry.enroll(admin, {
          request_id: "enroll-" + name,
          product_id: product.product_id,
          bot_name: name,
        });
        const binding = registry.bind(admin, {
          request_id: "bind-" + name,
          agent_id: agent.agent_id,
          expected_epoch: agent.epoch,
          principal: principal(name),
        });
        agents[name] = registry.setAccess(admin, {
          request_id: "access-" + name,
          agent_id: agent.agent_id,
          expected_epoch: binding.agent_epoch,
          state: "active",
          operations,
        });
      }
    } finally {
      registry.close();
    }
  }
  const http = { ...policy };
  delete http.resource_url;
  delete http.allowed_origins;
  const options = {
    directory,
    port: 0,
    limits,
    registry: registryOptions,
    store: {
      fingerprint_key: new Uint8Array(32).fill(43),
      max_pending: 20,
      max_records: 100,
      max_pending_per_recipient: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      max_attempts: 3,
      retry_base_ms: 10,
      retry_cap_ms: 100,
      poll_scan_limit: 20,
    },
    http,
    authority,
    verify: ({ authorization }) =>
      ({ "Bearer synthetic-a": contexts.a, "Bearer synthetic-b": contexts.b })[
        authorization
      ] ?? null,
    audit: { record() {} },
  };
  const hosts = [];
  const start = async (patch = {}) => {
    const host = await startLocalRelay({ ...options, ...patch });
    hosts.push(host);
    return host;
  };
  t.after(async () => {
    for (const host of hosts) await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = (host, name) =>
    new HabMcpClient({
      policy: {
        resource_url: host.url,
        agent_id: agents[name].agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2500,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
      },
      limits,
      authorization: () => "Bearer synthetic-" + name,
    });
  return {
    directory,
    options,
    start,
    client,
    agents,
    revoke: () => {
      permitted = false;
    },
  };
}
function list(url, authorization) {
  return globalThis.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(envelope()),
  });
}

test("explicit local host persists a submission across listener/database restart and completes HTTP poll/ACK", async (t) => {
  const f = fixture(t);
  let host = await f.start();
  const submission = { ...message(), recipient_id: f.agents.b.agent_id };
  const first = await f.client(host, "a").submit(submission);
  assert.equal(first.state, "pending");
  const oldUrl = host.url;
  await Promise.all([host.close(), host.close()]);
  await assert.rejects(list(oldUrl, "Bearer synthetic-a"));
  host = await f.start({ port: Number(new URL(oldUrl).port) });
  assert.deepEqual(await f.client(host, "a").submit(submission), first);
  const delivery = await f.client(host, "b").poll();
  assert.equal(delivery.message.message_id, submission.message_id);
  await f.client(host, "b").ack({
    sender_id: delivery.message.sender_id,
    message_id: submission.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "synthetic-ack",
  });
  assert.equal(
    (await f.client(host, "a").status(submission.message_id)).state,
    "acked",
  );
  for (const file of ["owner.sqlite", "registry.sqlite", "relay.sqlite"])
    assert.equal(statSync(join(f.directory, file)).mode & 0o077, 0);
});

test("no verifier or individual policy cannot silently enable unauthenticated hosting", async (t) => {
  const f = fixture(t, false);
  await assert.rejects(
    f.start({ verify: undefined }),
    /invalid_local_relay_options/,
  );
  await assert.rejects(
    f.start({ authority: {} }),
    /invalid_local_relay_options/,
  );
  assert.deepEqual(readdirSync(f.directory), []);
  const host = await f.start();
  assert.equal((await list(host.url)).status, 401);
  assert.equal((await list(host.url, "Bearer unknown")).status, 401);
});

test("registry revocation is checked for the next authenticated tool call", async (t) => {
  const f = fixture(t),
    host = await f.start();
  assert.equal(
    (await f.client(host, "a").resolve("b@synthetic.hab")).address,
    "b@synthetic.hab",
  );
  f.revoke();
  await assert.rejects(f.client(host, "a").resolve("b@synthetic.hab"));
});

test("competing owner refuses without releasing the existing host", async (t) => {
  const f = fixture(t),
    host = await f.start();
  await assert.rejects(f.start(), /host_owner_busy/);
  assert.equal((await list(host.url, "Bearer synthetic-a")).status, 200);
  await host.close();
  await f.start();
});

test("startup port collision releases ownership, preserves the other listener, and permits retry", async (t) => {
  const f = fixture(t),
    other = createServer((_req, res) => res.end("owned test server"));
  other.listen(0, "127.0.0.1");
  await once(other, "listening");
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const port = other.address().port;
  await assert.rejects(f.start({ port }), { code: "EADDRINUSE" });
  assert.equal(
    await (await globalThis.fetch(`http://127.0.0.1:${port}`)).text(),
    "owned test server",
  );
  await f.start();
});

test("private state is mandatory; existing permissive or symlinked DB files are not repaired", async (t) => {
  const f = fixture(t);
  chmodSync(f.directory, 0o755);
  await assert.rejects(f.start(), /private_path/);
  chmodSync(f.directory, 0o700);
  const db = join(f.directory, "registry.sqlite");
  chmodSync(db, 0o644);
  await assert.rejects(f.start(), /private_path/);
  assert.equal(statSync(db).mode & 0o777, 0o644);
  chmodSync(db, 0o600);
  symlinkSync(db, join(f.directory, "relay.sqlite"));
  await assert.rejects(f.start(), /private_path/);
});

test("invalid HTTP policy rolls back startup without leaking an owner or listener", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.start({ http: { ...f.options.http, timeout_ms: 0 } }));
  await f.start();
});

test("stop fences a verifier that resolves after shutdown; reopening retains the original DBs", async (t) => {
  const f = fixture(t);
  let admitted, finish;
  const entered = new Promise((resolve) => {
    admitted = resolve;
  });
  const host = await f.start({
    verify: async (input) => {
      admitted();
      await new Promise((resolve) => {
        finish = resolve;
      });
      return f.options.verify(input);
    },
  });
  const response = list(host.url, "Bearer synthetic-a").catch(() => null);
  await entered;
  await host.close();
  finish();
  await response;
  const fresh = await f.start();
  assert.equal(
    (await f.client(fresh, "a").resolve("b@synthetic.hab")).address,
    "b@synthetic.hab",
  );
});

test("changing the persisted integrity key refuses restart without overwriting state", async (t) => {
  const f = fixture(t),
    host = await f.start();
  const submission = { ...message(), recipient_id: f.agents.b.agent_id };
  await f.client(host, "a").submit(submission);
  await host.close();
  await assert.rejects(
    f.start({
      registry: {
        ...f.options.registry,
        fingerprint_key: new Uint8Array(32).fill(17),
      },
    }),
  );
  const fresh = await f.start();
  assert.equal(
    (await f.client(fresh, "a").status(submission.message_id)).state,
    "pending",
  );
});
