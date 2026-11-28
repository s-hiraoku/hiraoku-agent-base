import { journey } from "../hab-journey-fixtures.js";
import { pendingBackends } from "./manifest.js";

export async function hostBackend(t) {
  const f = await journey(t);
  await f.enrollAll();
  return {
    id: "hab-host-sqlite",
    agent: (name) => f.agents[name].agent_id,
    message: (to, patch) => f.makeMessage(to, patch),
    transport: (name) => ({
      submit: (message) => f.client(name).submit(message),
      status: (id) => f.client(name).status(id),
      poll: () => f.client(name).poll(),
      ack: (request) => f.client(name).ack(request),
    }),
    restart: () => f.restart(),
    disconnect: () => f.net.stop(),
    reconnect: () => f.net.start(),
    faults: {
      leaseExpired: () => f.expireLeases(),
    },
  };
}

export const backends = [
  { id: "hab-host-sqlite", create: hostBackend },
  ...pendingBackends,
];

export function ackRequest(delivery, request_id) {
  return {
    sender_id: delivery.message.sender_id,
    message_id: delivery.message.message_id,
    generation: delivery.generation,
    lease_token: delivery.lease_token,
    request_id,
  };
}
