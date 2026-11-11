/** Concurrent SQLite claim fixture; every owner check is serviced by the parent's actual held host. */
import { parentPort, workerData } from "node:worker_threads";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { SQLiteSourceLaunchJournal } from "../src/owner-integrations/source-launch-journal.ts";
const gate = new Int32Array(workerData.gate);
const checkOwner = () => {
  Atomics.store(gate, 0, 0); parentPort.postMessage({ type: "owner-check" });
  if (Atomics.wait(gate, 0, 0, 2000) === "timed-out" || Atomics.load(gate, 0) !== 1) throw Error("synthetic_owner_unavailable");
};
const inbox = new SQLiteInbox(workerData.inboxPath, workerData.inboxOptions);
inbox.migrate();
const context = {};
const journal = new SQLiteSourceLaunchJournal(workerData.journalPath, {
  ...workerData.journalOptions, inbox, checkOwner,
  authorization: ctx => ctx === context ? { agent_id: workerData.journalOptions.agent_id,
    actor_id: "synthetic-actor", authority_epoch: "scope-1" } : undefined,
});
journal.migrate(); parentPort.postMessage({ type: "ready" });
parentPort.once("message", () => {
  try { parentPort.postMessage({ type: "result", value: journal.claim(context, workerData.source) }); }
  finally { journal.close(); inbox.close(); parentPort.close(); }
});
