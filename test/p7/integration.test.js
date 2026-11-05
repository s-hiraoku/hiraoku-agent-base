import process from "node:process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { coldBackup, restoreImage, sealOracle, readOracle } from "./backup.js";
import { sha256 } from "../../scripts/lib/p7-provenance.mjs";
import { join } from "node:path";
import { TaskState, ListTasksRequest } from "@a2a-js/sdk";
import {
  openP7System,
  a2aRequest,
  eventually,
  readDb,
  RESPONSE,
} from "./system.js";

function evidence(id, data) {
  if (!process.env.P7_EVIDENCE) return;
  mkdirSync(process.env.P7_EVIDENCE, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(process.env.P7_EVIDENCE, `${id}.json`),
    JSON.stringify(data, null, 2) + "\n",
    { mode: 0o600 },
  );
}
async function receiveRequest(f) {
  await eventually(async () => {
    await f.recipient.receiveOnce();
    return f.recipientEntries().length === 1;
  });
}
async function receiveResult(f, count) {
  await eventually(async () => {
    await f.receiveResult();
    const entries = f.originEntries();
    return (
      entries.length === count &&
      entries.every((entry) => entry.receipt_confirmed)
    );
  });
}
async function execute(f, task, witnesses) {
  const source = f.sourceOf(task);
  f.recipient.accept(f.operator, source);
  const linked = await f.recipient.submitOnce(f.operator, source);
  assert.equal(f.engineCount(), 1);
  await f.recipient.submitOnce(f.operator, source);
  await f.publishReply(source, "execution_accepted");
  witnesses.push(await f.witness("execution_accepted", source));
  await receiveResult(f, 1);
  const accepted = await f.client.getTask({ id: task.id }, f.options);
  assert.notEqual(accepted.status.state, TaskState.TASK_STATE_COMPLETED);
  await f.complete(source);
  for (const view of [
    await f.client.getTask({ id: task.id }, f.options),
    await f.client.listTasks(
      ListTasksRequest.fromJSON({ includeArtifacts: true }),
      f.options,
    ),
  ])
    assert.equal(JSON.stringify(view).includes(RESPONSE), false);
  await f.publishReply(source, "execution_result");
  witnesses.push(await f.witness("execution_result", source));
  assert.equal(
    JSON.stringify(await f.client.getTask({ id: task.id }, f.options)).includes(
      RESPONSE,
    ),
    false,
  );
  await receiveResult(f, 2);
  const done = await f.client.getTask({ id: task.id }, f.options);
  assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(done.artifacts.length, 1);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.engineCount(), 1);
  return { done, linked };
}

test("P7-01 official A2A and real HAB NATS separate saved ACK from one Task and Artifact", async (t) => {
  let f = await openP7System(t);
  await assert.rejects(() => f.startBroker(), /already live/);
  await assert.rejects(() => f.startApplication(), /already live/);
  const request = a2aRequest("p7_native");
  const task = await f.client.sendMessage(request, f.options);
  const witnesses = [await f.witness("execution_request", f.sourceOf(task))];
  let observed = 0,
    observationError;
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(
      input instanceof Request ? input.clone() : input,
      init,
    );
    if (
      req.url === f.relayUrl &&
      req.headers.get("mcp-name") === "relay_ack" &&
      req.headers.get("authorization") === "Bearer fixture-b"
    ) {
      const args = (await req.json()).params.arguments;
      try {
        readDb(join(f.appDir, "inbox-b.sqlite"), (db) => {
          const row = db
            .prepare(
              "SELECT body,receipt_confirmed FROM relay_inbox WHERE sender_id=? AND message_id=?",
            )
            .get(args.sender_id, args.message_id);
          assert.ok(row);
          assert.equal(row.receipt_confirmed, 0);
          assert.deepEqual(JSON.parse(row.body), witnesses[0].body.message);
          const ack = db
            .prepare(
              "SELECT request FROM relay_receiver_acks WHERE request_id=?",
            )
            .get(args.request_id);
          const { as_address, expected_agent_id, ...savedAck } = args;
          assert.equal(as_address, f.agents.b.address);
          assert.equal(expected_agent_id, f.agents.b.agent_id);
          assert.deepEqual(JSON.parse(ack.request), savedAck);
        });
        observed++;
      } catch (error) {
        observationError = error;
        throw error;
      }
    }
    return original(input, init);
  });
  try {
    await receiveRequest(f);
  } catch (error) {
    throw observationError ?? error;
  }
  assert.equal(observed, 1);
  t.mock.restoreAll();
  assert.equal((await f.receipt(task)).state, "acked");
  assert.equal(f.engineCount(), 0);
  assert.equal(
    (await f.client.getTask({ id: task.id }, f.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  const { done, linked } = await execute(f, task, witnesses);
  const replay = await f.client.sendMessage(request, f.options);
  assert.equal(replay.id, task.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.equal(f.retiredStorePresent(), false);
  const [closed, sameClose] = await Promise.all([f.close(), f.close()]);
  assert.equal(sameClose, closed);
  await assert.rejects(() => f.startBroker(), /closed system/);
  await assert.rejects(() => f.startApplication(), /closed system/);
  f = await openP7System(t, { root: closed.root });
  const durable = await f.client.getTask({ id: task.id }, f.options);
  assert.deepEqual(durable.artifacts, done.artifacts);
  assert.deepEqual(
    durable.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.equal(f.engineCount(), 1);
  const pending = await f.settledCounts();
  const cleanup = await f.close();
  evidence("P7-01", {
    native_task: task.id,
    source: task.metadata.hab_relay.source,
    engine_task: linked.task.id,
    engine_tasks: 1,
    artifacts: 1,
    broker_witnesses: witnesses,
    independent_pre_ack_reads: observed,
    unresolved_delivery_and_rpc_intents: pending,
    retired_sqlite_store: false,
    cleanup: [closed.closure, cleanup.closure],
  });
});

test("P7-02 whole HAB cold restore preserves a live broker reply and one known engine Task", async (t) => {
  const savedBeforeAck = [{ receipt_confirmed: false }];
  let receiveAttempts = 0;
  await receiveResult(
    {
      async receiveResult() {
        if (++receiveAttempts === 2) savedBeforeAck[0].receipt_confirmed = true;
      },
      originEntries: () => savedBeforeAck,
    },
    1,
  );
  assert.equal(receiveAttempts, 2);
  const area = mkdtempSync(join(tmpdir(), "p7-cold-"));
  const backup = join(area, "backup"),
    restoredRoot = join(area, "restored");
  let f = await openP7System(t);
  const task = await f.client.sendMessage(a2aRequest("p7_restore"), f.options);
  await f.witness("execution_request", f.sourceOf(task));
  await receiveRequest(f);
  const source = f.sourceOf(task);
  f.recipient.accept(f.operator, source);
  const linked = await f.recipient.submitOnce(f.operator, source);
  await f.publishReply(source, "execution_accepted");
  const pending = await f.witness("execution_accepted", source);
  assert.equal(pending.outbox, null);
  assert.ok(pending.sequence > 0);
  assert.equal(f.originEntries().length, 0);
  assert.equal(f.engineCount(), 1);
  const sealed = sealOracle(
    join(area, "accepted-oracle.json"),
    {
      native_id: task.id,
      context_id: task.contextId,
      source: task.metadata.hab_relay.source,
      source_key: source,
      request_receipt: await f.receipt(task),
      engine_id: linked.task.id,
      request_key: f.journal.get(source).request_key,
      pending,
      agents: f.agents,
      urls: structuredClone(f.config.urls),
      device: lstatSync(f.hostDir).dev,
      binding_sha256: sha256(JSON.stringify(f.config.binding)),
      fingerprint_keys_sha256: sha256(JSON.stringify(f.config.keys)),
    },
    [f.root, backup, restoredRoot],
  );
  const closed = await f.close();
  const image = coldBackup(closed, backup);
  const unavailable = `${closed.root}-retired`;
  renameSync(closed.root, unavailable);
  restoreImage(image, restoredRoot);
  f = await openP7System(t, { root: restoredRoot, brokerOnly: true });
  const expected = readOracle(sealed);
  assert.equal(f.phase, "broker-only");
  const restoredMessage = await f.brokerMessage(expected.pending.sequence);
  assert.equal(restoredMessage.seq, expected.pending.sequence);
  assert.equal(restoredMessage.subject, expected.pending.subject);
  assert.equal(sha256(restoredMessage.data), expected.pending.sha256);
  assert.equal(f.phase, "broker-only");
  await f.startApplication();
  assert.deepEqual(f.agents, expected.agents);
  assert.equal(
    sha256(JSON.stringify(f.config.binding)),
    expected.binding_sha256,
  );
  assert.equal(
    sha256(JSON.stringify(f.config.keys)),
    expected.fingerprint_keys_sha256,
  );
  let repeatedRpc = 0;
  f.hub.submit = async () => {
    repeatedRpc++;
    throw Error("restored known RPC must not repeat");
  };
  const recovered = await f.recipient.submitOnce(
    f.operator,
    expected.source_key,
    true,
  );
  assert.equal(recovered.task.id, expected.engine_id);
  assert.equal(f.journal.get(source).request_key, expected.request_key);
  assert.equal(repeatedRpc, 0);
  const native = await f.client.getTask({ id: expected.native_id }, f.options);
  assert.equal(native.contextId, expected.context_id);
  assert.deepEqual(native.metadata.hab_relay.source, expected.source);
  assert.deepEqual(await f.receipt(native), expected.request_receipt);
  await receiveResult(f, 1);
  assert.equal(f.originEntries()[0].receipt_confirmed, true);
  await f.receiveResult();
  assert.equal(f.originEntries().length, 1);
  await f.complete(source);
  await f.publishReply(source, "execution_result");
  const resultWitness = await f.witness("execution_result", source);
  await receiveResult(f, 2);
  const done = await f.client.getTask({ id: expected.native_id }, f.options);
  assert.equal(done.artifacts.length, 1);
  assert.equal(done.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.engineCount(), 1);
  assert.equal(repeatedRpc, 0);
  const pendingAfterRestore = await f.settledCounts();
  const rebindings = {
    old: {
      directory: closed.root,
      urls: expected.urls,
      file_store: join(closed.root, "broker/store"),
      volume_marker: join(closed.root, "host/volume.local.json"),
      observed_device: expected.device,
    },
    new: {
      directory: f.root,
      urls: structuredClone(f.config.urls),
      file_store: join(f.root, "broker/store"),
      volume_marker: join(f.hostDir, "volume.local.json"),
      observed_device: lstatSync(f.hostDir).dev,
    },
    unchanged_binding: {
      before_sha256: expected.binding_sha256,
      after_sha256: sha256(JSON.stringify(f.config.binding)),
    },
    unchanged_fingerprint_keys: {
      before_sha256: expected.fingerprint_keys_sha256,
      after_sha256: sha256(JSON.stringify(f.config.keys)),
    },
  };
  assert.equal(
    rebindings.unchanged_binding.before_sha256,
    rebindings.unchanged_binding.after_sha256,
  );
  assert.equal(
    rebindings.unchanged_fingerprint_keys.before_sha256,
    rebindings.unchanged_fingerprint_keys.after_sha256,
  );
  const finalClose = await f.close();
  evidence("P7-02", {
    oracle_sha256: sealed.sha256,
    oracle: expected,
    image_files: image.manifest.files,
    original_configured_path_unavailable: true,
    broker_verified_before_application_resume: true,
    restored_broker_sha256: sha256(restoredMessage.data),
    repeated_engine_rpc: repeatedRpc,
    unresolved_delivery_and_rpc_intents: pendingAfterRestore,
    engine_tasks: 1,
    artifacts: 1,
    result_witness: resultWitness,
    rebindings,
    cleanup: [closed.closure, finalClose.closure],
  });
});

test("P7-03 incomplete cold images refuse restoration before serving traffic", async (t) => {
  const f = await openP7System(t);
  const task = await f.client.sendMessage(
    a2aRequest("p7_incomplete"),
    f.options,
  );
  await f.witness("execution_request", f.sourceOf(task));
  const area = mkdtempSync(join(tmpdir(), "p7-image-negative-"));
  assert.throws(
    () => coldBackup({ phase: "running" }, join(area, "live")),
    /observed closed/,
  );
  const closed = await f.close();
  const image = coldBackup(closed, join(area, "backup"));
  const brokerFile = image.manifest.files.find(
    (r) => r.path.startsWith("broker/store/") && r.path.endsWith(".blk"),
  ).path;
  for (const [index, missing] of [brokerFile, "app/engine.sqlite"].entries()) {
    const bad = join(area, `bad-${index}`);
    restoreImage(image, bad);
    rmSync(join(bad, missing));
    assert.throws(
      () =>
        restoreImage({ ...image, root: bad }, join(area, `refused-${index}`)),
      /inventory or bytes/,
    );
  }
  evidence("P7-03", {
    rejected_missing: [brokerFile, "app/engine.sqlite"],
    validator_before_traffic: true,
    product_partial_restore_detection_claimed: false,
    cleanup: closed.closure,
  });
});

test("P7-04 same-ID rename preserves the NATS chain and receipt across a cold host restart", async (t) => {
  let f = await openP7System(t);
  const request = a2aRequest("p7_rename_restart");
  const task = await f.client.sendMessage(request, f.options);
  const witnesses = [await f.witness("execution_request", f.sourceOf(task))];
  const originalReceipt = await f.receipt(task),
    originalRecipient = { ...f.agents.b };
  const renamed = f.rename("b", "p7-recipient-renamed");
  assert.equal(renamed.agent_id, originalRecipient.agent_id);
  await assert.rejects(() => f.client.getTask({ id: task.id }, f.options));
  assert.equal(f.engineCount(), 0);
  f.refreshAddress("b");
  assert.equal(f.agents.b.agent_id, originalRecipient.agent_id);
  assert.notEqual(f.agents.b.address, originalRecipient.address);
  assert.deepEqual(
    (await f.client.getTask({ id: task.id }, f.options)).metadata.hab_relay
      .source,
    task.metadata.hab_relay.source,
  );
  const closed = await f.close();
  f = await openP7System(t, { root: closed.root });
  const replay = await f.client.sendMessage(request, f.options);
  assert.equal(replay.id, task.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.equal(
    (await f.receipt(replay)).receipt_id,
    originalReceipt.receipt_id,
  );
  assert.equal(
    (await f.receipt(replay)).expires_at,
    originalReceipt.expires_at,
  );
  await receiveRequest(f);
  const { done } = await execute(f, replay, witnesses);
  const fresh = await f.client.sendMessage(
    a2aRequest("p7_rename_restart_new"),
    f.options,
  );
  const newSource = f.sourceOf(fresh);
  assert.equal(
    f.journalRows().filter((r) => r.message_id === newSource.message_id).length,
    1,
  );
  witnesses.push(await f.witness("execution_request", newSource));
  await eventually(async () => {
    await f.recipient.receiveOnce();
    return f.recipientEntries().length === 2;
  });
  assert.equal(f.engineCount(), 1);
  assert.equal(
    (await f.client.getTask({ id: fresh.id }, f.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  assert.equal(f.retiredStorePresent(), false);
  const pendingAfterRestart = await f.settledCounts();
  const finalClose = await f.close();
  evidence("P7-04", {
    native_task: task.id,
    source: task.metadata.hab_relay.source,
    original_recipient: originalRecipient,
    renamed_recipient: renamed,
    immutable_recipient_id: renamed.agent_id,
    old_receipt: originalReceipt.receipt_id,
    broker_witnesses: witnesses,
    new_source: newSource,
    new_task_unexecuted: true,
    unresolved_delivery_and_rpc_intents: pendingAfterRestart,
    engine_tasks: 1,
    artifacts: done.artifacts.length,
    retired_sqlite_store: false,
    cleanup: [closed.closure, finalClose.closure],
  });
});

test("P7-05 broker outage retains original admission without any SQLite fallback", async (t) => {
  const f = await openP7System(t);
  await f.stopBroker();
  const request = a2aRequest("p7_broker_outage");
  const task = await f.client.sendMessage(request, f.options);
  const original = await f.receipt(task);
  assert.equal(original.state, "pending");
  assert.equal(f.retiredStorePresent(), false);
  assert.equal(f.engineCount(), 0);
  const replay = await f.client.sendMessage(request, f.options);
  assert.equal(replay.id, task.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.equal((await f.receipt(replay)).receipt_id, original.receipt_id);
  await f.startBroker();
  const witnesses = [await f.witness("execution_request", f.sourceOf(task))];
  await receiveRequest(f);
  assert.equal(f.engineCount(), 0);
  const { done } = await execute(f, task, witnesses);
  assert.equal((await f.receipt(task)).receipt_id, original.receipt_id);
  assert.equal(f.retiredStorePresent(), false);
  const pendingAfterOutage = await f.settledCounts();
  const cleanup = await f.close();
  evidence("P7-05", {
    native_task: task.id,
    source: task.metadata.hab_relay.source,
    original_receipt: original.receipt_id,
    broker_witnesses: witnesses,
    fallback_rows: 0,
    unresolved_delivery_and_rpc_intents: pendingAfterOutage,
    engine_tasks: 1,
    artifacts: done.artifacts.length,
    cleanup: cleanup.closure,
  });
});
