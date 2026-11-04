import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/sqlite.ts";
import {
  GenericTextJobs,
  TextJobError,
  GENERIC_TEXT_PROFILE,
} from "../src/generic-jobs.ts";
import { identities } from "./generic-async/fixtures.js";

function fixture(t) {
  let clock = 100;
  const h = new Hub(":memory:", () => clock);
  t.after(() => h.close());
  const { sender, worker } = identities();
  const policy = { current: sender };
  const app = new GenericTextJobs(h, () => policy.current);
  const input = (messageId = crypto.randomUUID(), contextId = "context-a") => ({
    messageId,
    contextId,
    text: "private input text",
    workDeadline: 100000,
  });
  const submit = (...args) => app.submit(null, input(...args));
  const claim = () => h.claim(worker, {}, { textRetentionMs: 200000 });
  return {
    h,
    sender,
    worker,
    app,
    policy,
    input,
    submit,
    claim,
    set: (value) => {
      clock = value;
    },
  };
}
const code = (expected) => (error) => {
  assert.ok(error instanceof TextJobError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  return true;
};

test("generic job submission exposes only correlation and safe state", async (t) => {
  const { submit } = fixture(t);
  const job = await submit("message-1");
  assert.deepEqual(job, {
    profile: GENERIC_TEXT_PROFILE,
    version: 1,
    id: job.id,
    contextId: "context-a",
    sourceMessageId: "message-1",
    acceptedAt: 100,
    statusAt: 100,
    workDeadline: 100000,
    state: "submitted",
    outcome: "pending",
    cancellationRequested: false,
    cancellationConfirmed: false,
  });
});
test("same message is idempotent and changed input is a sanitized conflict", async (t) => {
  const { app, input } = fixture(t);
  const first = await app.submit(null, input("same"));
  assert.equal((await app.submit(null, input("same"))).id, first.id);
  await assert.rejects(
    app.submit(null, { ...input("same"), text: "changed" }),
    code("conflict"),
  );
});
test("strict public input rejects authority and unbounded text", async (t) => {
  const { app, input } = fixture(t);
  for (const extra of [
    { owner: "forged" },
    { textBinding: {} },
    { text: "界".repeat(10923) },
    { workDeadline: 1 },
    { contextId: "" },
  ])
    await assert.rejects(
      app.submit(null, { ...input(), ...extra }),
      code("invalid_request"),
    );
});
test("every entry re-resolves current permissions", async (t) => {
  const { policy, sender, submit, app } = fixture(t);
  const job = await submit();
  policy.current = { ...sender, operations: ["submit"] };
  assert.deepEqual(await app.capabilities(null), {
    submit: true,
    get: false,
    list: false,
    cancel: false,
  });
  await assert.rejects(app.get(null, { id: job.id }), code("forbidden"));
  await assert.rejects(app.list(null, {}), code("forbidden"));
  await assert.rejects(app.cancel(null, { id: job.id }), code("forbidden"));
  policy.current = null;
  await assert.rejects(app.capabilities(null), code("forbidden"));
});
test("sender discovery requires complete binding and rejects worker grants", async (t) => {
  const { app, sender, policy } = fixture(t);
  for (const change of [
    { clientId: undefined },
    { textBinding: undefined },
    { destination: "foreign" },
    { worker: "worker" },
    { runnerScope: "runtime" },
    { taskTypes: [] },
    { operations: [] },
    { resultReaders: [{ subject: "reader", notify: false }] },
  ]) {
    policy.current = { ...sender, ...change };
    await assert.rejects(app.capabilities(null), code("forbidden"));
  }
});
test("principal arrays and full binding are frozen before authorization awaits", async (t) => {
  const { h, sender, app, submit } = fixture(t);
  const original = h.authorization.bind.bind(h.authorization);
  h.authorization.bind = async (p) => {
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.textBinding));
    assert.ok(Object.isFrozen(p.operations));
    assert.ok(Object.isFrozen(p.taskTypes));
    sender.operations.length = 0;
    sender.textBinding.recipientOwner = "mutated";
    return original(p);
  };
  const accepted = await submit();
  assert.equal(accepted.state, "submitted");
  await assert.rejects(app.get(null, { id: accepted.id }), code("forbidden"));
});
test("stopped admission and stale epochs deny all entry operations", async (t) => {
  const { h, sender, app, policy, submit } = fixture(t);
  const job = await submit();
  const epoch = await h.authorization.epoch();
  policy.current = { ...sender, authorizationEpoch: epoch };
  await h.authorization.setStopped(
    { kind: "client", id: sender.clientId },
    true,
    epoch,
    "test-maintenance",
  );
  await assert.rejects(app.capabilities(null), code("forbidden"));
  await assert.rejects(app.get(null, { id: job.id }), code("forbidden"));
  await h.authorization.setStopped(
    { kind: "client", id: sender.clientId },
    false,
    epoch + 1,
    "test-maintenance",
  );
  await assert.rejects(app.list(null), code("forbidden"));
  policy.current = sender;
  assert.equal((await app.get(null, { id: job.id })).id, job.id);
});
test("missing and foreign subject IDs are indistinguishable with the same client", async (t) => {
  const { app, sender, policy, submit } = fixture(t);
  const job = await submit();
  policy.current = { ...sender, subject: "foreign-owner" };
  for (const id of [job.id, crypto.randomUUID()]) {
    await assert.rejects(app.get(null, { id }), code("not_found"));
    await assert.rejects(app.cancel(null, { id }), code("not_found"));
  }
  assert.deepEqual(await app.list(null), { jobs: [], totalSize: 0 });
});
for (const field of [
  "ownerScope",
  "senderAgent",
  "recipientAgent",
  "recipientOwner",
  "conversationBinding",
  "clientId",
])
  test(`read/cancel/list enforce ${field}`, async (t) => {
    const { app, policy, sender, submit } = fixture(t);
    const job = await submit();
    policy.current =
      field === "clientId"
        ? { ...sender, clientId: "foreign" }
        : {
            ...sender,
            textBinding: { ...sender.textBinding, [field]: "foreign" },
            ...(field === "recipientAgent" ? { destination: "foreign" } : {}),
          };
    await assert.rejects(app.get(null, { id: job.id }), code("not_found"));
    await assert.rejects(app.cancel(null, { id: job.id }), code("not_found"));
    assert.deepEqual(await app.list(null), { jobs: [], totalSize: 0 });
  });
test("pagination orders by status time and ID with context filtering", async (t) => {
  const { submit, app, set } = fixture(t);
  const jobs = [];
  for (let i = 0; i < 7; i++) {
    set(100 + Math.floor(i / 2));
    jobs.push(await submit(`m-${i}`, i === 0 ? "other-context" : "context-a"));
  }
  const expected = jobs
    .filter((j) => j.contextId === "context-a")
    .sort((a, b) => b.statusAt - a.statusAt || b.id.localeCompare(a.id));
  let pageToken;
  const actual = [];
  do {
    const page = await app.list(null, {
      pageSize: 2,
      contextId: "context-a",
      ...(pageToken ? { pageToken } : {}),
    });
    assert.equal(page.totalSize, 6);
    actual.push(...page.jobs);
    pageToken = page.nextPageToken;
  } while (pageToken);
  assert.deepEqual(
    actual.map((j) => j.id),
    expected.map((j) => j.id),
  );
  assert.ok(actual.every((j) => !("result" in j)));
});
test("strict cursors cannot change scope filter or page size", async (t) => {
  const { app, submit, policy, sender } = fixture(t);
  await submit();
  await submit();
  const { nextPageToken } = await app.list(null, { pageSize: 1 });
  for (const input of [
    { pageSize: 0 },
    { pageSize: 21 },
    { pageSize: 1.2 },
    { unknown: true },
    { pageSize: 1, pageToken: "!" },
    { pageSize: 2, pageToken: nextPageToken },
    { pageSize: 1, contextId: "other", pageToken: nextPageToken },
  ])
    await assert.rejects(app.list(null, input), code("invalid_request"));
  policy.current = { ...sender, subject: "foreign-owner" };
  await assert.rejects(
    app.list(null, { pageSize: 1, pageToken: nextPageToken }),
    code("invalid_request"),
  );
});
test("tampering a cursor scope cannot bypass the enforced owner WHERE", async (t) => {
  const { app, submit, policy, sender } = fixture(t);
  await submit();
  await submit();
  const { nextPageToken } = await app.list(null, { pageSize: 1 });
  const decoded = JSON.parse(
    Buffer.from(nextPageToken, "base64url").toString(),
  );
  policy.current = { ...sender, subject: "foreign-owner" };
  const scope = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        subject: "foreign-owner",
        clientId: sender.clientId,
        binding: sender.textBinding,
        contextId: null,
        pageSize: 1,
      }),
    ),
  );
  decoded.scope = Buffer.from(scope).toString("hex");
  const page = await app.list(null, {
    pageSize: 1,
    pageToken: Buffer.from(JSON.stringify(decoded)).toString("base64url"),
  });
  assert.deepEqual(page, { jobs: [], totalSize: 0 });
});
test("expired queued jobs retain submitted state and deadline metadata", async (t) => {
  const { submit, app, set } = fixture(t);
  const job = await submit();
  set(200000);
  const current = await app.get(null, { id: job.id });
  assert.equal(current.state, "submitted");
  assert.equal(current.workDeadline, 100000);
});
test("queued cancellation needs no get grant and repeated cancellation is idempotent", async (t) => {
  const { submit, app, policy, sender } = fixture(t);
  const job = await submit();
  policy.current = { ...sender, operations: ["cancel"] };
  const canceled = await app.cancel(null, { id: job.id });
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.cancellationConfirmed, true);
  assert.deepEqual(await app.cancel(null, { id: job.id }), canceled);
});
test("running cancellation remains working and unconfirmed", async (t) => {
  const { submit, app, claim } = fixture(t);
  const job = await submit();
  await claim();
  assert.equal((await app.get(null, { id: job.id })).state, "working");
  const canceled = await app.cancel(null, { id: job.id });
  assert.equal(canceled.state, "working");
  assert.equal(canceled.outcome, "unknown");
  assert.equal(canceled.waitReason, "cancellation_confirmation");
  assert.equal(canceled.cancellationConfirmed, false);
});
test("lease expiry reports reconciliation without fabricating approval", async (t) => {
  const { submit, app, claim, set } = fixture(t);
  const job = await submit();
  await claim();
  set(40000);
  await claim();
  const current = await app.get(null, { id: job.id });
  assert.equal(current.state, "working");
  assert.equal(current.outcome, "unknown");
  assert.equal(current.waitReason, "execution_reconciliation");
  assert.equal(JSON.stringify(current).includes("approval"), false);
});
test("confirmed result is returned by get and omitted from list", async (t) => {
  const { submit, app, h, worker, claim } = fixture(t);
  const job = await submit();
  const lease = await claim();
  await h.complete(worker, {
    ...lease,
    state: "succeeded",
    result: "bounded answer",
  });
  const result = await app.get(null, { id: job.id });
  assert.equal(result.state, "completed");
  assert.equal(result.outcome, "confirmed");
  assert.deepEqual(result.result, { version: 1, text: "bounded answer" });
  assert.equal("result" in (await app.list(null)).jobs[0], false);
  await assert.rejects(
    app.cancel(null, { id: job.id }),
    code("not_cancelable"),
  );
});
test("failed result is confirmed without an artifact and not cancelable", async (t) => {
  const { submit, app, h, worker, claim } = fixture(t);
  const job = await submit();
  const lease = await claim();
  await h.complete(worker, {
    ...lease,
    state: "failed",
    result: "generic_text_failed",
  });
  const failed = await app.get(null, { id: job.id });
  assert.equal(failed.state, "failed");
  assert.equal(failed.outcome, "confirmed");
  assert.equal("result" in failed, false);
  await assert.rejects(
    app.cancel(null, { id: job.id }),
    code("not_cancelable"),
  );
});
test("completion winning cancellation race cannot be reported as canceled", async (t) => {
  const { submit, app, h, worker, claim, policy, sender } = fixture(t);
  const job = await submit();
  const lease = await claim();
  const cancel = h.cancelText.bind(h);
  h.cancelText = async (...args) => {
    await h.complete(worker, { ...lease, state: "succeeded", result: "done" });
    return cancel(...args);
  };
  policy.current = { ...sender, operations: ["cancel"] };
  await assert.rejects(
    app.cancel(null, { id: job.id }),
    code("not_cancelable"),
  );
});
test("fixed tasks cannot be canceled or exposed through generic entries", async (t) => {
  const { h, sender, app } = fixture(t);
  const task = await h.submit(
    { ...sender, destination: "hermes", taskTypes: ["connectivity_check"] },
    { task_type: "connectivity_check", request_key: "fixed" },
  );
  const snapshot = () =>
    ["tasks", "audit", "outbox"].map((table) =>
      h.sqlite.db.prepare(`SELECT * FROM ${table}`).all(),
    );
  const before = snapshot();
  await assert.rejects(app.cancel(null, { id: task.id }), code("not_found"));
  await assert.rejects(app.get(null, { id: task.id }), code("not_found"));
  assert.deepEqual(await app.list(null), { jobs: [], totalSize: 0 });
  assert.deepEqual(snapshot(), before);
});
test("storage errors are typed and never disclose internal messages", async (t) => {
  const { app, h, input } = fixture(t);
  h.submitText = async () => {
    throw Error("private-path SQL secret");
  };
  await assert.rejects(app.submit(null, input()), code("unavailable"));
});
