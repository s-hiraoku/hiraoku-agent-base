import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hostFixture, deferred } from "./adapter-host-fixtures.js";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { createSingleSourceHost } from "../src/adapter-host/single-source-authority.ts";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { limits } from "./adapter-host-fixtures.js";

async function setup(t) {
  const f = await hostFixture(t);
  const { key } = f.submit();
  const recipient = {}, operator = {};
  const journal = new SQLiteAnswerJournal(join(f.dir, "single-source-answers.sqlite"), {
    agent_id: "b", fingerprint_key: new Uint8Array(32).fill(70), limits,
    max_records: 50, max_body_bytes: 1000000, max_clock_skew_ms: 1000,
  });
  journal.migrate(); t.after(() => journal.close());
  const owner = new SQLiteHostOwner(join(f.dir, "single-source-owner.sqlite"), {
    agent_id: "b", fingerprint_key: new Uint8Array(32).fill(71),
  });
  owner.migrate(); owner.acquire(() => {}); t.after(() => owner.close());
  const inputSource = { ...key };
  const options = { hostOptions: f.hostOptions({ owner, answer_intents: journal }),
    actorId: "synthetic-owner", verifiedRecipientContext: recipient,
    verifiedOperatorContext: operator, source: inputSource };
  const policy = createSingleSourceHost(options);
  const { host } = policy;
  const update = (allow) => policy.updateWhilePaused(operator, host.status(operator).epoch, allow);
  const resume = () => host.setPaused(operator, false, host.status(operator).epoch);
  const step = (command) => host.stepOnce(recipient, command);
  return { f, key, recipient, operator, policy, host, update, resume, step, owner, options, inputSource };
}

test("single-source owner policy defaults deny and cannot be changed by recipient", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.step({ op: "receive" }), /host_forbidden/);
  assert.throws(() => s.policy.updateWhilePaused(s.recipient, 0, true), /policy_denied/);
  s.update(true);
  assert.equal(s.host.status(s.operator).paused, true);
  await assert.rejects(s.step({ op: "receive" }), /host_paused/);
  s.resume(); await s.step({ op: "receive" });
  assert.equal((await s.step({ op: "inbox_read", source: s.key })).state, "done");
  await assert.rejects(s.step({ op: "inbox_read", source: { ...s.key, message_id: "other" } }), /host_forbidden/);
  await assert.rejects(s.step({ op: "message_enqueue", message: {} }), /host_forbidden/);
  assert.throws(() => s.host.setPaused(s.recipient, true, 1), /host_forbidden/);
  assert.throws(() => s.policy.revokePermanently(s.recipient), /policy_denied/);
  assert.equal((await s.step({ op: "inbox_read", source: s.key })).state, "done");
  s.policy.revokePermanently(s.operator);
  s.policy.revokePermanently(s.operator); // Repeated shutdown cannot restore authority.
  await assert.rejects(s.step({ op: "inbox_read", source: s.key }), /host_forbidden/);
  await assert.rejects(s.step({ op: "send" }), /host_forbidden/);
  assert.throws(() => s.update(true), /authority_revoked/);
});

test("source revocation also denies whole dedicated outbox send until explicit regrant", async (t) => {
  const s = await setup(t); s.update(true); s.resume(); await s.step({ op: "receive" });
  await s.step({ op: "answer_prepare", source: s.key, body: { parts: [{ type: "text", text: "fixed synthetic reply" }] } });
  await s.step({ op: "answer_enqueue", source: s.key });
  assert.equal(s.f.queued().length, 1);
  const oldEpoch = s.host.status(s.operator).epoch;
  s.update(false);
  assert.throws(() => s.policy.updateWhilePaused(s.operator, oldEpoch, true));
  s.resume();
  await assert.rejects(s.step({ op: "send" }), /host_forbidden/);
  assert.equal(s.f.queued().length, 1);
  s.update(true); s.resume();
  assert.equal((await s.step({ op: "send" })).state, "done");
  assert.equal(s.f.queued().length, 1); // Same persisted intent, not a replacement ID.
});

test("policy update pauses but refuses pending RPC; old epoch cannot borrow regrant", async (t) => {
  const s = await setup(t); s.update(true); s.resume();
  const entered = deferred(), release = deferred();
  s.f.state.afterNetwork = async () => { entered.resolve(); await release.promise; };
  const pending = s.step({ op: "receive" }); await entered.promise;
  assert.throws(() => s.update(false), /not_drained/);
  assert.equal(s.host.status(s.operator).paused, true);
  release.resolve();
  assert.equal((await pending).state, "incomplete");
  s.f.state.afterNetwork = null;
  s.update(false); s.update(true); s.resume();
  assert.equal(s.f.queued().length, 0);
  assert.equal((await s.step({ op: "receive" })).state, "done");
});


test("composition hides authorization and rejects missing/lost owner and context misbinding", async (t) => {
  const s = await setup(t);
  assert.equal("authorization" in s.policy, false);
  assert.equal("bind" in s.policy, false);
  assert.throws(() => createSingleSourceHost({ ...s.options,
    hostOptions: { ...s.options.hostOptions, owner: undefined } }), /paused_owned/);
  assert.throws(() => createSingleSourceHost({ ...s.options,
    verifiedRecipientContext: s.operator }), /invalid_single_source/);
  assert.throws(() => createSingleSourceHost(s.options), /already_attached/);
  assert.throws(() => s.policy.updateWhilePaused({}, 0, true), /policy_denied/);
  s.inputSource.message_id = "changed-after-construction";
  s.update(true); s.resume(); await s.step({ op: "receive" });
  assert.equal((await s.step({ op: "inbox_read", source: s.key })).state, "done");
  await assert.rejects(s.step({ op: "inbox_read", source: s.inputSource }), /host_forbidden/);
  s.update(false);
  s.owner.close();
  assert.equal(s.host.status(s.operator).owner, "lost");
  assert.throws(() => s.update(true), /not_drained/);
  await assert.rejects(s.step({ op: "send" }), /host_forbidden/);
});

test("policy fence refuses settled command with credential work still draining", async (t) => {
  const s = await setup(t); s.update(true); s.resume();
  const wait = deferred();
  s.f.state.timeout_ms = 30;
  s.f.state.credential = () => wait.promise;
  assert.equal((await s.step({ op: "receive" })).state, "incomplete");
  const status = s.host.status(s.operator);
  assert.equal(status.running, false); assert.equal(status.draining, 1);
  assert.throws(() => s.update(false), /not_drained/);
  assert.equal(s.host.status(s.operator).paused, true);
  wait.resolve("Bearer fixture-b");
  for (let i = 0; i < 100 && s.host.status(s.operator).draining; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.host.status(s.operator).draining, 0);
  assert.equal(s.f.state.tools.length, 0);
  s.update(false); s.resume();
  await assert.rejects(s.step({ op: "send" }), /host_forbidden/);
});
