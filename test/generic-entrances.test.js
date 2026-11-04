import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskState } from "@a2a-js/sdk";
import { GENERIC_TEXT_PROFILE } from "../src/generic-jobs.ts";
import {
  openGenericEntranceFixture,
  a2aRequest,
  unpack,
} from "./generic-entrance-fixture.js";

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return unpack(result);
};
function publicOnly(value) {
  const text = JSON.stringify(value);
  for (const hidden of [
    "ownerScope",
    "ownerClient",
    "runnerScope",
    "run_id",
    "text_request",
    "fingerprint",
    "trusted-conversation",
    "synthetic-sender-client",
  ])
    assert.equal(text.includes(hidden), false, hidden);
}

test("official A2A and MCP clients share two real jobs and reversed results on one host", async (t) => {
  const f = await openGenericEntranceFixture();
  t.after(() => f.close());
  const a = await f.a2a(),
    b = await f.a2a("mirror");
  const m = await f.mcp(),
    n = await f.mcp("mirror");
  const first = await a.client.sendMessage(
    a2aRequest(f.input("a2a-first", "first")),
    a.options,
  );
  const second = await call(n, "text_submit", f.input("mcp-second", "second"));
  assert.equal((await call(m, "text_get", { id: first.id })).id, first.id);
  assert.equal(
    (await b.client.getTask({ id: second.id }, b.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  await f.execute("mirror");
  await f.execute("paper");
  const firstResult = await call(m, "text_get", { id: first.id });
  const secondResult = await b.client.getTask({ id: second.id }, b.options);
  assert.equal(firstResult.result.text, "paper:first");
  assert.equal(
    secondResult.artifacts[0].parts[0].content.value,
    "mirror:SECOND",
  );
  assert.equal(firstResult.sourceMessageId, "a2a-first");
  assert.equal(secondResult.contextId, "context-mcp-second");
  const list = await call(m, "text_list", {});
  assert.equal(list.totalSize, 1);
  assert.equal(list.jobs[0].result, undefined);
  publicOnly(firstResult);
  publicOnly(secondResult);
  publicOnly(list);
});

test("cross-protocol retry after committed response loss and host restart keeps one Task", async (t) => {
  const f = await openGenericEntranceFixture();
  t.after(() => f.close());
  const a = await f.a2a(),
    m = await f.mcp(),
    input = f.input("lost-response");
  f.state.failAfterSubmit = true;
  await assert.rejects(a.client.sendMessage(a2aRequest(input), a.options));
  assert.equal(
    f.hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
    1,
  );
  const task = await call(m, "text_submit", input);
  assert.equal((await f.execute()).admissions, 1);
  await f.restart();
  const restored = await a.client.getTask({ id: task.id }, a.options);
  assert.equal(restored.artifacts[0].parts[0].content.value, "paper:hello");
  assert.equal((await call(m, "text_submit", input)).id, task.id);
  assert.equal(
    f.hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
    1,
  );
  publicOnly(restored);
});

test("cross-protocol identity is the verified client binding, with no human-owner alias", async (t) => {
  const f = await openGenericEntranceFixture();
  t.after(() => f.close());
  const a = await f.a2a(),
    m = await f.mcp();
  const task = await call(m, "text_submit", f.input("scoped-task"));
  for (const token of ["other-client", "other-owner", "mirror"]) {
    const other = await f.a2a(token),
      client = await f.mcp(token);
    await assert.rejects(other.client.getTask({ id: task.id }, other.options));
    assert.equal(
      (await client.callTool({ name: "text_get", arguments: { id: task.id } }))
        .isError,
      true,
    );
    assert.equal((await call(client, "text_list", {})).totalSize, 0);
  }
  f.state.revoked = true;
  await assert.rejects(a.client.getTask({ id: task.id }, a.options));
  await assert.rejects(
    m.callTool({ name: "text_get", arguments: { id: task.id } }),
  );
});

test("queued and active cancellation expose confirmed stop only after trusted evidence", async (t) => {
  const f = await openGenericEntranceFixture();
  t.after(() => f.close());
  const a = await f.a2a(),
    m = await f.mcp();
  const queued = await call(m, "text_submit", f.input("queued-cancel"));
  assert.equal(
    (await call(m, "text_cancel", { id: queued.id })).cancellationConfirmed,
    true,
  );
  assert.equal(
    (await a.client.getTask({ id: queued.id }, a.options)).status.state,
    TaskState.TASK_STATE_CANCELED,
  );
  const running = await call(m, "text_submit", f.input("active-cancel"));
  await f.execute("paper", "running");
  const requested = await a.client.cancelTask({ id: running.id }, a.options);
  assert.equal(requested.status.state, TaskState.TASK_STATE_WORKING);
  assert.equal(
    requested.metadata[GENERIC_TEXT_PROFILE].cancellationConfirmed,
    false,
  );
  const pending = await call(m, "text_get", { id: running.id });
  assert.equal(pending.outcome, "unknown");
  await f.confirmCancellation(running.id);
  const confirmed = await a.client.getTask({ id: running.id }, a.options);
  assert.equal(confirmed.status.state, TaskState.TASK_STATE_CANCELED);
  assert.deepEqual(confirmed.artifacts, []);
});

test("lease loss remains execution reconciliation on both protocols and grants no approval", async (t) => {
  const f = await openGenericEntranceFixture();
  t.after(() => f.close());
  const a = await f.a2a(),
    m = await f.mcp();
  const task = await call(m, "text_submit", f.input("lease-loss"));
  await f.hub.claim(f.paper.worker, {}, { textRetentionMs: 86400000 });
  f.state.now += 31000;
  assert.equal(
    await f.hub.claim(f.paper.worker, {}, { textRetentionMs: 86400000 }),
    null,
  );
  const view = await call(m, "text_get", { id: task.id });
  assert.equal(view.state, "working");
  assert.equal(view.waitReason, "execution_reconciliation");
  const native = await a.client.getTask({ id: task.id }, a.options);
  assert.equal(native.status.state, TaskState.TASK_STATE_WORKING);
  assert.equal(native.metadata[GENERIC_TEXT_PROFILE].outcome, "unknown");
  const tools = await m.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "text_cancel",
    "text_get",
    "text_list",
    "text_submit",
  ]);
});
