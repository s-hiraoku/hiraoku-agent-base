import test from "node:test";
import assert from "node:assert/strict";
import { groupFixture } from "./hab-group-fixtures.js";
import { code } from "./hab-registry-fixtures.js";
import { setup } from "./hab-http-fixtures.js";
import {
  policy,
  limits,
  message,
  call,
  request,
  decode,
} from "./relay-http-fixtures.js";
import { HabHttpGateway } from "../src/hab/http.ts";
import { RelayHttpGateway } from "../src/relay/http.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { DurableSender, DurableReceiver } from "../src/relay/index.ts";
import { WriterAdmission } from "../src/relay/writer-admission.ts";
import { habWriterIdentity } from "../src/hab/writer-admission.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

function direct(t, admission = false) {
  const f = groupFixture(t);
  const queue = admission
    ? new WriterAdmission(
        {
          max_individuals: 4,
          max_waiting_per_individual: 4,
          requests_per_window: 50,
          window_ms: 60000,
          max_wait_ms: 1000,
        },
        habWriterIdentity(f.registry),
      )
    : undefined;
  if (queue) t.after(() => queue.close());
  return {
    ...f,
    gateway: new HabHttpGateway(f.hab, policy, f.audit, f.verifier, queue),
  };
}

test("HAB discovers exactly five tools with the optional address selector; core Relay stays independent", async (t) => {
  const f = direct(t);
  const listed = await decode(await f.gateway.fetch(request("tools/list")));
  assert.equal(listed.result.tools.length, 5);
  for (const tool of listed.result.tools) {
    assert.ok(tool.inputSchema.properties.as_address);
    assert.ok(!(tool.inputSchema.required ?? []).includes("as_address"));
  }
  const core = new RelayHttpGateway(f.service, policy, f.audit, f.verifier);
  const coreList = await decode(await core.fetch(request("tools/list")));
  assert.equal(coreList.result.tools.length, 4);
  for (const tool of coreList.result.tools)
    assert.ok(!tool.inputSchema.properties.as_address);
});

test("one authenticated group selects two sender names over standard MCP", async (t) => {
  const f = direct(t);
  for (const [index, agent] of [f.first, f.second].entries()) {
    const resolved = await call(f.gateway, "relay_resolve", {
      as_address: agent.address,
      address: f.external.address,
    });
    assert.equal(
      resolved.body.result.structuredContent.recipient_id,
      f.external.agent_id,
    );
    const input = {
      ...message(String(index + 1).repeat(32)),
      recipient_id: f.external.agent_id,
      as_address: agent.address,
    };
    const sent = await call(f.gateway, "relay_submit", input);
    assert.equal(sent.body.result.structuredContent.sender_id, agent.agent_id);
    const status = await call(f.gateway, "relay_status", {
      as_address: agent.address,
      message_id: input.message_id,
    });
    assert.equal(
      status.body.result.structuredContent.sender_id,
      agent.agent_id,
    );
  }
});

test("all five MCP operations refuse foreign local names and do not infer identity from extra fields", async (t) => {
  const f = direct(t);
  const args = {
    relay_resolve: { address: f.first.address },
    relay_submit: { ...message(), recipient_id: f.first.agent_id },
    relay_status: { message_id: message().message_id },
    relay_poll: {},
    relay_ack: {
      sender_id: f.external.agent_id,
      message_id: message().message_id,
      generation: 1,
      lease_token: "a".repeat(43),
      request_id: "synthetic-ack",
    },
  };
  for (const [tool, input] of Object.entries(args)) {
    const foreign = await call(f.gateway, tool, {
      ...input,
      as_address: f.external.address,
    });
    assert.equal(foreign.body.result.isError, true, tool);
    assert.equal(
      foreign.body.result.structuredContent.error,
      "forbidden",
      tool,
    );
    const mismatch = await call(f.gateway, tool, {
      ...input,
      as_address: f.first.address,
      expected_agent_id: f.external.agent_id,
    });
    assert.equal(
      mismatch.body.result.structuredContent.error,
      "forbidden",
      tool,
    );
    const impersonated = await call(f.gateway, tool, {
      ...input,
      as_address: f.first.address,
      group_id: f.group.group_id,
    });
    assert.ok(
      impersonated.body.error || impersonated.body.result?.isError,
      tool,
    );
  }
  assert.equal(f.count(), 0);
  const unpaired = await call(f.gateway, "relay_poll", {
    expected_agent_id: f.first.agent_id,
  });
  assert.equal(unpaired.body.result.structuredContent.error, "invalid_request");
});

test("writer admission uses the validated selected member and rechecks group stop", async (t) => {
  const f = direct(t, true);
  const result = await call(f.gateway, "relay_poll", {
    as_address: f.second.address,
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.result.structuredContent, { delivery: null });
  f.access("stopped");
  const stopped = await call(f.gateway, "relay_poll", {
    as_address: f.second.address,
  });
  assert.equal(stopped.response.status, 403);
});

test("selector capability is fail-closed if a host only supplies the legacy service contract", async (t) => {
  const f = direct(t);
  const legacy = Object.fromEntries(
    ["submit", "status", "poll", "ack", "resolve"].map((op) => [
      op,
      f.hab[op].bind(f.hab),
    ]),
  );
  const gateway = new HabHttpGateway(legacy, policy, f.audit, f.verifier);
  const denied = await call(gateway, "relay_poll", {
    as_address: f.first.address,
  });
  assert.equal(denied.body.result.structuredContent.error, "forbidden");
  const old = await call(
    gateway,
    "relay_poll",
    {},
    { headers: { Authorization: "Bearer fixture-b" } },
  );
  assert.deepEqual(old.body.result.structuredContent, { delivery: null });
});

test(
  "native HTTP clients preserve their fixed address through durable send, reply, status and ACK",
  { timeout: 10000 },
  async (t) => {
    const f = groupFixture(t),
      net = await setup(t, f);
    const first = net.clients("a", f.first, globalThis.fetch, f.first.address);
    const second = net.clients(
      "a",
      f.second,
      globalThis.fetch,
      f.second.address,
    );
    const external = net.clients("b", f.external);
    const resolved = await first.resolve(f.external.address);
    const input = { ...message(), recipient_id: resolved.recipient_id };
    const sender = new DurableSender(net.outbox("group-first", f.first), first);
    const receiving = new DurableReceiver(
      net.inbox("legacy-external", f.external),
      external,
    );
    sender.enqueue(input);
    await sender.sendOnce();
    await receiving.receiveOnce();
    assert.equal(receiving.inbox()[0].receipt_confirmed, true);
    assert.equal((await first.status(input.message_id)).state, "acked");
    const reply = {
      ...message("2".repeat(32)),
      recipient_id: f.first.agent_id,
      kind: "answer",
      thread_id: input.thread_id,
      in_reply_to: {
        sender_id: f.first.agent_id,
        message_id: input.message_id,
      },
    };
    const replying = new DurableSender(
      net.outbox("legacy-external", f.external),
      external,
    );
    const inbox = net.inbox("group-first", f.first);
    const receiver = new DurableReceiver(inbox, first);
    replying.enqueue(reply);
    await replying.sendOnce();
    assert.equal(await second.poll(), null);
    await receiver.receiveOnce();
    assert.equal(receiver.inbox()[0].receipt_confirmed, true);
    assert.deepEqual(receiver.inbox()[0].message, reply);
    await assert.rejects(net.clients("a", f.first).poll(), code("forbidden"));
    await assert.rejects(
      net.clients("b", f.first, globalThis.fetch, f.first.address).poll(),
      code("forbidden"),
    );
    net.close(inbox);
    const reopened = new DurableReceiver(
      net.inbox("group-first", f.first),
      net.clients("a", f.first, globalThis.fetch, f.first.address),
    );
    assert.equal(reopened.inbox()[0].receipt_confirmed, true);
    assert.equal((await external.status(reply.message_id)).state, "acked");
  },
);

test(
  "client validates its expected immutable owner independently of the selected name",
  { timeout: 10000 },
  async (t) => {
    const f = groupFixture(t),
      net = await setup(t, f);
    const wrong = net.clients("a", f.second, globalThis.fetch, f.first.address);
    const input = { ...message(), recipient_id: f.external.agent_id };
    await assert.rejects(wrong.submit(input), code("forbidden"));
    const correct = net.clients(
      "a",
      f.first,
      globalThis.fetch,
      f.first.address,
    );
    assert.equal(f.count(), 0);
    await assert.rejects(correct.status(input.message_id), code("not_found"));
  },
);

test(
  "lost acceptance resumes the original outbox and selected name after registry and HTTP restart",
  { timeout: 10000 },
  async (t) => {
    const f = groupFixture(t),
      net = await setup(t, f),
      seen = [];
    let lost = false;
    const transport = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({
        name: body.params.name,
        address: body.params.arguments.as_address,
      });
      const response = await globalThis.fetch(url, init);
      if (body.params.name === "relay_submit" && !lost) {
        lost = true;
        await response.arrayBuffer();
        throw Error("synthetic lost acceptance");
      }
      return response;
    };
    const outbox = net.outbox("recover-selected", f.first);
    const before = new DurableSender(
      outbox,
      net.clients("a", f.first, transport, f.first.address),
    );
    const input = { ...message(), recipient_id: f.external.agent_id };
    before.enqueue(input);
    await assert.rejects(before.sendOnce(), code("sender_transport_failed"));
    assert.equal(f.count(), 1);
    const misconfigured = net.clients(
      "a",
      f.first,
      transport,
      f.second.address,
    );
    await assert.rejects(misconfigured.submit(input), code("forbidden"));
    assert.equal(f.count(), 1);
    net.close(outbox);
    const raw = new DatabaseSync(join(f.dir, "outbox-recover-selected.sqlite"));
    try {
      raw.exec("UPDATE relay_outbox SET next_retry_at=0");
    } finally {
      raw.close();
    }
    await net.stop();
    const registry = f.open();
    registry.migrate();
    await net.start(new HabRelayService(registry, f.store, limits));
    const after = new DurableSender(
      net.outbox("recover-selected", f.first),
      net.clients("a", f.first, transport, f.first.address),
    );
    await after.sendOnce();
    assert.equal(
      after.get(input.message_id).receipt.sender_id,
      f.first.agent_id,
    );
    assert.equal(f.count(), 1);
    assert.ok(seen.length >= 2);
    assert.equal(
      seen.filter((request) => request.address === f.second.address).length,
      1,
    );
    for (const request of seen.filter(
      (item) => item.address !== f.second.address,
    ))
      assert.equal(request.address, f.first.address);
  },
);

test("malformed address configuration fails before credential lookup or IO", () => {
  let called = false;
  assert.throws(
    () =>
      new HabMcpClient({
        as_address: "Wrong@bad.hab",
        limits,
        authorization: () => {
          called = true;
          return "Bearer fixture-a";
        },
      }),
  );
  assert.equal(called, false);
});
