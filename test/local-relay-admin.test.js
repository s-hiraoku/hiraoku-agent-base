import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { startConfiguredLocalRelay } from "../src/relay-host/configured.ts";
import {
  relayAdminStatus,
  relayAdminConnect,
  relayAdminDisconnect,
} from "../src/relay-host/admin.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { DurableSender, DurableReceiver } from "../src/relay/index.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { envelope, message, limits, decode } from "./relay-http-fixtures.js";
import { fixture, list } from "./local-relay-service-fixtures.js";
import { oauthFixture } from "./relay-oauth-fixtures.js";

const cli = resolve("scripts/hab-relay-admin.mjs");
const tokens = { c: "c".repeat(64), h: "d".repeat(64), x: "e".repeat(64) };

async function started(t, patch = {}, oauthConfig) {
  const f = fixture(t);
  Object.assign(f.config.registry, patch);
  if (oauthConfig) {
    f.config.ingress = {
      port: 0,
      resource_url: oauthConfig.resource,
      oauth_file: f.write("remote-auth.local.json", oauthConfig),
      allowed_origins: [],
    };
  }
  f.write("service.local.json", f.config);
  const host = await startConfiguredLocalRelay(f.configPath);
  t.after(() => host.close());
  // The operator config names the fixed port the clients use as audience.
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);
  const credentials = (audience = host.url) => {
    const now = Date.now();
    f.write("credentials.local.json", {
      version: 1,
      credentials: Object.entries(tokens).map(([name, token]) => ({
        sha256: createHash("sha256").update(token).digest("hex"),
        principal: {
          issuer: "urn:synthetic:local",
          audience,
          subject: `synthetic-${name}`,
          client_id: `client-${name}`,
          connection_id: `conn-${name}`,
        },
        issued_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 600000).toISOString(),
      })),
    });
  };
  credentials();
  const call = async (token, name, args = {}) => {
    const response = await globalThis.fetch(host.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": "tools/call",
        "mcp-name": name,
        "mcp-protocol-version": "2026-07-28",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(envelope("tools/call", { name, arguments: args })),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const json = JSON.parse(
      text.startsWith("{") ? text : /^data: (.*)$/m.exec(text)[1],
    );
    return json.result.structuredContent;
  };
  return { ...f, host, call, credentials };
}

test("admin refuses a registry the Relay has not created", (t) => {
  const f = fixture(t);
  assert.throws(() => relayAdminStatus(f.configPath), {
    code: "relay_not_initialized",
  });
});

test("connect registers, binds and grants two addresses for a real roundtrip; rerun is a no-op", async (t) => {
  const f = await started(t);
  assert.deepEqual(
    relayAdminStatus(f.configPath).problems.map((p) => p.code),
    ["credential_unbound", "credential_unbound", "credential_unbound"],
  );
  const codex = relayAdminConnect(f.configPath, {
    address: "codex@codex.hab",
    connection_id: "conn-c",
  });
  assert.deepEqual(codex.steps, [
    "product_registered",
    "address_enrolled",
    "connection_bound",
    "address_access_granted",
  ]);
  const hermes = relayAdminConnect(f.configPath, {
    address: "hermes@hermes.hab",
    connection_id: "conn-h",
  });
  assert.equal(hermes.address.state, "active");
  assert.deepEqual(
    relayAdminConnect(f.configPath, {
      address: "hermes@hermes.hab",
      connection_id: "conn-h",
    }).steps,
    [],
  );
  const status = relayAdminStatus(f.configPath);
  assert.deepEqual(status.problems, [
    { code: "credential_unbound", subject: "conn-x" },
  ]);
  assert.deepEqual(status.resource_urls, [f.host.url]);
  const text = JSON.stringify(status);
  for (const token of Object.values(tokens)) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(createHash("sha256").update(token).digest("hex")));
  }

  const resolved = await f.call(tokens.c, "relay_resolve", {
    address: "hermes@hermes.hab",
  });
  assert.equal(resolved.recipient_id, hermes.address.agent_id);
  const sent = { ...message(), recipient_id: resolved.recipient_id };
  assert.equal(
    (await f.call(tokens.c, "relay_submit", sent)).sender_id,
    codex.address.agent_id,
  );
  const { delivery } = await f.call(tokens.h, "relay_poll");
  assert.equal(delivery.message.message_id, sent.message_id);
  const acked = await f.call(tokens.h, "relay_ack", {
    sender_id: delivery.message.sender_id,
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id: "ack-1",
  });
  assert.equal(acked.state, "acked");
  assert.equal(
    (await f.call(tokens.c, "relay_status", { message_id: sent.message_id }))
      .state,
    "acked",
  );
});

test("disconnect revokes with current epochs, is rerunnable and needs no token mapping", async (t) => {
  const f = await started(t);
  relayAdminConnect(f.configPath, {
    address: "hermes@hermes.hab",
    connection_id: "conn-h",
  });
  // Cleanup order must not matter: the mapping is already gone.
  f.write("credentials.local.json", { version: 1, credentials: [] });
  const first = relayAdminDisconnect(f.configPath, "hermes@hermes.hab");
  assert.equal(first.revoked_bindings, 1);
  assert.equal(first.address.state, "stopped");
  assert.equal(
    relayAdminDisconnect(f.configPath, "hermes@hermes.hab")
      .already_disconnected,
    true,
  );
  f.credentials();
  assert.deepEqual((await f.call(tokens.h, "relay_poll")).error, "forbidden");
  assert.ok(
    relayAdminStatus(f.configPath).problems.some(
      (p) => p.code === "credential_revoked" && p.subject === "conn-h",
    ),
  );
  // A revoked descriptor stays reserved; a fresh connection id rebinds the address.
  assert.throws(
    () =>
      relayAdminConnect(f.configPath, {
        address: "hermes@hermes.hab",
        connection_id: "conn-h",
      }),
    { code: "credential_revoked_use_new_connection_id" },
  );
  assert.deepEqual(
    relayAdminConnect(f.configPath, {
      address: "hermes@hermes.hab",
      connection_id: "conn-x",
    }).steps,
    ["connection_bound", "address_access_granted"],
  );
  assert.equal((await f.call(tokens.x, "relay_poll")).delivery, null);
});

test("configured groups complete a durable reply roundtrip and revoke both connections", async (t) => {
  const f = await started(t, { authentication_groups: true });
  const participants = [
    ["sender@client-a.hab", "c"],
    ["receiver@client-b.hab", "h"],
  ].map(([address, name]) => {
    const connected = relayAdminConnect(f.configPath, {
      address,
      connection_id: `conn-${name}`,
    });
    const agentId = connected.address.agent_id;
    const client = new HabMcpClient({
      as_address: address,
      policy: {
        resource_url: f.host.url,
        agent_id: agentId,
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
      authorization: () => `Bearer ${tokens[name]}`,
    });
    const outbox = new SQLiteOutbox(join(f.dir, `outbox-${name}.sqlite`), {
      agent_id: agentId,
      fingerprint_key: new Uint8Array(32).fill(71),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_submit_attempts: 3,
      max_status_attempts: 3,
      status_retry_ms: 86400000,
    });
    outbox.migrate();
    t.after(() => outbox.close());
    const inboxPath = join(f.dir, `inbox-${name}.sqlite`);
    const openInbox = () => {
      const store = new SQLiteInbox(inboxPath, {
        agent_id: agentId,
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
    const inbox = openInbox();
    t.after(() => inbox.close());
    const savedBeforeAck = [];
    const receiver = new DurableReceiver(inbox, {
      poll: () => client.poll(),
      ack: async (request) => {
        // A separate connection must see the committed body before network ACK.
        const reader = openInbox();
        try {
          const saved = reader
            .inbox()
            .find(
              (entry) =>
                entry.sender_id === request.sender_id &&
                entry.message.message_id === request.message_id,
            );
          assert.ok(saved);
          assert.equal(saved.receipt_confirmed, false);
          savedBeforeAck.push(saved.message);
        } finally {
          reader.close();
        }
        return client.ack(request);
      },
    });
    return {
      address,
      name,
      agentId,
      client,
      outbox,
      receiver,
      savedBeforeAck,
      sender: new DurableSender(outbox, client),
    };
  });
  const [a, b] = participants;
  assert.equal((await a.client.resolve(b.address)).recipient_id, b.agentId);
  const sent = { ...message(), recipient_id: b.agentId };
  assert.equal(a.sender.enqueue(sent).state, "queued");
  await a.sender.sendOnce();
  assert.equal(a.outbox.get(sent.message_id).state, "accepted");
  await b.receiver.receiveOnce();
  assert.deepEqual(b.savedBeforeAck, [sent]);
  assert.equal(b.receiver.inbox()[0].receipt_confirmed, true);

  const reply = {
    ...message("2".repeat(32)),
    recipient_id: a.agentId,
    kind: "answer",
    in_reply_to: { sender_id: a.agentId, message_id: sent.message_id },
  };
  assert.equal(b.sender.enqueue(reply).state, "queued");
  await b.sender.sendOnce();
  assert.equal(b.outbox.get(reply.message_id).state, "accepted");
  await a.receiver.receiveOnce();
  assert.deepEqual(a.savedBeforeAck, [reply]);
  assert.equal(a.receiver.inbox()[0].receipt_confirmed, true);
  assert.equal((await a.client.status(sent.message_id)).state, "acked");
  assert.equal((await b.client.status(reply.message_id)).state, "acked");
  assert.deepEqual(a.receiver.inbox()[0].message.in_reply_to, {
    sender_id: a.agentId,
    message_id: sent.message_id,
  });

  f.write("credentials.local.json", { version: 1, credentials: [] });
  for (const participant of participants) {
    const response = await list(f.host.url, tokens[participant.name]);
    assert.equal(response.status, 401);
    await response.body?.cancel();
    assert.equal(
      relayAdminDisconnect(f.configPath, participant.address).revoked_bindings,
      1,
    );
  }
  const status = relayAdminStatus(f.configPath);
  assert.ok(
    status.groups.every(
      (group) => group.state === "stopped" && group.active_bindings === 0,
    ),
  );
  assert.equal(status.groups.length, 2);
  assert.equal(status.credentials.length, 0);
});

test("connect rejects unknown, mismatched-audience and foreign-bound connections", async (t) => {
  const f = await started(t);
  assert.throws(
    () =>
      relayAdminConnect(f.configPath, {
        address: "codex@codex.hab",
        connection_id: "conn-missing",
      }),
    { code: "credential_not_found" },
  );
  assert.throws(
    () =>
      relayAdminConnect(f.configPath, {
        address: "codex@codex.hab",
        connection_id: "conn-c",
        operations: ["poll", "execute"],
      }),
    { code: "invalid_operations" },
  );
  relayAdminConnect(f.configPath, {
    address: "codex@codex.hab",
    connection_id: "conn-c",
  });
  assert.throws(
    () =>
      relayAdminConnect(f.configPath, {
        address: "hermes@hermes.hab",
        connection_id: "conn-c",
      }),
    { code: "credential_bound_elsewhere" },
  );
  f.credentials("http://localhost:1/mcp");
  assert.throws(
    () =>
      relayAdminConnect(f.configPath, {
        address: "hermes@hermes.hab",
        connection_id: "conn-h",
      }),
    { code: "credential_audience_mismatch" },
  );
  assert.ok(
    relayAdminStatus(f.configPath).problems.some(
      (p) => p.code === "credential_audience_mismatch",
    ),
  );
});

test("admin binds OAuth mappings to a shared group without a local bearer copy", async (t) => {
  const oauth = await oauthFixture(true);
  const f = await started(
    t,
    { authentication_groups: true },
    oauth.getConfig(),
  );
  const connectionId = oauth.record.connection_id;
  const local = relayAdminConnect(f.configPath, {
    address: "receiver@local.hab",
    connection_id: "conn-h",
  });
  const first = relayAdminConnect(f.configPath, {
    address: "first@remote.hab",
    connection_id: connectionId,
  });
  const second = relayAdminConnect(f.configPath, {
    address: "second@remote.hab",
    connection_id: connectionId,
  });
  assert.equal(first.address.group_id, second.address.group_id);
  const status = relayAdminStatus(f.configPath);
  const remote = status.credentials.find(
    (record) => record.connection_id === connectionId,
  );
  assert.deepEqual(remote.addresses.sort(), [
    first.address.address,
    second.address.address,
  ]);
  assert.equal(remote.binding.kind, "group");
  assert.ok(
    !status.problems.some((problem) => problem.subject === connectionId),
  );
  const jwt = await oauth.token();
  assert.ok(!JSON.stringify(status).includes(jwt));
  const call = async (tool, args, expectedStatus = 200) => {
    const response = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: f.host.ingress_port,
          path: "/hab/mcp",
          method: "POST",
          headers: {
            Host: "relay.example",
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": tool,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: { "content-type": res.headers["content-type"] },
              }),
            ),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.setTimeout(2500, () => req.destroy(Error("synthetic_proxy_timeout")));
      req.end(
        JSON.stringify(envelope("tools/call", { name: tool, arguments: args })),
      );
    });
    assert.equal(response.status, expectedStatus);
    if (expectedStatus !== 200) {
      await response.body?.cancel();
      return null;
    }
    return (await decode(response)).result.structuredContent;
  };
  const selection = {
    as_address: second.address.address,
    expected_agent_id: second.address.agent_id,
  };
  assert.equal(
    (
      await call("relay_resolve", {
        ...selection,
        address: local.address.address,
      })
    ).recipient_id,
    local.address.agent_id,
  );
  assert.equal(
    (
      await call("relay_poll", {
        as_address: local.address.address,
        expected_agent_id: local.address.agent_id,
      })
    ).error,
    "forbidden",
  );
  const sent = { ...message(), recipient_id: local.address.agent_id };
  assert.equal(
    (await call("relay_submit", { ...selection, ...sent })).sender_id,
    second.address.agent_id,
  );
  const received = (
    await f.call(tokens.h, "relay_poll", {
      as_address: local.address.address,
      expected_agent_id: local.address.agent_id,
    })
  ).delivery;
  assert.equal(received.message.sender_id, second.address.agent_id);
  assert.equal(received.message.message_id, sent.message_id);
  const ack = {
    sender_id: received.message.sender_id,
    message_id: sent.message_id,
    generation: received.generation,
    lease_token: received.lease_token,
    request_id: "local-ack",
  };
  assert.equal(
    (await call("relay_ack", { ...selection, ...ack })).error,
    "invalid_ack",
  );
  const localSelection = {
    as_address: local.address.address,
    expected_agent_id: local.address.agent_id,
  };
  assert.equal(
    (await call("relay_ack", { ...localSelection, ...ack })).error,
    "forbidden",
  );
  assert.equal(
    (await f.call(tokens.h, "relay_ack", { ...localSelection, ...ack })).state,
    "acked",
  );
  const reply = {
    ...message("2".repeat(32)),
    recipient_id: second.address.agent_id,
    kind: "answer",
    in_reply_to: {
      sender_id: second.address.agent_id,
      message_id: sent.message_id,
    },
  };
  await f.call(tokens.h, "relay_submit", { ...localSelection, ...reply });
  const returned = (await call("relay_poll", selection)).delivery;
  assert.deepEqual(returned.message.in_reply_to, reply.in_reply_to);
  assert.equal(
    (
      await call("relay_ack", {
        ...selection,
        sender_id: local.address.agent_id,
        message_id: reply.message_id,
        generation: returned.generation,
        lease_token: returned.lease_token,
        request_id: "remote-ack",
      })
    ).state,
    "acked",
  );
  assert.equal(
    (await call("relay_status", { ...selection, message_id: sent.message_id }))
      .state,
    "acked",
  );
  assert.equal(
    (
      await f.call(tokens.h, "relay_status", {
        ...localSelection,
        message_id: reply.message_id,
      })
    ).state,
    "acked",
  );

  // Removing the OAuth mapping must not prevent revoking its Registry binding.
  f.write("remote-auth.local.json", {
    ...oauth.getConfig(),
    enabled: false,
    connections: [],
  });
  await call("relay_poll", selection, 401);
  const revoked = relayAdminDisconnect(f.configPath, first.address.address);
  assert.equal(revoked.revoked_bindings, 1);
  assert.deepEqual(revoked.affected_addresses.sort(), [
    first.address.address,
    second.address.address,
  ]);
  f.write("remote-auth.local.json", oauth.getConfig());
  assert.equal((await call("relay_poll", selection)).error, "forbidden");
  assert.ok(
    relayAdminStatus(f.configPath).problems.some(
      (p) => p.code === "credential_revoked" && p.subject === connectionId,
    ),
  );
});

test("admin refuses disabled, mismatched and ambiguous OAuth connection registration", async (t) => {
  const oauth = await oauthFixture(true);
  const original = oauth.getConfig();
  const f = await started(t, { authentication_groups: true }, original);
  const connect = (connection_id = oauth.record.connection_id) =>
    relayAdminConnect(f.configPath, {
      address: "first@remote.hab",
      connection_id,
    });
  f.write("remote-auth.local.json", { ...original, enabled: false });
  assert.throws(connect, { code: "credential_not_found" });
  f.write("remote-auth.local.json", {
    ...original,
    resource: "https://other.example/hab/mcp",
  });
  assert.throws(connect, { code: "oauth_resource_mismatch" });
  f.write("remote-auth.local.json", {
    ...original,
    connections: [...original.connections, original.connections[0]],
  });
  assert.throws(connect, { code: "oauth_invalid" });
  f.write("remote-auth.local.json", {
    ...original,
    connections: [{ ...oauth.record, connection_id: "conn-h" }],
  });
  assert.throws(() => connect("conn-h"), { code: "credential_ambiguous" });
  f.write("remote-auth.local.json", original);
  assert.equal(relayAdminStatus(f.configPath).addresses.length, 0);
});

test("group mode shares one connection between addresses; disconnect reports every member", async (t) => {
  const f = await started(t, { authentication_groups: true });
  const research = relayAdminConnect(f.configPath, {
    address: "research@hermes.hab",
    connection_id: "conn-h",
  });
  assert.deepEqual(research.steps, [
    "product_registered",
    "address_enrolled",
    "group_created",
    "connection_bound",
    "group_member_added",
    "group_access_granted",
    "address_access_granted",
  ]);
  const calendar = relayAdminConnect(f.configPath, {
    address: "calendar@hermes.hab",
    connection_id: "conn-h",
    operations: ["poll", "ack"],
  });
  assert.deepEqual(calendar.steps, [
    "address_enrolled",
    "group_member_added",
    "address_access_granted",
  ]);
  assert.equal(calendar.address.group_id, research.address.group_id);
  assert.deepEqual(calendar.group_members.sort(), [
    "calendar@hermes.hab",
    "research@hermes.hab",
  ]);
  const disconnected = relayAdminDisconnect(
    f.configPath,
    "calendar@hermes.hab",
  );
  assert.equal(disconnected.revoked_bindings, 1);
  assert.deepEqual(disconnected.affected_addresses.sort(), [
    "calendar@hermes.hab",
    "research@hermes.hab",
  ]);
  const status = relayAdminStatus(f.configPath);
  assert.equal(status.groups[0].state, "stopped");
});

test("CLI prints JSON results and fixed refusal codes without secrets", async (t) => {
  const f = await started(t);
  const run = async (...args) => {
    const child = spawn(
      process.execPath,
      [cli, "--config", f.configPath, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  };
  const ok = await run(
    "connect",
    "--address",
    "codex@codex.hab",
    "--connection-id",
    "conn-c",
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).address.state, "active");
  const status = await run("status");
  assert.equal(status.code, 0);
  assert.ok(!status.stdout.includes(tokens.c));
  const refused = await run("disconnect", "--address", "nobody@codex.hab");
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, "relay_admin_rejected address_not_found\n");
  const usage = await run("status", "--address", "codex@codex.hab");
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^relay_admin_rejected usage\n/);
});
