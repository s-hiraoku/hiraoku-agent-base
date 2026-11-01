import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskState } from "@a2a-js/sdk";
import {
  createA2aRelayFixture,
  a2aRequest,
  worker,
  RESPONSE,
} from "../test/a2a-relay-fixtures.js";

const args = process.argv.slice(2);
const values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--output", "--contracts"].includes(args[i]) ||
    !args[i + 1] ||
    values.has(args[i])
  )
    throw Error(
      "Use --output <new-directory> and optional --contracts <common-test-file>",
    );
  values.set(args[i], args[i + 1]);
}
if (!values.has("--output"))
  throw Error("An explicit --output directory is required");
const output = resolve(values.get("--output"));
mkdirSync(output, { mode: 0o700 });
const scratch = join(realpathSync(output), "tmp");
mkdirSync(scratch, { mode: 0o700 });
process.env.TMPDIR = scratch;
const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sourcePaths = [
  ...readdirSync(join(root, "src/a2a")).map((name) => `src/a2a/${name}`),
  "test/a2a-relay-fixtures.js",
  "test/a2a-relay-e2e.test.js",
  "scripts/prove-a2a-relay.mjs",
  "package-lock.json",
].sort();
const checks = [];
const hooks = [];
const report = {
  schema: "hab-a2a-relay-proof-v1",
  synthetic_only: true,
  backend: "sqlite",
  status: "running",
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  git_dirty: Boolean(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  ),
  source_sha256: Object.fromEntries(
    sourcePaths.map((path) => [path, sha(join(root, path))]),
  ),
  ...(values.has("--contracts")
    ? {
        common_contracts: {
          sha256: sha(resolve(values.get("--contracts"))),
          execution: "not_run_by_this_proof",
        },
      }
    : {}),
  checks,
};
let fixture;
let failure;
try {
  fixture = await createA2aRelayFixture({ after: (hook) => hooks.push(hook) });
  const f = fixture;
  const first = await f.client.sendMessage(
    a2aRequest("finite_proof"),
    f.options,
  );
  const source = f.sourceOf(first);
  assert.equal(first.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(f.count(), 0);
  checks.push(
    "A2A request stores one original Relay envelope without engine execution",
  );
  await f.recipient.receiveOnce();
  const receipt = await f.receipt(first);
  assert.equal(receipt.state, "acked");
  assert.equal(f.recipientEntries()[0].receipt_confirmed, true);
  assert.equal(f.count(), 0);
  assert.equal(
    (await f.client.getTask({ id: first.id }, f.options)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  checks.push(
    "recipient durable storage ACK does not accept or complete execution",
  );
  f.recipient.accept(f.operator, source);
  await f.recipient.submitOnce(f.operator, source);
  await f.recipient.submitOnce(f.operator, source);
  assert.equal(f.count(), 1);
  f.recipient.replyOnce(f.operator, source, "execution_accepted");
  await f.sendReply();
  await f.receiveResult();
  const claimed = await f.hub.claim(worker);
  await f.hub.complete(worker, {
    id: claimed.id,
    fence: claimed.fence,
    state: "succeeded",
    result: RESPONSE,
  });
  const waiting = await f.client.getTask({ id: first.id }, f.options);
  assert.notEqual(waiting.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(waiting.artifacts, []);
  assert.equal(JSON.stringify(waiting).includes(RESPONSE), false);
  checks.push(
    "explicit acceptance starts exactly one Task and result remains private before reply",
  );
  await f.recipient.observeOnce(f.operator, source);
  f.recipient.replyOnce(f.operator, source, "execution_result");
  await f.sendReply();
  await f.receiveResult();
  const complete = await f.client.getTask({ id: first.id }, f.options);
  assert.equal(complete.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(complete.artifacts[0].parts[0].content.value, RESPONSE);
  const envelope = complete.metadata.hab_relay.source;
  await f.restart();
  const durable = await f.client.getTask({ id: first.id }, f.options);
  const replay = await f.client.sendMessage(
    a2aRequest("finite_proof"),
    f.options,
  );
  assert.equal(replay.id, first.id);
  assert.deepEqual(replay.metadata.hab_relay.source, envelope);
  assert.equal(durable.artifacts[0].parts[0].content.value, RESPONSE);
  assert.equal(f.count(), 1);
  checks.push(
    "all owned stores reopen with the original Task, envelope and Artifact",
  );
  report.counts = {
    engine_tasks: f.count(),
    relay_messages: f.relayRows().length,
    recipient_inbox: f.recipientEntries().length,
    origin_inbox: f.originEntries().length,
    artifacts: durable.artifacts.length,
    uncertain_intents: f.unresolvedIntents(),
  };
  assert.equal(report.counts.uncertain_intents, 0);
  report.correlation = {
    a2a_task: first.id,
    a2a_context: first.contextId,
    relay_message: source.message_id,
    relay_thread: envelope.thread_id,
    relay_receipt: receipt.receipt_id,
    first_sent_at: envelope.first_sent_at,
    expires_at: envelope.expires_at,
  };
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  failure = error;
} finally {
  for (const hook of hooks.reverse()) await hook();
  if (fixture) {
    for (const url of [
      `${fixture.base}/.well-known/agent-card.json`,
      fixture.relayUrl,
    ]) {
      await assert.rejects(() =>
        globalThis.fetch(url, { signal: AbortSignal.timeout(1000) }),
      );
    }
    report.cleanup = {
      owned_http_ports_closed: 2,
      owned_fixture_stores_closed: true,
      global_process_inventory: "not_measured",
    };
  }
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}
if (failure) throw failure;
process.stdout.write(
  JSON.stringify({
    status: report.status,
    commit: report.commit,
    counts: report.counts,
    report: join(output, "report.json"),
  }) + "\n",
);
