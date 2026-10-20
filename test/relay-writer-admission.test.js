import { test } from "node:test";
import assert from "node:assert/strict";
import { WriterAdmission } from "../src/relay/writer-admission.ts";
const policy = {
  max_individuals: 3,
  max_waiting_per_individual: 4,
  requests_per_window: 20,
  window_ms: 1000,
  max_wait_ms: 1000,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const code = (wanted) => (error) =>
  error.code === wanted && error.message === wanted;
function fixture(t, patch = {}) {
  const contexts = { a: Symbol("a"), b: Symbol("b"), c: Symbol("c") },
    active = new Set(["a", "b", "c"]);
  const state = { now: 0, override: null };
  const identify = (ctx) =>
    state.override ??
    Object.keys(contexts).find((id) => contexts[id] === ctx && active.has(id));
  const admission = new WriterAdmission(
    { ...policy, ...patch },
    identify,
    () => state.now,
  );
  t.after(() => admission.close());
  const run = (
    id,
    action = () => id,
    operation = "submit",
    signal = new AbortController().signal,
  ) => admission.run(contexts[id], operation, signal, action);
  return { admission, contexts, active, state, run };
}
test("writer admission: strict finite policy and default missing identity fail closed", async (t) => {
  for (const patch of [
    { max_individuals: 0 },
    { max_individuals: 257 },
    { max_waiting_per_individual: 65 },
    { max_individuals: 256, max_waiting_per_individual: 64 },
    { requests_per_window: Infinity },
    { window_ms: 3600001 },
    { max_wait_ms: 30001 },
  ])
    assert.throws(
      () => new WriterAdmission({ ...policy, ...patch }),
      /invalid_writer_admission_policy/,
    );
  const a = new WriterAdmission(policy);
  t.after(() => a.close());
  await assert.rejects(
    a.run({ agent_id: "a" }, "submit", new AbortController().signal, () =>
      assert.fail(),
    ),
    code("writer_forbidden"),
  );
});
test("writer admission: shared round robin serves waiting peers before a hot individual gets another turn", async (t) => {
  const f = fixture(t),
    held = deferred(),
    order = [];
  const a1 = f.run("a", () => {
    order.push("a1");
    return held.promise;
  });
  await tick();
  const jobs = [
    f.run("a", () => order.push("a2")),
    f.run("a", () => order.push("a3")),
    f.run("b", () => order.push("b1")),
    f.run("b", () => order.push("b2")),
    f.run("c", () => order.push("c1")),
  ];
  assert.deepEqual(order, ["a1"]);
  held.resolve();
  await Promise.all([a1, ...jobs]);
  assert.deepEqual(order, ["a1", "b1", "c1", "a2", "b2", "a3"]);
});
test("writer admission: one callback is active across asynchronous work and synchronous failures", async (t) => {
  const f = fixture(t),
    held = deferred();
  let active = 0,
    max = 0;
  const first = f.run("a", async () => {
    max = Math.max(max, ++active);
    await held.promise;
    active--;
    throw Error("synthetic");
  });
  const failed = assert.rejects(first, /synthetic/);
  await tick();
  const second = f.run("b", () => {
    max = Math.max(max, ++active);
    active--;
    return "done";
  });
  held.resolve();
  await failed;
  assert.equal(await second, "done");
  assert.equal(max, 1);
});
test("writer admission: per-individual queue ceiling leaves other individual queues available", async (t) => {
  const f = fixture(t, { max_waiting_per_individual: 1 }),
    held = deferred();
  const first = f.run("a", () => held.promise);
  await tick();
  const waiting = f.run("a");
  await assert.rejects(f.run("a"), code("writer_busy"));
  const other = f.run("b");
  held.resolve();
  await Promise.all([first, waiting, other]);
});
test("writer admission: each verified identity shares a token bucket across all operations", async (t) => {
  const f = fixture(t, { requests_per_window: 2 });
  await f.run("a", () => 1, "submit");
  await f.run("a", () => 2, "ack");
  await assert.rejects(
    f.run("a", () => 3, "poll"),
    code("writer_rate_limited"),
  );
  assert.equal(await f.run("b", () => "peer", "status"), "peer");
});
test("writer admission: integer token refill is proportional without a double fixed-window burst", async (t) => {
  const f = fixture(t, { requests_per_window: 2 });
  await f.run("a");
  await f.run("a");
  f.state.now = 499;
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
  f.state.now = 500;
  await f.run("a");
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
  f.state.now = 1000;
  await f.run("a");
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
  f.state.now = 1000000000000;
  await f.run("a");
  await f.run("a");
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
});
test("writer admission: queued abort removes work without refunding its accepted attempt", async (t) => {
  const f = fixture(t, { requests_per_window: 2 }),
    held = deferred(),
    controller = new AbortController();
  const first = f.run("a", () => held.promise);
  await tick();
  const waiting = f.run("a", () => assert.fail(), "status", controller.signal);
  const rejected = assert.rejects(waiting, code("writer_aborted"));
  controller.abort();
  await rejected;
  held.resolve();
  await first;
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
});
test("writer admission: aborting an active callback does not free its unresolved slot", async (t) => {
  const f = fixture(t),
    held = deferred(),
    controller = new AbortController();
  let started = false;
  const first = f.run("a", () => held.promise, "submit", controller.signal);
  await tick();
  controller.abort();
  const second = f.run("b", () => {
    started = true;
  });
  await tick();
  assert.equal(started, false);
  held.resolve();
  await Promise.all([first, second]);
  assert.equal(started, true);
});
test("writer admission: finite queue timeout never invokes the abandoned callback", async (t) => {
  const f = fixture(t, { max_wait_ms: 20 }),
    held = deferred();
  let called = false;
  const first = f.run("a", () => held.promise);
  await tick();
  await assert.rejects(
    f.run("b", () => {
      called = true;
    }),
    code("writer_queue_expired"),
  );
  assert.equal(called, false);
  held.resolve();
  await first;
});
test("writer admission: an elapsed monotonic deadline is rejected before dispatch", async (t) => {
  const f = fixture(t);
  const pending = f.run("a", () => assert.fail());
  f.state.now = 1000;
  await assert.rejects(pending, code("writer_queue_expired"));
});
test("writer admission: current revocation or changed binding rejects queued work", async (t) => {
  const f = fixture(t),
    held = deferred();
  const first = f.run("a", () => held.promise);
  await tick();
  const waiting = f.run("b", () => assert.fail()),
    rejected = assert.rejects(waiting, code("writer_forbidden"));
  f.active.delete("b");
  held.resolve();
  await first;
  await rejected;
  f.active.add("b");
  const rebound = f.run("b", () => assert.fail());
  f.state.override = "c";
  await assert.rejects(rebound, code("writer_forbidden"));
});
test("writer admission: authentication is rechecked at the actual callback microtask", async (t) => {
  const f = fixture(t),
    pending = f.run("a", () => assert.fail());
  globalThis.queueMicrotask(() => f.active.delete("a"));
  await assert.rejects(pending, code("writer_forbidden"));
});
test("writer admission: claimed context, unknown operation and async identity ports grant nothing", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.admission.run(
      { agent_id: "a" },
      "submit",
      new AbortController().signal,
      () => assert.fail(),
    ),
    code("writer_forbidden"),
  );
  await assert.rejects(
    f.admission.run(
      f.contexts.a,
      "maintenance",
      new AbortController().signal,
      () => assert.fail(),
    ),
    code("writer_forbidden"),
  );
  const a = new WriterAdmission(policy, () =>
    Promise.reject(Error("synthetic")),
  );
  t.after(() => a.close());
  await assert.rejects(
    a.run(null, "submit", new AbortController().signal, () => assert.fail()),
    code("writer_forbidden"),
  );
  await tick();
});
test("writer admission: saturated identity state is retained until idle and fully refilled", async (t) => {
  const f = fixture(t, { max_individuals: 1, requests_per_window: 1 });
  await f.run("a");
  await assert.rejects(f.run("b"), code("writer_busy"));
  await assert.rejects(f.run("a"), code("writer_rate_limited"));
  await tick();
  f.state.now = 1000;
  assert.equal(await f.run("b"), "b");
});
test("writer admission: an active identity is never evicted even after its tokens refill", async (t) => {
  const f = fixture(t, { max_individuals: 1 }),
    held = deferred();
  const first = f.run("a", () => held.promise);
  await tick();
  f.state.now = 1000;
  await assert.rejects(f.run("b"), code("writer_busy"));
  held.resolve();
  await first;
  await tick();
  assert.equal(await f.run("b"), "b");
});
test("writer admission: immutable policy copy prevents caller mutation from increasing limits", async (t) => {
  const p = { ...policy, requests_per_window: 1 },
    a = new WriterAdmission(
      p,
      () => "a",
      () => 0,
    );
  t.after(() => a.close());
  p.requests_per_window = 99;
  await a.run(null, "submit", new AbortController().signal, () => null);
  await assert.rejects(
    a.run(null, "submit", new AbortController().signal, () => null),
    code("writer_rate_limited"),
  );
});
test("writer admission: a regressing clock fails closed without releasing active work", async (t) => {
  const f = fixture(t),
    held = deferred();
  f.state.now = 100;
  const first = f.run("a", () => held.promise);
  await tick();
  f.state.now = 90;
  await assert.rejects(f.run("b"), code("writer_unavailable"));
  f.state.now = 100;
  let started = false;
  const second = f.run("b", () => {
    started = true;
  });
  await tick();
  assert.equal(started, false);
  held.resolve();
  await Promise.all([first, second]);
});
test("writer admission: close rejects waiting work and prevents further admission", async (t) => {
  const f = fixture(t),
    held = deferred();
  const first = f.run("a", () => held.promise);
  await tick();
  const second = f.run("b", () => assert.fail()),
    rejected = assert.rejects(second, code("writer_closed"));
  f.admission.close();
  f.admission.close();
  await rejected;
  await assert.rejects(f.run("c"), code("writer_closed"));
  held.resolve();
  await first;
});
test("writer admission: close between selection and invocation prevents starting the callback", async (t) => {
  const f = fixture(t),
    pending = f.run("a", () => assert.fail());
  globalThis.queueMicrotask(() => f.admission.close());
  await assert.rejects(pending, code("writer_closed"));
});
test("writer admission: an identity resolver aborting at dispatch cannot execute work", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const a = new WriterAdmission(policy, () => {
    if (++calls === 3) controller.abort();
    return "a";
  });
  t.after(() => a.close());
  await assert.rejects(
    a.run(null, "submit", controller.signal, () => assert.fail()),
    code("writer_aborted"),
  );
});
