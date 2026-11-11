import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { hostFixture, limits } from "./adapter-host-fixtures.js";
import { RecipientMessages } from "../src/recipient-messages/messages.ts";

// Synthetic native input/policy store. This is not a product model or approval API.
export async function fixture(t) {
  // These are policy/handoff tests, not short-lease expiry tests. The sending
  // lease must outlive the bounded RPC budget, including a loaded CI runner.
  const f = await hostFixture(t, {}, { outboxLeaseMs: 5000 }),
    path = join(f.dir, "synthetic-recipient.sqlite"),
    context = Symbol("recipient-caller"),
    owner = Symbol("recipient-owner"),
    binding = {
      agent_id: "b",
      owner_scope: "owner-b",
      runtime_id: "runtime-b",
      authority_epoch: "epoch-1",
    },
    state = {
      enabled: true,
      actor: "recipient-session",
      epoch: "epoch-1",
      denied: new Set(),
      admits: 0,
      inputs: [],
      refs: [],
      lost: false,
      afterInspect: null,
    };
  f.state.timeout_ms = 2000;
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE inputs(key TEXT PRIMARY KEY,hash TEXT NOT NULL,input TEXT NOT NULL,phase TEXT NOT NULL,reply TEXT,allowed INTEGER NOT NULL DEFAULT 0)",
  );
  t.after(() => db.close());
  const row = (ref) => {
    const v = db.prepare("SELECT * FROM inputs WHERE key=?").get(ref.key);
    if (v && v.hash !== ref.input_hash) throw Error("conflict");
    return v;
  };
  const receipt = (v) => ({ key: v.key, input_hash: v.hash, phase: v.phase });
  const port = {
    binding,
    async inspect(ref, check) {
      check();
      state.refs.push(ref);
      const v = row(ref);
      if (state.afterInspect) await state.afterInspect();
      check();
      return v ? receipt(v) : null;
    },
    async admit(input, check) {
      check();
      state.admits++;
      state.inputs.push(structuredClone(input));
      let v = row(input);
      if (!v) {
        check();
        db.prepare(
          "INSERT INTO inputs(key,hash,input,phase) VALUES(?,?,?,'accepted')",
        ).run(input.key, input.input_hash, JSON.stringify(input));
        v = row(input);
      }
      if (state.lost) throw Error("lost synthetic native response");
      check();
      return receipt(v);
    },
    withReply(ref, check, action) {
      const expected = row(ref)?.reply;
      const checkReply = () => {
        check();
        const v = row(ref);
        if (
          v?.phase !== "reply_ready" ||
          v.allowed !== 1 ||
          v.reply !== expected
        )
          throw Error("native_reply_not_authorized");
      };
      checkReply();
      return action(JSON.parse(row(ref).reply), checkReply);
    },
  };
  const authorize = (ctx, op) =>
    ctx === context && state.enabled && !state.denied.has(op)
      ? { agent_id: "b", actor_id: state.actor, authority_epoch: state.epoch }
      : undefined;
  const make = (patch = {}) =>
    new RecipientMessages({
      binding,
      inbox: f.inbox,
      outbox: f.outbox,
      budget: f.budget,
      limits,
      recipient: port,
      authorization: authorize,
      ...patch,
    });
  const driver = make();
  const receive = async (patch = {}, ack = true) => {
    const s = f.submit("question", patch);
    const delivery = f.service.poll(f.contexts.b);
    f.inbox.save(delivery);
    if (ack) {
      const req = f.inbox.claimAck();
      f.inbox.confirmAck(req, f.service.ack(f.contexts.b, req));
    }
    return s;
  };
  const decide = (phase, reply = null, principal = owner) => {
    assert.equal(principal, owner);
    db.prepare("UPDATE inputs SET phase=?,reply=?,allowed=?").run(
      phase,
      reply ? JSON.stringify(reply) : null,
      Number(phase === "reply_ready"),
    );
  };
  return {
    ...f,
    hostContext: f.context,
    hostState: f.state,
    context,
    owner,
    binding,
    state,
    port,
    make,
    driver,
    receive,
    decide,
    reopen() {
      db.close();
      db = new DatabaseSync(path);
    },
    nativeRows() {
      return db.prepare("SELECT * FROM inputs").all();
    },
    revokeReply() {
      db.exec("UPDATE inputs SET allowed=0");
    },
    allowByPolicy(reply) {
      db.prepare("UPDATE inputs SET phase='reply_ready',reply=?,allowed=1").run(
        JSON.stringify(reply),
      );
    },
  };
}
