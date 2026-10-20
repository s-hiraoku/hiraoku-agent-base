import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { RelayService } from "../src/relay/service.ts";
import {
  makeReplayBoundMessageId,
  parseSubmission,
} from "../src/relay/contract.ts";
import { limits } from "./relay-http-fixtures.js";
export function fixture(t, changes = {}, capacity = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-agent-capacity-")),
    path = join(dir, "relay.sqlite"),
    stores = new Set();
  const options = {
    fingerprint_key: new Uint8Array(32).fill(112),
    max_pending: 6,
    max_records: 12,
    max_pending_per_recipient: 6,
    max_body_bytes: 10000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    poll_scan_limit: 10,
    ...changes,
  };
  options.agent_capacity = {
    max_pending_per_sender: Math.min(4, options.max_pending),
    max_body_bytes_per_sender: Math.min(6000, options.max_body_bytes),
    max_records_per_sender: Math.min(8, options.max_records),
    max_body_bytes_per_recipient: Math.min(9000, options.max_body_bytes),
    max_records_per_recipient: options.max_records,
    reservations: [
      {
        sender_id: "b",
        pending: 2,
        body_bytes: Math.min(1500, options.max_body_bytes),
        records: 2,
      },
    ],
    ...capacity,
  };
  const open = (patch = {}) => {
    const s = new SQLiteRelayStore(path, { ...options, ...patch });
    stores.add(s);
    s.migrate();
    return s;
  };
  const store = open(),
    raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const close = (s) => {
    s.close();
    stores.delete(s);
  };
  const contexts = {},
    identities = new Map(),
    active = new Set(["a", "b", "c", "d", "sink", "other", "operator"]);
  for (const who of active) {
    contexts[who] = Symbol("verified-" + who);
    identities.set(contexts[who], who);
  }
  const state = { blocked: new Set() };
  const authorization = {
    authorize(ctx, operation, peer) {
      const who = identities.get(ctx);
      if (!who || !active.has(who)) return undefined;
      if (operation === "maintenance")
        return who === "operator" ? { agent_id: who } : undefined;
      if (
        who === "operator" ||
        (operation === "poll" && peer && state.blocked.has(peer))
      )
        return undefined;
      return { agent_id: who };
    },
  };
  const serviceFor = (s) => new RelayService(s, limits, authorization),
    service = serviceFor(store);
  let seq = 0;
  const message = (
    sender = "a",
    recipient = "sink",
    text = "Synthetic message",
    first = new Date(Date.now() - 100).toISOString(),
  ) => ({
    version: 1,
    message_id: makeReplayBoundMessageId(
      first,
      (++seq).toString(16).padStart(32, "0"),
    ),
    recipient_id: recipient,
    kind: "question",
    first_sent_at: first,
    expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
    thread_id: "thread-" + [sender, recipient].sort().join("-"),
    in_reply_to: null,
    body: { parts: [{ type: "text", text }] },
  });
  const send = (who = "a", m = message(who)) =>
    service.submit(contexts[who], m);
  const ack = (receiver = "sink", s = service) => {
    const d = s.poll(contexts[receiver]);
    if (!d) return null;
    s.ack(contexts[receiver], {
      sender_id: d.message.sender_id,
      message_id: d.message.message_id,
      generation: d.generation,
      lease_token: d.lease_token,
      request_id: randomUUID(),
    });
    return d;
  };
  const usage = (who) =>
    raw
      .prepare(
        "SELECT count(*) records,coalesce(sum(CASE WHEN state IN ('pending','leased','quarantined') THEN 1 ELSE 0 END),0) pending,coalesce(sum(body_bytes),0) body_bytes FROM relay_messages WHERE sender_id=?",
      )
      .get(who);
  return {
    dir,
    path,
    options,
    store,
    raw,
    open,
    close,
    contexts,
    active,
    state,
    authorization,
    serviceFor,
    service,
    message,
    send,
    ack,
    usage,
    size: (m) => Buffer.byteLength(JSON.stringify(parseSubmission(m, limits))),
  };
}
export { limits };
