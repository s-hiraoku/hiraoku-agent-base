import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  fixture as deliveryFixture,
  message,
  limits,
} from "./mcp-http-fixtures.js";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";
export { limits };
export const code = (wanted) => (error) =>
  error.code === wanted || error.message === wanted;
/** A delivery fixture with recipient b's durable inbox. */
export async function fixture(t) {
  const f = await deliveryFixture(t),
    inbox = new SQLiteInbox(join(f.dir, "bridge-inbox.sqlite"), {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(44),
      limits,
      max_records: 20,
      max_body_bytes: 100000,
      max_ack_records: 40,
      ack_retry_ms: 86400000,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      max_attempts: 3,
    });
  inbox.migrate();
  const state = { enabled: true, denied: new Set() },
    context = Symbol("explicit-acceptance");
  const authorize = (ctx, op) =>
    ctx === context && state.enabled && !state.denied.has(op)
      ? { receiver_id: "b", actor_id: "synthetic-operator" }
      : undefined;
  const receive = (patch = {}, ack = true) => {
    const v = {
      ...message(),
      kind: "execution_request",
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 1,
            value: { task_type: "connectivity_check" },
          },
        ],
      },
      ...patch,
    };
    v.message_id = makeReplayBoundMessageId(
      v.first_sent_at,
      randomUUID().replaceAll("-", ""),
    );
    f.service.submit(f.contexts.a, v);
    const delivery = f.service.poll(f.contexts.b);
    inbox.save(delivery);
    if (ack) {
      const request = inbox.claimAck();
      inbox.confirmAck(request, f.service.ack(f.contexts.b, request));
    }
    return { sender_id: "a", message_id: v.message_id };
  };
  t.after(() => {
    inbox.close();
  });
  return { ...f, inbox, state, context, authorize, receive };
}
