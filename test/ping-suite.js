import assert from "node:assert/strict";
import { PingService } from "../src/ping.ts";
export const routes = {
  dots: { subject: "fixture-dots", clientId: "fixture-dots-client" },
  grok: { subject: "fixture-grok", clientId: "fixture-grok-client" },
};
export const dots = {
  ...routes.dots,
  operations: ["ping_submit", "ping_get", "ping_reply", "ping_pending"],
};
export const grok = { ...routes.grok, operations: [...dots.operations] };
export const reply = (task) => ({
  in_reply_to: task.id,
  correlation_id: task.correlation_id,
  payload: "pong",
});
export async function pingSuite(t, h) {
  const service = new PingService(h, routes);
  const reset = () =>
    h.driver.batch([
      { sql: "DELETE FROM diagnostic_pings" },
      { sql: "DELETE FROM diagnostic_outbox" },
      { sql: "DELETE FROM diagnostic_audit" },
      { sql: "DELETE FROM authorization_state WHERE kind<>'global'" },
      {
        sql: "UPDATE authorization_state SET stopped=0,epoch=0 WHERE kind='global'",
      },
    ]);
  const check = async (name, fn) => {
    await reset();
    await t.test(name, fn);
  };
  for (const [sender, recipient] of [
    [dots, grok],
    [grok, dots],
  ])
    await check(
      `${sender.subject} → fixed ping → ${recipient.subject} pong with one reply/outbox and no loop`,
      async () => {
        const task = await service.submit(sender, {
          request_key: "diagnostic-1",
          payload: "ping",
        });
        assert.equal(task.state, "pending");
        assert.equal((await service.pending(recipient, {}))[0].id, task.id);
        assert.equal((await service.pending(sender, {})).length, 0);
        const duplicate = await service.submit(sender, {
          request_key: "diagnostic-1",
          payload: "ping",
        });
        assert.deepEqual(duplicate, task);
        const response = await service.reply(recipient, reply(task));
        assert.equal(response.state, "replied");
        assert.equal(response.reply.payload, "pong");
        assert.equal(response.reply.in_reply_to, task.id);
        assert.equal(response.reply.correlation_id, task.correlation_id);
        assert.deepEqual(await service.reply(recipient, reply(task)), response);
        assert.deepEqual(await service.get(sender, { id: task.id }), response);
        await assert.rejects(service.reply(sender, reply(task)));
        await assert.rejects(
          service.reply(recipient, {
            ...reply(task),
            in_reply_to: response.reply.id,
          }),
        );
        const rows = await h.driver.batch([
          { sql: "SELECT * FROM diagnostic_pings" },
          { sql: "SELECT * FROM diagnostic_outbox" },
          { sql: "SELECT * FROM diagnostic_audit" },
        ]);
        assert.equal(rows[0].length, 1);
        assert.equal(rows[1].length, 2);
        assert.equal(rows[2].length, 2);
      },
    );
  await check(
    "caller labels, free text, URLs, shell, forged client and missing scope cannot confer diagnostic rights",
    async () => {
      await assert.rejects(
        new PingService(h).submit(dots, { request_key: "x", payload: "ping" }),
      );
      for (const field of [
        { sender: "grok" },
        { recipient: "dots" },
        { url: "https://callback.example" },
        { shell: "whoami" },
        { message: "free text" },
        { in_reply_to: crypto.randomUUID() },
      ])
        await assert.rejects(
          service.submit(dots, { request_key: "x", payload: "ping", ...field }),
        );
      for (const p of [
        { ...dots, clientId: grok.clientId },
        { ...dots, subject: "unknown" },
        { ...dots, operations: [] },
      ])
        await assert.rejects(
          service.submit(p, { request_key: "x", payload: "ping" }),
        );
      const task = await service.submit(dots, {
        request_key: "identity",
        payload: "ping",
      });
      await assert.rejects(
        service.reply(grok, {
          ...reply(task),
          correlation_id: crypto.randomUUID(),
        }),
      );
      await assert.rejects(
        service.reply(grok, { ...reply(task), payload: "ping" }),
      );
      await assert.rejects(
        service.get({ ...grok, subject: "other" }, { id: task.id }),
      );
      await assert.rejects(
        service.submit(dots, {
          request_key: "identity",
          payload: "ping",
          ttl_ms: 3000,
        }),
        /ping_idempotency_conflict/,
      );
    },
  );
  await check(
    "TTL uses database time at mutation and cannot be extended through replay",
    async () => {
      const task = await service.submit(dots, {
        request_key: "expired",
        payload: "ping",
        ttl_ms: 1000,
      });
      const original = h.driver.batch.bind(h.driver);
      let injected = false;
      h.driver.batch = async (statements) => {
        if (
          !injected &&
          statements.some((s) => s.sql.includes("SET state='replied'"))
        ) {
          injected = true;
          // One clock sample keeps the rewritten window exactly ttl_ms wide, as submit does.
          await original([
            {
              sql:
                "WITH c AS MATERIALIZED (SELECT " +
                h.driver.nowSQL +
                " AS now) UPDATE diagnostic_pings SET created=(SELECT now FROM c)-2000,expires=(SELECT now FROM c)-1000 WHERE id=?",
              params: [task.id],
            },
          ]);
        }
        return original(statements);
      };
      try {
        await assert.rejects(service.reply(grok, reply(task)));
      } finally {
        h.driver.batch = original;
      }
      assert.equal(injected, true);
      assert.equal((await service.get(dots, { id: task.id })).state, "expired");
      assert.equal(
        (
          await service.submit(dots, {
            request_key: "expired",
            payload: "ping",
            ttl_ms: 1000,
          })
        ).state,
        "expired",
      );
      assert.equal((await service.pending(grok, {})).length, 0);
    },
  );
  await check(
    "same human distinct clients preserve ownership and independent client stop",
    async () => {
      const a = { ...dots, subject: "fixture-shared-human" },
        b = { ...grok, subject: a.subject };
      const shared = new PingService(h, {
        dots: { subject: a.subject, clientId: a.clientId },
        grok: { subject: b.subject, clientId: b.clientId },
      });
      const task = await shared.submit(a, {
        request_key: "shared",
        payload: "ping",
      });
      await assert.rejects(shared.reply(a, reply(task)));
      await assert.rejects(
        shared.get({ ...a, clientId: "unregistered" }, { id: task.id }),
      );
      assert.equal((await shared.pending(a, {})).length, 0);
      assert.equal((await shared.pending(b, {})).length, 1);
      const fromB = await shared.submit(b, {
        request_key: "shared",
        payload: "ping",
      });
      assert.notEqual(fromB.id, task.id);
      await h.authorization.setStopped(
        { kind: "client", id: a.clientId },
        true,
        0,
        "fixture-maintainer",
      );
      await assert.rejects(h.authorization.bind(a), /authorization_rejected/);
      assert.equal((await h.authorization.bind(b)).clientId, b.clientId);
      await assert.rejects(
        shared.reply(b, reply(task)),
        /authorization_rejected/,
      );
      await h.authorization.setStopped(
        { kind: "subject", id: a.subject },
        true,
        1,
        "fixture-maintainer",
      );
      await assert.rejects(h.authorization.bind(b), /authorization_rejected/);
    },
  );
  await check(
    "recipient and origin stops block traffic, and restore does not revive stale diagnostics",
    async () => {
      const task = await service.submit(dots, {
        request_key: "stop",
        payload: "ping",
      });
      await h.authorization.setStopped(
        { kind: "client", id: dots.clientId },
        true,
        0,
        "fixture-maintainer",
      );
      await assert.rejects(
        service.reply(grok, reply(task)),
        /authorization_rejected/,
      );
      await assert.rejects(
        service.submit(grok, { request_key: "reply-stop", payload: "ping" }),
        /authorization_rejected/,
      );
      await h.authorization.setStopped(
        { kind: "client", id: dots.clientId },
        false,
        1,
        "fixture-maintainer",
      );
      await assert.rejects(service.reply(grok, reply(task)));
      assert.equal((await service.pending(grok, {})).length, 0);
      assert.equal((await service.get(dots, { id: task.id })).state, "expired");
    },
  );
  await check(
    "concurrent pong and webhook dispatch have one winner; HTTP200 never completes the ping",
    async () => {
      const task = await service.submit(dots, {
        request_key: "wake",
        payload: "ping",
      });
      let count = 0;
      const transport = {
        post: async (body) => {
          count++;
          assert.deepEqual(body, {
            request_id: task.id,
            correlation_id: task.correlation_id,
            payload: "ping",
          });
          return { status: 200 };
        },
      };
      const calls = await Promise.all([
        service.dispatchGrokWake(transport),
        service.dispatchGrokWake(transport),
      ]);
      assert.equal(calls.filter(Boolean).length, 1);
      assert.equal(count, 1);
      assert.equal((await service.get(dots, { id: task.id })).state, "pending");
      assert.equal(
        (
          await h.driver.batch([
            {
              sql: "SELECT delivery FROM diagnostic_outbox WHERE kind='requested'",
            },
          ])
        )[0][0].delivery,
        "accepted",
      );
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => service.reply(grok, reply(task))),
      );
      assert.equal(new Set(responses.map((r) => r.reply.id)).size, 1);
      assert.equal(await service.dispatchGrokWake(transport), false);
      assert.equal(count, 1);
    },
  );
  for (const status of [503, "lost-ack"])
    await check(
      `webhook ${status} parks event without automatic retry or completion`,
      async () => {
        const task = await service.submit(dots, {
          request_key: "failed-wake",
          payload: "ping",
        });
        let count = 0;
        const transport = {
          post: async () => {
            count++;
            if (status === "lost-ack")
              throw Error("fixture provider secret must not persist");
            return { status };
          },
        };
        assert.equal(await service.dispatchGrokWake(transport), true);
        assert.equal(await service.dispatchGrokWake(transport), false);
        assert.equal(count, 1);
        assert.equal(
          (await service.get(dots, { id: task.id })).state,
          "pending",
        );
        const result = (
          await h.driver.batch([
            {
              sql: "SELECT delivery FROM diagnostic_outbox WHERE kind='requested'",
            },
          ])
        )[0][0].delivery;
        assert.equal(result, status === "lost-ack" ? "uncertain" : "failed");
      },
    );
  await check(
    "Grok-origin pending report is pull-only and never wakes or loops back into Grok",
    async () => {
      await service.submit(grok, { request_key: "report", payload: "ping" });
      assert.equal(
        await service.dispatchGrokWake({
          post: async () => {
            throw Error("must not call");
          },
        }),
        false,
      );
      assert.equal((await service.pending(dots, {})).length, 1);
    },
  );
  await check(
    "bounded ten pending diagnostics prevents unbounded active wakeups",
    async () => {
      for (let i = 0; i < 10; i++)
        await service.submit(dots, {
          request_key: `limit-${i}`,
          payload: "ping",
        });
      await assert.rejects(
        service.submit(dots, { request_key: "over-limit", payload: "ping" }),
        /ping_capacity_rejected/,
      );
      assert.equal((await service.pending(grok, {})).length, 10);
      assert.equal(
        (
          await service.submit(dots, {
            request_key: "limit-0",
            payload: "ping",
          })
        ).state,
        "pending",
      );
    },
  );
}
