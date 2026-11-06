import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeReplayBoundMessageId } from "../src/messaging/index.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { authorizedDelivery } from "./jetstream-delivery.js";

const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  parts: 8,
  json_depth: 20,
  json_nodes: 1000,
};
const script = new URL(
  "../scripts/relay-rollback-reconcile.mjs",
  import.meta.url,
).pathname;

function message(recipient) {
  const at = new Date(Date.now() - 100).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(at, randomUUID().replaceAll("-", "")),
    recipient_id: recipient,
    kind: "question",
    body: { parts: [{ type: "text", text: "rollback drill" }] },
    thread_id: "rollback-drill",
    in_reply_to: null,
    first_sent_at: at,
    expires_at: new Date(Date.parse(at) + 3600000).toISOString(),
  };
}
const copy = (from, to) => {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${to}'`);
  } finally {
    db.close();
  }
};

test("the rollback drill lists IDs incomplete at backup and ACK-lost saves as delivered, and unsaved ones by inbox evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { service, options } = await authorizedDelivery(t, {
    authorization: {
      authorize: (ctx) =>
        ["a", "b", "c", "e"].includes(ctx) ? { agent_id: ctx } : undefined,
    },
    limits,
    directory: dir,
    queue: {
      max_pending: 10,
      max_pending_per_recipient: 5,
      poll_scan_limit: 10,
      agent_capacity: undefined,
    },
  });
  const inboxes = {};
  for (const agent of ["b", "c"]) {
    inboxes[agent] = new SQLiteInbox(join(dir, `inbox-${agent}.sqlite`), {
      agent_id: agent,
      fingerprint_key: new Uint8Array(32).fill(44),
      limits,
      max_records: 10,
      max_body_bytes: 100000,
      max_ack_records: 30,
      ack_retry_ms: 86400000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_attempts: 5,
    });
    inboxes[agent].migrate();
    t.after(() => inboxes[agent].close());
  }
  const sent = (recipient) => {
    const m = message(recipient);
    service.submit("a", m);
    return m;
  };
  /** The recipient saves the delivery; `acked` says whether its ACK reached the relay. */
  const receive = async (recipient, m, acked) => {
    const delivery = await service.poll(recipient);
    assert.equal(delivery.message.message_id, m.message_id);
    inboxes[recipient].save(delivery);
    if (acked)
      service.ack(recipient, {
        sender_id: "a",
        message_id: m.message_id,
        generation: delivery.generation,
        lease_token: delivery.lease_token,
        request_id: randomUUID(),
      });
  };

  const finished = sent("b");
  await receive("b", finished, true);
  const inFlight = sent("b");
  const backup = join(dir, "backup-journal.sqlite");
  copy(options.journal_path, backup);

  await receive("b", inFlight, false);
  const acked = sent("c");
  await receive("c", acked, true);
  const ackLost = sent("c");
  await receive("c", ackLost, false);
  const unsaved = sent("c");
  const unknown = sent("e");

  const upgraded = join(dir, "upgraded-journal.sqlite");
  copy(options.journal_path, upgraded);
  const drained = new DatabaseSync(upgraded);
  // Draining waits out the one-hour expiry; the journal then marks unfinished rows expired.
  drained.exec(
    "UPDATE nats_messages SET state='expired' WHERE state IN ('staging','pending','leased','quarantined')",
  );
  drained.close();

  const out = JSON.parse(
    execFileSync(execPath, [
      script,
      "--upgraded-journal",
      upgraded,
      "--backup-journal",
      backup,
      "--inbox",
      join(dir, "inbox-b.sqlite"),
      "--inbox",
      join(dir, "inbox-c.sqlite"),
    ]).toString(),
  );
  const listed = Object.fromEntries(
    out.messages.map((row) => [row.message_id, row]),
  );
  const pick = (m) => {
    const { backup_state, final_state, recipient_record, action } =
      listed[m.message_id];
    return { backup_state, final_state, recipient_record, action };
  };
  assert.equal(listed[finished.message_id], undefined, "complete at backup");
  assert.deepEqual(pick(inFlight), {
    backup_state: "staging",
    final_state: "expired",
    recipient_record: "saved",
    action: "delivered",
  });
  assert.deepEqual(pick(acked), {
    backup_state: null,
    final_state: "acked",
    recipient_record: "saved",
    action: "delivered",
  });
  assert.deepEqual(pick(ackLost), {
    backup_state: null,
    final_state: "expired",
    recipient_record: "saved",
    action: "delivered",
  });
  assert.deepEqual(pick(unsaved), {
    backup_state: null,
    final_state: "expired",
    recipient_record: "absent",
    action: "not_saved",
  });
  assert.deepEqual(pick(unknown), {
    backup_state: null,
    final_state: "expired",
    recipient_record: "no_inbox_copy",
    action: "unknown",
  });
  assert.equal(out.messages.length, 5);
  assert.equal(out.restored_incomplete_expire_by, inFlight.expires_at);
});
