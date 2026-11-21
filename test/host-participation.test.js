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
  hostAdminPending,
  hostAdminApprove,
  hostAdminReject,
  hostAdminRevoke,
} from "../src/host/admin-pending.ts";
import { hostAdminDoctor } from "../src/host/doctor.ts";
import { PendingConnections } from "../src/host/oauth-pending.ts";
import { parseOAuthConfig } from "../src/host/oauth-auth.ts";
import { main as runHabAdmin } from "../scripts/hab-admin.ts";
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminStatus,
} from "../src/host/admin.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { DurableReceiver } from "../src/agent-sdk/receiver.ts";
import { envelope, limits, message } from "./mcp-http-fixtures.js";

// Synthetic reverse proxy transport. It accepts exactly the public resource and its
// delivery endpoint and reaches only this test's loopback listener; no DNS, Auth0 or
// real host calls.
function proxyFetch(currentHost) {
  return async (url, init) => {
    assert.ok([resource, resource + "/delivery"].includes(String(url)));
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new globalThis.Headers(init.headers));
      headers.host = new URL(resource).host;
      const req = request(
        {
          hostname: "127.0.0.1",
          port: currentHost().ingress_port,
          path: new URL(String(url)).pathname,
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
        resource_url: remoteSide ? resource + "/delivery" : host.delivery_url,
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
      [resolve("scripts/hab-admin.ts"), "--config", f.configPath, ...args],
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

const NEWCOMER = { sub: "newcomer-subject-0001", azp: "newcomer-client" };
/** One JSON-RPC call to the public resource with `jwt`, as a product would make it. */
async function ingress(host, jwt) {
  return proxyFetch(() => host)(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Until a token's whole-second `iat` can be on or after the approval. */
async function afterApproval(approvedAt) {
  while (nowSeconds() * 1000 < Date.parse(approvedAt))
    await new Promise((done) => setTimeout(done, 50));
}

test("an unregistered sign-in becomes pending and approve connects it without a restart (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const early = await oauth.token({
    ...NEWCOMER,
    iat: nowSeconds(),
    exp: nowSeconds() + 300,
  });
  assert.equal((await ingress(f.host(), early)).status, 401);
  const [row] = hostAdminPending(f.configPath).pending;
  assert.equal(row.client_id, NEWCOMER.azp);
  assert.notEqual(row.subject, NEWCOMER.sub, "the subject is masked");
  assert.ok(row.subject.startsWith(NEWCOMER.sub.slice(0, 6)));
  assert.equal(hostAdminStatus(f.configPath).pending_connections, 1);
  const raw = readFileSync(join(f.config.directory, "oauth-pending.sqlite"));
  assert.equal(raw.includes(early.split(".")[2]), false, "no token kept");

  const approved = runHabAdmin([
    "--config",
    f.configPath,
    "approve",
    "--pending",
    row.pending_id,
    "--address",
    "newcomer@remote.hab",
    "--days",
    "30",
  ]);
  assert.equal(approved.ledger, "added");
  assert.match(approved.next_action, /token_before_approval/);
  assert.equal(statSync(approved.backup).mode & 0o777, 0o600);
  const ledger = parseOAuthConfig(JSON.parse(readFileSync(ledgerFile, "utf8")));
  const entry = ledger.connections.find((c) => c.subject === NEWCOMER.sub);
  assert.equal(entry.connection_id, approved.connection_id);
  assert.equal(
    Date.parse(entry.approved_until) - Date.parse(entry.approved_at),
    30 * 86400000,
  );
  assert.ok(Date.parse(entry.approved_at) >= Date.now() - 1000);
  assert.deepEqual(hostAdminPending(f.configPath).pending, []);
  assert.equal(
    readdirSync(dirname(ledgerFile)).some((name) => name.includes(".tmp-")),
    false,
  );

  // The token from before approval stays refused; a new one goes through at once.
  assert.equal((await ingress(f.host(), early)).status, 401);
  await afterApproval(entry.approved_at);
  const address = approved.connect.address;
  const client = f.client(address, true);
  f.setToken(
    await oauth.token({
      ...NEWCOMER,
      iat: nowSeconds(),
      exp: nowSeconds() + 300,
    }),
  );
  assert.equal(
    (await client.resolve(f.local.address)).recipient_id,
    f.local.agent_id,
  );
  assert.equal(
    hostAdminDoctor(f.configPath, "newcomer@remote.hab").checks.registration
      .reason,
    "registered",
  );
  assert.throws(
    () =>
      hostAdminApprove(f.configPath, {
        pending_id: row.pending_id,
        address: "newcomer@remote.hab",
      }),
    { code: "pending_not_found" },
  );
});

test("approve finishes a half-done approval once and keeps an address's operations (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  // An address that the operator allowed only part of the operations.
  hostAdminConnect(f.configPath, {
    address: "narrow@remote.hab",
    connection_id: oauth.record.connection_id,
    operations: ["resolve", "status"],
  });
  const narrow = () =>
    hostAdminStatus(f.configPath).addresses.find(
      (a) => a.address === "narrow@remote.hab",
    ).operations;
  const before = narrow();
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  const pair = {
    issuer: oauth.getConfig().issuer,
    subject: oauth.record.subject,
    client_id: "owner-new-client",
  };
  seen.record(pair, true);
  const [row] = hostAdminPending(f.configPath).pending;
  const first = hostAdminApprove(f.configPath, {
    pending_id: row.pending_id,
    address: "narrow@remote.hab",
  });
  assert.equal(first.ledger, "added");
  assert.deepEqual(narrow(), before, "operations neither grew nor shrank");
  // The same sign-in shows up again as if the first approve stopped before its last step.
  seen.record(pair, true);
  const again = hostAdminApprove(f.configPath, {
    pending_id: row.pending_id,
    address: "narrow@remote.hab",
  });
  assert.equal(again.ledger, "existing");
  assert.equal(again.connection_id, first.connection_id);
  assert.equal(again.backup, null);
  const ledger = parseOAuthConfig(JSON.parse(readFileSync(ledgerFile, "utf8")));
  assert.equal(
    ledger.connections.filter((c) => c.client_id === "owner-new-client").length,
    1,
  );
  assert.deepEqual(narrow(), before);
  // Reject removes a row; a stranger's malformed ID is refused.
  seen.record({ ...pair, client_id: "yet-another" }, true);
  const [other] = hostAdminPending(f.configPath).pending;
  assert.deepEqual(hostAdminReject(f.configPath, other.pending_id), {
    pending_id: other.pending_id,
    removed: true,
  });
  assert.throws(() => hostAdminReject(f.configPath, "../x"), {
    code: "invalid_pending_id",
  });
});

test("a ledger write that fails leaves the old ledger whole (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const original = readFileSync(ledgerFile, "utf8");
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: "s-0123456789",
      client_id: "c",
    },
    false,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  // No room for the backup or the temporary file: the write stops before the swap.
  const folder = dirname(ledgerFile);
  chmodSync(folder, 0o500);
  try {
    assert.throws(() =>
      hostAdminApprove(f.configPath, {
        pending_id: row.pending_id,
        address: "late@remote.hab",
      }),
    );
  } finally {
    chmodSync(folder, 0o700);
  }
  assert.equal(readFileSync(ledgerFile, "utf8"), original);
  parseOAuthConfig(JSON.parse(original));
  assert.equal(hostAdminPending(f.configPath).pending.length, 1);
});

test("approve never widens a group narrower than its address (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  // sender@remote.hab has all five operations; the operator then narrowed its group.
  const db = new DatabaseSync(join(f.config.directory, "registry.sqlite"));
  db.prepare(
    "UPDATE hab_auth_groups SET operations=?, epoch=epoch+1 WHERE group_id=?",
  ).run(JSON.stringify(["resolve", "status"]), f.remote.group_id);
  db.close();
  const view = () => {
    const status = hostAdminStatus(f.configPath);
    return {
      group: status.groups.find((g) => g.group_id === f.remote.group_id)
        .operations,
      address: status.addresses.find((a) => a.address === "sender@remote.hab")
        .operations,
    };
  };
  const before = view();
  assert.deepEqual([...before.group].sort(), ["resolve", "status"]);
  assert.equal(before.address.length, 5);
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: oauth.record.subject,
      client_id: "owner-new-client",
    },
    true,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  const approved = hostAdminApprove(f.configPath, {
    pending_id: row.pending_id,
    address: "sender@remote.hab",
  });
  assert.deepEqual(approved.connect.steps, ["connection_bound"]);
  assert.deepEqual(view(), before, "neither the group nor the address changed");
});

test("approve preserves a disconnected group's stopped address and grants (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  hostAdminDisconnect(f.configPath, f.remote.address);
  const pending = new PendingConnections(f.config.directory);
  t.after(() => pending.close());
  pending.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: oauth.record.subject,
      client_id: "replacement-client",
    },
    true,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  const approved = hostAdminApprove(f.configPath, {
    pending_id: row.pending_id,
    address: f.remote.address,
  });
  assert.deepEqual(approved.connect.steps, ["connection_bound"]);
  assert.equal(approved.connect.address.state, "stopped");
  assert.deepEqual(approved.connect.address.operations, []);
  assert.match(approved.next_action, /hab:admin connect/);
  const group = hostAdminStatus(f.configPath).groups.find(
    (entry) => entry.group_id === f.remote.group_id,
  );
  assert.equal(group.state, "stopped");
  assert.deepEqual(group.operations, []);
});

const cli = resolve("scripts/hab-admin.ts");
function runCli(args) {
  const child = spawn(process.execPath, ["--no-warnings", cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  return once(child, "close").then(([code]) => ({ code, out }));
}

test("two approves at once both stay in the ledger (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  for (const n of [1, 2])
    seen.record(
      {
        issuer: oauth.getConfig().issuer,
        subject: `parallel-subject-${n}`,
        client_id: `parallel-client-${n}`,
      },
      false,
    );
  const rows = hostAdminPending(f.configPath).pending;
  const results = await Promise.all(
    rows.map((row, i) =>
      runCli([
        "--config",
        f.configPath,
        "approve",
        "--pending",
        row.pending_id,
        "--address",
        `parallel${i}@remote.hab`,
      ]),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.out);
  const ledger = parseOAuthConfig(JSON.parse(readFileSync(ledgerFile, "utf8")));
  for (const n of [1, 2])
    assert.ok(
      ledger.connections.some((c) => c.subject === `parallel-subject-${n}`),
      `approval ${n} kept`,
    );
  assert.equal(statSync(`${ledgerFile}.approve-lock.sqlite`).mode & 0o777, 0o600);
});

test("approval and rejection wait for the same lock and recover after process exit (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const lock = `${ledgerFile}.approve-lock.sqlite`;
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: "locked-subject-1",
      client_id: "c1",
    },
    false,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  const approve = () =>
    hostAdminApprove(f.configPath, {
      pending_id: row.pending_id,
      address: "locked@remote.hab",
    });
  writeFileSync(lock, "", { mode: 0o600 });
  const holder = spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      console.log("locked");
      process.stdin.resume();
    `, lock],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(holder, "exit");
  t.after(() => holder.kill());
  await Promise.race([
    once(holder.stdout, "data"),
    exited.then(() => assert.fail("lock holder exited before acquiring the lock")),
  ]);
  const rejection = runCli([
    "--config",
    f.configPath,
    "reject",
    "--pending",
    row.pending_id,
  ]);
  assert.throws(approve, { code: "ledger_busy" });
  const rejected = await rejection;
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.out, /ledger_busy/);
  assert.equal(hostAdminPending(f.configPath).pending.length, 1);
  assert.equal(holder.kill("SIGKILL"), true);
  await exited;
  assert.equal(approve().ledger, "added");
  assert.equal(hostAdminPending(f.configPath).pending.length, 0);
});

test("approve refuses to write a ledger the host could no longer read (plan 2)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  const pad = (n, width) => `${n}`.padStart(width, "x");
  // Fill the ledger to just under the host's config size limit.
  for (let n = 0; ; n++) {
    const row = {
      subject: pad(`s${n}`, 480),
      client_id: pad(`c${n}`, 480),
      connection_id: `filler-${n}`,
      approved_at: oauth.participation.approved_at,
      approved_until: oauth.participation.approved_until,
      state: "revoked",
    };
    const next = { ...ledger, connections: [...ledger.connections, row] };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") > 65536 - 600)
      break;
    ledger.connections.push(row);
  }
  const original = JSON.stringify(ledger, null, 2) + "\n";
  writeFileSync(ledgerFile, original);
  parseOAuthConfig(JSON.parse(original));
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: pad("big-subject", 480),
      client_id: pad("big-client", 480),
    },
    false,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  assert.throws(
    () =>
      hostAdminApprove(f.configPath, {
        pending_id: row.pending_id,
        address: "big@remote.hab",
      }),
    { code: "ledger_too_large" },
  );
  assert.equal(readFileSync(ledgerFile, "utf8"), original);
  assert.equal(hostAdminPending(f.configPath).pending.length, 1);
  assert.equal(
    readdirSync(dirname(ledgerFile)).some((name) =>
      /\.bak-|\.tmp-|\.lock$/.test(name),
    ),
    false,
    "no backup, temp file or lock left",
  );
});

/** A reconnect from the same owner with a new client, as DCR products make (DCR plan 6). */
async function reconnected(t) {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  const fresh = { sub: oauth.record.subject, azp: "tpc_reconnected" };
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: fresh.sub,
      client_id: fresh.azp,
    },
    true,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  const approved = hostAdminApprove(f.configPath, {
    pending_id: row.pending_id,
    address: f.remote.address,
  });
  return { f, oauth, fresh, approved };
}

test("revoke --connection stops one connection and keeps the group's other one (DCR plan 6)", async (t) => {
  const { f, oauth, fresh, approved } = await reconnected(t);
  const ledgerFile = f.config.ingress.oauth_file;
  const old = oauth.record.connection_id;
  const groupOf = () =>
    hostAdminStatus(f.configPath).groups.find(
      (g) => g.group_id === f.remote.group_id,
    );
  assert.equal(approved.connect.address.group_id, f.remote.group_id);
  assert.equal(groupOf().active_bindings, 2);
  const oldToken = await oauth.token();
  assert.equal(
    (await ingress(f.host(), oldToken)).status,
    200,
    "old still live",
  );

  const revoked = runHabAdmin([
    "--config",
    f.configPath,
    "revoke",
    "--connection",
    old,
  ]);
  assert.equal(revoked.ledger, "revoked");
  assert.equal(statSync(revoked.backup).mode & 0o777, 0o600);
  assert.deepEqual(revoked.registry, {
    binding: "revoked",
    group_id: f.remote.group_id,
    group_state: "active",
    remaining_active_bindings: 1,
  });
  const ledger = parseOAuthConfig(JSON.parse(readFileSync(ledgerFile, "utf8")));
  assert.equal(
    ledger.connections.find((c) => c.connection_id === old).state,
    "revoked",
  );
  assert.equal(
    ledger.connections.find((c) => c.connection_id === approved.connection_id)
      .state,
    "active",
  );
  assert.equal((await ingress(f.host(), oldToken)).status, 401);
  await afterApproval(
    ledger.connections.find((c) => c.connection_id === approved.connection_id)
      .approved_at,
  );
  f.setToken(
    await oauth.token({ ...fresh, iat: nowSeconds(), exp: nowSeconds() + 300 }),
  );
  const client = f.client(approved.connect.address, true);
  assert.equal(
    (await client.resolve(f.local.address)).recipient_id,
    f.local.agent_id,
  );

  const again = hostAdminRevoke(f.configPath, old);
  assert.equal(again.ledger, "already_revoked");
  assert.equal(again.backup, null);
  assert.equal(again.registry.binding, "already_revoked");
  assert.throws(() => hostAdminRevoke(f.configPath, "no-such-connection"), {
    code: "connection_not_found",
  });
  assert.throws(() => hostAdminRevoke(f.configPath, "bad\tid"), {
    code: "invalid_connection_id",
  });
});

test("revoke --connection finishes from a ledger-only revoke and reports a stopped group (DCR plan 6)", async (t) => {
  const { f, oauth, approved } = await reconnected(t);
  const ledgerFile = f.config.ingress.oauth_file;
  hostAdminRevoke(f.configPath, oauth.record.connection_id);
  // As if a revoke stopped after the ledger write: the row is revoked, the binding live.
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  ledger.connections.find(
    (c) => c.connection_id === approved.connection_id,
  ).state = "revoked";
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  const finished = hostAdminRevoke(f.configPath, approved.connection_id);
  assert.equal(finished.ledger, "already_revoked");
  assert.equal(finished.registry.binding, "revoked");
  assert.equal(finished.registry.group_state, "stopped");
  assert.equal(finished.registry.remaining_active_bindings, 0);
});

test("revoke --connection stops the binding while OAuth sign-in is off (DCR plan 6)", async (t) => {
  const { f, approved } = await reconnected(t);
  const ledgerFile = f.config.ingress.oauth_file;
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  ledger.enabled = false;
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  const result = hostAdminRevoke(f.configPath, approved.connection_id);
  assert.equal(result.ledger, "revoked");
  assert.equal(result.registry.binding, "revoked");
  assert.equal(result.registry.remaining_active_bindings, 1);
});

test("revoke accepts an existing ledger connection ID (DCR plan 6)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const connectionId = `手動 接続-${"x".repeat(257)}`;
  oauth.record.connection_id = connectionId;
  oauth.participation.connection_id = connectionId;
  const f = await setup(t, oauth);
  const result = runHabAdmin([
    "--config",
    f.configPath,
    "revoke",
    "--connection",
    connectionId,
  ]);
  assert.equal(result.connection_id, connectionId);
  assert.equal(result.ledger, "revoked");
  assert.equal(result.registry.binding, "revoked");
});

test("revoke leaves unsafe or mismatched OAuth files untouched (DCR plan 6)", async (t) => {
  const { f, approved } = await reconnected(t);
  const ledgerFile = f.config.ingress.oauth_file;
  const original = readFileSync(ledgerFile, "utf8");
  const revoke = () => hostAdminRevoke(f.configPath, approved.connection_id);
  const backups = () =>
    readdirSync(dirname(ledgerFile)).filter((name) => name.includes(".bak-"));
  const originalBackups = backups();
  chmodSync(ledgerFile, 0o644);
  assert.throws(revoke, { code: "oauth_invalid" });
  assert.equal(readFileSync(ledgerFile, "utf8"), original);
  chmodSync(ledgerFile, 0o600);

  const mismatched = JSON.stringify({
    ...JSON.parse(original),
    resource: "https://other-host.example/mcp",
  });
  writeFileSync(ledgerFile, mismatched);
  assert.throws(revoke, { code: "oauth_resource_mismatch" });
  assert.equal(readFileSync(ledgerFile, "utf8"), mismatched);
  assert.deepEqual(backups(), originalBackups);

  writeFileSync(ledgerFile, original);
  assert.equal(
    hostAdminStatus(f.configPath).groups.find(
      (group) => group.group_id === f.remote.group_id,
    ).active_bindings,
    2,
  );
});

test("direct connect waits for the revoke lock before binding (DCR plan 6)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const ledger = oauth.getConfig();
  const connectionId = "approved-not-yet-bound";
  ledger.connections.push({
    ...oauth.participation,
    client_id: "replacement-client",
    connection_id: connectionId,
  });
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  const args = [
    "--config",
    f.configPath,
    "connect",
    "--address",
    f.remote.address,
    "--connection-id",
    connectionId,
  ];
  const lock = new DatabaseSync(`${ledgerFile}.approve-lock.sqlite`);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const blocked = await runCli(args);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.out, /ledger_busy/);
  } finally {
    lock.close();
  }

  assert.equal(
    hostAdminRevoke(f.configPath, connectionId).registry.binding,
    "none",
  );
  assert.throws(() => runHabAdmin(args), { code: "participation_revoked" });
  assert.equal(
    hostAdminStatus(f.configPath).groups.find(
      (group) => group.group_id === f.remote.group_id,
    ).active_bindings,
    1,
  );
});

test("an approve and a revoke at once both stay in the ledger (DCR plan 6)", async (t) => {
  const oauth = await persistentOAuthFixture(true);
  oauth.participation.approved_at = new Date(
    oauth.start - 3600000,
  ).toISOString();
  const f = await setup(t, oauth);
  const ledgerFile = f.config.ingress.oauth_file;
  const seen = new PendingConnections(f.config.directory);
  t.after(() => seen.close());
  seen.record(
    {
      issuer: oauth.getConfig().issuer,
      subject: oauth.record.subject,
      client_id: "tpc_parallel",
    },
    true,
  );
  const [row] = hostAdminPending(f.configPath).pending;
  const results = await Promise.all([
    runCli([
      "--config",
      f.configPath,
      "approve",
      "--pending",
      row.pending_id,
      "--address",
      f.remote.address,
    ]),
    runCli([
      "--config",
      f.configPath,
      "revoke",
      "--connection",
      oauth.record.connection_id,
    ]),
  ]);
  for (const result of results) assert.equal(result.code, 0, result.out);
  const ledger = parseOAuthConfig(JSON.parse(readFileSync(ledgerFile, "utf8")));
  assert.equal(
    ledger.connections.find(
      (c) => c.connection_id === oauth.record.connection_id,
    ).state,
    "revoked",
  );
  assert.equal(
    ledger.connections.find((c) => c.client_id === "tpc_parallel").state,
    "active",
  );
});
