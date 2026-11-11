/** Synthetic managed transport only: private SQLite, no product, token or network. */
import test from "node:test";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticStores } from "./external-owner-fixture.js";
import { AdapterHostCycle } from "../src/adapter-host/cycle.ts";
import { HostError } from "../src/adapter-host/sqlite-control.ts";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
function setup(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-managed-fixture-")),
    s = syntheticStores(dir),
    context = {};
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = {
    enabled: true,
    actor: "fixture-operator",
    requests: 0,
    clients: [],
    operations: [],
    credential: null,
    retry: null,
    timeout: false,
    checkFailure: false,
  };
  const base = { ...s.binding.hostOptions };
  delete base.transport;
  const authorization = (ctx) =>
    ctx === context && state.enabled
      ? { agent_id: base.control.agentId, actor_id: state.actor }
      : undefined;
  const options = {
    ...base,
    authorization,
    managedTransport(operation) {
      state.operations.push(operation);
      let active = 0;
      const perform = async (name, message) => {
        active++;
        const work = (async () => {
          try {
            operation.check();
            if (state.credential) await state.credential.promise;
            operation.check();
            state.requests++;
            if (state.retry) {
              await state.retry.promise;
              operation.check();
              state.requests++;
            }
            operation.check();
            return name === "poll"
              ? null
              : {
                  sender_id: base.control.agentId,
                  message_id: message.message_id,
                  recipient_id: message.recipient_id,
                  receipt_id: "fixture-receipt",
                  accepted_at: new Date().toISOString(),
                  expires_at: message.expires_at,
                  state: "pending",
                };
          } finally {
            active--;
          }
        })();
        if (state.timeout) {
          void work.catch(() => {});
          throw Error("synthetic_timeout_with_native_work_pending");
        }
        return work;
      };
      const client = {
        agentId: base.control.agentId,
        get activeRequests() {
          return active;
        },
        poll: () => perform("poll"),
        ack: () => {
          throw Error("unused");
        },
        submit: (m) => perform("submit", m),
        status: () => {
          throw Error("unused");
        },
      };
      state.clients.push(client);
      return client;
    },
    ...patch,
  };
  const host = new AdapterHostCycle(options);
  const pause = () => host.setPaused(context, true, host.status(context).epoch);
  const resume = () =>
    host.setPaused(context, false, host.status(context).epoch);
  const step = (op) => host.stepOnce(context, { op });
  return { s, context, state, options, host, pause, resume, step };
}
test("managed transport is exclusive, pure, and obtains a frozen finite command port", async (t) => {
  const f = setup(t);
  assert.equal(f.state.operations.length, 0);
  f.resume();
  assert.equal((await f.step("receive")).state, "done");
  assert.equal(f.state.requests, 1);
  const op = f.state.operations[0];
  assert.equal(Object.isFrozen(op), true);
  assert.equal(op.signal.aborted, true);
  assert.throws(() => op.check(), /host_session_closed/);
  assert.throws(
    () => new AdapterHostCycle({ ...f.options, transport: () => {} }),
    /invalid_host_composition/,
  );
  assert.throws(
    () => new AdapterHostCycle({ ...f.options, network: globalThis.fetch }),
    /invalid_host_composition/,
  );
  assert.throws(
    () => new AdapterHostCycle({ ...f.options, managedTransport: undefined }),
    /invalid_host_composition/,
  );
});
test("pause during credential wait aborts immediately, no network and owner retained until settlement", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const pending = f.step("receive");
  await tick();
  const op = f.state.operations[0];
  let aborts = 0;
  op.signal.addEventListener("abort", () => {
    aborts++;
    assert.equal(f.host.status(f.context).paused, true);
  });
  f.pause();
  assert.equal(op.signal.aborted, true);
  assert.equal(aborts, 1);
  assert.throws(() => f.host.releaseOwner(f.context), /host_busy/);
  assert.equal(f.host.status(f.context).owner, "held");
  f.state.credential.resolve();
  assert.equal((await pending).state, "incomplete");
  assert.equal(f.state.requests, 0);
  f.host.releaseOwner(f.context);
  assert.equal(f.host.status(f.context).owner, "lost");
});
test("invalid stale or unauthorized pause does not cancel valid command", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const pending = f.step("receive");
  await tick();
  const op = f.state.operations[0];
  assert.throws(
    () => f.host.setPaused(f.context, true, 0),
    /host_epoch_changed/,
  );
  assert.throws(
    () => f.host.setPaused({}, true, f.host.status(f.context).epoch),
    /host_forbidden/,
  );
  assert.throws(
    () => f.host.setPaused(f.context, true, -1),
    /invalid_host_control_request/,
  );
  assert.equal(op.signal.aborted, false);
  f.state.credential.resolve();
  assert.equal((await pending).state, "done");
  assert.equal(f.state.requests, 1);
});
test("pause then resume cannot lend new epoch to old command or callback", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const pending = f.step("receive");
  await tick();
  const old = f.state.operations[0];
  f.pause();
  f.resume();
  f.state.credential.resolve();
  assert.equal((await pending).state, "incomplete");
  assert.equal(f.state.requests, 0);
  assert.throws(() => old.check());
  f.state.credential = null;
  assert.equal((await f.step("receive")).state, "done");
  assert.notEqual(f.state.operations[1], old);
});
test("current authorization actor and exclusive owner are checked after credential waits", async (t) => {
  for (const mode of ["revoke", "actor", "owner"])
    await t.test(mode, async (t) => {
      const f = setup(t);
      f.resume();
      f.state.credential = deferred();
      const pending = f.step("receive");
      await tick();
      if (mode === "revoke") f.state.enabled = false;
      else if (mode === "actor") f.state.actor = "changed";
      else f.s.owner.close();
      f.state.credential.resolve();
      assert.equal((await pending).state, "incomplete");
      assert.equal(f.state.requests, 0);
      assert.equal(f.state.operations[0].signal.aborted, true);
    });
});
test("managed retry must recheck; cancellation fences second native admission", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.retry = deferred();
  const pending = f.step("receive");
  await tick();
  assert.equal(f.state.requests, 1);
  f.pause();
  f.state.retry.resolve();
  assert.equal((await pending).state, "incomplete");
  assert.equal(f.state.requests, 1);
});
test("early timeout preserves draining after command ends until real cleanup settles", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  f.state.timeout = true;
  assert.equal((await f.step("receive")).state, "incomplete");
  assert.equal(f.host.status(f.context).draining, 1);
  assert.equal(f.state.operations[0].signal.aborted, true);
  await assert.rejects(f.step("receive"), /host_busy/);
  f.pause();
  assert.throws(() => f.host.releaseOwner(f.context), /host_busy/);
  f.state.credential.resolve();
  await tick();
  assert.equal(f.host.status(f.context).draining, 0);
  assert.equal(f.state.requests, 0);
  f.host.releaseOwner(f.context);
});
test("ambiguous submitted message keeps original outbox claim and owner until native settlement", async (t) => {
  const f = setup(t);
  f.resume();
  const now = Date.now() - 100;
  const message = {
    version: 1,
    message_id: "fixture-send",
    recipient_id: "fixture-peer",
    kind: "question",
    body: { parts: [{ type: "text", text: "synthetic" }] },
    thread_id: "fixture-thread",
    in_reply_to: null,
    first_sent_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(),
  };
  f.s.binding.hostOptions.outbox.enqueue(message);
  f.state.retry = deferred();
  const pending = f.step("send");
  await tick();
  assert.equal(f.state.requests, 1);
  f.pause();
  assert.throws(() => f.host.releaseOwner(f.context), /host_busy/);
  f.state.retry.resolve();
  assert.equal((await pending).state, "incomplete");
  const record = f.s.binding.hostOptions.outbox.get(message.message_id);
  assert.equal(record.state, "sending");
  assert.equal(record.receipt, null);
  assert.equal(f.host.status(f.context).owner, "held");
  assert.equal(f.state.requests, 1);
});
test("authorized pause with failed persistence still cancels local managed IO", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const pending = f.step("receive");
  await tick();
  const original = f.s.control.setPaused.bind(f.s.control);
  f.s.control.setPaused = () => {
    throw new HostError("host_store_unavailable");
  };
  assert.throws(() => f.pause(), /host_store_unavailable/);
  assert.equal(f.state.operations[0].signal.aborted, true);
  f.s.control.setPaused = original;
  f.state.credential.resolve();
  assert.equal((await pending).state, "incomplete");
  assert.equal(f.state.requests, 0);
});
test("synchronous abort reentry cannot reuse a running command or release its owner", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const pending = f.step("receive");
  await tick();
  let count = 0;
  f.state.operations[0].signal.addEventListener("abort", () => {
    count++;
    f.pause();
    assert.throws(() => f.host.releaseOwner(f.context), /host_busy/);
  });
  f.pause();
  assert.equal(count, 1);
  f.state.credential.resolve();
  await pending;
  assert.equal(f.state.requests, 0);
});
test("fully drained pause/resume creates fresh IO; late old checks cannot cancel the next operation", async (t) => {
  const f = setup(t);
  f.resume();
  f.state.credential = deferred();
  const first = f.step("receive");
  await tick();
  const old = f.state.operations[0];
  f.pause();
  f.state.credential.resolve();
  assert.equal((await first).state, "incomplete");
  assert.equal(f.host.status(f.context).draining, 0);
  assert.equal(old.signal.aborted, true);
  f.resume();
  f.state.credential = deferred();
  const second = f.step("receive");
  await tick();
  const current = f.state.operations[1];
  assert.notEqual(current.signal, old.signal);
  assert.equal(current.signal.aborted, false);
  assert.throws(() => old.check(), /host_session_closed/);
  assert.equal(current.signal.aborted, false);
  assert.equal(f.host.status(f.context).running, true);
  assert.throws(() => f.host.releaseOwner(f.context), /host_busy/);
  f.state.credential.resolve();
  assert.equal((await second).state, "done");
  assert.equal(f.state.requests, 1);
  assert.equal(current.signal.aborted, true);
});
test("authorization reentry that aborts during atomic guard cannot admit native IO", async (t) => {
  let f,
    armed = false,
    admissions = 0,
    operation;
  f = setup(t, {
    authorization(ctx, op) {
      if (!f || ctx !== f.context) return undefined;
      if (op === "receive" && armed) {
        armed = false;
        assert.throws(
          () => f.host.setPaused(ctx, true, 1),
          /host_busy/,
        );
      }
      return { agent_id: "synthetic-recipient", actor_id: "fixture-operator" };
    },
    managedTransport(port) {
      operation = port;
      return {
        agentId: "synthetic-recipient",
        activeRequests: 0,
        async poll() {
          armed = true;
          port.check();
          admissions++;
          return null;
        },
        async ack() {
          throw Error("unused");
        },
        async submit() {
          throw Error("unused");
        },
        async status() {
          throw Error("unused");
        },
      };
    },
  });
  f.resume();
  const result = await f.step("receive");
  assert.equal(result.state, "incomplete");
  assert.equal(operation.signal.aborted, true);
  assert.equal(admissions, 0);
});
