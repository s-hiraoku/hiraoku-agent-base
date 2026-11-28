import assert from "node:assert/strict";
import { test } from "node:test";
import { backends, ackRequest } from "./backends.js";

const scenarios = [
  [
    "D01 six directed round trips preserve sender, recipient and UTF-8 body",
    async (t, f) => {
      let seq = 0;
      for (const [from, to] of [
        ["a", "b"],
        ["b", "a"],
        ["a", "c"],
        ["c", "a"],
        ["b", "c"],
        ["c", "b"],
      ]) {
        const message = f.message(to, {
          body: {
            parts: [{ type: "text", text: `日本語\r\n${from} → ${to}` }],
          },
        });
        const receipt = await f.transport(from).submit(message);
        assert.equal(receipt.sender_id, f.agent(from));
        assert.equal(receipt.recipient_id, f.agent(to));
        const delivery = await f.transport(to).poll();
        assert.deepEqual(delivery.message, {
          ...message,
          sender_id: f.agent(from),
        });
        assert.equal(
          (await f.transport(to).ack(ackRequest(delivery, `d01-${++seq}`)))
            .state,
          "acked",
        );
        assert.equal(
          (await f.transport(from).status(message.message_id)).state,
          "acked",
        );
      }
      for (const name of ["a", "b", "c"])
        assert.equal(await f.transport(name).poll(), null);
    },
  ],
  [
    "D02 duplicate acceptance returns one receipt and changed content is rejected",
    async (t, f) => {
      const message = f.message("b");
      const first = await f.transport("a").submit(message);
      assert.deepEqual(await f.transport("a").submit(message), first);
      await assert.rejects(
        f.transport("a").submit({
          ...message,
          body: { parts: [{ type: "text", text: "changed" }] },
        }),
        { code: "idempotency_conflict" },
      );
      const delivery = await f.transport("b").poll();
      assert.deepEqual(delivery.message, {
        ...message,
        sender_id: f.agent("a"),
      });
      await f.transport("b").ack(ackRequest(delivery, "d02-ack"));
      assert.equal(await f.transport("b").poll(), null);
    },
  ],
  [
    "D03 accepted message survives restart before poll and ACK",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      await f.restart();
      const delivery = await f.transport("b").poll();
      assert.deepEqual(delivery.message, {
        ...message,
        sender_id: f.agent("a"),
      });
      await f.transport("b").ack(ackRequest(delivery, "d03-ack"));
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "acked",
      );
    },
  ],
  [
    "D04 lost committed ACK response recovers the exact receipt after restart",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      const delivery = await f.transport("b").poll();
      const req = ackRequest(delivery, "d04-ack");
      const first = await f.transport("b").ack(req);
      assert.equal(first.state, "acked");
      await f.restart();
      const second = await f.transport("b").ack(req);
      assert.deepEqual(second, first);
      assert.equal(await f.transport("b").poll(), null);
    },
  ],
  [
    "D05 unacked lease expiry redelivers under a new generation and rejects the stale ACK",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      const first = await f.transport("b").poll();
      const stale = ackRequest(first, "d05-stale");
      await f.restart();
      f.faults.leaseExpired();
      const second = await f.transport("b").poll();
      assert.equal(second.generation, first.generation + 1);
      assert.notEqual(second.lease_token, first.lease_token);
      await assert.rejects(f.transport("b").ack(stale), {
        code: "invalid_ack",
      });
      await f.transport("b").ack(ackRequest(second, "d05-fresh"));
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "acked",
      );
    },
  ],
  [
    "D06 two competing consumers receive only one active lease",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      const results = await Promise.all([
        f.transport("b").poll(),
        f.transport("b").poll(),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      const delivery = results.find(Boolean);
      assert.equal(delivery.message.message_id, message.message_id);
      await f.transport("b").ack(ackRequest(delivery, "consumer-ack"));
      assert.equal(await f.transport("b").poll(), null);
    },
  ],
  [
    "D07 foreign status, mailbox and ACK cannot cross identity boundaries",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      await assert.rejects(f.transport("c").status(message.message_id));
      assert.equal(await f.transport("c").poll(), null);
      const delivery = await f.transport("b").poll();
      await assert.rejects(
        f.transport("c").ack(ackRequest(delivery, "foreign-ack")),
        { code: "invalid_ack" },
      );
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "leased",
      );
      await f.transport("b").ack(ackRequest(delivery, "owner-ack"));
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "acked",
      );
    },
  ],
  [
    "D08 disconnected receiver reconnects and recovers an accepted message",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      await f.disconnect();
      await assert.rejects(f.transport("b").poll(), {
        code: "transport_failed",
      });
      await f.reconnect();
      const delivery = await f.transport("b").poll();
      assert.deepEqual(delivery.message, {
        ...message,
        sender_id: f.agent("a"),
      });
      assert.equal(
        (await f.transport("b").ack(ackRequest(delivery, "d08-ack"))).state,
        "acked",
      );
    },
  ],
];

for (const backend of backends) {
  for (const [name, scenario] of scenarios) {
    test(
      `${backend.id} ${name}`,
      { timeout: 15000, skip: backend.reason ?? false },
      async (t) => {
        await scenario(t, await backend.create(t));
      },
    );
  }
}
