import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableSender, DurableReceiver } from "../src/relay/index.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { RelayMcpClient } from "../src/relay/mcp-client.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import { fixture, message, limits } from "./relay-http-fixtures.js";

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
  handle = createRelayNodeHandler(f.gateway({ resource_url: url }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const connect = (
    agent = "a",
    fetch = globalThis.fetch,
    authorization = () => `Bearer fixture-${agent}`,
  ) =>
    new RelayMcpClient({
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
function journals(t, f) {
  const stores = new Set(),
    outboxPath = join(f.dir, "outbox.sqlite"),
    inboxPath = join(f.dir, "inbox.sqlite");
  const openOutbox = () => {
    const s = new SQLiteOutbox(outboxPath, {
      agent_id: "a",
      fingerprint_key: new Uint8Array(32).fill(44),
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
  const openInbox = () => {
    const s = new SQLiteInbox(inboxPath, {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(43),
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
  const outbox = openOutbox(),
    inbox = openInbox(),
    outboxRaw = new DatabaseSync(outboxPath),
    inboxRaw = new DatabaseSync(inboxPath);
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  t.after(() => {
    outboxRaw.close();
    inboxRaw.close();
    for (const s of stores) s.close();
  });
  return { outbox, inbox, openOutbox, openInbox, close, outboxRaw, inboxRaw };
}
const code = (wanted) => (e) => e.code === wanted && e.message === wanted;

for (const loss of ["before_send", "after_commit"]) {
  test(
    `HTTP durable journals recover ${loss} submit loss and committed ACK loss across client/store restart`,
    { timeout: 10000 },
    async (t) => {
      const f = fixture(t),
        j = journals(t, f),
        { connect } = await listening(t, f),
        m = message();
      const submits = [],
        acks = [];
      let loseSubmit = true,
        loseAck = true;
      const aFetch = async (url, init) => {
        const args = JSON.parse(init.body).params.arguments;
        submits.push(args);
        const row = j.outboxRaw
          .prepare("SELECT state,body FROM relay_outbox")
          .get();
        assert.equal(row.state, "sending");
        assert.deepEqual(JSON.parse(row.body), m);
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
      let sender = new DurableSender(j.outbox, connect("a", aFetch));
      sender.enqueue(m);
      await assert.rejects(sender.sendOnce(), code("sender_transport_failed"));
      assert.equal(f.count(), loss === "before_send" ? 0 : 1);
      const acceptedBeforeRetry =
        loss === "after_commit"
          ? f.service.status(f.contexts.a, m.message_id).receipt_id
          : null;
      j.close(j.outbox);
      const outbox = j.openOutbox();
      j.outboxRaw.exec("UPDATE relay_outbox SET next_retry_at=0");
      sender = new DurableSender(outbox, connect("a", aFetch));
      await sender.sendOnce();
      assert.deepEqual(submits, [m, m]);
      assert.equal(f.count(), 1);
      assert.equal(sender.get(m.message_id).state, "accepted");
      assert.equal(
        j.outboxRaw.prepare("SELECT body FROM relay_outbox").get().body,
        null,
      );
      if (acceptedBeforeRetry)
        assert.equal(
          sender.get(m.message_id).receipt.receipt_id,
          acceptedBeforeRetry,
        );
      const bFetch = async (url, init) => {
        if (JSON.parse(init.body).params.name === "relay_ack") {
          const args = JSON.parse(init.body).params.arguments;
          acks.push(args);
          const pending = j.inboxRaw
            .prepare("SELECT request,state FROM relay_receiver_acks")
            .get();
          assert.equal(pending.state, "pending");
          assert.deepEqual(JSON.parse(pending.request), args);
          assert.equal(
            j.inboxRaw.prepare("SELECT count(*) n FROM relay_inbox").get().n,
            1,
          );
        }
        const response = await globalThis.fetch(url, init);
        if (JSON.parse(init.body).params.name === "relay_ack" && loseAck) {
          loseAck = false;
          await response.arrayBuffer();
          throw Error("synthetic lost ACK response");
        }
        return response;
      };
      let receiver = new DurableReceiver(j.inbox, connect("b", bFetch));
      await assert.rejects(
        receiver.receiveOnce(),
        code("ack_transport_failed"),
      );
      assert.deepEqual(receiver.inbox()[0].message, m);
      assert.equal(receiver.inbox()[0].receipt_confirmed, false);
      assert.equal(f.service.status(f.contexts.a, m.message_id).state, "acked");
      assert.equal(
        f.raw.prepare("SELECT body FROM relay_messages").get().body,
        null,
      );
      j.close(j.inbox);
      const inbox = j.openInbox();
      j.inboxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
      receiver = new DurableReceiver(inbox, connect("b", bFetch));
      await receiver.receiveOnce();
      assert.deepEqual(acks[0], acks[1]);
      assert.equal(acks.length, 2);
      assert.equal(receiver.inbox().length, 1);
      assert.equal(receiver.inbox()[0].receipt_confirmed, true);
      assert.equal(
        j.inboxRaw.prepare("SELECT request FROM relay_receiver_acks").get()
          .request,
        null,
      );
      assert.equal(
        j.inboxRaw.prepare("SELECT count(*) n FROM relay_receiver_acks").get()
          .n,
        1,
      );
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
    const f = fixture(t),
      { connect } = await listening(t, f),
      m = message();
    await connect("a").submit(m);
    let lost;
    const b = connect("b", async (url, init) => {
      const response = await globalThis.fetch(url, init);
      lost = (await response.json()).result.structuredContent.delivery;
      throw Error("synthetic poll response lost");
    });
    await assert.rejects(b.poll(), code("relay_transport_failed"));
    const recovered = connect("b");
    assert.equal(await recovered.poll(), null);
    f.raw.exec(
      "UPDATE relay_deliveries SET lease_until=0 WHERE state='leased'",
    );
    assert.equal(await recovered.poll(), null);
    f.raw.exec(
      "UPDATE relay_deliveries SET next_visible_at=0 WHERE state='pending'",
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
  "HTTP credential refusal and current revocation preserve pending sender intent without switching identity",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      j = journals(t, f),
      { connect } = await listening(t, f),
      m = message();
    const sender = new DurableSender(
      j.outbox,
      connect("a", globalThis.fetch, () => "Bearer unverified-fixture"),
    );
    sender.enqueue(m);
    await assert.rejects(sender.sendOnce(), code("sender_transport_failed"));
    assert.equal(f.count(), 0);
    assert.equal(sender.get(m.message_id).state, "queued");
    j.outboxRaw.exec("UPDATE relay_outbox SET next_retry_at=0");
    f.active.delete("a");
    await new DurableSender(j.outbox, connect("a")).sendOnce();
    assert.equal(sender.get(m.message_id).state, "quarantined");
    assert.equal(sender.get(m.message_id).reason, "forbidden");
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
    const c = new RelayMcpClient({
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
    await assert.rejects(c.poll(), code("relay_transport_failed"));
    assert.equal(reached, 0);
  },
);

test(
  "misbound credentials cannot select a sender with local agent labels; returned mismatch stops resending",
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      j = journals(t, f),
      { connect } = await listening(t, f),
      m = message();
    const sender = new DurableSender(
      j.outbox,
      connect("a", globalThis.fetch, () => "Bearer fixture-c"),
    );
    sender.enqueue(m);
    await sender.sendOnce();
    assert.equal(f.count(), 1);
    assert.equal(
      f.raw.prepare("SELECT sender_id FROM relay_messages").get().sender_id,
      "c",
    );
    assert.equal(sender.get(m.message_id).state, "quarantined");
    assert.equal(sender.get(m.message_id).reason, "forbidden");
    assert.equal(sender.get(m.message_id).receipt, null);
    assert.equal(f.service.status(f.contexts.c, m.message_id).state, "pending");
    assert.throws(
      () => f.service.status(f.contexts.a, m.message_id),
      code("not_found"),
    );
    await new DurableSender(j.outbox, connect("a")).sendOnce();
    assert.equal(f.count(), 1);
  },
);
