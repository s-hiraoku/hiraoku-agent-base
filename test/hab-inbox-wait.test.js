import assert from "node:assert/strict";
import { test } from "node:test";
import { HabHttpGateway } from "../src/hab/http.ts";
import { InboxArrivals } from "../src/hab/inbox-wait.ts";
import { HAB_AGENT_INSTRUCTIONS } from "../src/hab/agent-tools.ts";
import { fixture } from "./hab-registry-fixtures.js";
import { policy, request, decode } from "./mcp-http-fixtures.js";

// hab_inbox's wait (ADR-028): with wait_secs and no new mail, the host holds the call until
// mail for that agent is accepted or the granted time is up, then reads as usual.
async function setup(t, patch = {}) {
  const f = await fixture(t);
  const a = f.enroll("a"),
    b = f.enroll("b");
  const audit = { record() {}, note() {} };
  const agent = new HabHttpGateway(
    f.hab,
    { ...policy, max_wait_ms: 3000, ...patch },
    audit,
    f.verifier,
    undefined,
    "agent",
  );
  const call = async (who, name, args = {}) => {
    const response = await agent.fetch(
      request(
        "tools/call",
        { name, arguments: args },
        { headers: { Authorization: `Bearer fixture-${who}` } },
      ),
    );
    return { status: response.status, body: await decode(response) };
  };
  const ok = async (...args) => {
    const { body } = await call(...args);
    assert.equal(body.error, undefined);
    assert.notEqual(body.result.isError, true, JSON.stringify(body.result));
    return body.result.structuredContent;
  };
  return { ...f, a, b, agent, call, ok };
}

test("a waiting hab_inbox returns as soon as mail for that agent arrives", async (t) => {
  const f = await setup(t);
  const started = Date.now();
  const waiting = f.ok("b", "hab_inbox", { wait_secs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sent = await f.ok("a", "hab_send", { to: f.b.address, text: "hi" });
  const inbox = await waiting;
  const took = Date.now() - started;
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].message_id, sent.message_id);
  assert.ok(took >= 250 && took < 2500, `took ${took}ms`);
  assert.equal(typeof inbox.waited_secs, "number");
  // It was read through the normal path: a second read finds nothing new.
  assert.equal((await f.ok("b", "hab_inbox")).messages.length, 0);
});

test("unread mail is returned at once without waiting", async (t) => {
  const f = await setup(t);
  await f.ok("a", "hab_send", { to: f.b.address, text: "already here" });
  const started = Date.now();
  const inbox = await f.ok("b", "hab_inbox", { wait_secs: 10 });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.waited_secs, 0);
  assert.ok(Date.now() - started < 1000);
});

test("mail for another agent does not end the wait, and the host caps the time", async (t) => {
  const f = await setup(t, { max_wait_ms: 1200 });
  const c = f.enroll("c");
  const started = Date.now();
  const waiting = f.ok("b", "hab_inbox", { wait_secs: 60 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await f.ok("a", "hab_send", { to: c.address, text: "not for b" });
  const inbox = await waiting;
  const took = Date.now() - started;
  assert.deepEqual(inbox.messages, []);
  assert.ok(took >= 1100 && took < 2500, `took ${took}ms`);
  assert.equal(inbox.waited_secs, 1);
  assert.match(inbox.explanation, /No new messages/);
});

test("without max_wait_ms the host does not wait", async (t) => {
  const f = await setup(t, { max_wait_ms: undefined });
  const started = Date.now();
  const inbox = await f.ok("b", "hab_inbox", { wait_secs: 30 });
  assert.deepEqual(inbox.messages, []);
  assert.equal(inbox.waited_secs, 0);
  assert.ok(Date.now() - started < 1000);
});

test("a newer wait for the same agent ends the older one", async (t) => {
  const f = await setup(t);
  const first = f.ok("b", "hab_inbox", { wait_secs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = f.ok("b", "hab_inbox", { wait_secs: 10 });
  const older = await first;
  assert.deepEqual(older.messages, []);
  await f.ok("a", "hab_send", { to: f.b.address, text: "for the newer wait" });
  const newer = await second;
  assert.equal(newer.messages.length, 1);
});

test("holds leave room for other requests", async (t) => {
  const f = await setup(t, { max_active_requests: 3 });
  const c = f.enroll("c");
  // Two holds may run (max_active_requests - 1); a third waiting call answers at once.
  const one = f.ok("b", "hab_inbox", { wait_secs: 2 });
  const two = f.ok("c", "hab_inbox", { wait_secs: 2 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  const three = await f.ok("a", "hab_inbox", { wait_secs: 2 });
  assert.equal(three.waited_secs, 0);
  assert.ok(Date.now() - started < 1000);
  await Promise.all([one, two]);
  void c;
});

test("wait_secs is checked like any other argument", async (t) => {
  const f = await setup(t);
  for (const args of [
    { wait_secs: -1 },
    { wait_secs: 61 },
    { wait_secs: 1.5 },
    { wait_secs: 5, include_read: true },
    { wait_secs: 5, message_id: "m-1" },
  ]) {
    const { body } = await f.call("b", "hab_inbox", args);
    assert.equal(body.result.isError, true, JSON.stringify(args));
    assert.equal(body.result.structuredContent.error, "invalid_request");
    assert.equal(body.result.structuredContent.field, "wait_secs");
  }
  // 0 means no wait and is accepted with the other options.
  assert.deepEqual(
    (await f.ok("b", "hab_inbox", { wait_secs: 0, include_read: true }))
      .messages,
    [],
  );
});

test("the policy rejects an out-of-range max_wait_ms", async (t) => {
  const f = await fixture(t);
  for (const max_wait_ms of [-1, 60001, 1.5])
    assert.throws(
      () =>
        new HabHttpGateway(
          f.hab,
          { ...policy, max_wait_ms },
          { record() {}, note() {} },
          f.verifier,
          undefined,
          "agent",
        ),
      /invalid_mcp_http_policy/,
    );
});

test("the instructions tell agents to wait only when the user wants the answer now", () => {
  assert.match(HAB_AGENT_INSTRUCTIONS, /wait_secs/);
  assert.match(HAB_AGENT_INSTRUCTIONS, /only when your user wants the answer/);
});

test("InboxArrivals wakes one waiter per agent and ignores other agents", async () => {
  const hub = new InboxArrivals();
  const waiting = hub.wait("agent-b", 1000);
  hub.notify("agent-c");
  hub.notify("agent-b");
  assert.equal(await waiting, "arrived");
  assert.equal(hub.waiting, 0);
  const older = hub.wait("agent-b", 1000);
  const newer = hub.wait("agent-b", 50);
  assert.equal(await older, "superseded");
  assert.equal(await newer, "timeout");
  const abort = new AbortController();
  const aborted = hub.wait("agent-b", 1000, abort.signal);
  abort.abort();
  assert.equal(await aborted, "aborted");
  assert.equal(hub.waiting, 0);
});

test("at the hold limit a newer wait for the same agent still replaces the older one", async (t) => {
  const f = await setup(t, { max_active_requests: 2 });
  // One hold fills the limit (max_active_requests - 1).
  const first = f.ok("b", "hab_inbox", { wait_secs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = f.ok("b", "hab_inbox", { wait_secs: 10 });
  assert.deepEqual((await first).messages, []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await f.ok("a", "hab_send", { to: f.b.address, text: "to the newer wait" });
  const newer = await second;
  assert.equal(newer.messages.length, 1);
  assert.equal(newer.messages[0].text, "to the newer wait");
});

test("a superseded wait ends empty without reading mail meant for the newer wait", async (t) => {
  const f = await setup(t);
  const older = f.ok("b", "hab_inbox", { wait_secs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const newer = f.ok("b", "hab_inbox", { wait_secs: 10 });
  // Mail arrives in the same tick the older wait is superseded.
  const sending = f.ok("a", "hab_send", { to: f.b.address, text: "race" });
  const [o, , n] = await Promise.all([older, sending, newer]);
  assert.deepEqual(o.messages, []);
  assert.equal(n.messages.length, 1);
  assert.equal(n.messages[0].text, "race");
});
