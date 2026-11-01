import assert from "node:assert/strict";
import { test } from "node:test";
import { backends, ackRequest } from "./backends.js";

const scenarios = [
  [
    "D01 six directed round trips preserve sender, recipient and UTF-8 body",
    async (t, f) => {
      const receivers = Object.fromEntries(
        ["a", "b", "c"].map((name) => [name, f.receiver(name)]),
      );
      const expected = { a: [], b: [], c: [] };
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
        expected[to].push({ sender_id: f.agent(from), message });
        const receipt = await f.transport(from).submit(message);
        assert.equal(receipt.sender_id, f.agent(from));
        assert.equal(receipt.recipient_id, f.agent(to));
        await receivers[to].once();
        assert.equal(
          (await f.transport(from).status(message.message_id)).state,
          "acked",
        );
      }
      for (const name of ["a", "b", "c"]) {
        assert.deepEqual(
          receivers[name]
            .entries()
            .map(({ sender_id, message }) => ({ sender_id, message })),
          expected[name],
        );
        assert.equal(
          receivers[name].entries().every((entry) => entry.receipt_confirmed),
          true,
        );
        assert.equal(await f.transport(name).poll(), null);
      }
    },
  ],
  [
    "D02 duplicate acceptance returns one receipt and changed content is rejected",
    async (t, f) => {
      const message = f.message("b");
      const first = await f.transport("a").submit(message);
      assert.deepEqual(await f.transport("a").submit(message), first);
      await assert.rejects(
        f
          .transport("a")
          .submit({
            ...message,
            body: { parts: [{ type: "text", text: "changed" }] },
          }),
        { code: "idempotency_conflict" },
      );
      const receiver = f.receiver("b");
      await receiver.once();
      await receiver.once();
      assert.deepEqual(
        receiver.entries().map((entry) => entry.message),
        [message],
      );
    },
  ],
  [
    "D03 ACK is sent only after inbox survives an independent reopen",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      let calls = 0;
      const receiver = f.receiver("b", {
        async ack(request) {
          calls++;
          const witness = f.receiver("b");
          try {
            assert.deepEqual(
              witness.entries().map((entry) => entry.message),
              [message],
            );
            assert.equal(witness.entries()[0].receipt_confirmed, false);
          } finally {
            witness.close();
          }
          return f.transport("b").ack(request);
        },
      });
      await receiver.once();
      assert.equal(calls, 1);
      assert.equal(receiver.entries()[0].receipt_confirmed, true);
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "acked",
      );
    },
  ],
  [
    "D04 lost committed ACK response recovers the exact request after restart",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      const requests = [];
      const receiver = f.receiver("b", {
        async ack(request) {
          requests.push(structuredClone(request));
          await f.transport("b").ack(request);
          throw Error("synthetic response loss");
        },
      });
      await assert.rejects(receiver.once(), { code: "ack_transport_failed" });
      assert.equal(receiver.entries()[0].receipt_confirmed, false);
      assert.equal(
        (await f.transport("a").status(message.message_id)).state,
        "acked",
      );
      receiver.close();
      await f.restart();
      f.faults.ackRetryDue("b");
      const restored = f.receiver("b", {
        async ack(request) {
          requests.push(structuredClone(request));
          return f.transport("b").ack(request);
        },
      });
      await restored.once();
      assert.deepEqual(requests[1], requests[0]);
      assert.equal(requests.length, 2);
      assert.deepEqual(
        restored.entries().map((entry) => entry.message),
        [message],
      );
      assert.equal(restored.entries()[0].receipt_confirmed, true);
    },
  ],
  [
    "D05 ACK loss before commit and lease expiry redeliver without a duplicate inbox entry",
    async (t, f) => {
      const message = f.message("b");
      await f.transport("a").submit(message);
      let stale;
      const receiver = f.receiver("b", {
        async ack(request) {
          stale = structuredClone(request);
          throw Error("synthetic disconnect before ACK");
        },
      });
      await assert.rejects(receiver.once(), { code: "ack_transport_failed" });
      receiver.close();
      await f.restart();
      f.faults.leaseExpired();
      f.faults.ackRetryDue("b");
      const restored = f.receiver("b");
      await restored.once();
      assert.deepEqual(
        restored.entries().map((entry) => entry.message),
        [message],
      );
      assert.equal(restored.entries()[0].receipt_confirmed, true);
      await assert.rejects(f.transport("b").ack(stale), {
        code: "invalid_ack",
      });
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
      const receiver = f.receiver("b");
      await f.disconnect();
      await assert.rejects(receiver.once(), { code: "poll_transport_failed" });
      assert.deepEqual(receiver.entries(), []);
      await f.reconnect();
      await receiver.once();
      assert.deepEqual(
        receiver.entries().map((entry) => entry.message),
        [message],
      );
      assert.equal(receiver.entries()[0].receipt_confirmed, true);
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
