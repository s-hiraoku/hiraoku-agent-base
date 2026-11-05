import { relayBackend, ackRequest } from "../delivery-lab/backends.js";
import { guardedJetStreamBackend } from "../../packages/relay-nats/test/hab-lab-adapter.js";
export { ackRequest };
export const backends = [
  { id: "hab-host-jetstream", create: relayBackend },
  { id: "nats-jetstream-real-hab", create: guardedJetStreamBackend },
];
