import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SQLiteInbox } from "../../../src/agent-sdk/sqlite-inbox.ts";
import { DurableReceiver } from "../../../src/agent-sdk/receiver.ts";
import { habFixture } from "./hab-fixture.js";

export async function guardedJetStreamBackend(t, { serverBinary } = {}) {
  const f = await habFixture(t, { lease_ms: 500 }, serverBinary);
  const inboxes = new Set();
  t.after(() => {
    for (const store of inboxes) store.close();
  });
  return {
    id: "nats-jetstream-real-hab",
    agent: (name) => f.agents[name].agent_id,
    message: (to, patch) => f.message(to, patch),
    transport: f.transport,
    receiver(name, patch = {}) {
      const store = new SQLiteInbox(join(f.dir, `hab-inbox-${name}.sqlite`), {
        agent_id: f.agents[name].agent_id,
        fingerprint_key: new Uint8Array(32).fill(45),
        limits: f.options.limits,
        max_records: 100,
        max_body_bytes: 100000,
        max_ack_records: 100,
        ack_retry_ms: 10000,
        retry_base_ms: 1,
        retry_cap_ms: 10,
        max_attempts: 100,
      });
      store.migrate();
      inboxes.add(store);
      const receiver = new DurableReceiver(store, {
        ...f.transport(name),
        ...patch,
      });
      return {
        once: () => receiver.receiveOnce(),
        entries: () => receiver.inbox(),
        close() {
          if (inboxes.delete(store)) store.close();
        },
      };
    },
    restart: f.restart,
    disconnect: f.disconnect,
    reconnect: f.reconnect,
    faults: {
      ackRetryDue(name) {
        const raw = new DatabaseSync(join(f.dir, `hab-inbox-${name}.sqlite`));
        try {
          raw.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
        } finally {
          raw.close();
        }
      },
      leaseExpired() {
        const raw = f.journal();
        try {
          raw.exec(
            "UPDATE nats_messages SET lease_until=0,next_visible_at=0 WHERE state='leased'",
          );
        } finally {
          raw.close();
        }
      },
    },
  };
}
export { ackRequest } from "./fixture.js";
export const backends = [
  { id: "nats-jetstream-real-hab", create: guardedJetStreamBackend },
];
