import type { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { SQLiteOutbox } from "../agent-sdk/sqlite-outbox.ts";
import type { SQLiteInbox } from "../agent-sdk/sqlite-inbox.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import type { HabA2aRoute, HabExecutionEvidence } from "./hab-contract.ts";

export function createHabRelayRoute(options: {
  registry: SQLiteHabRegistry;
  context: unknown;
  sender: { agent_id: string; address: string };
  recipient: { agent_id: string; address: string };
  outbox: Pick<SQLiteOutbox, "agentId" | "enqueueGuarded" | "get">;
  senderTransport: { sendOnce(): Promise<void> };
  inbox: Pick<SQLiteInbox, "inbox">;
  evidence: HabExecutionEvidence;
}): HabA2aRoute {
  const { registry, outbox, senderTransport, inbox, evidence } = options;
  const sender = Object.freeze({ ...options.sender });
  const recipient = Object.freeze({ ...options.recipient });
  if (outbox.agentId !== sender.agent_id) throw new MessagingError("forbidden");
  const selected = registry.selectAddress(
    options.context,
    sender.address,
    sender.agent_id,
  );
  const assertCurrent = () => {
    registry.withRelay(selected, "submit", (authorization, agentId) => {
      const decision = authorization.authorize(
        selected,
        "submit",
        recipient.agent_id,
        "execution_request",
      );
      if (agentId !== sender.agent_id || decision?.agent_id !== sender.agent_id)
        throw new MessagingError("forbidden");
    });
    if (
      registry.resolve(selected, recipient.address).recipient_id !==
      recipient.agent_id
    )
      throw new MessagingError("forbidden");
  };
  assertCurrent();
  return Object.freeze<HabA2aRoute>({
    ownerId: sender.agent_id,
    senderId: sender.agent_id,
    recipientId: recipient.agent_id,
    evidence,
    assertCurrent,
    enqueue(message) {
      assertCurrent();
      if (
        message.recipient_id !== recipient.agent_id ||
        message.kind !== "execution_request"
      )
        throw new MessagingError("forbidden");
      return registry.withRelay(selected, "submit", (authorization, agentId) =>
        outbox.enqueueGuarded(message, () => {
          const decision = authorization.authorize(
            selected,
            "submit",
            recipient.agent_id,
            "execution_request",
          );
          if (
            agentId !== sender.agent_id ||
            decision?.agent_id !== sender.agent_id
          )
            throw new MessagingError("forbidden");
        }),
      );
    },
    delivery(messageId) {
      assertCurrent();
      return outbox.get(messageId);
    },
    async flush() {
      assertCurrent();
      try {
        await senderTransport.sendOnce();
      } finally {
        assertCurrent();
      }
    },
    replies(source) {
      assertCurrent();
      return inbox.inbox(source);
    },
  });
}
