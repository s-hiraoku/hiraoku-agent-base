import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hub } from "../src/sqlite.ts";
import { taskTypes } from "../src/task-contract.ts";
import { Adapter } from "../src/adapter.ts";
import {
  journal,
  owner as fixedOwner,
  submit as submitFixed,
} from "./fixtures.js";

const binding = {
  ownerScope: "owner-group-a",
  senderAgent: "synthetic-sender-a",
  recipientAgent: "synthetic-recipient-b",
  recipientOwner: "recipient-owner-b",
  conversationBinding: "host-conversation-a",
};
const sender = {
  subject: "request-owner",
  clientId: "sender-client",
  taskTypes: ["generic_text"],
  destination: binding.recipientAgent,
  textBinding: binding,
  operations: ["submit", "get", "cancel", "events"],
};
const worker = {
  subject: "receiver-service",
  clientId: "receiver-client",
  taskTypes: ["generic_text"],
  worker: binding.recipientAgent,
  runnerScope: "text-runtime-a",
  textBinding: binding,
  operations: ["claim", "get", "heartbeat", "complete", "reconcile"],
};
const input = (overrides = {}) => ({
  messageId: "message-a",
  contextId: "context-a",
  text: "External text, not an owner instruction.",
  workDeadline: 60000,
  ...overrides,
});
const runtime = (overrides = {}) => ({
  supportedTaskTypes: ["generic_text"],
  boundaryId: "text-runtime-a",
  admissionContract: "synthetic-text-v1",
  textBoundary: {
    version: 1,
    inputAuthority: "external_agent",
    effects: "none",
    automaticReply: false,
  },
  toolIsolationVerified: true,
  durableIdempotency: true,
  retentionMs: 100000,
  async create() {
    throw Error("fixed_prompt_must_not_receive_text");
  },
  async createText({ content, tools }) {
    assert.equal(content.origin, "external_agent");
    assert.deepEqual(tools, []);
    return { id: "run-a", state: "succeeded", text: `answer:${content.text}` };
  },
  async get(id) {
    return { id, state: "succeeded", text: "recovered answer" };
  },
  ...overrides,
});
function fixture(t, initial = 100) {
  let clock = initial;
  const h = new Hub(":memory:", () => clock);
  t.after(() => h.close());
  return {
    h,
    now: () => clock,
    set: (value) => {
      clock = value;
    },
  };
}

test("generic text persists exact correlation and results in the existing Task engine", async (t) => {
  const { h, now } = fixture(t);
  const accepted = await h.submitText(sender, input());
  assert.equal(accepted.state, "queued");
  assert.equal(accepted.text_request.acceptedAt, 100);
  assert.equal(accepted.text_request.input.contextId, "context-a");
  await new Adapter(h, worker, runtime(), journal(), { now }).once();
  const result = await h.get(sender, accepted);
  assert.equal(result.state, "succeeded");
  assert.equal(result.result, `answer:${input().text}`);
  assert.equal(
    result.text_request.binding.conversationBinding,
    binding.conversationBinding,
  );
  assert.equal((await h.pending(sender)).length, 1);
  assert.equal(await h.canNotify(sender.subject, accepted.id), false);
});

test("same scoped message is idempotent and every changed immutable field conflicts", async (t) => {
  const { h } = fixture(t);
  const first = await h.submitText(sender, input());
  assert.equal((await h.submitText(sender, input())).id, first.id);
  for (const change of [
    { text: "changed" },
    { contextId: "changed" },
    { workDeadline: 61000 },
  ]) {
    await assert.rejects(
      h.submitText(sender, input(change)),
      /text_idempotency_conflict/,
    );
  }
  for (const change of [
    { recipientAgent: "different" },
    { conversationBinding: "different" },
    { recipientOwner: "different" },
  ]) {
    const b = { ...binding, ...change };
    await assert.rejects(
      h.submitText(
        { ...sender, destination: b.recipientAgent, textBinding: b },
        input(),
      ),
      /text_idempotency_conflict/,
    );
  }
  assert.equal(
    h.sqlite.db.prepare("SELECT count(*) AS n FROM tasks").get().n,
    1,
  );
});

test("body cannot supply policy, binding, tools or a host conversation", async (t) => {
  const { h } = fixture(t);
  for (const extra of [
    { owner: sender.subject },
    { textBinding: binding },
    { tools: [] },
    { conversationBinding: "external-session" },
    { approved: true },
  ]) {
    await assert.rejects(h.submitText(sender, { ...input(), ...extra }));
  }
  await assert.rejects(
    h.submitText({ ...sender, clientId: undefined }, input()),
    /text_binding_required/,
  );
  await assert.rejects(
    h.submitText(sender, input({ text: "界".repeat(10923) })),
  );
  assert.equal(
    h.sqlite.db.prepare("SELECT count(*) AS n FROM tasks").get().n,
    0,
  );
});

test("owner client, scope and agent binding guard reads, cancellation and event acknowledgement", async (t) => {
  const { h, now } = fixture(t);
  const accepted = await h.submitText(sender, input());
  await new Adapter(h, worker, runtime(), journal(), { now }).once();
  const event = (await h.pending(sender))[0];
  const alternatives = [
    { ...sender, clientId: "other-client" },
    { ...sender, textBinding: { ...binding, ownerScope: "other-scope" } },
    { ...sender, textBinding: { ...binding, senderAgent: "other-agent" } },
    { ...sender, textBinding: undefined },
  ];
  for (const p of alternatives) {
    await assert.rejects(h.get(p, accepted), /operation_rejected/);
    await assert.rejects(h.cancel(p, accepted), /operation_rejected/);
    assert.deepEqual(await h.pending(p), []);
    await h.ack(p, event.id);
    assert.equal((await h.pending(sender)).length, 1);
  }
  await h.ack(sender, event.id);
  assert.deepEqual(await h.pending(sender), []);
});

test("worker client and binding guard heartbeat, completion and reconciliation", async (t) => {
  const { h } = fixture(t);
  const accepted = await h.submitText(sender, input());
  const claimed = await h.claim(worker, {});
  assert.equal(claimed.id, accepted.id);
  for (const p of [
    { ...worker, clientId: "other-worker-client" },
    { ...worker, textBinding: { ...binding, recipientOwner: "other-owner" } },
  ]) {
    await assert.rejects(h.get(p, claimed), /operation_rejected/);
    await assert.rejects(h.heartbeat(p, claimed), /operation_rejected/);
    await assert.rejects(
      h.complete(p, { ...claimed, state: "succeeded", result: "forged" }),
      /operation_rejected/,
    );
    await assert.rejects(
      h.reconciliationTask(p, claimed.id),
      /operation_rejected/,
    );
  }
  await h.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: "valid",
  });
});

test("legacy submit and fixed runtime never receive generic text", async (t) => {
  assert.deepEqual(taskTypes, ["connectivity_check", "shift_log_inventory"]);
  const { h, now } = fixture(t);
  await assert.rejects(
    h.submit(sender, { task_type: "generic_text", request_key: "text" }),
    /invalid_request/,
  );
  await h.submitText(sender, input());
  await assert.rejects(
    new Adapter(h, worker, runtime({ createText: undefined }), journal(), {
      now,
    }).once(),
    /text_runner_boundary_unverified/,
  );
  assert.equal(
    (
      await h.get(sender, {
        id: h.sqlite.db.prepare("SELECT id FROM tasks").get().id,
      })
    ).state,
    "queued",
  );
  const fixed = await submitFixed(h);
  assert.equal(
    (await h.get(fixedOwner, fixed)).task_type,
    "connectivity_check",
  );
});

test("a verified allowlist may contain all three types and can claim the third type", async (t) => {
  const { h } = fixture(t);
  const b = { ...binding, recipientAgent: "hermes" };
  const accepted = await h.submitText(
    { ...sender, destination: "hermes", textBinding: b },
    input(),
  );
  const p = {
    ...worker,
    worker: "hermes",
    textBinding: b,
    taskTypes: ["connectivity_check", "shift_log_inventory", "generic_text"],
  };
  assert.equal((await h.claim(p)).id, accepted.id);
});

test("current revocation and stale authority epoch reject generic operations", async (t) => {
  const { h } = fixture(t);
  const epoch = await h.authorization.epoch();
  const captured = { ...sender, authorizationEpoch: epoch };
  await h.authorization.setStopped(
    { kind: "client", id: sender.clientId },
    true,
    epoch,
    "operator",
  );
  await assert.rejects(h.submitText(captured, input()));
  await h.authorization.setStopped(
    { kind: "client", id: sender.clientId },
    false,
    epoch + 1,
    "operator",
  );
  await assert.rejects(h.submitText(captured, input()));
  await h.submitText(sender, input());
});

test("queued work expires without executing and unknown admission cannot replay past work deadline", async (t) => {
  const { h, now, set } = fixture(t);
  await h.submitText(sender, input());
  set(60000);
  assert.equal(await h.claim(worker), null);
  set(100);
  const j = journal();
  const failing = runtime({
    async createText() {
      throw Error("response lost");
    },
  });
  await assert.rejects(
    new Adapter(h, worker, failing, j, { now }).once(),
    /response lost/,
  );
  set(60000);
  await assert.rejects(
    new Adapter(h, worker, failing, j, { now }).once(),
    /text_work_deadline_requires_reconciliation/,
  );
});

test("restored queued state cannot refresh the external idempotency horizon", async (t) => {
  const { h, now, set } = fixture(t);
  await h.submitText(sender, input({ workDeadline: 90000 }));
  set(50000);
  let created = 0;
  const runs = runtime({
    retentionMs: 10000,
    async createText() {
      created++;
      throw Error("must not execute");
    },
  });
  await assert.rejects(
    new Adapter(h, worker, runs, journal(), { now }).once(),
    /text_work_deadline_requires_reconciliation/,
  );
  assert.equal(created, 0);
});

test("new migration preserves previous tasks, audit, outbox and uniqueness", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "generic-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.db");
  const db = new DatabaseSync(path);
  db.function("hub_now", () => 100);
  db.exec("CREATE TABLE hub_migrations(id TEXT PRIMARY KEY)");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((n) => n.endsWith(".sql") && n < "0009")
    .sort();
  for (const name of migrations) {
    db.exec(
      readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8"),
    );
    db.prepare("INSERT INTO hub_migrations VALUES(?)").run(name);
  }
  db.exec(
    "INSERT INTO tasks(id,owner,destination,request_key,task_type,state,actor,at,mutation) VALUES('old','owner','hermes','old-key','connectivity_check','queued','owner',100,'first'); UPDATE tasks SET state='succeeded',mutation='done' WHERE id='old'",
  );
  const oldAudit = db.prepare("SELECT * FROM audit").all();
  const oldOutbox = db.prepare("SELECT * FROM outbox").all();
  db.close();
  const h = new Hub(path);
  try {
    assert.equal(
      h.sqlite.db.prepare("SELECT state FROM tasks WHERE id='old'").get().state,
      "succeeded",
    );
    assert.deepEqual(
      h.sqlite.db.prepare("SELECT * FROM audit").all(),
      oldAudit,
    );
    assert.deepEqual(
      h.sqlite.db.prepare("SELECT * FROM outbox").all(),
      oldOutbox,
    );
    assert.throws(
      () =>
        h.sqlite.db.exec(
          "INSERT INTO tasks(id,owner,destination,request_key,task_type,state,actor,at,mutation) VALUES('duplicate','owner','hermes','old-key','connectivity_check','queued','owner',100,'duplicate')",
        ),
      /UNIQUE/,
    );
  } finally {
    h.close();
  }
});
