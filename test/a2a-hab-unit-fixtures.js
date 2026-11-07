import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { SendMessageRequest } from "@a2a-js/sdk";
import { HabA2aHandler, habRelayAgentCard } from "../src/a2a/hab-adapter.ts";
import { MessagingError } from "../src/messaging/delivery-service.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";
import { RESPONSE } from "../src/types.ts";
export { RESPONSE };
export const request = (messageId = "first", text = "connectivity_check") =>
  SendMessageRequest.fromJSON({
    message: { messageId, role: "ROLE_USER", parts: [{ text }] },
    configuration: { returnImmediately: true },
  });
export const context = (owner = "sender-a") =>
  new ServerCallContext({
    requestedVersion: "1.0",
    user: { isAuthenticated: true, userName: owner },
  });
export function fixture() {
  const store = new InMemoryTaskStore();
  const state = {
    allowed: true,
    records: new Map(),
    entries: [],
    flushError: undefined,
    enqueueCalls: 0,
    flushCalls: 0,
    verifyCalls: 0,
    evidence: {
      id: "engine-task",
      owner: "synthetic-owner",
      destination: "hermes",
      request_key: "br_" + "a".repeat(32),
      task_type: "connectivity_check",
      state: "queued",
      execution_open: 0,
      fence: 0,
      result: null,
    },
  };
  const makeRoute = (ownerId = "sender-a") => ({
    ownerId,
    senderId: ownerId,
    recipientId: "recipient-b",
    assertCurrent() {
      if (!state.allowed) throw new MessagingError("forbidden");
    },
    enqueue(message) {
      state.enqueueCalls++;
      const previous = state.records.get(message.message_id);
      if (previous)
        assert.equal(JSON.stringify(message), JSON.stringify(previous.message));
      else
        state.records.set(message.message_id, {
          message: structuredClone(message),
          state: "queued",
          receipt: null,
        });
      return this.delivery(message.message_id);
    },
    delivery(id) {
      const record = state.records.get(id);
      if (!record) throw new MessagingError("not_found");
      return {
        message_id: id,
        recipient_id: record.message.recipient_id,
        expires_at: record.message.expires_at,
        state: record.state,
        submit_attempts: 0,
        status_attempts: 0,
        reason: null,
        receipt: record.receipt,
      };
    },
    async flush() {
      state.flushCalls++;
      if (state.flushError) throw state.flushError;
    },
    replies: () => state.entries,
    evidence: {
      binding: {
        engine_id: "synthetic-engine",
        owner_subject: "synthetic-owner",
        client_id: null,
      },
      async verify(source, recipient, id) {
        state.verifyCalls++;
        assert.ok(state.records.has(source.message_id));
        assert.equal(recipient, "recipient-b");
        assert.equal(id, state.evidence.id);
        return {
          request_key: state.evidence.request_key,
          task: structuredClone(state.evidence),
        };
      },
    },
  });
  const route = makeRoute();
  const handler = new HabA2aHandler(
    habRelayAgentCard("http://127.0.0.1:12345/a2a"),
    store,
    (ctx) =>
      ctx.user.userName === "sender-a" ? route : makeRoute(ctx.user.userName),
  );
  const reply = (task, kind = "execution_accepted", patch = {}) => {
    const source = task.metadata.hab_relay.source;
    const first = new Date().toISOString();
    const value =
      kind === "execution_accepted"
        ? { task_type: "connectivity_check", task_id: state.evidence.id }
        : {
            task_type: "connectivity_check",
            task_id: state.evidence.id,
            state: state.evidence.state,
            result: state.evidence.result,
          };
    const entry = {
      sender_id: "recipient-b",
      received_at: first,
      receipt_confirmed: true,
      message: {
        version: 1,
        message_id: makeReplayBoundMessageId(
          first,
          randomUUID().replaceAll("-", ""),
        ),
        recipient_id: task.metadata.hab_relay.sender_id,
        kind,
        thread_id: source.thread_id,
        in_reply_to: {
          sender_id: task.metadata.hab_relay.sender_id,
          message_id: source.message_id,
        },
        first_sent_at: first,
        expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
        body: {
          parts: [
            {
              type: "data",
              schema_id: `task.${kind}`,
              schema_version: 1,
              value,
            },
          ],
        },
        ...patch,
      },
    };
    state.entries.push(entry);
    return entry;
  };
  return { store, state, route, handler, reply };
}
