import { test } from "node:test";
import assert from "node:assert/strict";
import { workerLoop } from "../src/worker-loop.ts";
import { EventSender } from "../src/events.ts";

test("worker rejects non-finite or nonnumeric idle budgets before constructing an adapter", async () => {
  let constructed = 0;
  for (const idleMs of [NaN, Infinity, -Infinity, "100", {}, 99, 60001]) {
    await assert.rejects(
      workerLoop({
        signal: new AbortController().signal,
        idleMs,
        maxCycles: 1,
        adapter: async () => {
          constructed++;
          return { run: async () => {} };
        },
      }),
      /invalid_worker_budget/,
    );
  }
  assert.equal(constructed, 0);
});

test("finite worker idle budgets preserve explicit cycle and wait limits", async () => {
  for (const idleMs of [100, 100.5, 60000]) {
    let runs = 0;
    const waits = [];
    assert.equal(
      await workerLoop({
        signal: new AbortController().signal,
        idleMs,
        maxCycles: 2,
        adapter: async () => ({
          run: async () => {
            runs++;
          },
        }),
        wait: async (ms) => {
          waits.push(ms);
        },
      }),
      2,
    );
    assert.equal(runs, 2);
    assert.deepEqual(waits, [idleMs]);
  }
});

test("callback verification sends no challenge when subscription expires during authorization", async () => {
  let now = 1000;
  let posts = 0;
  const sender = new EventSender({
    subscription: {
      id: "fixture-subscription",
      subject: "fixture-owner",
      task_id: "fixture-task",
      url: "https://callback.example/hook",
      secret: Buffer.alloc(32, 1).toString("base64"),
      expiresAt: 1001,
    },
    now: () => now,
    authorise: async () => {
      await Promise.resolve();
      now = 1001;
      return true;
    },
    transport: {
      post: async (_url, _headers, body) => {
        posts++;
        return {
          status: 200,
          body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
        };
      },
    },
  });
  await assert.rejects(sender.verify(), /subscription_not_authorised/);
  assert.equal(posts, 0);
});
