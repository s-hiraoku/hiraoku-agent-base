/** Synthetic owner composition. Private test controls are never MCP tools or product policy. */
import process from "node:process";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "node:timers";
import { useParentTestBroker } from "./jetstream-delivery.js";
import { hostFixture, limits } from "./adapter-host-fixtures.js";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { startSingleSourceRecipientStdio } from "../src/adapter-host/stdio.ts";

const directory = process.env.HAB_TEST_SINGLE_SOURCE_DIRECTORY;
const drainTest = process.env.HAB_TEST_SINGLE_SOURCE_MODE === "drain";
const write = (name, value) => {
  const path = join(directory, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
const cleanup = [];
const watchdog = setTimeout(() => process.exit(2), 25000);
process.once("SIGTERM", () => {
  process.stderr.write("SINGLE_SOURCE_SIGTERM\n", () => process.exit(3));
});
// Do not stop on EOF here: the production composition must observe it itself.
process.stdin.once("end", () => process.stderr.write("SINGLE_SOURCE_EOF\n"));
useParentTestBroker(JSON.parse(readFileSync(join(directory, "broker.json"), "utf8")));
const f = await hostFixture({ after: (action) => cleanup.push(action) }, {}, { outboxLeaseMs: 5000 });
// This test is about stdio/lifecycle, so leave generous leases under CI contention.
f.state.timeout_ms = 5000;
const submitted = f.submit("question", {
  body: { parts: [{ type: "text", text: "Synthetic single-source stdio question" }] },
});
const journal = new SQLiteAnswerJournal(join(f.dir, "single-source-answers.sqlite"), {
  agent_id: "b", fingerprint_key: new Uint8Array(32).fill(72), limits,
  max_records: 20, max_body_bytes: 100000, max_clock_skew_ms: 1000,
});
journal.migrate();
cleanup.push(() => journal.close());
const owner = new SQLiteHostOwner(join(f.dir, "single-source-owner.sqlite"), {
  agent_id: "b", fingerprint_key: new Uint8Array(32).fill(73),
});
owner.migrate();
owner.acquire(() => {});
cleanup.push(() => owner.close());
const entry = await startSingleSourceRecipientStdio({
  hostOptions: f.hostOptions({ owner, answer_intents: journal }),
  actorId: "synthetic-stdio-owner", verifiedRecipientContext: {}, verifiedOperatorContext: {},
  source: submitted.key, shutdownTimeoutMs: drainTest ? 100 : 1000,
  lifetimeMs: Number(process.env.HAB_TEST_SINGLE_SOURCE_LIFETIME_MS ?? 15000),
});
write("ready.json", { source: submitted.key, message: submitted.message, status: entry.status() });
let releaseNetwork, resolveRetry;
const retriedStop = new Promise((resolve) => { resolveRetry = resolve; });
const completion = entry.completion.catch((error) => {
  if (!drainTest) throw error;
  write("stop-failed.json", { error: error.message, status: entry.status() });
  return retriedStop;
});
let lastCommand = 0;
const commands = setInterval(async () => {
  const path = join(directory, "command.json");
  if (!existsSync(path)) return;
  const request = JSON.parse(readFileSync(path, "utf8"));
  if (request.id === lastCommand) return;
  lastCommand = request.id;
  try {
    let value;
    switch (request.op) {
      case "grant":
        value = entry.updatePermission(entry.status().epoch, true);
        break;
      case "revoke":
        value = entry.updatePermission(entry.status().epoch, false);
        break;
      case "resume":
        value = entry.resume(entry.status().epoch);
        break;
      case "pause":
        value = entry.pause(entry.status().epoch);
        break;
      case "state":
        value = { status: entry.status(), outbox: f.queued(), taskCount: f.count(),
          inboxCount: f.inboxRaw.prepare("SELECT count(*) n FROM relay_inbox").get().n };
        break;
      case "hold": {
        if (!drainTest) throw Error("invalid_synthetic_command");
        const pending = new Promise((resolve) => { releaseNetwork = resolve; });
        f.state.afterNetwork = async () => {
          write("network-entered.json", { entered: true });
          await pending;
        };
        value = true;
        break;
      }
      case "release":
        if (!drainTest || !releaseNetwork) throw Error("invalid_synthetic_command");
        f.state.afterNetwork = null;
        releaseNetwork();
        value = true;
        break;
      case "stop":
        if (!drainTest) throw Error("invalid_synthetic_command");
        try {
          await entry.stop();
          value = { stopped: true };
          resolveRetry();
        } catch (error) {
          value = { stopped: false, error: error.message, status: entry.status() };
        }
        break;
      case "reply": {
        const delivery = await f.service.poll(f.contexts.a);
        assert.deepEqual(delivery.message.in_reply_to, submitted.key);
        assert.equal(delivery.message.body.parts[0].text, "Synthetic single-source stdio answer");
        assert.equal(f.queued().length, 1);
        value = delivery.message;
        break;
      }
      default: throw Error("invalid_synthetic_command");
    }
    write("response.json", { id: request.id, ok: true, value });
  } catch (error) {
    write("response.json", { id: request.id, ok: false, error: error.message });
  }
}, 10);
try {
  await completion;
  const state = entry.status();
  assert.equal(state.paused, true);
  assert.equal(state.running, false);
  assert.equal(state.draining, 0);
  assert.equal(state.owner, "lost"); // releaseOwner has completed before store close.
  clearInterval(commands);
  for (const action of cleanup.reverse()) await action();
  clearTimeout(watchdog);
  write("cleanup.json", { paused: state.paused, running: state.running,
    draining: state.draining, ownerReleased: state.owner === "lost", storesClosed: true });
  process.stderr.write("SINGLE_SOURCE_CLEANUP_OK\n", () => process.exit(0));
} catch {
  clearInterval(commands);
  // A failed stop must retain state; the owning parent reclaims this synthetic scratch.
  process.stderr.write("SINGLE_SOURCE_CLEANUP_FAILED\n", () => process.exit(1));
}
