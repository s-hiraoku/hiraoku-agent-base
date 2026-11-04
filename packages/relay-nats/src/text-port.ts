import type { TextRelayPort } from "../../../src/generic-nats/protocol.ts";
import type { JetStreamRelay } from "./backend.ts";

export function jetStreamTextPort(
  backend: JetStreamRelay,
  context: unknown,
  agentId: string,
): TextRelayPort {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(agentId))
    throw Error("invalid_text_transport_identity");
  const port: TextRelayPort = {
    agentId,
    async submit(message) {
      const receipt = await backend.submit(context, message);
      if (
        receipt.sender_id !== agentId ||
        receipt.message_id !== message.message_id ||
        receipt.recipient_id !== message.recipient_id
      )
        throw Error("text_transport_identity_mismatch");
      return receipt;
    },
    async status(messageId) {
      const receipt = await backend.status(context, messageId);
      if (receipt.sender_id !== agentId || receipt.message_id !== messageId)
        throw Error("text_transport_identity_mismatch");
      return receipt;
    },
    async poll() {
      const delivery = await backend.poll(context);
      if (delivery && delivery.message.recipient_id !== agentId)
        throw Error("text_transport_identity_mismatch");
      return delivery;
    },
    async ack(request) {
      const receipt = await backend.ack(context, request);
      if (
        receipt.recipient_id !== agentId ||
        receipt.sender_id !== request.sender_id ||
        receipt.message_id !== request.message_id ||
        receipt.request_id !== request.request_id
      )
        throw Error("text_transport_identity_mismatch");
      return receipt;
    },
  };
  return Object.freeze(port);
}
