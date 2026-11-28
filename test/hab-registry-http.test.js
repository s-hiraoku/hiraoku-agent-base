import assert from "node:assert/strict";
import { setup } from "./hab-http-fixtures.js";
import { test } from "node:test";
import { fixture, code, operations } from "./hab-registry-fixtures.js";
import { message, decode, request } from "./mcp-http-fixtures.js";

const ackFor = (delivery, requestId) => ({
  sender_id: delivery.message.sender_id,
  message_id: delivery.message.message_id,
  generation: delivery.generation,
  lease_token: delivery.lease_token,
  request_id: requestId,
});

test(
  "mock three-individual HTTP round trip resolves over MCP and retries submit after lost acceptance without resolving again",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
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
    const hab = f.habFor(reopened),
      net = await setup(t, f, hab);
    const ca = net.clients("a", a),
      cb = net.clients("b", b),
      cc = net.clients("c", c);
    let lost = false;
    const losingSender = net.clients("a", a, async (url, init) => {
      const response = await globalThis.fetch(url, init);
      if (init.headers["Mcp-Name"] === "hab_submit" && !lost) {
        lost = true;
        await response.arrayBuffer();
        throw Error("synthetic lost acceptance");
      }
      return response;
    });
    const resolved = await ca.resolve(b.address),
      m = { ...message(), recipient_id: resolved.recipient_id };
    await assert.rejects(losingSender.submit(m), code("transport_failed"));
    assert.equal(f.count(), 1);
    const receipt = hab.status(f.contexts.a, m.message_id);
    assert.equal(net.tools.filter((tool) => tool === "hab_resolve").length, 1);
    const recovered = await ca.submit(m);
    assert.equal(net.tools.filter((tool) => tool === "hab_resolve").length, 1);
    assert.equal(recovered.receipt_id, receipt.receipt_id);
    assert.equal(recovered.recipient_id, b.agent_id);
    const delivered = await cb.poll();
    assert.deepEqual(delivered.message, { ...m, sender_id: a.agent_id });
    assert.equal((await cb.ack(ackFor(delivered, "ack-ab"))).state, "acked");
    assert.equal(await cc.poll(), null);
    await assert.rejects(cc.status(m.message_id), code("not_found"));
    const reply = {
      ...message("2".repeat(32)),
      recipient_id: (await cb.resolve(a.address)).recipient_id,
      kind: "answer",
      thread_id: m.thread_id,
      in_reply_to: { sender_id: a.agent_id, message_id: m.message_id },
    };
    await cb.submit(reply);
    const replyDelivery = await ca.poll();
    assert.deepEqual(replyDelivery.message, {
      ...reply,
      sender_id: b.agent_id,
    });
    assert.equal(
      (await ca.ack(ackFor(replyDelivery, "ack-ba"))).state,
      "acked",
    );
    const notice = {
      ...message("3".repeat(32)),
      recipient_id: (await cc.resolve(a.address)).recipient_id,
      thread_id: "thread-ca",
      kind: "notice",
    };
    await cc.submit(notice);
    const noticeDelivery = await ca.poll();
    assert.deepEqual(noticeDelivery.message, {
      ...notice,
      sender_id: c.agent_id,
    });
    assert.equal(
      (await ca.ack(ackFor(noticeDelivery, "ack-ca"))).state,
      "acked",
    );
    assert.equal(f.count(), 3);
    assert.equal((await cc.status(notice.message_id)).state, "acked");
    const listed = await decode(
      await globalThis.fetch(request("tools/list", {}, { url: net.url })),
    );
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
      "hab_ack",
      "hab_mark_read",
      "hab_peek",
      "hab_poll",
      "hab_resolve",
      "hab_status",
      "hab_submit",
    ]);
  },
);

test(
  "cached address resolution never bypasses a later stop or allows name reuse",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b"),
      net = await setup(t, f);
    const ca = net.clients("a", a);
    const target = await ca.resolve(b.address),
      m = { ...message(), recipient_id: target.recipient_id };
    const stopped = f.registry.setAccess(f.admin, {
      request_id: "stop-b",
      agent_id: b.agent_id,
      expected_epoch: b.epoch,
      state: "stopped",
      operations: [],
    });
    await assert.rejects(ca.submit(m), code("recipient_unavailable"));
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
    const f = await fixture(t),
      a = f.enroll("a"),
      b = f.enroll("b");
    const missing = f.open({}, { administrator: f.authority.administrator });
    missing.migrate();
    const net = await setup(t, f, f.habFor(missing));
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
    const f = await fixture(t),
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
    await assert.rejects(ca.resolve(b.address), code("transport_failed"));
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
