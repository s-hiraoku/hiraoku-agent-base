import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { HAB_A2A_LIMITS } from "../src/a2a/hab-contract.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";

const options = {
  agent_id: "host",
  fingerprint_key: new Uint8Array(32).fill(43),
  limits: HAB_A2A_LIMITS,
  max_records: 200,
  max_body_bytes: 200 * 16384,
  max_ack_records: 300,
  ack_retry_ms: 86400000,
  retry_base_ms: 1000,
  retry_cap_ms: 60000,
  max_attempts: 5,
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-inbox-source-"));
  const path = join(dir, "inbox.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // The migration/reopen test closes its first connection itself.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const store = new SQLiteInbox(path, options);
    stores.push(store);
    store.migrate();
    return store;
  };
  const store = open();
  return { store, path, open };
}
function save(
  store,
  n,
  source = { sender_id: "host", message_id: `source-${n}` },
) {
  const at = Date.now() - 100;
  const first = new Date(at).toISOString();
  const message = {
    version: 1,
    sender_id: "recipient",
    message_id: makeReplayBoundMessageId(
      first,
      n.toString(16).padStart(32, "0"),
    ),
    recipient_id: "host",
    kind: "execution_result",
    thread_id: `thread-${n}`,
    in_reply_to: source,
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
    body: {
      parts: [
        {
          type: "data",
          schema_id: "task.execution_result",
          schema_version: 1,
          value: {
            task_type: "connectivity_check",
            task_id: `task-${n}`,
            state: "succeeded",
            result: "x".repeat(256),
          },
        },
      ],
    },
  };
  store.save({
    message,
    generation: 1,
    lease_token: "x".repeat(43),
    lease_until: new Date(Date.now() + 30000).toISOString(),
  });
  return message;
}

test("inbox source reads preserve pending replies and ordering, and exclude other source pairs and released bodies", (t) => {
  const { store } = fixture(t);
  const source = { sender_id: "host", message_id: "source-1" };
  save(store, 1, source);
  const request = store.claimAck();
  store.confirmAck(request, {
    recipient_id: "host",
    sender_id: request.sender_id,
    message_id: request.message_id,
    request_id: request.request_id,
    receipt_id: "receipt-source-test",
    acked_at: new Date().toISOString(),
    state: "acked",
  });
  save(store, 2, source);
  save(store, 3, { ...source, sender_id: "other-host" });
  save(store, 4, { ...source, message_id: "other-source" });
  save(store, 5, null);
  const released = save(store, 6, source);
  store.releaseBody("recipient", released.message_id);
  const all = store.inbox();
  const expected = all.filter(
    (entry) =>
      entry.message.in_reply_to?.sender_id === source.sender_id &&
      entry.message.in_reply_to.message_id === source.message_id,
  );
  assert.equal(all.length, 5);
  assert.equal(expected.length, 2);
  assert.deepEqual(store.inbox(source), expected);
  assert.deepEqual(
    expected.map((entry) => entry.receipt_confirmed),
    [true, false],
  );
  assert.deepEqual(store.inbox({ ...source, message_id: "missing" }), []);
  assert.throws(() => store.inbox({ ...source, message_id: "" }), {
    code: "invalid_request",
  });
});

test("source index is added to an existing schema-4 inbox and remains usable after body release and reopen", (t) => {
  const { store, path, open } = fixture(t);
  const source = { sender_id: "host", message_id: "source-1" };
  save(store, 1, source);
  const released = save(store, 2, source);
  store.releaseBody("recipient", released.message_id);
  store.close();
  const old = new DatabaseSync(path);
  old.exec("DROP INDEX IF EXISTS inbox_reply_source");
  assert.equal(
    old.prepare("SELECT version FROM inbox_meta").get().version,
    4,
  );
  old.close();
  const reopened = open();
  assert.equal(reopened.inbox(source).length, 1);
  reopened.migrate();
  const raw = new DatabaseSync(path);
  try {
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT sender_id,body,received_at,receipt_confirmed
      FROM inbox WHERE released_at IS NULL
      AND json_extract(body,'$.in_reply_to.sender_id')=?
      AND json_extract(body,'$.in_reply_to.message_id')=?
      ORDER BY received_at,sender_id,message_id`,
      )
      .all(source.sender_id, source.message_id);
    assert.ok(
      plan.some((row) =>
        /SEARCH inbox USING INDEX inbox_reply_source/.test(
          row.detail,
        ),
      ),
    );
    assert.ok(
      plan.every((row) => !/TEMP B-TREE|SCAN inbox/.test(row.detail)),
    );
  } finally {
    raw.close();
  }
});

test("64 source observations parse only their matching bodies in a 200-reply backlog", (t) => {
  const { store } = fixture(t);
  for (let n = 0; n < 200; n++) save(store, n);
  const parse = JSON.parse;
  let parsed = 0;
  const start = performance.now();
  JSON.parse = (...args) => {
    parsed++;
    return parse(...args);
  };
  try {
    for (let n = 0; n < 64; n++) {
      const source = { sender_id: "host", message_id: `source-${n}` };
      const matches = store
        .inbox(source)
        .filter(
          (entry) =>
            entry.message.in_reply_to?.sender_id === source.sender_id &&
            entry.message.in_reply_to.message_id === source.message_id,
        );
      assert.equal(matches.length, 1);
    }
  } finally {
    JSON.parse = parse;
  }
  t.diagnostic(
    `200 unreleased 256-character results, 64 observations: ${parsed} body parses in ${(performance.now() - start).toFixed(2)} ms; timing is informational, not a production latency bound`,
  );
  assert.equal(parsed, 64);
});
