import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { createHash } from "node:crypto";
import { cpSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./host-service-fixtures.js";
import { pollUntilDelivered } from "./delivery-fixture.js";
import {
  oauthFixture,
  persistentOAuthFixture,
  resource,
} from "./oauth-fixtures.js";
import { startHost } from "../src/host/start.ts";
import {
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminStatus,
} from "../src/host/admin.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { DurableReceiver } from "../src/agent-sdk/receiver.ts";
import { envelope, limits, message } from "./mcp-http-fixtures.js";

// Synthetic reverse proxy transport. It accepts exactly one public resource and
// reaches only this test's loopback listener; no DNS, Auth0 or real host calls.
function proxyFetch(currentHost) {
  return async (url, init) => {
    assert.equal(String(url), resource);
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new globalThis.Headers(init.headers));
      headers.host = new URL(resource).host;
      const req = request(
        {
          hostname: "127.0.0.1",
          port: currentHost().ingress_port,
          path: "/hab/mcp",
          method: init.method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: { "content-type": res.headers["content-type"] },
              }),
            ),
          );
        },
      );
      const abort = () => req.destroy(Error("synthetic_proxy_aborted"));
      req.on("error", reject);
      req.once("close", () => init.signal?.removeEventListener("abort", abort));
      req.setTimeout(3000, () => req.destroy(Error("synthetic_proxy_timeout")));
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
      else req.end(init.body);
    });
  };
}

async function setup(t, oauth) {
  const f = await fixture(t);
  f.config.ingress = {
    port: 0,
    resource_url: resource,
    oauth_file: f.write("remote-auth.local.json", oauth.getConfig()),
    allowed_origins: [],
  };
  f.write("service.local.json", f.config);
  let host = await startHost(f.configPath);
  t.after(() => host.close());
  f.config.port = Number(new URL(host.url).port);
  f.config.ingress.port = host.ingress_port;
  f.write("service.local.json", f.config);
  const token = "a".repeat(64);
  f.write("credentials.local.json", {
    version: 1,
    credentials: [
      {
        sha256: createHash("sha256").update(token).digest("hex"),
        principal: {
          issuer: "urn:synthetic:local",
          audience: host.url,
          subject: "local-owner",
          client_id: "local-host",
          connection_id: "local-connection",
        },
        issued_at: new Date(oauth.start - 1000).toISOString(),
        expires_at: new Date(oauth.start + 600000).toISOString(),
      },
    ],
  });
  const local = hostAdminConnect(f.configPath, {
    address: "receiver@local.hab",
    connection_id: "local-connection",
  }).address;
  const remote = hostAdminConnect(f.configPath, {
    address: "sender@remote.hab",
    connection_id: oauth.record.connection_id,
  }).address;
  let jwt = await oauth.token();
  const client = (address, remoteSide = false) =>
    new HabMcpClient({
      as_address: address.address,
      policy: {
        resource_url: remoteSide ? resource : host.url,
        agent_id: address.agent_id,
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
      authorization: () => `Bearer ${remoteSide ? jwt : token}`,
      ...(remoteSide ? { fetch: proxyFetch(() => host) } : {}),
    });
  return {
    ...f,
    local,
    remote,
    token,
    client,
    setToken: (value) => {
      jwt = value;
    },
    host: () => host,
    stop: () => host.close(),
    restart: async () => {
      await host.close();
      host = await startHost(f.configPath);
    },
  };
}

test("persistent configured MCP keeps groups and durable receipts across host token renewal and host restart", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  // A current short token is issued one hour after participation began.
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const sibling = hostAdminConnect(f.configPath, {
    address: "sibling@remote.hab",
    connection_id: oauth.record.connection_id,
  }).address;
  assert.equal(sibling.group_id, f.remote.group_id);
  const remote = f.client(f.remote, true),
    local = f.client(f.local);
  f.setToken(
    await oauth.token({
      iat: oauth.start / 1000 - 1200,
      exp: oauth.start / 1000 - 600,
    }),
  );
  await assert.rejects(remote.resolve(f.local.address));
  f.setToken(await oauth.token());
  assert.equal(
    (await remote.resolve(f.local.address)).recipient_id,
    f.local.agent_id,
  );
  const status = hostAdminStatus(f.configPath);
  const permission = status.credentials.find(
    (c) => c.connection_id === oauth.record.connection_id,
  );
  assert.ok(permission.participation.expires_in_seconds > 900);
  assert.equal(permission.max_access_token_lifetime_seconds, 600);
  assert.equal(permission.expires_in_seconds, undefined);
  assert.equal(permission.addresses.length, 2);
  assert.deepEqual(status.problems, []);

  const inboxPath = join(f.dir, "receiver-inbox.sqlite");
  const openInbox = (agent = f.local, path = inboxPath) => {
    const store = new SQLiteInbox(path, {
      agent_id: agent.agent_id,
      fingerprint_key: new Uint8Array(32).fill(72),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_ack_records: 30,
      ack_retry_ms: 86400000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_attempts: 5,
    });
    store.migrate();
    return store;
  };
  let inbox = openInbox();
  t.after(() => inbox.close());
  const replyInboxPath = join(f.dir, "sender-inbox.sqlite");
  let replyInbox = openInbox(f.remote, replyInboxPath);
  t.after(() => replyInbox.close());
  const sent = { ...message(), recipient_id: f.local.agent_id };
  const accepted = await remote.submit(sent);
  const receiver = new DurableReceiver(inbox, {
    poll: () => pollUntilDelivered(local),
    ack: async (ack) => {
      const separate = openInbox();
      try {
        const saved = separate
          .inbox()
          .find((e) => e.message.message_id === sent.message_id);
        assert.deepEqual(saved.message, sent);
        assert.equal(saved.sender_id, f.remote.agent_id);
        assert.equal(saved.receipt_confirmed, false);
      } finally {
        separate.close();
      }
      return local.ack(ack);
    },
  });
  await receiver.receiveOnce();
  assert.equal(inbox.inbox()[0].receipt_confirmed, true);
  assert.equal((await remote.status(sent.message_id)).state, "acked");
  const reply = {
    ...message("2".repeat(32)),
    recipient_id: f.remote.agent_id,
    kind: "answer",
    thread_id: sent.thread_id,
    in_reply_to: { sender_id: f.remote.agent_id, message_id: sent.message_id },
  };
  await local.submit(reply);
  await new DurableReceiver(replyInbox, {
    poll: () => pollUntilDelivered(remote),
    ack: async (ack) => {
      const separate = openInbox(f.remote, replyInboxPath);
      try {
        assert.deepEqual(separate.inbox()[0].message, reply);
      } finally {
        separate.close();
      }
      return remote.ack(ack);
    },
  }).receiveOnce();
  assert.equal((await local.status(reply.message_id)).state, "acked");
  assert.equal(replyInbox.inbox()[0].receipt_confirmed, true);
  inbox.close();
  replyInbox.close();
  await f.restart();
  inbox = openInbox();
  replyInbox = openInbox(f.remote, replyInboxPath);
  assert.equal(inbox.inbox()[0].receipt_confirmed, true);
  assert.equal(replyInbox.inbox()[0].receipt_confirmed, true);
  assert.deepEqual(
    replyInbox.inbox()[0].message.in_reply_to,
    reply.in_reply_to,
  );
  assert.equal(
    (await remote.status(sent.message_id)).receipt_id,
    accepted.receipt_id,
  );
  assert.equal((await remote.submit(sent)).receipt_id, accepted.receipt_id);
  assert.equal(
    hostAdminConnect(f.configPath, {
      address: f.remote.address,
      connection_id: oauth.record.connection_id,
    }).address.agent_id,
    f.remote.agent_id,
  );
  const foreign = f.client(f.local, true);
  await assert.rejects(foreign.poll(), { code: "forbidden" });

  // Config revocation survives a full restart; a valid access token does not override it.
  const revoked = structuredClone(oauth.getConfig());
  revoked.connections[0].state = "revoked";
  f.write("remote-auth.local.json", revoked);
  await f.restart();
  await assert.rejects(remote.poll());
  assert.throws(
    () =>
      hostAdminConnect(f.configPath, {
        address: f.remote.address,
        connection_id: oauth.record.connection_id,
      }),
    { code: "participation_revoked" },
  );
  assert.ok(
    hostAdminStatus(f.configPath).problems.some(
      (p) => p.code === "participation_revoked",
    ),
  );
  assert.equal(
    hostAdminDisconnect(f.configPath, f.remote.address).revoked_bindings,
    1,
  );
  f.write("remote-auth.local.json", oauth.getConfig());
  await f.restart();
  await assert.rejects(remote.poll(), { code: "forbidden" });
  assert.throws(
    () =>
      hostAdminConnect(f.configPath, {
        address: f.remote.address,
        connection_id: oauth.record.connection_id,
      }),
    { code: "credential_revoked_use_new_connection_id" },
  );
});

test("stopped v1 backup restores before new acceptance; explicit v2 upgrade retains address, binding and acked message", async (t) => {
  const oauth = await oauthFixture(true);
  const f = await setup(t, oauth);
  const remote = f.client(f.remote, true),
    local = f.client(f.local);
  const sent = { ...message(), recipient_id: f.local.agent_id };
  await remote.submit(sent);
  const delivery = await pollUntilDelivered(local);
  const ack = await local.ack({
    sender_id: f.remote.agent_id,
    message_id: sent.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "upgrade-ack",
  });
  await f.stop();
  const backup = join(f.dir, "stopped-backup");
  cpSync(f.config.directory, backup, { recursive: true });
  chmodSync(backup, 0o700);
  const v1 = structuredClone(oauth.getConfig());
  const { issued_at, subject, client_id, connection_id } = v1.connections[0];
  const identity = { subject, client_id, connection_id };
  const v2 = {
    ...v1,
    version: 2,
    mode: "persistent",
    max_access_token_lifetime_seconds: 600,
    connections: [
      {
        ...identity,
        approved_at: issued_at,
        approved_until: new Date(oauth.start + 86400000).toISOString(),
        state: "active",
      },
    ],
  };
  const apply = (config) => {
    f.write("remote-auth.local.json", config);
    f.write("service.local.json", f.config);
  };
  apply(v2);
  await f.restart();
  assert.ok(
    hostAdminStatus(f.configPath).credentials.some((c) => c.participation),
  );
  // Roll back only before this candidate accepts new work. Keep DBs and keys together.
  await f.stop();
  rmSync(f.config.directory, { recursive: true });
  cpSync(backup, f.config.directory, { recursive: true });
  chmodSync(f.config.directory, 0o700);
  apply(v1);
  await f.restart();
  assert.ok(
    !hostAdminStatus(f.configPath).credentials.some((c) => c.participation),
  );
  assert.equal((await remote.status(sent.message_id)).state, "acked");
  assert.equal(
    (
      await local.ack({
        sender_id: f.remote.agent_id,
        message_id: sent.message_id,
        generation: delivery.generation,
        lease_token: delivery.lease_token,
        request_id: "upgrade-ack",
      })
    ).receipt_id,
    ack.receipt_id,
  );
  await f.stop();
  apply(v2);
  await f.restart();
  const status = hostAdminStatus(f.configPath);
  assert.ok(status.credentials.some((c) => c.participation));
  assert.equal(
    status.addresses.find((a) => a.address === f.remote.address).agent_id,
    f.remote.agent_id,
  );
  assert.equal((await remote.status(sent.message_id)).state, "acked");
  assert.deepEqual(
    hostAdminConnect(f.configPath, {
      address: f.remote.address,
      connection_id: identity.connection_id,
    }).steps,
    [],
  );
});

test("admin separates participation expiry and not-yet-approved state from token expiry", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  const f = await setup(t, oauth);
  for (const [start, end, code] of [
    [oauth.start - 3600000, oauth.start - 1000, "participation_expired"],
    [
      oauth.start + 3600000,
      oauth.start + 7200000,
      "participation_not_yet_active",
    ],
  ]) {
    const c = structuredClone(oauth.getConfig());
    c.connections[0].approved_at = new Date(start).toISOString();
    c.connections[0].approved_until = new Date(end).toISOString();
    f.write("remote-auth.local.json", c);
    assert.ok(
      hostAdminStatus(f.configPath).problems.some((p) => p.code === code),
    );
    assert.throws(
      () =>
        hostAdminConnect(f.configPath, {
          address: f.remote.address,
          connection_id: oauth.record.connection_id,
        }),
      { code },
    );
  }
  const response = await proxyFetch(f.host)(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
      authorization: `Bearer ${await oauth.token()}`,
    },
    body: JSON.stringify(envelope()),
  });
  assert.equal(response.status, 401);
});

test("shipped admin CLI reports persistent participation and refuses a revoked connection without printing tokens", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  const f = await setup(t, oauth);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        resolve("scripts/hab-admin.ts"),
        "--config",
        f.configPath,
        ...args,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  const status = run("status");
  assert.equal(status.status, 0, status.stderr);
  const policy = JSON.parse(status.stdout).credentials.find(
    (c) => c.connection_id === oauth.record.connection_id,
  );
  assert.equal(
    policy.participation.approved_until,
    oauth.participation.approved_until,
  );
  assert.equal(policy.max_access_token_lifetime_seconds, 600);
  assert.ok(!status.stdout.includes(await oauth.token()));
  const revoked = structuredClone(oauth.getConfig());
  revoked.connections[0].state = "revoked";
  f.write("remote-auth.local.json", revoked);
  const denied = run(
    "connect",
    "--address",
    f.remote.address,
    "--connection-id",
    oauth.record.connection_id,
  );
  assert.equal(denied.status, 1);
  assert.equal(denied.stderr, "admin_rejected participation_revoked\n");
});

test("participation status uses the same exact expiry boundary as admission", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  const f = await setup(t, oauth);
  const end = Date.parse(oauth.participation.approved_until);
  for (const [offset, expired, remaining] of [
    [-1000, false, 1],
    [-999, false, 1],
    [-1, false, 1],
    [0, true, 0],
    [1, true, 0],
  ]) {
    const status = hostAdminStatus(f.configPath, end + offset);
    const entry = status.credentials.find(
      (c) => c.connection_id === oauth.record.connection_id,
    );
    assert.equal(entry.participation.expires_in_seconds, remaining);
    assert.equal(
      status.problems.some(
        (p) =>
          p.subject === oauth.record.connection_id &&
          p.code === "participation_expired",
      ),
      expired,
    );
  }
});
