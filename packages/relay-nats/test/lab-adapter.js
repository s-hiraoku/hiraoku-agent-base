import { DatabaseSync } from "node:sqlite";
import { fixture } from "./fixture.js";

export async function jetstreamBackend(t) {
  const f = await fixture(t);
  const raw = new DatabaseSync(f.options.journal_path);
  t.after(() => raw.close());
  const receiver = f.receiver.bind(f);
  return {
    id: "nats-jetstream",
    agent: (name) => name,
    message: (to, patch) => f.message(to, patch),
    transport: f.transport.bind(f),
    receiver,
    restart: () => f.restart(),
    disconnect: () => f.stop(),
    async reconnect() {
      await f.close(f.backend);
      await f.start();
      await f.open();
    },
    faults: {
      ackRetryDue(name) {
        const inbox = new DatabaseSync(`${f.dir}/inbox-${name}.sqlite`);
        try {
          inbox.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
        } finally {
          inbox.close();
        }
      },
      leaseExpired() {
        raw.exec(
          "UPDATE nats_messages SET lease_until=0,next_visible_at=0 WHERE state='leased'",
        );
      },
    },
  };
}
export { ackRequest } from "./fixture.js";
export const backends = [{ id: "nats-jetstream", create: jetstreamBackend }];
