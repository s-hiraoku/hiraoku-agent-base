/** Synthetic denied host only: real private SQLite, no broker, product, model or network adapter. */
import { join } from "node:path";
import { SQLiteHostOwner } from "../src/adapter-host/sqlite-owner.ts";
import { SQLiteHostControl } from "../src/adapter-host/sqlite-control.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { SQLiteOutbox } from "../src/agent-sdk/sqlite-outbox.ts";
import { SQLiteReplyBudget } from "../src/adapter-policy/sqlite-reply-budget.ts";
import { SQLiteAnswerJournal } from "../src/answer-intents/sqlite-journal.ts";
import { limits } from "./relay-http-fixtures.js";
export const syntheticToken = "synthetic_only_external_owner_not_native_proof_12345";

export function syntheticStores(directory) {
  const common = { agent_id: "synthetic-recipient", fingerprint_key: new Uint8Array(32).fill(79), limits,
    max_records: 20, max_body_bytes: 100000, max_clock_skew_ms: 1000, retry_base_ms: 1, retry_cap_ms: 10 };
  const owner = new SQLiteHostOwner(join(directory, "owner.sqlite"), common);
  const control = new SQLiteHostControl(join(directory, "control.sqlite"), { ...common, max_audit_records: 20 });
  const inbox = new SQLiteInbox(join(directory, "inbox.sqlite"), { ...common, max_ack_records: 40, ack_retry_ms: 86400000, max_attempts: 3 });
  const outbox = new SQLiteOutbox(join(directory, "outbox.sqlite"), { ...common, lease_ms: 5000, max_submit_attempts: 3, max_status_attempts: 3, status_retry_ms: 86400000 });
  const budget = new SQLiteReplyBudget(join(directory, "budget.sqlite"), { ...common, max_thread_replies: 8, max_per_window: 20, window_ms: 60000 });
  const answers = new SQLiteAnswerJournal(join(directory, "answers.sqlite"), common);
  const stores = [owner, control, inbox, outbox, budget, answers];
  for (const store of stores) store.migrate();
  owner.acquire(() => {});
  let closed = false, network = 0;
  return {
    control, owner, network: () => network,
    binding: { hostOptions: { owner, control, inbox, outbox, budget, answer_intents: answers, limits,
      transport: () => { network++; throw Error("synthetic_deny_only_network_forbidden"); } },
      actorId: "synthetic-owner", verifiedRecipientContext: {}, verifiedOperatorContext: {},
      source: { sender_id: "synthetic-peer", message_id: "synthetic-fixed-question" } },
    close() { if (!closed) { for (const store of stores.toReversed()) store.close(); closed = true; } },
  };
}
