import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { groupFixture } from "./hab-group-fixtures.js";
import { SQLiteOutbox } from "../src/agent-sdk/sqlite-outbox.ts";
import { createHabRelayRoute } from "../src/a2a/hab-route.ts";
import { message, limits } from "./relay-http-fixtures.js";

async function setup(t) {
  const f = await groupFixture(t, {
    allowed_kinds: [
      "execution_request",
      "execution_accepted",
      "execution_result",
    ],
  });
  const outbox = new SQLiteOutbox(join(f.dir, "a2a-outbox.sqlite"), {
    agent_id: f.first.agent_id,
    fingerprint_key: new Uint8Array(32).fill(21),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 1000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  });
  outbox.migrate();
  t.after(() => outbox.close());
  const evidence = {
    binding: {
      engine_id: "synthetic-engine",
      owner_subject: "synthetic-owner",
      client_id: null,
    },
    verify: async () => {
      throw Error("not requested");
    },
  };
  const options = {
    registry: f.registry,
    context: f.contexts.a,
    sender: f.first,
    recipient: f.external,
    outbox,
    senderTransport: { sendOnce: async () => {} },
    inbox: { inbox: () => [] },
    evidence,
  };
  const route = createHabRelayRoute(options);
  const input = {
    ...message(),
    recipient_id: f.external.agent_id,
    kind: "execution_request",
    body: {
      parts: [
        {
          type: "data",
          schema_id: "task.execution_request",
          schema_version: 1,
          value: { task_type: "connectivity_check" },
        },
      ],
    },
  };
  return { ...f, outbox, route, options, input };
}

test("HAB A2A route uses current group membership and immutable sender ID under enqueue guard", async (t) => {
  const f = await setup(t);
  assert.equal(f.route.ownerId, f.first.agent_id);
  const queued = f.route.enqueue(f.input);
  assert.equal(queued.state, "queued");
  assert.equal(
    f.route.delivery(f.input.message_id).message_id,
    f.input.message_id,
  );
  assert.throws(
    () => createHabRelayRoute({ ...f.options, context: f.contexts.b }),
    /forbidden/,
  );
  assert.throws(
    () => createHabRelayRoute({ ...f.options, sender: f.second }),
    /forbidden/,
  );
  assert.throws(
    () => f.route.enqueue({ ...f.input, recipient_id: f.second.agent_id }),
    /forbidden/,
  );
  f.access("stopped");
  assert.throws(() => f.route.assertCurrent(), /forbidden/);
  assert.throws(() => f.route.delivery(f.input.message_id), /forbidden/);
});

test("HAB A2A route rechecks current authorization after asynchronous sender work", async (t) => {
  const f = await setup(t);
  const route = createHabRelayRoute({
    ...f.options,
    senderTransport: {
      sendOnce: async () => {
        f.access("stopped");
      },
    },
  });
  await assert.rejects(() => route.flush(), /forbidden/);
});

test("HAB A2A route recipient mapping cannot silently move to another identity", async (t) => {
  const f = await setup(t);
  assert.throws(
    () =>
      createHabRelayRoute({
        ...f.options,
        recipient: { ...f.external, agent_id: f.second.agent_id },
      }),
    /forbidden/,
  );
});

test("HAB A2A route snapshots its configured identities before later host-object mutations", async (t) => {
  const f = await setup(t);
  const recipientId = f.external.agent_id;
  f.options.recipient.agent_id = f.second.agent_id;
  f.options.recipient.address = f.second.address;
  const queued = f.route.enqueue(f.input);
  assert.equal(queued.recipient_id, recipientId);
  assert.equal(f.route.recipientId, recipientId);
});
