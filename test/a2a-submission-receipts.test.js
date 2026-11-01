import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SQLiteSubmissionReceipts } from "../src/a2a/submission-receipts.ts";
const source = { sender_id: "origin", message_id: "source-message" };
const requestKey = "br_" + "a".repeat(32);
const options = {
  receiver_id: "recipient",
  binding: {
    engine_id: "synthetic-engine",
    owner_subject: "owner",
    client_id: null,
  },
  fingerprint_key: new Uint8Array(32).fill(119),
  max_records: 1,
};
const task = {
  id: "engine-task",
  owner: "owner",
  destination: "hermes",
  request_key: requestKey,
  task_type: "connectivity_check",
  state: "queued",
  execution_open: 0,
  fence: 0,
  result: null,
};

test("A2A submission receipt persists one original success without becoming another Task engine", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-submission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "receipts.sqlite");
  let store = new SQLiteSubmissionReceipts(path, options);
  store.prepare(source, requestKey);
  assert.equal(store.read(source, requestKey), undefined);
  store.record(source, requestKey, task);
  store.record(source, requestKey, {
    ...task,
    state: "running",
    execution_open: 1,
    fence: 1,
  });
  assert.deepEqual(store.read(source, requestKey), task);
  assert.throws(
    () => store.prepare({ ...source, message_id: "another" }, requestKey),
    /capacity/,
  );
  store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store = new SQLiteSubmissionReceipts(path, options);
  try {
    assert.deepEqual(store.read(source, requestKey), task);
    assert.throws(() => store.read(source, "another-key"), /conflict/);
    assert.throws(
      () =>
        store.record(source, requestKey, { ...task, id: "wrong-engine-task" }),
      /conflict/,
    );
  } finally {
    store.close();
  }
});

test("A2A submission receipt refuses binding changes and tampered success evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-submission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "receipts.sqlite");
  const initial = new SQLiteSubmissionReceipts(path, options);
  initial.prepare(source, requestKey);
  initial.record(source, requestKey, task);
  initial.close();
  assert.throws(
    () =>
      new SQLiteSubmissionReceipts(path, {
        ...options,
        binding: { ...options.binding, engine_id: "different-engine" },
      }),
    /integrity/,
  );
  const raw = new DatabaseSync(path);
  raw
    .prepare(
      "UPDATE a2a_submission_receipts SET data=replace(data,'engine-task','forged-task')",
    )
    .run();
  raw.close();
  const store = new SQLiteSubmissionReceipts(path, options);
  try {
    assert.throws(() => store.read(source, requestKey), /integrity/);
  } finally {
    store.close();
  }
});
