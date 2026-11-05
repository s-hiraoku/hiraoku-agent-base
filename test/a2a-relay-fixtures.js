import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";
import { DatabaseSync } from "node:sqlite";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { SQLiteHabRegistry } from "../src/hab/sqlite-registry.ts";
import { HabRelayService } from "../src/hab/relay.ts";
import { SQLiteRelayStore } from "../src/relay/sqlite-store.ts";
import { SQLiteTaskBridgeJournal } from "../src/task-bridge/sqlite-journal.ts";
import { ConnectivityTaskPort } from "../src/task-bridge/task-port.ts";
import { DurableSender } from "../src/relay/sender.ts";
import { DurableReceiver } from "../src/relay/receiver.ts";
import { openA2aTaskStore } from "../src/a2a/store.ts";
import { habRelayAgentCard } from "../src/a2a/hab-adapter.ts";
import { createHabA2aGateway } from "../src/a2a/hab-http.ts";
import { createHabRelayRoute } from "../src/a2a/hab-route.ts";
import { SQLiteSubmissionReceipts } from "../src/a2a/submission-receipts.ts";
import { createHabA2aRecipient } from "../src/a2a/recipient.ts";
import { createA2aNodeHandler } from "../src/a2a/http-node.ts";
import { setup } from "./hab-http-fixtures.js";
import {
  options as registryDefaults,
  operations,
  principal,
} from "./hab-registry-fixtures.js";
import { limits } from "./relay-http-fixtures.js";
import { Hub, owner, worker, RESPONSE } from "./fixtures.js";
export { worker, RESPONSE };
export const a2aRequest = (
  messageId = "relay_check",
  text = "connectivity_check",
) =>
  SendMessageRequest.fromJSON({
    message: { messageId, role: "ROLE_USER", parts: [{ text }] },
    configuration: { returnImmediately: true },
  });
export async function createA2aRelayFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-relay-"));
  const admin = Symbol("synthetic-admin"),
    operator = Symbol("explicit-recipient-operator");
  const contexts = {
    a: Symbol("origin-group"),
    b: Symbol("recipient"),
    c: Symbol("third-group"),
  };
  const identities = new Map(
    Object.entries(contexts).map(([key, value]) => [value, key]),
  );
  const state = {
    enabled: true,
    execution: true,
    explicit: true,
    failSubmitReply: false,
    failAckReply: false,
    failEvidence: false,
    observed: undefined,
    clock: undefined,
  };
  const binding = {
    engine_id: "synthetic-relay-engine",
    owner_subject: owner.subject,
    client_id: null,
  };
  const { enableRename = false, ...gatewayOverrides } = overrides;
  const registryOptions = {
    ...registryDefaults,
    authentication_groups: true,
    agent_rename: enableRename,
    allowed_kinds: [
      "question",
      "answer",
      "notice",
      "execution_request",
      "execution_accepted",
      "execution_result",
    ],
  };
  const relayOptions = {
    fingerprint_key: new Uint8Array(32).fill(43),
    max_pending: 30,
    max_records: 200,
    max_pending_per_recipient: 20,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    max_attempts: 3,
    retry_base_ms: 10,
    retry_cap_ms: 100,
    poll_scan_limit: 30,
  };
  const authority = {
    administrator: (ctx) =>
      ctx === admin ? { actor_id: "synthetic-admin" } : undefined,
    individual: (ctx) =>
      state.enabled && identities.has(ctx)
        ? {
            principal: principal(identities.get(ctx)),
            expires_at: new Date(Date.now() + 60000).toISOString(),
          }
        : undefined,
  };
  let registry, relayStore, hub, sdk, journal, net, server, receipts;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await sdk?.close();
    journal?.close();
    receipts?.close();
    await net?.dispose();
    registry?.close();
    relayStore?.close();
    hub?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const openBase = () => {
    registry = new SQLiteHabRegistry(
      join(dir, "registry.sqlite"),
      registryOptions,
      authority,
    );
    registry.migrate();
    relayStore = new SQLiteRelayStore(join(dir, "relay.sqlite"), relayOptions);
    relayStore.migrate();
    hub = new Hub(join(dir, "tasks.sqlite"));
  };
  openBase();
  const product = registry.registerProduct(admin, {
    request_id: "product",
    agent_name: "synthetic",
  });
  let sequence = 0;
  const req = () => `setup-${++sequence}`;
  const group = registry.createGroup(admin, { request_id: req() });
  registry.bindGroup(admin, {
    request_id: req(),
    group_id: group.group_id,
    expected_epoch: group.epoch,
    principal: principal("a"),
  });
  let origin = registry.enroll(admin, {
    request_id: req(),
    product_id: product.product_id,
    bot_name: "origin",
  });
  const currentGroup = registry.inspectGroup(admin, group.group_id);
  registry.addGroupMember(admin, {
    request_id: req(),
    group_id: group.group_id,
    expected_group_epoch: currentGroup.epoch,
    agent_id: origin.agent_id,
    expected_epoch: origin.epoch,
  });
  origin = registry.inspect(admin, origin.agent_id);
  origin = registry.setAccess(admin, {
    request_id: req(),
    agent_id: origin.agent_id,
    expected_epoch: origin.epoch,
    state: "active",
    operations,
  });
  registry.setGroupAccess(admin, {
    request_id: req(),
    group_id: group.group_id,
    expected_epoch: registry.inspectGroup(admin, group.group_id).epoch,
    state: "active",
    operations,
  });
  let destination = registry.enroll(admin, {
    request_id: req(),
    product_id: product.product_id,
    bot_name: "recipient",
  });
  const bound = registry.bind(admin, {
    request_id: req(),
    agent_id: destination.agent_id,
    expected_epoch: destination.epoch,
    principal: principal("b"),
  });
  destination = registry.setAccess(admin, {
    request_id: req(),
    agent_id: destination.agent_id,
    expected_epoch: bound.agent_epoch,
    state: "active",
    operations,
  });
  const thirdGroup = registry.createGroup(admin, { request_id: req() });
  registry.bindGroup(admin, {
    request_id: req(),
    group_id: thirdGroup.group_id,
    expected_epoch: thirdGroup.epoch,
    principal: principal("c"),
  });
  let third = registry.enroll(admin, {
    request_id: req(),
    product_id: product.product_id,
    bot_name: "third",
  });
  registry.addGroupMember(admin, {
    request_id: req(),
    group_id: thirdGroup.group_id,
    expected_group_epoch: registry.inspectGroup(admin, thirdGroup.group_id)
      .epoch,
    agent_id: third.agent_id,
    expected_epoch: third.epoch,
  });
  third = registry.inspect(admin, third.agent_id);
  registry.setAccess(admin, {
    request_id: req(),
    agent_id: third.agent_id,
    expected_epoch: third.epoch,
    state: "active",
    operations,
  });
  registry.setGroupAccess(admin, {
    request_id: req(),
    group_id: thirdGroup.group_id,
    expected_epoch: registry.inspectGroup(admin, thirdGroup.group_id).epoch,
    state: "active",
    operations,
  });
  const service = () => new HabRelayService(registry, relayStore, limits);
  net = await setup(
    { after() {} },
    {
      dir,
      audit: { record() {} },
      verifier: ({ authorization }) =>
        ({
          "Bearer fixture-a": contexts.a,
          "Bearer fixture-b": contexts.b,
          "Bearer fixture-c": contexts.c,
        })[authorization] ?? null,
    },
    service(),
  );
  let originBox,
    recipientBox,
    originInbox,
    recipientInbox,
    originSender,
    recipientSender,
    recipient,
    originReceiver,
    taskPort;
  const clientFor = (name) => {
    const agent = name === "a" ? origin : name === "b" ? destination : third;
    return net.clients(
      name,
      agent,
      globalThis.fetch,
      name === "b" ? undefined : agent.address,
    );
  };
  const openStores = () => {
    originBox = net.outbox("a", origin);
    recipientBox = net.outbox("b", destination);
    originInbox = net.inbox("a", origin);
    recipientInbox = net.inbox("b", destination);
    taskPort = new ConnectivityTaskPort(
      {
        submit: (...args) => hub.submit(...args),
        get: (...args) => state.observed ?? hub.get(...args),
      },
      binding,
      () => (state.execution ? owner : undefined),
    );
    journal = new SQLiteTaskBridgeJournal(join(dir, "bridge.sqlite"), {
      receiver_id: destination.agent_id,
      binding,
      fingerprint_key: new Uint8Array(32).fill(118),
      limits,
      max_records: 30,
      max_audit_records: 200,
      lease_ms: 1000,
      max_submit_attempts: 3,
    });
    journal.migrate();
    originSender = new DurableSender(originBox, {
      async submit(message) {
        const receipt = await clientFor("a").submit(message);
        if (state.failSubmitReply) {
          state.failSubmitReply = false;
          throw Error("synthetic lost submit response");
        }
        return receipt;
      },
      status: (id) => clientFor("a").status(id),
    });
    recipientSender = new DurableSender(recipientBox, {
      submit: (message) => clientFor("b").submit(message),
      status: (id) => clientFor("b").status(id),
    });
    originReceiver = new DurableReceiver(originInbox, {
      poll: () => clientFor("a").poll(),
      ack: (request) => clientFor("a").ack(request),
    });
    const receiver = new DurableReceiver(recipientInbox, {
      poll: () => clientFor("b").poll(),
      async ack(request) {
        const receipt = await clientFor("b").ack(request);
        if (state.failAckReply) {
          state.failAckReply = false;
          throw Error("synthetic lost ACK response");
        }
        return receipt;
      },
    });
    receipts = new SQLiteSubmissionReceipts(
      join(dir, "submission-receipts.sqlite"),
      {
        receiver_id: destination.agent_id,
        binding,
        fingerprint_key: new Uint8Array(32).fill(119),
        max_records: 30,
      },
    );
    recipient = createHabA2aRecipient({
      receipts,
      inbox: recipientInbox,
      receiver,
      journal,
      tasks: taskPort,
      outbox: recipientBox,
      limits,
      now: () => state.clock ?? Date.now(),
      authorize: (ctx, operation, source) => {
        if (ctx !== operator || !state.explicit) return undefined;
        return registry.withRelay(contexts.b, "poll", (auth) =>
          auth.authorize(
            contexts.b,
            "poll",
            source.sender_id,
            "execution_request",
          )
            ? {
                receiver_id: destination.agent_id,
                actor_id: "synthetic-explicit-operator",
              }
            : undefined,
        );
      },
    });
  };
  openStores();
  const evidence = {
    binding,
    async verify(source, recipientId, taskId) {
      if (state.failEvidence || recipientId !== destination.agent_id)
        throw Error("evidence unavailable");
      const link = journal.get(source);
      if (
        link.receiver_id !== recipientId ||
        !link.task ||
        link.task.id !== taskId
      )
        throw Error("source mismatch");
      return {
        request_key: link.request_key,
        task: await taskPort.get(taskId, link.request_key),
      };
    },
  };
  let handler;
  server = createServer((request, response) => handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`,
    endpoint = `${base}/a2a`;
  const openGateway = () => {
    sdk = openA2aTaskStore(join(dir, "a2a.sqlite"));
    const gateway = createHabA2aGateway({
      endpoint,
      card: habRelayAgentCard(endpoint),
      store: {
        load: (id, context) => sdk.store.load(id, context),
        list: (params, context) => sdk.store.list(params, context),
        save: (task, context) => {
          if (state.failCompletionSave && task.status?.state === 3)
            throw Error("synthetic completion store fault");
          return sdk.store.save(task, context);
        },
      },
      authorize: (request) => {
        const ctx = {
          "Bearer fixture-a": contexts.a,
          "Bearer fixture-c": contexts.c,
        }[request.headers.get("authorization")];
        if (!ctx) return undefined;
        return createHabRelayRoute({
          registry,
          context: ctx,
          sender: origin,
          recipient: destination,
          outbox: originBox,
          senderTransport: originSender,
          inbox: originInbox,
          evidence,
        });
      },
      ...gatewayOverrides,
    });
    handler = createA2aNodeHandler(endpoint, gateway);
  };
  openGateway();
  const client = await new ClientFactory({
    ...new ClientFactory().options,
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: (url, init) =>
        globalThis.fetch(url, {
          ...init,
          headers: { ...init?.headers, Authorization: "Bearer fixture-a" },
        }),
    }),
  }).createFromUrl(base);
  const options = { serviceParameters: { Authorization: "Bearer fixture-a" } };
  const sourceOf = (task) => ({
    sender_id: origin.agent_id,
    message_id: task.metadata.hab_relay.source.message_id,
  });
  const closeStores = () => {
    for (const s of [originBox, recipientBox, originInbox, recipientInbox])
      net.close(s);
    journal.close();
    receipts.close();
  };
  return {
    dir,
    client,
    options,
    state,
    operator,
    get origin() {
      return origin;
    },
    get destination() {
      return destination;
    },
    group,
    sourceOf,
    base,
    relayUrl: net.url,
    transport: (name) => clientFor(name),
    inboxStore: (name) => (name === "a" ? originInbox : recipientInbox),
    routeSnapshot: (expectedRecipient = destination) =>
      createHabRelayRoute({
        registry,
        context: contexts.a,
        sender: origin,
        recipient: expectedRecipient,
        outbox: originBox,
        senderTransport: originSender,
        inbox: originInbox,
        evidence,
      }),
    rename(name, botName) {
      if (!enableRename || !["a", "b"].includes(name))
        throw Error("rename fixture disabled");
      const expected = name === "a" ? origin : destination;
      const current = registry.inspect(admin, expected.agent_id);
      return registry.renameAgent(admin, {
        request_id: req(),
        agent_id: expected.agent_id,
        expected_epoch: current.epoch,
        expected_address: current.address,
        bot_name: botName,
      });
    },
    refreshAddress(name) {
      if (name === "a") origin = registry.inspect(admin, origin.agent_id);
      else if (name === "b")
        destination = registry.inspect(admin, destination.agent_id);
      else throw Error("invalid fixture member");
    },
    claimName(botName) {
      return registry.enroll(admin, {
        request_id: req(),
        product_id: product.product_id,
        bot_name: botName,
      });
    },
    get hub() {
      return hub;
    },
    get journal() {
      return journal;
    },
    get submissionReceipts() {
      return receipts;
    },
    get recipient() {
      return recipient;
    },
    get registry() {
      return registry;
    },
    faults: {
      outboxRetryDue(name = "a") {
        const db = new DatabaseSync(join(dir, `outbox-${name}.sqlite`));
        try {
          db.exec("UPDATE relay_outbox SET next_retry_at=0");
        } finally {
          db.close();
        }
      },
      ackRetryDue(name = "b") {
        const db = new DatabaseSync(join(dir, `inbox-${name}.sqlite`));
        try {
          db.exec("UPDATE relay_receiver_acks SET next_retry_at=0");
        } finally {
          db.close();
        }
      },
    },
    count: () => hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
    unresolvedIntents() {
      let count = 0;
      for (const name of ["a", "b"]) {
        const db = new DatabaseSync(join(dir, `outbox-${name}.sqlite`));
        try {
          count += db
            .prepare(
              "SELECT count(*) n FROM relay_outbox WHERE state IN ('queued','sending')",
            )
            .get().n;
        } finally {
          db.close();
        }
      }
      const db = new DatabaseSync(join(dir, "bridge.sqlite"));
      try {
        count += db
          .prepare(
            "SELECT count(*) n FROM task_bridge_links WHERE state!='linked'",
          )
          .get().n;
      } finally {
        db.close();
      }
      const receiptDb = new DatabaseSync(
        join(dir, "submission-receipts.sqlite"),
      );
      try {
        count += receiptDb
          .prepare(
            "SELECT count(*) n FROM a2a_submission_receipts WHERE json_extract(data,'$.task') IS NULL",
          )
          .get().n;
      } finally {
        receiptDb.close();
      }
      return count;
    },
    relayRows() {
      const db = new DatabaseSync(join(dir, "relay.sqlite"));
      try {
        return db
          .prepare(
            "SELECT sender_id,message_id,recipient_id,receipt_id,thread_id,expires_at,body FROM relay_messages ORDER BY rowid",
          )
          .all();
      } finally {
        db.close();
      }
    },
    requestCount: () =>
      net.tools.filter((tool) => tool === "relay_submit").length,
    originEntries: () => originInbox.inbox(),
    recipientEntries: () => recipientInbox.inbox(),
    receiveResult: () => originReceiver.receiveOnce(),
    sendReply: () => recipientSender.sendOnce(),
    async ordinaryReply(task, kind = "answer") {
      const source = task.metadata.hab_relay.source,
        at = new Date().toISOString();
      await clientFor("b").submit({
        version: 1,
        message_id: makeReplayBoundMessageId(
          at,
          randomUUID().replaceAll("-", ""),
        ),
        recipient_id: origin.agent_id,
        kind,
        thread_id: source.thread_id,
        in_reply_to: {
          sender_id: origin.agent_id,
          message_id: source.message_id,
        },
        first_sent_at: at,
        expires_at: new Date(Date.parse(at) + 3600000).toISOString(),
        body: { parts: [{ type: "text", text: "ordinary synthetic reply" }] },
      });
      await originReceiver.receiveOnce();
    },
    flush: () => originSender.sendOnce(),
    receipt: (task) => clientFor("a").status(sourceOf(task).message_id),
    raw: (method, params, token = "fixture-a") =>
      globalThis.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "proof", method, params }),
      }),
    revokeGroup() {
      const current = registry.inspectGroup(admin, group.group_id);
      registry.setGroupAccess(admin, {
        request_id: req(),
        group_id: group.group_id,
        expected_epoch: current.epoch,
        state: "stopped",
        operations: [],
      });
    },
    restoreGroup() {
      const current = registry.inspectGroup(admin, group.group_id);
      registry.setGroupAccess(admin, {
        request_id: req(),
        group_id: group.group_id,
        expected_epoch: current.epoch,
        state: "active",
        operations,
      });
    },
    async restart() {
      await sdk.close();
      closeStores();
      await net.stop();
      registry.close();
      relayStore.close();
      hub.close();
      openBase();
      await net.start(service());
      openStores();
      openGateway();
    },
  };
}
