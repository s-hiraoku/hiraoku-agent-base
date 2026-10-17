import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { DurableSender, DurableReceiver } from "../src/relay/index.ts";
import { RelayMcpClient } from "../src/relay/mcp-client.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { RelayHttpGateway } from "../src/relay/http.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { fixture, code, operations } from "./hab-registry-fixtures.js";
import {
  limits,
  policy,
  message,
  decode,
  request,
} from "./relay-http-fixtures.js";

async function setup(t, f, hab = f.hab) {
  let handle;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 },
    (req, res) => {
      void handle(req, res);
    },
  );
  server.maxConnections = 4;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  handle = createRelayNodeHandler(
    new RelayHttpGateway(
      hab,
      { ...policy, resource_url: url },
      f.audit,
      f.verifier,
    ),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const clients = (name, agent) =>
    new RelayMcpClient({
      policy: {
        resource_url: url,
        agent_id: agent.agent_id,
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
      authorization: () => `Bearer fixture-${name}`,
    });
  const stores = [];
  const outbox = (name, agent) => {
    const s = new SQLiteOutbox(join(f.dir, `outbox-${name}.sqlite`), {
      agent_id: agent.agent_id,
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
    s.migrate();
    stores.push(s);
    return s;
  };
  const inbox = (name, agent) => {
    const s = new SQLiteInbox(join(f.dir, `inbox-${name}.sqlite`), {
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
    s.migrate();
    stores.push(s);
    return s;
  };
  t.after(() => {
    for (const s of stores) s.close();
  });
  return { url, clients, outbox, inbox };
}

test(
  "enrolled mock Grok/dot/Hermes individuals use resolved immutable IDs, durable journals and real HTTP MCP",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      a = f.enroll("a");
    const dot = f.registry.registerProduct(f.admin, {
      request_id: "product-dot",
      agent_name: "dot",
    });
    const hermes = f.registry.registerProduct(f.admin, {
      request_id: "product-hermes",
      agent_name: "hermes",
    });
    const b = f.enroll("b", true, dot),
      c = f.enroll("c", true, hermes);
    const reopened = f.open();
    reopened.migrate();
    const hab = new HabRelayService(reopened, f.store, limits),
      net = await setup(t, f, hab);
    const ca = net.clients("a", a),
      cb = net.clients("b", b),
      cc = net.clients("c", c);
    const sender = new DurableSender(net.outbox("a", a), ca),
      receiver = new DurableReceiver(net.inbox("b", b), cb);
    const resolved = hab.resolve(f.contexts.a, b.address),
      m = { ...message(), recipient_id: resolved.recipient_id };
    sender.enqueue(m);
    await sender.sendOnce();
    assert.equal(sender.get(m.message_id).state, "accepted");
    assert.equal(sender.get(m.message_id).receipt.recipient_id, b.agent_id);
    await receiver.receiveOnce();
    assert.deepEqual(receiver.inbox()[0].message, m);
    assert.equal(receiver.inbox()[0].receipt_confirmed, true);
    assert.equal(await cc.poll(), null);
    await assert.rejects(cc.status(m.message_id), code("not_found"));
    const reply = {
      ...message("2".repeat(32)),
      recipient_id: hab.resolve(f.contexts.b, a.address).recipient_id,
      kind: "answer",
      thread_id: m.thread_id,
      in_reply_to: { sender_id: a.agent_id, message_id: m.message_id },
    };
    const replying = new DurableSender(net.outbox("b", b), cb),
      receiving = new DurableReceiver(net.inbox("a", a), ca);
    replying.enqueue(reply);
    await replying.sendOnce();
    await receiving.receiveOnce();
    assert.deepEqual(receiving.inbox()[0].message, reply);
    const notice = {
      ...message("3".repeat(32)),
      recipient_id: hab.resolve(f.contexts.c, a.address).recipient_id,
      thread_id: "thread-ca",
      kind: "notice",
    };
    const third = new DurableSender(net.outbox("c", c), cc);
    third.enqueue(notice);
    await third.sendOnce();
    await receiving.receiveOnce();
    assert.equal(receiving.inbox().length, 2);
    assert.equal(f.count(), 3);
    assert.equal((await cc.status(notice.message_id)).state, "acked");
    const listed = await decode(
      await globalThis.fetch(request("tools/list", {}, { url: net.url })),
    );
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
      "relay_ack",
      "relay_poll",
      "relay_status",
      "relay_submit",
    ]);
  },
);

test(
  "cached address resolution never bypasses a later stop or silently redirects a stored outbox",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t);
    f.enroll("a");
    const b = f.enroll("b"),
      net = await setup(t, f);
    const a = f.registry.inspect(
      f.admin,
      f.registry.resolve(f.contexts.b, "a@grok-bot.hab").recipient_id,
    );
    const target = f.hab.resolve(f.contexts.a, b.address),
      m = { ...message(), recipient_id: target.recipient_id };
    const sender = new DurableSender(net.outbox("a", a), net.clients("a", a));
    sender.enqueue(m);
    const stopped = f.registry.setAccess(f.admin, {
      request_id: "stop-b",
      agent_id: b.agent_id,
      expected_epoch: b.epoch,
      state: "stopped",
      operations: [],
    });
    await sender.sendOnce();
    assert.equal(sender.get(m.message_id).state, "quarantined");
    assert.equal(sender.get(m.message_id).reason, "forbidden");
    assert.equal(sender.get(m.message_id).recipient_id, b.agent_id);
    assert.equal(f.count(), 0);
    assert.throws(
      () =>
        f.registry.enroll(f.admin, {
          request_id: "reuse-b",
          product_id: f.product.product_id,
          bot_name: "b",
        }),
      code("registry_name_reserved"),
    );
    f.registry.setAccess(f.admin, {
      request_id: "resume-b",
      agent_id: b.agent_id,
      expected_epoch: stopped.epoch,
      state: "active",
      operations,
    });
    await sender.sendOnce();
    assert.equal(f.count(), 0);
    assert.equal(
      f.hab.resolve(f.contexts.a, b.address).recipient_id,
      target.recipient_id,
    );
  },
);

test(
  "HTTP verification cannot grant an individual when registry binding resolution is missing",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b");
    const missing = f.open({}, { administrator: f.authority.administrator });
    missing.migrate();
    const net = await setup(
      t,
      f,
      new HabRelayService(missing, f.store, limits),
    );
    await assert.rejects(
      net.clients("a", a).submit({ ...message(), recipient_id: b.agent_id }),
      code("forbidden"),
    );
    assert.equal(f.count(), 0);
  },
);
