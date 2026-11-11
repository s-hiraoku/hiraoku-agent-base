/** Synthetic authorities, actual held host/SQLite, no transport or native process. */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { syntheticStores } from "./external-owner-fixture.js";
import { AdapterHostCycle } from "../src/adapter-host/cycle.ts";
import { SQLiteSourceLaunchJournal } from "../src/owner-integrations/source-launch-journal.ts";
import { message, limits } from "./relay-http-fixtures.js";
export function sourceFixture(directory, patch = {}) {
  const stores = syntheticStores(directory), context = {}, operator = {};
  const inbox = stores.binding.hostOptions.inbox;
  const state = { allowed: true, actor: "synthetic-actor", epoch: "scope-1", held: true, calls: 0, beforeAuthority: null };
  const host = new AdapterHostCycle({ ...stores.binding.hostOptions,
    authorization: ctx => ctx === operator ? { agent_id: "synthetic-recipient", actor_id: "synthetic-operator" } : undefined });
  const authorization = (ctx, _op, source) => {
    state.calls++; state.beforeAuthority?.();
    return ctx === context && state.allowed && source.sender_id === "synthetic-peer"
      ? { agent_id: "synthetic-recipient", actor_id: state.actor, authority_epoch: state.epoch } : undefined;
  };
  const checkOwner = () => {
    const value = host.status(operator);
    if (!state.held || value.owner !== "held" || value.running || value.draining) throw Error("synthetic_owner_lost");
  };
  const options = { agent_id: "synthetic-recipient", policy_id: "synthetic-approved-source-policy", fingerprint_key: new Uint8Array(32).fill(81),
    limits, max_records: 20, inbox, authorization, checkOwner, ...patch };
  const path = join(directory, "source-launch.sqlite"), journals = new Set();
  const open = (extra = {}, filename = path) => {
    const journal = new SQLiteSourceLaunchJournal(filename, { ...options, ...extra }); journals.add(journal); return journal;
  };
  const journal = open(); journal.migrate();
  const receive = ({ kind = "question", confirmed = true, sender = "synthetic-peer", patch = {} } = {}) => {
    const m = { ...message(randomUUID().replaceAll("-", "")), recipient_id: "synthetic-recipient", kind,
      in_reply_to: ["answer", "execution_result"].includes(kind) ? { sender_id: "synthetic-recipient", message_id: "synthetic-origin" } : null, ...patch };
    inbox.save({ message: { ...m, sender_id: sender }, generation: 1,
      lease_token: "s".repeat(43), lease_until: new Date(Date.now() + 60000).toISOString() });
    const request = inbox.claimAck();
    if (confirmed) inbox.confirmAck(request, { recipient_id: "synthetic-recipient", sender_id: sender, message_id: m.message_id,
      request_id: request.request_id, receipt_id: randomUUID(), acked_at: new Date().toISOString(), state: "acked" });
    return { sender_id: sender, message_id: m.message_id };
  };
  return { state, context, operator, host, stores, journal, open, path, receive, inbox, options,
    close() { for (const j of journals) j.close(); stores.close(); } };
}
