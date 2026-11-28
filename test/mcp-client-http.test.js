import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { DeliveryMcpClient } from "../src/hab/delivery-mcp-client.ts";
import { createMcpNodeHandler } from "../src/host/mcp/http-node.ts";
import { fixture, message, limits } from "./mcp-http-fixtures.js";

async function listening(t, f) {
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
  handle = createMcpNodeHandler(f.gateway({ resource_url: url }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const connect = (
    agent = "a",
    fetch = globalThis.fetch,
    authorization = () => `Bearer fixture-${agent}`,
  ) =>
    new DeliveryMcpClient({
      policy: {
        resource_url: url,
        agent_id: agent,
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
      authorization,
      fetch,
    });
  return { url, connect };
}
const code = (wanted) => (e) => e.code === wanted && e.message === wanted;

for (const loss of ["before_send", "after_commit"]) {
  test(
    `HTTP client recovers ${loss} submit loss and committed ACK loss via idempotent retries`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        { connect } = await listening(t, f),
        m = message();
      const submits = [],
        acks = [];
      let loseSubmit = true,
        loseAck = true;
      const aFetch = async (url, init) => {
        const args = JSON.parse(init.body).params.arguments;
        submits.push(args);
        if (loseSubmit && loss === "before_send") {
          loseSubmit = false;
          throw Error("synthetic lost send");
        }
        const response = await globalThis.fetch(url, init);
        if (loseSubmit) {
          loseSubmit = false;
          await response.arrayBuffer();
          throw Error("synthetic lost acceptance response");
        }
        return response;
      };
      const sender = connect("a", aFetch);
      await assert.rejects(sender.submit(m), code("transport_failed"));
      assert.equal(f.count(), loss === "before_send" ? 0 : 1);
      const acceptedBeforeRetry =
        loss === "after_commit"
          ? f.service.status(f.contexts.a, m.message_id).receipt_id
          : null;
      const accepted = await sender.submit(m);
      assert.deepEqual(submits, [m, m]);
      assert.equal(f.count(), 1);
      assert.equal(accepted.state, "pending");
      if (acceptedBeforeRetry)
        assert.equal(accepted.receipt_id, acceptedBeforeRetry);

      const bFetch = async (url, init) => {
        if (JSON.parse(init.body).params.name === "hab_ack")
          acks.push(JSON.parse(init.body).params.arguments);
        const response = await globalThis.fetch(url, init);
        if (JSON.parse(init.body).params.name === "hab_ack" && loseAck) {
          loseAck = false;
          await response.arrayBuffer();
          throw Error("synthetic lost ACK response");
        }
        return response;
      };
      const receiver = connect("b", bFetch);
      const delivery = await receiver.poll();
      assert.deepEqual(delivery.message, { ...m, sender_id: "a" });
      const ackRequest = {
        sender_id: "a",
        message_id: m.message_id,
        generation: delivery.generation,
        lease_token: delivery.lease_token,
        request_id: `ack-${loss}`,
      };
      await assert.rejects(receiver.ack(ackRequest), code("transport_failed"));
      assert.equal(f.service.status(f.contexts.a, m.message_id).state, "acked");
      assert.equal(
        f.raw.prepare("SELECT body FROM delivery_messages").get().body,
        null,
      );
      const confirmed = await receiver.ack(ackRequest);
      assert.equal(confirmed.state, "acked");
      assert.deepEqual(acks[0], acks[1]);
      assert.equal(acks.length, 2);
      assert.equal(await connect("c").poll(), null);
      await assert.rejects(
        connect("c").status(m.message_id),
        code("not_found"),
      );
      assert.equal(f.count(), 1);
    },
  );
}

test(
  "lost HTTP poll response waits for old lease and redelivers a new fenced generation",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      { connect } = await listening(t, f),
      m = message();
    await connect("a").submit(m);
    let lost;
    const b = connect("b", async (url, init) => {
      const response = await globalThis.fetch(url, init);
      lost = (await response.json()).result.structuredContent.delivery;
      throw Error("synthetic poll response lost");
    });
    await assert.rejects(b.poll(), code("transport_failed"));
    const recovered = connect("b");
    assert.equal(await recovered.poll(), null);
    f.raw.exec(
      "UPDATE delivery_messages SET lease_until=0 WHERE state='leased'",
    );
    assert.equal(await recovered.poll(), null);
    f.raw.exec(
      "UPDATE delivery_messages SET next_visible_at=0 WHERE state='pending'",
    );
    const next = await recovered.poll();
    assert.equal(next.generation, lost.generation + 1);
    assert.notEqual(next.lease_token, lost.lease_token);
    assert.deepEqual(next.message, lost.message);
    await assert.rejects(
      recovered.ack({
        sender_id: "a",
        message_id: m.message_id,
        generation: lost.generation,
        lease_token: lost.lease_token,
        request_id: "stale-ack",
      }),
      code("invalid_ack"),
    );
    const receipt = await recovered.ack({
      sender_id: "a",
      message_id: m.message_id,
      generation: next.generation,
      lease_token: next.lease_token,
      request_id: "current-ack",
    });
    assert.equal(receipt.state, "acked");
  },
);

test(
  "HTTP credential refusal and current revocation prevent acceptance without switching identity",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      { connect } = await listening(t, f),
      m = message();
    await assert.rejects(
      connect("a", globalThis.fetch, () => "Bearer unverified-fixture").submit(
        m,
      ),
      code("transport_failed"),
    );
    assert.equal(f.count(), 0);
    f.active.delete("a");
    await assert.rejects(connect("a").submit(m), code("forbidden"));
    assert.equal(f.count(), 0);
  },
);

test(
  "native fetch refuses redirects without sending bearer to the redirected path",
  { timeout: 10000 },
  async (t) => {
    let reached = 0;
    const server = createServer((req, res) => {
      if (req.url === "/other") reached++;
      res.writeHead(307, { Location: "/other" });
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const c = new DeliveryMcpClient({
      policy: {
        resource_url: `http://127.0.0.1:${server.address().port}/mcp`,
        agent_id: "a",
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2000,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
      },
      limits,
      authorization: () => "Bearer fixture-a",
    });
    await assert.rejects(c.poll(), code("transport_failed"));
    assert.equal(reached, 0);
  },
);

test(
  "misbound credentials cannot select a sender with local agent labels; returned mismatch is rejected",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      { connect } = await listening(t, f),
      m = message();
    await assert.rejects(
      connect("a", globalThis.fetch, () => "Bearer fixture-c").submit(m),
      code("forbidden"),
    );
    assert.equal(f.count(), 1);
    assert.equal(
      f.raw.prepare("SELECT sender_id FROM delivery_messages").get().sender_id,
      "c",
    );
    assert.equal(f.service.status(f.contexts.c, m.message_id).state, "pending");
    assert.throws(
      () => f.service.status(f.contexts.a, m.message_id),
      code("not_found"),
    );
  },
);
