import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeReplayBoundMessageId } from "../src/messaging/index.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { DurableReceiver } from "../src/agent-sdk/receiver.ts";
import { authorizedDelivery } from "./jetstream-delivery.js";
import { startLocalBroker } from "../scripts/lib/nats-broker.mjs";
import { JetStreamRelay } from "../packages/relay-nats/src/backend.ts";

const nats = createRequire(
  new URL("../packages/relay-nats/package.json", import.meta.url),
);

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

/** A message that expires `ttlMs` from now; the contract's one-hour TTL backdates its send. */
function message(recipient, ttlMs = 3600000 - 100) {
  const at = new Date(Date.now() - 3600000 + ttlMs).toISOString();
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

/** A real JetStream journal, sender `a`, and agent SDK inboxes for recipients `b` and `c`. */
async function drill(t) {
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
  const run = (...args) =>
    JSON.parse(execFileSync(execPath, [script, ...args]).toString());
  return { dir, options, inboxes, sent, receive, run };
}

test("the rollback drill lists IDs incomplete at backup and ACK-lost saves as delivered, and unsaved ones by inbox evidence", async (t) => {
  const { dir, options, sent, receive } = await drill(t);
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

test("the rollback drill lists bodies the backup restores unprocessed, and IDs the upgraded journal already collected", async (t) => {
  const { dir, options, inboxes, sent, receive, run } = await drill(t);
  const handled = sent("b");
  await receive("b", handled, true);
  const waiting = sent("b");
  await receive("b", waiting, true);
  const collected = sent("c");
  const backup = join(dir, "backup-journal.sqlite");
  copy(options.journal_path, backup);
  const backupInbox = join(dir, "backup-inbox-b.sqlite");
  copy(join(dir, "inbox-b.sqlite"), backupInbox);

  // After the upgrade b's application executes `handled`, records it by its dedup key
  // and releases the body. `waiting` stays saved and unprocessed.
  assert.equal(inboxes.b.releaseBody("a", handled.message_id), true);
  const record = join(dir, "execution-b.json");
  writeFileSync(
    record,
    JSON.stringify({
      recipient_id: "b",
      handled: [{ sender_id: "a", message_id: handled.message_id }],
    }),
  );
  const upgraded = join(dir, "upgraded-journal.sqlite");
  copy(options.journal_path, upgraded);
  const drained = new DatabaseSync(upgraded);
  // `collected` expired long ago and the upgraded journal's purge deleted its row.
  drained
    .prepare("DELETE FROM nats_messages WHERE message_id=?")
    .run(collected.message_id);
  drained.close();

  const out = run(
    "--upgraded-journal",
    upgraded,
    "--backup-journal",
    backup,
    "--inbox",
    join(dir, "inbox-b.sqlite"),
    "--inbox",
    join(dir, "inbox-c.sqlite"),
    "--backup-inbox",
    backupInbox,
    "--execution-record",
    record,
  );
  const gone = out.messages.find(
    (row) => row.message_id === collected.message_id,
  );
  assert.ok(
    gone,
    "an ID incomplete at backup stays listed after its row is collected",
  );
  assert.deepEqual(
    {
      final_state: gone.final_state,
      recipient_record: gone.recipient_record,
      action: gone.action,
    },
    { final_state: null, recipient_record: "absent", action: "unknown" },
  );
  assert.ok(["staging", "pending"].includes(gone.backup_state));
  assert.equal(out.restored_incomplete_expire_by, collected.expires_at);

  const bodies = Object.fromEntries(
    out.restored_bodies.map(({ message_id, ...row }) => [message_id, row]),
  );
  assert.deepEqual(
    Object.keys(bodies).sort(),
    [handled.message_id, waiting.message_id].sort(),
  );
  assert.deepEqual(bodies[handled.message_id], {
    recipient_id: "b",
    sender_id: "a",
    expires_at: handled.expires_at,
    upgraded_record: "released",
    execution_record: "handled",
    action: "do_not_process",
  });
  assert.deepEqual(bodies[waiting.message_id], {
    recipient_id: "b",
    sender_id: "a",
    expires_at: waiting.expires_at,
    upgraded_record: "unreleased",
    execution_record: "absent",
    action: "process",
  });
  assert.equal(
    out.messages.some((row) =>
      [handled.message_id, waiting.message_id].includes(row.message_id),
    ),
    false,
    "both were acked at backup, so only their restored bodies need settling",
  );
});

/**
 * A relay on its own broker. The journal and the JetStream store dir both live under
 * `dir`, so stopping it leaves one consistent generation of files to copy or replace.
 */
async function relayGeneration(t, dir) {
  const broker = await startLocalBroker(join(dir, "broker"));
  t.after(() => broker.stop());
  const authorization = {
    authorize: (ctx) =>
      ["a", "b"].includes(ctx) ? { agent_id: ctx } : undefined,
  };
  const options = {
    max_pending: 10,
    max_records: 100,
    max_pending_per_recipient: 5,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 10,
    retry_cap_ms: 100,
    poll_scan_limit: 10,
    prefetch_per_recipient: 5,
    fingerprint_key: new Uint8Array(32).fill(63),
    journal_path: join(dir, "journal.sqlite"),
    server: broker.server,
    user: broker.user,
    password: broker.password,
    stream: "DRILL",
    subject_prefix: "drill",
    max_consumers: 10,
    broker_max_bytes: 4000000,
    broker_max_message_bytes: 64000,
    request_timeout_ms: 2000,
    limits,
    authorization,
  };
  let relay = await JetStreamRelay.open(options);
  t.after(() => relay?.close());
  return {
    journal: options.journal_path,
    store: join(dir, "broker", "store"),
    max_clock_skew_ms: options.max_clock_skew_ms,
    async submit(m) {
      relay.admitWithAuthorization("a", m, authorization);
      await relay.publishPending();
    },
    async poll(recipient) {
      await relay.pumpOnce();
      return relay.pollWithAuthorization(recipient, authorization);
    },
    ack: (recipient, input) =>
      relay.ackWithAuthorization(recipient, input, authorization),
    status: (id) => relay.statusWithAuthorization("a", id, authorization).state,
    /** The broker stream's last sequence: which store generation the broker runs on. */
    async lastSequence() {
      const nc = await nats("@nats-io/transport-node").connect({
        servers: broker.server,
        user: broker.user,
        pass: broker.password,
      });
      try {
        const manager = await nats("@nats-io/jetstream").jetstreamManager(nc);
        return (await manager.streams.info("DRILL")).state.last_seq;
      } finally {
        await nc.close();
      }
    },
    async stop() {
      await relay.close();
      relay = undefined;
      await broker.stop();
    },
    async start() {
      await broker.restart();
      relay = await JetStreamRelay.open(options);
    },
  };
}

test("the rollback drill restores the journal with its broker store, settles restored bodies, and the restored recipient executes nothing twice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-rollback-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = await relayGeneration(t, dir);
  const inboxPath = join(dir, "inbox-b.sqlite");
  const appPath = join(dir, "app-b.json");
  writeFileSync(appPath, JSON.stringify({ recipient_id: "b", handled: [] }));
  let inbox;
  const openInbox = (path = inboxPath) => {
    inbox = new SQLiteInbox(path, {
      agent_id: "b",
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
    inbox.migrate();
  };
  openInbox();
  t.after(() => inbox?.close());
  const receiver = () =>
    new DurableReceiver(inbox, {
      poll: () => relay.poll("b"),
      ack: async (request) => relay.ack("b", request),
    });
  // Every execution b's application performs, in either build. This list is never restored.
  const executed = [];
  /** b's application: executes each unrecorded body (or only `only`), records it, releases it. */
  const runApplication = (only) => {
    const store = JSON.parse(readFileSync(appPath, "utf8"));
    for (const entry of inbox.inbox()) {
      const id = entry.message.message_id;
      if (only && !only.includes(id)) continue;
      if (!store.handled.some((key) => key.message_id === id)) {
        executed.push(id);
        store.handled.push({ sender_id: entry.sender_id, message_id: id });
        writeFileSync(appPath, JSON.stringify(store));
      }
      inbox.releaseBody(entry.sender_id, id);
    }
  };
  const restore = (from, to) => {
    rmSync(to, { force: true });
    for (const suffix of ["-wal", "-shm"]) rmSync(to + suffix, { force: true });
    cpSync(from, to);
    chmodSync(to, 0o600);
  };

  const handled = message("b");
  const waiting = message("b");
  for (const m of [handled, waiting]) {
    await relay.submit(m);
    await receiver().receiveOnce();
  }
  assert.equal(inbox.inbox().length, 2, "both bodies are saved, unprocessed");
  const inFlight = message("b", 20000);
  await relay.submit(inFlight);

  // Backup: with delivery and execution quiesced, one generation of every part.
  const backup = join(dir, "backup");
  const backupSequence = await relay.lastSequence();
  inbox.close();
  await relay.stop();
  cpSync(relay.store, join(backup, "store"), { recursive: true });
  copy(relay.journal, join(backup, "journal.sqlite"));
  copy(inboxPath, join(backup, "inbox-b.sqlite"));
  cpSync(appPath, join(backup, "app-b.json"));
  await relay.start();
  openInbox();

  // The upgraded build delivers the in-flight message and a new one, and b executes
  // both and `handled`.
  const afterBackup = message("b");
  const retainedWaiting = message("b", 20000);
  await relay.submit(afterBackup);
  await relay.submit(retainedWaiting);
  for (let i = 0; i < 3; i++) await receiver().receiveOnce();
  assert.equal(relay.status(retainedWaiting.message_id), "acked");
  assert.equal(relay.status(inFlight.message_id), "acked");
  assert.equal(relay.status(afterBackup.message_id), "acked");
  runApplication([
    handled.message_id,
    inFlight.message_id,
    afterBackup.message_id,
  ]);
  assert.deepEqual(
    [...executed].sort(),
    [handled.message_id, inFlight.message_id, afterBackup.message_id].sort(),
  );
  assert.ok((await relay.lastSequence()) > backupSequence);

  // Rollback: quiesce, copy the upgraded state, then restore the backup generation.
  inbox.close();
  await relay.stop();
  const upgraded = join(dir, "upgraded");
  mkdirSync(upgraded);
  copy(relay.journal, join(upgraded, "journal.sqlite"));
  copy(inboxPath, join(upgraded, "inbox-b.sqlite"));
  cpSync(appPath, join(upgraded, "execution-b.json"));
  restore(join(backup, "journal.sqlite"), relay.journal);
  rmSync(relay.store, { recursive: true, force: true });
  cpSync(join(backup, "store"), relay.store, { recursive: true });
  restore(join(backup, "inbox-b.sqlite"), inboxPath);
  cpSync(join(backup, "app-b.json"), appPath);

  const out = JSON.parse(
    execFileSync(execPath, [
      script,
      "--upgraded-journal",
      join(upgraded, "journal.sqlite"),
      "--backup-journal",
      relay.journal,
      "--inbox",
      join(upgraded, "inbox-b.sqlite"),
      "--backup-inbox",
      inboxPath,
      "--execution-record",
      join(upgraded, "execution-b.json"),
    ]).toString(),
  );
  assert.deepEqual(
    Object.fromEntries(
      out.messages.map(({ message_id, backup_state, final_state, action }) => [
        message_id,
        { backup_state, final_state, action },
      ]),
    ),
    {
      [inFlight.message_id]: {
        backup_state: "pending",
        final_state: "acked",
        action: "delivered",
      },
      [afterBackup.message_id]: {
        backup_state: null,
        final_state: "acked",
        action: "delivered",
      },
      [retainedWaiting.message_id]: {
        backup_state: null,
        final_state: "acked",
        action: "delivered",
      },
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      out.restored_bodies.map((row) => [row.message_id, row.action]),
    ),
    {
      [handled.message_id]: "do_not_process",
      [waiting.message_id]: "process",
    },
  );
  assert.deepEqual(
    out.retained_bodies.map((row) => [row.message_id, row.action]),
    [[retainedWaiting.message_id, "review_application_handoff"]],
  );
  assert.equal(out.restored_incomplete_expire_by, inFlight.expires_at);
  const restoredRow = new DatabaseSync(relay.journal, { readOnly: true });
  assert.equal(
    restoredRow
      .prepare("SELECT state FROM nats_messages WHERE message_id=?")
      .get(inFlight.message_id).state,
    "pending",
    "the restored journal would deliver the in-flight message again",
  );
  restoredRow.close();

  // Settle the restored inbox before b restarts: a do_not_process body is recorded as
  // handled in the restored application store and released without being handed over.
  openInbox();
  const store = JSON.parse(readFileSync(appPath, "utf8"));
  for (const row of out.restored_bodies.filter(
    (body) => body.action === "do_not_process",
  )) {
    store.handled.push({
      sender_id: row.sender_id,
      message_id: row.message_id,
    });
    assert.equal(inbox.releaseBody(row.sender_id, row.message_id), true);
  }
  writeFileSync(appPath, JSON.stringify(store));
  inbox.close();

  // Hold the relay stopped until every restored ID has expired, then restart it and b.
  const holdUntil =
    Date.parse(out.restored_incomplete_expire_by) + relay.max_clock_skew_ms;
  await new Promise((done) =>
    setTimeout(done, Math.max(0, holdUntil - Date.now()) + 100),
  );
  // Application-specific local recovery, with the network still stopped: read a
  // working copy through its compatible SDK, preserve the original key, and use
  // this fixture application's durable dedup store. Never submit an expired body
  // to the relay or inject it through restored inbox.save(). Keep evidence intact.
  const recoveryInbox = join(dir, "recovery-inbox.sqlite");
  copy(join(upgraded, "inbox-b.sqlite"), recoveryInbox);
  chmodSync(recoveryInbox, 0o600);
  openInbox(recoveryInbox);
  assert.ok(Date.parse(retainedWaiting.expires_at) <= Date.now());
  runApplication([retainedWaiting.message_id]);
  inbox.close();
  await relay.start();
  assert.equal(
    await relay.lastSequence(),
    backupSequence,
    "the broker runs on the restored backup store",
  );
  openInbox();
  for (let i = 0; i < 3; i++) await receiver().receiveOnce();
  runApplication();
  assert.equal(await relay.poll("b"), null, "the relay delivers nothing again");
  assert.equal(relay.status(inFlight.message_id), "expired");
  assert.equal(relay.status(handled.message_id), "acked");
  assert.throws(() => relay.status(afterBackup.message_id), {
    code: "not_found",
  });
  assert.deepEqual(
    executed.slice(3),
    [retainedWaiting.message_id, waiting.message_id],
    "both unprocessed bodies run once, including the retained-copy handoff",
  );
  assert.equal(new Set(executed).size, executed.length, "nothing runs twice");
  assert.deepEqual(inbox.inbox(), []);
});
