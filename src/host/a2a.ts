/**
 * Optional A2A entry owned by the host. The host has its own Registry address and
 * durable mailbox; A2A Tasks are sent from that identity and recipients reply to it.
 *
 * - Identity: `a2a.identity` is provisioned at start through a provisioning-only
 *   administrator port. Each step reads current Registry state and applies only the
 *   difference, so a restart or a crash mid-way converges on the same agent.
 * - Credentials: none on any wire. The host identity is an in-process context that only
 *   this module holds, attested as the reserved `urn:hab:host` principal. Operator or
 *   OAuth principals with that issuer are refused by the host's Registry authority.
 * - Authorization: every A2A request is verified with the caller's own credential, and
 *   the caller must currently hold resolve+submit rights to the configured recipient for
 *   `execution_request`. The host identity therefore never reaches a recipient its caller
 *   could not. Each Task and its replies are scoped to the caller's agent ID.
 * - Durability: outbox, inbox and SDK Task store are private SQLite files in the host
 *   directory. Delivery of a saved intent happens only inside its owner's authorized
 *   request (SendMessage, repeated to retry); a background retry would send without a
 *   current owner check. Only the receiver loop (poll, save, then ACK) runs in background.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { DurableReceiver } from "../agent-sdk/receiver.ts";
import type { InboxEntry } from "../agent-sdk/receiver.ts";
import { DurableSender } from "../agent-sdk/sender.ts";
import { SQLiteOutbox } from "../agent-sdk/sqlite-outbox.ts";
import { SQLiteInbox } from "../agent-sdk/sqlite-inbox.ts";
import { MessagingError } from "../messaging/delivery-service.ts";
import type { ContractLimits } from "../messaging/contract.ts";
import type { SQLiteHabRegistry } from "../hab/sqlite-registry.ts";
import type { HabMcpService } from "../hab/mcp.ts";
import { parseHabAddress } from "../hab/registry.ts";
import type {
  AdminOperation,
  AgentOperation,
  AgentRecord,
  IndividualPrincipal,
} from "../hab/registry.ts";
import { openA2aTaskStore } from "../a2a/store.ts";
import { habHostAgentCard } from "../a2a/hab-adapter.ts";
import { createHabA2aGateway } from "../a2a/hab-http.ts";
import { createA2aNodeHandler } from "../a2a/http-node.ts";
import type { HabA2aRoute } from "../a2a/hab-contract.ts";
import type { RelayHttpVerifier } from "./mcp/http.ts";
import type { HostA2aConfig } from "./config.ts";

export const HOST_A2A_ISSUER = "urn:hab:host";
const hostPrincipal: IndividualPrincipal = Object.freeze({
  issuer: HOST_A2A_ISSUER,
  audience: "urn:hab:host:a2a",
  subject: "a2a-identity",
  client_id: "hab-host",
  connection_id: "host-a2a",
});
const hostOperations: AgentOperation[] = ["ack", "poll", "status", "submit"];
export const provisioningOperations: ReadonlySet<AdminOperation> = new Set([
  "inspect",
  "product",
  "enroll",
  "bind",
  "access",
]);

/** Refusal with a fixed reason code that the host start reports as-is. */
export class HostA2aError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "HostA2aError";
  }
}

const request = () => `host-a2a-${randomUUID()}`;

/**
 * Converges the configured address onto an active agent whose only live binding is the
 * host principal. A retired, stopped or revoked identity, or one an operator credential
 * can also authenticate, is refused rather than repaired.
 */
export function provisionHostA2aIdentity(
  registry: SQLiteHabRegistry,
  admin: unknown,
  identityAddress: string,
): AgentRecord {
  const target = parseHabAddress(identityAddress);
  const find = () =>
    registry
      .overview(admin)
      .agents.find((agent) => agent.address === target.address);
  if (!find()) {
    let product = registry
      .overview(admin)
      .products.find((p) => p.agent_name === target.agent_name);
    product ??= registry.registerProduct(admin, {
      request_id: request(),
      agent_name: target.agent_name,
    });
    registry.enroll(admin, {
      request_id: request(),
      product_id: product.product_id,
      bot_name: target.bot_name,
    });
  }
  let agent = find()!;
  if (agent.state === "retired") throw new HostA2aError("a2a_identity_retired");
  if (agent.group_id) throw new HostA2aError("a2a_identity_conflict");
  const reservation = registry.findPrincipal(admin, hostPrincipal);
  if (reservation) {
    if (reservation.kind !== "agent" || reservation.owner_id !== agent.agent_id)
      throw new HostA2aError("a2a_identity_conflict");
    if (reservation.state !== "active")
      throw new HostA2aError("a2a_identity_revoked");
  } else {
    if (agent.active_binding_ids.length)
      throw new HostA2aError("a2a_identity_conflict");
    registry.bind(admin, {
      request_id: request(),
      agent_id: agent.agent_id,
      expected_epoch: registry.inspect(admin, agent.agent_id).epoch,
      principal: hostPrincipal,
    });
    agent = find()!;
  }
  if (agent.active_binding_ids.length !== 1)
    throw new HostA2aError("a2a_identity_conflict");
  if (agent.state === "stopped") throw new HostA2aError("a2a_identity_stopped");
  const current = registry.inspect(admin, agent.agent_id);
  if (
    current.state !== "active" ||
    current.operations.join() !== hostOperations.join()
  )
    return registry.setAccess(admin, {
      request_id: request(),
      agent_id: current.agent_id,
      expected_epoch: current.epoch,
      state: "active",
      operations: hostOperations,
    });
  return current;
}

/** The verified descriptor for the in-process host context. */
export function hostA2aIndividual(maxContextMs: number) {
  return {
    principal: { ...hostPrincipal },
    expires_at: new Date(
      Date.now() + Math.min(1000, maxContextMs),
    ).toISOString(),
  };
}

/** Per-request route: the caller is checked by the Registry; the host identity sends. */
function hostRoute(options: {
  registry: SQLiteHabRegistry;
  context: unknown;
  identity: AgentRecord;
  recipient: string;
  outbox: SQLiteOutbox;
  sender: DurableSender;
  inbox: SQLiteInbox;
}): HabA2aRoute {
  const { registry, context, identity, outbox, sender, inbox } = options;
  const recipientId = registry.resolve(context, options.recipient).recipient_id;
  const caller = () =>
    registry.withRelay(context, "submit", (authorization, agentId) => {
      if (
        agentId === identity.agent_id ||
        authorization.authorize(
          context,
          "submit",
          recipientId,
          "execution_request",
        )?.agent_id !== agentId
      )
        throw new MessagingError("forbidden");
      return agentId;
    });
  const ownerId = caller();
  const assertCurrent = () => {
    if (
      registry.resolve(context, options.recipient).recipient_id !==
        recipientId ||
      caller() !== ownerId
    )
      throw new MessagingError("forbidden");
  };
  return Object.freeze<HabA2aRoute>({
    ownerId,
    senderId: identity.agent_id,
    recipientId,
    assertCurrent,
    enqueue(message) {
      assertCurrent();
      if (
        message.recipient_id !== recipientId ||
        message.kind !== "execution_request"
      )
        throw new MessagingError("forbidden");
      return registry.withRelay(context, "submit", (authorization, agentId) =>
        outbox.enqueueGuarded(message, () => {
          if (
            agentId !== ownerId ||
            authorization.authorize(
              context,
              "submit",
              recipientId,
              "execution_request",
            )?.agent_id !== ownerId
          )
            throw new MessagingError("forbidden");
        }),
      );
    },
    delivery(messageId) {
      assertCurrent();
      return outbox.get(messageId);
    },
    async flush(messageId) {
      assertCurrent();
      try {
        await sender.sendOnce(messageId);
      } finally {
        assertCurrent();
      }
    },
    replies() {
      assertCurrent();
      return inbox.inbox();
    },
    // The terminal Task is saved; its reply bodies would otherwise fill the inbox.
    settle(replies) {
      for (const entry of replies)
        inbox.releaseBody(entry.sender_id, entry.message.message_id);
    },
  });
}

export interface HostA2aDependencies {
  config: HostA2aConfig;
  registry: SQLiteHabRegistry;
  service: HabMcpService;
  identity: AgentRecord;
  /** The in-process context the Registry attests as the host principal. */
  hostContext: object;
  limits: ContractLimits;
  fingerprintKey: Uint8Array;
  timeoutMs: number;
  privateFile(name: string): string;
  verify: RelayHttpVerifier;
  /** Throws once ownership is lost or the host is stopping. */
  assertOwner(): void;
  stopping(): boolean;
}

export async function startHostA2a(deps: HostA2aDependencies) {
  const { config, registry, service, identity, hostContext } = deps;
  const key = (purpose: string) =>
    createHmac("sha256", deps.fingerprintKey).update(purpose).digest();
  const bodyBytes = config.max_records * deps.limits.envelope_bytes;
  let outbox: SQLiteOutbox | undefined,
    inbox: SQLiteInbox | undefined,
    tasks: ReturnType<typeof openA2aTaskStore> | undefined,
    server: Server | undefined,
    timer: NodeJS.Timeout | undefined,
    cycle: Promise<void> | undefined,
    stopped = false;
  const pending = new Set<Promise<void>>();
  const close = async () => {
    stopped = true;
    clearTimeout(timer);
    if (server?.listening) {
      const closed = new Promise((resolve) => server!.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await Promise.allSettled([...pending]);
    await cycle;
    try {
      await tasks?.close();
    } finally {
      try {
        outbox?.close();
      } finally {
        inbox?.close();
      }
    }
  };
  try {
    outbox = new SQLiteOutbox(deps.privateFile("a2a-outbox.sqlite"), {
      agent_id: identity.agent_id,
      fingerprint_key: key("hab-host-a2a-outbox-v1"),
      limits: deps.limits,
      max_records: config.max_records,
      max_body_bytes: bodyBytes,
      max_clock_skew_ms: 1000,
      lease_ms: 30000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_submit_attempts: 3,
      max_status_attempts: 3,
      status_retry_ms: 86400000,
    });
    outbox.migrate();
    inbox = new SQLiteInbox(deps.privateFile("a2a-inbox.sqlite"), {
      agent_id: identity.agent_id,
      fingerprint_key: key("hab-host-a2a-inbox-v1"),
      limits: deps.limits,
      max_records: config.max_records,
      max_body_bytes: bodyBytes,
      max_ack_records: config.max_records * 3,
      ack_retry_ms: 86400000,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_attempts: 5,
    });
    inbox.migrate();
    tasks = openA2aTaskStore(deps.privateFile("a2a-tasks.sqlite"));
    const box = outbox,
      mail = inbox;
    const sender = new DurableSender(box, {
      submit: async (message) => service.submit(hostContext, message),
      status: async (messageId) => service.status(hostContext, messageId),
    });
    let received = false;
    const receiver = new DurableReceiver(mail, {
      poll: async () => {
        const delivery = service.poll(hostContext);
        received = delivery !== null;
        return delivery;
      },
      ack: async (input) => service.ack(hostContext, input),
    });
    // Only replies from the recipient a host message went to are kept; anything else
    // is released so that unrelated senders cannot fill the host mailbox.
    const correlated = (entry: InboxEntry) => {
      const reference = entry.message.in_reply_to;
      if (
        !["execution_accepted", "execution_result"].includes(
          entry.message.kind,
        ) ||
        reference?.sender_id !== identity.agent_id
      )
        return false;
      try {
        return box.get(reference.message_id).recipient_id === entry.sender_id;
      } catch {
        return false;
      }
    };
    let maintainedAt = 0;
    const receive = async () => {
      try {
        for (let i = 0; i < 16 && !stopped; i++) {
          received = false;
          await receiver.receiveOnce();
          if (!received) break;
          for (const entry of mail.inbox())
            if (!correlated(entry))
              mail.releaseBody(entry.sender_id, entry.message.message_id);
        }
        if (Date.now() - maintainedAt >= 60000) {
          maintainedAt = Date.now();
          box.maintain(100);
          mail.maintain(100);
        }
      } catch {
        // A failed cycle keeps its durable state; the next cycle retries it.
      }
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        cycle = receive().finally(schedule);
      }, config.poll_interval_ms);
    };
    // Set once the bound port fixes the endpoint the gateway checks.
    const serving: { handler?: ReturnType<typeof createA2aNodeHandler> } = {};
    server = createServer(
      {
        maxHeaderSize: 8192,
        requestTimeout: deps.timeoutMs,
        headersTimeout: deps.timeoutMs,
      },
      (req, res) => {
        const handler = serving.handler;
        if (stopped || deps.stopping() || !handler) {
          res.writeHead(503, {
            "Cache-Control": "no-store",
            Connection: "close",
          });
          res.end();
          return;
        }
        const work = handler(req, res);
        pending.add(work);
        void work.finally(() => pending.delete(work));
      },
    );
    server.maxConnections = config.max_active_requests;
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
    const bound = server.address();
    if (!bound || typeof bound === "string" || bound.address !== "127.0.0.1")
      throw Error("local_relay_listener_rejected");
    const endpoint = `http://127.0.0.1:${bound.port}/a2a`;
    const gateway = createHabA2aGateway({
      endpoint,
      card: habHostAgentCard(endpoint),
      store: tasks.store,
      authorize: async (incoming) => {
        if (stopped) return undefined;
        deps.assertOwner();
        const context = await deps.verify({
          authorization: incoming.headers.get("authorization") ?? "",
          resource: endpoint,
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
        deps.assertOwner();
        if (!context || stopped) return undefined;
        return hostRoute({
          registry,
          context,
          identity,
          recipient: config.recipient,
          outbox: box,
          sender,
          inbox: mail,
        });
      },
    });
    serving.handler = createA2aNodeHandler(endpoint, gateway);
    schedule();
    return Object.freeze({ url: endpoint, close });
  } catch (error) {
    await close();
    throw error;
  }
}
