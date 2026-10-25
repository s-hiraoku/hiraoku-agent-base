import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { envelope, message, limits } from "./relay-http-fixtures.js";
import { fixture, list } from "./local-relay-service-fixtures.js";

const cli = resolve("scripts/hab-relay-admin.mjs");
const tokens = { c: "c".repeat(64), h: "d".repeat(64), x: "e".repeat(64) };

async function started(t, patch = {}) {
  const f = fixture(t);
  Object.assign(f.config.registry, patch);
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
  b.sender.enqueue(reply);
  await b.sender.sendOnce();
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
