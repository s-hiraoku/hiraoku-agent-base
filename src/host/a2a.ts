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
 *   current owner check. Only the receiver loop runs in background: it saves then ACKs
 *   a reply to a host message, applies it to that message's Task and releases it, and
 *   ACKs anything else without saving it.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { DurableReceiver } from "../agent-sdk/receiver.ts";
import { DurableSender } from "../agent-sdk/sender.ts";
import { SQLiteOutbox } from "../agent-sdk/sqlite-outbox.ts";
import { SQLiteInbox } from "../agent-sdk/sqlite-inbox.ts";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { ZodError } from "zod";
import { MessagingError } from "../messaging/delivery-service.ts";
import type { Delivery } from "../messaging/delivery-service.ts";
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
import type { InboxEntry } from "../agent-sdk/receiver.ts";
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

/** A reply is saved only until this long after its request's own expiry; a Task still without a result then fails. */
const REPLY_WINDOW_MS = 86400000;
const ACK_RETRY_MS = 86400000;
// An outbox record outlives the ACK history of every reply it can still receive
// (window, ACK retry, the reply's own one-hour expiry and slack), so a slot it frees
// never leaves ACK rows behind that a newly admitted Task's replies would need.
const STATUS_RETRY_MS = REPLY_WINDOW_MS + ACK_RETRY_MS + 2 * 3600000;

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
  /** A sender whose host submit runs inside `guard`. */
  sender(guard: <T>(admit: () => T) => T): DurableSender;
  inbox: SQLiteInbox;
}): HabA2aRoute {
  const { registry, context, identity, outbox, inbox } = options;
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
  // The host identity's admission joins this Registry transaction, so a revocation
  // commits either before the caller check here or after the message is admitted.
  const sender = options.sender((admit) =>
    registry.withRelay(context, "submit", () => {
      assertCurrent();
      return admit();
    }),
  );
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
    replyWindowMs: REPLY_WINDOW_MS,
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
  // The outbox holds at most max_records host messages, and each one gets an
  // execution_accepted and an execution_result reply. With two body slots per message
  // an accepted reply never holds the slot its own result needs to finish the Task.
  const replySlots = config.max_records * 2;
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
      status_retry_ms: STATUS_RETRY_MS,
    });
    outbox.migrate();
    inbox = new SQLiteInbox(deps.privateFile("a2a-inbox.sqlite"), {
      agent_id: identity.agent_id,
      fingerprint_key: key("hab-host-a2a-inbox-v1"),
      limits: deps.limits,
      max_records: replySlots,
      max_body_bytes: replySlots * deps.limits.envelope_bytes,
      max_ack_records: config.max_records * 3,
      ack_retry_ms: ACK_RETRY_MS,
      retry_base_ms: 1000,
      retry_cap_ms: 60000,
      max_attempts: 5,
    });
    inbox.migrate();
    tasks = openA2aTaskStore(deps.privateFile("a2a-tasks.sqlite"));
    const box = outbox,
      mail = inbox;
    const sender = (guard: <T>(admit: () => T) => T) =>
      new DurableSender(box, {
        submit: async (message) =>
          guard(() => service.submit(hostContext, message)),
        status: async (messageId) => service.status(hostContext, messageId),
      });
    // Only replies from the recipient a host message went to, within its reply window, are kept.
    const correlated = (message: Delivery["message"]) => {
      const reference = message.in_reply_to;
      if (
        !["execution_accepted", "execution_result"].includes(message.kind) ||
        reference?.sender_id !== identity.agent_id
      )
        return false;
      try {
        const record = box.get(reference.message_id);
        return (
          record.recipient_id === message.sender_id &&
          Date.now() < Date.parse(record.expires_at) + REPLY_WINDOW_MS
        );
      } catch {
        return false;
      }
    };
    // A new reply ID is saved only if it would change its Task. One that repeats what
    // the Task or a held reply already carries, or that the Task would refuse, changes
    // nothing when dropped, so a recipient cannot fill the ACK history with fresh IDs.
    // An ID the inbox still holds always reaches it, so its redelivery is deduplicated.
    const changesTask = async (delivery: Delivery) => {
      const { sender_id, ...message } = delivery.message;
      const source = message.in_reply_to!.message_id;
      const held = mail
        .inbox()
        .filter(
          (entry) =>
            entry.sender_id === sender_id &&
            entry.message.in_reply_to?.message_id === source,
        );
      if (held.some((entry) => entry.message.message_id === message.message_id))
        return true;
      const task = store.findBySource(source);
      const gateway = wired.gateway;
      if (!task || !gateway) return false;
      // A held reply counts as confirmed, so a copy under a new ID is not saved while
      // the first one waits for its ACK.
      const confirmed = held.map((entry) => ({
        ...entry,
        receipt_confirmed: true,
      }));
      const state = async (replies: InboxEntry[]) =>
        (await gateway.preview(task, storedRoute(task, replies)))?.status
          ?.state;
      try {
        const before = await state(confirmed).catch(() => state([]));
        const after = await state([
          ...confirmed,
          {
            sender_id,
            message,
            received_at: new Date().toISOString(),
            receipt_confirmed: true,
          },
        ]);
        return after !== before;
      } catch {
        return false;
      }
    };
    let received = false;
    const receiver = new DurableReceiver(mail, {
      poll: async () => {
        const delivery = service.poll(hostContext);
        received = delivery !== null;
        if (
          !delivery ||
          (correlated(delivery.message) && (await changesTask(delivery)))
        )
          return delivery;
        // Anything else is ACKed without an inbox record, so it spends none of the
        // record or ACK history capacity that replies need. Dropping it again on a
        // redelivery is harmless, so it needs no dedup record.
        const { sender_id, message_id } = delivery.message;
        await service.ack(hostContext, {
          sender_id,
          message_id,
          generation: delivery.generation,
          lease_token: delivery.lease_token,
          request_id: randomUUID(),
        });
        return null;
      },
      ack: async (input) => service.ack(hostContext, input),
    });
    const store = tasks;
    const wired: { gateway?: ReturnType<typeof createHabA2aGateway> } = {};
    // Each ACKed reply is applied to its Task here, not on the caller's next read, and
    // its body is released once the Task store holds the result. A Task nobody reads
    // therefore never keeps a slot, even after its outbox record is purged.
    const storedRoute = (
      task: { tenant: string; owner: string },
      replies: InboxEntry[],
    ): HabA2aRoute => ({
      ownerId: task.owner,
      senderId: identity.agent_id,
      recipientId: task.tenant.slice("hab-a2a:".length),
      replyWindowMs: REPLY_WINDOW_MS,
      assertCurrent() {},
      enqueue() {
        throw new MessagingError("forbidden");
      },
      delivery: (messageId) => box.get(messageId),
      async flush() {
        throw new MessagingError("forbidden");
      },
      replies: () => replies,
    });
    const applyReplies = async () => {
      for (const entry of mail.inbox()) {
        const gateway = wired.gateway;
        if (stopped || !gateway) return;
        // An unconfirmed reply is never applied. Once no ACK can confirm it, its body
        // is released unread; its Task's outcome stays unknown until the reply window closes.
        if (!entry.receipt_confirmed) {
          mail.releaseUnconfirmable(entry.sender_id, entry.message.message_id);
          continue;
        }
        const source = entry.message.in_reply_to?.message_id;
        const task = source ? store.findBySource(source) : undefined;
        try {
          if (task)
            await gateway.apply(task, storedRoute(task, [entry]));
        } catch (error) {
          // A reply the Task refuses (a conflict, a malformed body) is rejected; any
          // other failure keeps the body for the next cycle.
          if (
            !(error instanceof RequestMalformedError) &&
            !(error instanceof ZodError)
          )
            continue;
        }
        mail.releaseBody(entry.sender_id, entry.message.message_id);
      }
    };
    // A Task whose reply window closed without a result fails without waiting for a read.
    // The next pass is due when the earliest open window closes, and at most a minute
    // later: a Task created after this pass expires a delivery TTL plus the window from
    // now, and one that failed to apply is retried with maintenance.
    let windowsDueAt = 0;
    const closeWindows = async () => {
      const now = Date.now();
      const cutoff = new Date(now - REPLY_WINDOW_MS).toISOString();
      const due = store.overdue(cutoff, 100);
      for (const task of due) {
        const gateway = wired.gateway;
        if (stopped || !gateway) return;
        try {
          await gateway.apply(task, storedRoute(task, []));
        } catch {
          // One Task that cannot be applied must not hold back the others or maintenance.
        }
      }
      const next = store.nextExpiry(cutoff);
      windowsDueAt =
        due.length === 100
          ? 0
          : Math.min(
              next ? Date.parse(next) + REPLY_WINDOW_MS : Infinity,
              now + 60000,
            );
    };
    let maintainedAt = 0;
    const receive = async () => {
      try {
        // Release what can be released before polling, so a full inbox does not
        // refuse a new reply while it still holds bodies that no ACK can confirm.
        await applyReplies();
      } catch {
        // The bodies stay saved; the apply after polling retries them.
      }
      try {
        for (let i = 0; i < 16 && !stopped; i++) {
          received = false;
          await receiver.receiveOnce();
          if (!received) break;
        }
      } catch {
        // A failed cycle keeps its durable state; the next cycle retries it.
      }
      try {
        await applyReplies();
        if (Date.now() - maintainedAt >= 60000) {
          maintainedAt = Date.now();
          box.maintain(100);
          mail.maintain(100);
          windowsDueAt = 0;
        }
        if (Date.now() >= windowsDueAt) await closeWindows();
      } catch {
        // As above: the replies stay saved and the next cycle applies them.
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
    const gateway = (wired.gateway = createHabA2aGateway({
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
    }));
    serving.handler = createA2aNodeHandler(endpoint, gateway);
    schedule();
    return Object.freeze({ url: endpoint, close });
  } catch (error) {
    await close();
    throw error;
  }
}
