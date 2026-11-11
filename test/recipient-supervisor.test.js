import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { RecipientMessageError } from "../src/recipient-messages/contract.ts";
import { RecipientSupervisor } from "../src/recipient-messages/supervisor.ts";
import { SQLiteHostOwner } from "../src/agent-sdk/sqlite-host-owner.ts";
import { fixture as recipientFixture } from "./recipient-messages-fixtures.js";
import { deferred, limits } from "./adapter-host-fixtures.js";

const policy = { interval_ms: 1000, drain_timeout_ms: 2000 };
async function fixture(t) {
  const f = await recipientFixture(t);
  const owner = new SQLiteHostOwner(join(f.dir, "recipient-owner.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(99),
  });
  owner.migrate();
  owner.acquire(() => {});
  t.after(() => owner.close());
  const host = f.makeHost({ owner });
  const states = [];
  const port = {
    version: 1,
    host,
    hostContext: f.hostContext,
    recipientContext: f.context,
    messages: {
      binding: f.binding,
      inbox: f.inbox,
      outbox: f.outbox,
      budget: f.budget,
      limits,
      recipient: f.port,
      authorization: (context, operation) =>
        context === f.context &&
        f.state.enabled &&
        !f.state.denied.has(operation)
          ? {
              agent_id: "b",
              actor_id: f.state.actor,
              authority_epoch: f.state.epoch,
            }
          : undefined,
    },
    sources: () =>
      f.inbox
        .inbox()
        .filter(
          (entry) =>
            entry.receipt_confirmed &&
            entry.message.kind === "question" &&
            entry.message.in_reply_to === null,
        )
        .map((entry) => ({
          sender_id: entry.sender_id,
          message_id: entry.message.message_id,
        })),
    observe: (state) => states.push(state),
  };
  return { ...f, host, owner, port, states };
}
async function once(f, patch = {}, afterTick = () => {}) {
  const stop = new AbortController();
  const supervisor = new RecipientSupervisor({ ...f.port, ...patch }, policy, {
    wait: async () => {
      await afterTick();
      stop.abort();
    },
  });
  return supervisor.run(stop.signal);
}

test("recipient owner: receive -> native policy -> fixed reply -> durable send without manual per-message calls", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit();
  const answer = f.answer(key);
  const native = {
    ...f.port.messages.recipient,
    async admit(input, check) {
      await f.port.messages.recipient.admit(input, check);
      // Synthetic native decision, not an HAB model or sender-side approval.
      check();
      f.allowByPolicy(answer);
      return {
        key: input.key,
        input_hash: input.input_hash,
        phase: "reply_ready",
      };
    },
  };
  assert.deepEqual(
    await once(f, { messages: { ...f.port.messages, recipient: native } }),
    {
      reason: "stopped",
      receive_steps: 1,
      recipient_steps: 1,
      send_steps: 1,
      drained: true,
    },
  );
  assert.equal(f.state.admits, 1);
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
  assert.equal(f.outbox.get(answer.message_id).state, "accepted");
  assert.deepEqual(f.service.poll(f.contexts.a).message, {
    ...answer,
    sender_id: "b",
  });
  assert.deepEqual(
    f.states.map((state) => state.phase),
    ["reply_ready", "reply_queued"],
  );
  assert.equal(f.states[1].outbox_state, "queued"); // enqueue is not delivery proof
  assert.equal(f.count(), 0); // no Task/worker fallback
  assert.equal(f.state.inputs[0].origin, "external_agent");
  f.reopen();
  await once(f);
  assert.equal(f.state.admits, 1);
  assert.equal(f.queued().length, 1);
  assert.equal(f.states.at(-1).outbox_state, "accepted");
});

test("recipient owner: waiting_owner/processing/unknown are distinct and never manufacture a reply", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  f.submit();
  await once(f);
  for (const phase of ["processing", "waiting_owner", "unknown", "declined"]) {
    f.decide(phase);
    await once(f);
    assert.equal(f.states.at(-1).phase, phase);
  }
  assert.equal(f.state.admits, 1);
  assert.equal(f.queued().length, 0);
});

test("recipient owner: lost admission is reconciled on restart without duplicate native work", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  f.submit();
  f.state.lost = true;
  await once(f);
  assert.equal(f.states.at(-1).phase, "unknown");
  f.reopen();
  f.state.lost = false;
  await once(f);
  assert.equal(f.states.at(-1).phase, "accepted");
  assert.equal(f.state.admits, 1);
});

test("recipient owner: pause and pause/resume during native wait fence admission at commit", async (t) => {
  for (const resume of [false, true]) {
    await t.test(String(resume), async (t) => {
      const f = await fixture(t);
      f.resume(f.host);
      f.submit();
      f.state.afterInspect = async () => {
        f.pause(f.host);
        if (resume) f.resume(f.host);
      };
      const result = await once(f);
      assert.equal(result.reason, resume ? "host_unavailable" : "paused");
      assert.equal(f.state.admits, 0);
      assert.equal(f.queued().length, 0);
      assert.equal(result.send_steps, 0);
    });
  }
});

test("recipient owner: stop while native inspect waits does not detach work or admit/send later", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    finish = deferred(),
    stop = new AbortController();
  f.resume(f.host);
  f.submit();
  f.state.afterInspect = async () => {
    entered.resolve();
    await finish.promise;
  };
  const supervisor = new RecipientSupervisor(f.port, policy);
  const running = supervisor.run(stop.signal);
  await entered.promise;
  await assert.rejects(
    supervisor.run(stop.signal),
    /recipient_supervisor_busy/,
  );
  stop.abort();
  finish.resolve();
  const result = await running;
  assert.equal(result.reason, "stopped");
  assert.equal(result.drained, true);
  assert.equal(f.state.admits, 0);
  assert.equal(result.send_steps, 0);
});

test("recipient owner: missing owner or native port never implies conversation-ready", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      new RecipientSupervisor(
        { ...f.port, messages: { ...f.port.messages, recipient: undefined } },
        policy,
      ),
    (error) => error.code === "recipient_input_unsupported",
  );
  f.resume(f.host);
  const missingOwner = f.makeHost();
  assert.equal(
    (await once(f, { host: missingOwner })).reason,
    "owner_unavailable",
  );
  assert.equal(f.hostState.tools.length, 0);
});

test("recipient owner: source denial and revoked native reply remain blocked, not waiting_owner", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit();
  f.state.denied.add("handoff");
  await once(f);
  assert.equal(f.states.at(-1).phase, "blocked");
  assert.equal(f.state.admits, 0);
  f.state.denied.clear();
  await once(f);
  f.allowByPolicy(f.answer(key));
  f.revokeReply();
  await once(f);
  assert.equal(f.states.at(-1).phase, "blocked");
  assert.equal(f.states.at(-1).reason, "recipient_reply_unavailable");
  assert.equal(f.queued().length, 0);
});

test("recipient owner: notices cannot produce automatic answers", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit("notice");
  await once(f, { sources: () => [key] });
  assert.equal(f.state.admits, 1); // notice may be observed by native, never answered
  f.allowByPolicy(f.answer(key));
  await once(f, { sources: () => [key] });
  assert.equal(f.states.at(-1).reason, "recipient_invalid_reply");
  assert.equal(f.queued().length, 0);
});

test("recipient owner: selection is bounded, synchronous and duplicate-free", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit();
  assert.equal(
    (await once(f, { sources: () => [key, key] })).reason,
    "recipient_unavailable",
  );
  assert.equal(
    (await once(f, { sources: async () => [key] })).reason,
    "recipient_unavailable",
  );
  assert.equal(f.state.admits, 0);
});

test("recipient owner: lost ACK retries the existing journal before native admission", async (t) => {
  const f = await fixture(t),
    stop = new AbortController();
  f.resume(f.host);
  const { key } = f.submit();
  let lost = false,
    ticks = 0;
  f.hostState.afterNetwork = async (tool) => {
    if (tool === "relay_ack" && !lost) {
      lost = true;
      throw Error("private transport detail");
    }
  };
  const supervisor = new RecipientSupervisor(f.port, policy, {
    wait: async () => {
      if (++ticks === 1) {
        assert.equal(f.state.admits, 0);
        assert.equal(f.inbox.inbox()[0].receipt_confirmed, false);
        f.inboxRaw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
      } else stop.abort();
    },
  });
  const result = await supervisor.run(stop.signal);
  assert.equal(result.reason, "stopped");
  assert.equal(result.receive_steps, 2);
  assert.equal(result.send_steps, 2);
  assert.equal(f.state.admits, 1);
  assert.equal(f.service.status(f.contexts.a, key.message_id).state, "acked");
});

test("recipient owner: lost send response preserves the exact outbox and native identity", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit();
  await once(f);
  const reply = f.answer(key);
  f.allowByPolicy(reply);
  let lost = false;
  f.hostState.afterNetwork = async (tool) => {
    if (tool === "relay_submit" && !lost) {
      lost = true;
      throw Error("private submit detail");
    }
  };
  await once(f);
  assert.equal(f.queued().length, 1);
  assert.equal(f.state.admits, 1);
  f.outboxRaw.exec("UPDATE relay_outbox SET next_retry_at=0");
  f.reopen();
  await once(f);
  assert.equal(f.queued().length, 1);
  assert.equal(f.state.admits, 1);
  assert.equal(f.outbox.get(reply.message_id).state, "accepted");
  assert.equal(
    f.service.poll(f.contexts.a).message.message_id,
    reply.message_id,
  );
});

test("recipient owner: unsettled host drain retains ownership and does not start more work", async (t) => {
  const f = await fixture(t);
  let now = 0,
    calls = 0;
  const host = {
    status: () => ({
      paused: false,
      epoch: 1,
      running: false,
      draining: 1,
      owner: "held",
    }),
    stepOnce: async () => {
      calls++;
      throw Error("must not run");
    },
  };
  const supervisor = new RecipientSupervisor({ ...f.port, host }, policy, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  const result = await supervisor.run(new AbortController().signal);
  assert.equal(result.reason, "drain_timeout");
  assert.equal(result.drained, false);
  assert.equal(calls, 0);
  assert.equal(f.host.status(f.hostContext).owner, "held");
});

test("recipient owner: inbound polling outage does not starve an already confirmed reply", async (t) => {
  const f = await fixture(t);
  const { key } = await f.receive();
  await f.driver.handoffOnce(f.context, key);
  const reply = f.answer(key);
  f.allowByPolicy(reply);
  f.resume(f.host);
  f.hostState.afterNetwork = async (tool) => {
    if (tool === "relay_poll") throw Error("poll unavailable");
  };
  const result = await once(f);
  assert.equal(result.reason, "stopped");
  assert.equal(result.recipient_steps, 1);
  assert.equal(f.outbox.get(reply.message_id).state, "accepted");
  assert.equal(f.state.admits, 1);
});

test("recipient owner: native error codes cannot leak content through state metadata", async (t) => {
  const f = await fixture(t);
  const { key } = await f.receive();
  await f.driver.handoffOnce(f.context, key);
  f.allowByPolicy(f.answer(key));
  f.resume(f.host);
  await once(f, {
    messages: {
      ...f.port.messages,
      recipient: {
        ...f.port.messages.recipient,
        withReply() {
          throw new RecipientMessageError("private native diagnostic or token");
        },
      },
    },
  });
  assert.equal(f.states.at(-1).reason, "recipient_unavailable");
  assert.equal(JSON.stringify(f.states).includes("private native"), false);
  assert.equal(f.queued().length, 0);
});

test("recipient owner: consumed handoff permission does not revoke separate inspect/reply authority", async (t) => {
  const f = await fixture(t);
  f.resume(f.host);
  const { key } = f.submit();
  await once(f);
  f.state.denied.add("handoff");
  const reply = f.answer(key);
  f.allowByPolicy(reply);
  await once(f);
  assert.equal(f.state.admits, 1);
  assert.equal(f.outbox.get(reply.message_id).state, "accepted");
});
