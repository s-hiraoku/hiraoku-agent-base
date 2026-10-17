import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableSender, DurableReceiver } from "../src/relay/index.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
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
  const tools = [];
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 },
    (req, res) => {
      tools.push(req.headers["mcp-name"]);
      void handle(req, res);
    },
  );
  server.maxConnections = 4;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  handle = createRelayNodeHandler(
    new HabHttpGateway(
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
  const clients = (name, agent, fetch = globalThis.fetch) =>
    new HabMcpClient({
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
      fetch,
    });
  const stores = new Set();
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
    stores.add(s);
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
    stores.add(s);
    return s;
  };
  t.after(() => {
    for (const s of stores) s.close();
  });
  return {
    url,
    clients,
    outbox,
    inbox,
    tools,
    close(store) {
      store.close();
      stores.delete(store);
    },
  };
}

test(
  "mock three-individual HTTP round trip resolves over MCP and retries durable send after restart without resolving again",
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
    const stored = net.outbox("a", a),
      receiver = new DurableReceiver(net.inbox("b", b), cb);
    let lost = false;
    let sender = new DurableSender(
      stored,
      net.clients("a", a, async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (init.headers["Mcp-Name"] === "relay_submit" && !lost) {
          lost = true;
          await response.arrayBuffer();
          throw Error("synthetic lost acceptance");
        }
        return response;
      }),
    );
    const resolved = await ca.resolve(b.address),
      m = { ...message(), recipient_id: resolved.recipient_id };
    sender.enqueue(m);
    await assert.rejects(sender.sendOnce(), code("sender_transport_failed"));
    assert.equal(f.count(), 1);
    const receipt = hab.status(f.contexts.a, m.message_id);
    assert.equal(
      net.tools.filter((tool) => tool === "relay_resolve").length,
      1,
    );
    net.close(stored);
    const raw = new DatabaseSync(join(f.dir, "outbox-a.sqlite"));
    try {
      raw.exec("UPDATE relay_outbox SET next_retry_at=0");
    } finally {
      raw.close();
    }
    sender = new DurableSender(net.outbox("a", a), net.clients("a", a));
    await sender.sendOnce();
    assert.equal(
      net.tools.filter((tool) => tool === "relay_resolve").length,
      1,
    );
    assert.equal(
      sender.get(m.message_id).receipt.receipt_id,
      receipt.receipt_id,
    );
    assert.equal(sender.get(m.message_id).state, "accepted");
    assert.equal(sender.get(m.message_id).receipt.recipient_id, b.agent_id);
    await receiver.receiveOnce();
    assert.deepEqual(receiver.inbox()[0].message, m);
    assert.equal(receiver.inbox()[0].receipt_confirmed, true);
    assert.equal(await cc.poll(), null);
    await assert.rejects(cc.status(m.message_id), code("not_found"));
    const reply = {
      ...message("2".repeat(32)),
      recipient_id: (await cb.resolve(a.address)).recipient_id,
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
      recipient_id: (await cc.resolve(a.address)).recipient_id,
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
      "relay_resolve",
      "relay_status",
      "relay_submit",
    ]);
  },
);

test(
  "cached address resolution never bypasses a later stop or silently redirects a stored outbox",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b"),
      net = await setup(t, f);
    const ca = net.clients("a", a);
    const target = await ca.resolve(b.address),
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
      (await ca.resolve(b.address)).recipient_id,
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
    await assert.rejects(
      net.clients("a", a).resolve(b.address),
      code("forbidden"),
    );
    assert.equal(f.count(), 0);
  },
);

test(
  "lost directory response creates no message and a caller retry resolves the same reserved ID",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b"),
      net = await setup(t, f);
    let calls = 0;
    const ca = net.clients("a", a, async (url, init) => {
      calls++;
      const response = await globalThis.fetch(url, init);
      if (calls === 1) {
        await response.arrayBuffer();
        throw Error("synthetic lost directory response");
      }
      return response;
    });
    await assert.rejects(ca.resolve(b.address), code("relay_transport_failed"));
    assert.equal(calls, 1);
    assert.equal(f.count(), 0);
    assert.deepEqual(await ca.resolve(b.address), {
      recipient_id: b.agent_id,
      address: b.address,
      normalization_version: 1,
    });
    assert.equal(calls, 2);
    assert.equal(f.count(), 0);
    assert.equal(
      f.registryRaw.prepare("SELECT count(*) n FROM hab_agents").get().n,
      2,
    );
  },
);
