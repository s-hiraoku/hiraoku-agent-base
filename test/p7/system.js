import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import process from "node:process";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { connect } from "../../packages/relay-nats/node_modules/@nats-io/transport-node/lib/mod.js";
import { jetstreamManager } from "../../packages/relay-nats/node_modules/@nats-io/jetstream/lib/mod.js";
import { SQLiteHabRegistry } from "../../src/hab/sqlite-registry.ts";
import { startHostServer } from "../../src/host/server.ts";
import { createJetStreamDelivery } from "../../src/host/delivery.ts";
import { HabMcpClient } from "../../src/hab/mcp-client.ts";
import { SQLiteOutbox } from "../../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../../src/relay/sqlite-inbox.ts";
import { DurableSender } from "../../src/relay/sender.ts";
import { DurableReceiver } from "../../src/relay/receiver.ts";
import { SQLiteTaskBridgeJournal } from "../../src/task-bridge/sqlite-journal.ts";
import { ConnectivityTaskPort } from "../../src/task-bridge/task-port.ts";
import { SQLiteSubmissionReceipts } from "../../src/a2a/submission-receipts.ts";
import { openA2aTaskStore } from "../../src/a2a/store.ts";
import { createHabA2aGateway } from "../../src/a2a/hab-http.ts";
import { habRelayAgentCard } from "../../src/a2a/hab-adapter.ts";
import { createHabRelayRoute } from "../../src/a2a/hab-route.ts";
import { createHabA2aRecipient } from "../../src/a2a/recipient.ts";
import { createA2aNodeHandler } from "../../src/a2a/http-node.ts";
import {
  options as defaults,
  principal,
  operations,
} from "../hab-registry-fixtures.js";
import { limits, policy as httpPolicy } from "../relay-http-fixtures.js";
import { Hub, owner, worker, RESPONSE } from "../fixtures.js";
import { a2aRequest } from "../a2a-relay-fixtures.js";
import { sha256 } from "../../scripts/lib/p7-provenance.mjs";
export { a2aRequest, worker, RESPONSE };

const kinds = [
  "question",
  "answer",
  "notice",
  "execution_request",
  "execution_accepted",
  "execution_result",
];
const key = (n) => new Uint8Array(32).fill(n);
const registryOptions = {
  ...defaults,
  authentication_groups: true,
  agent_rename: true,
  allowed_kinds: kinds,
};
const queueOptions = {
  max_records: 200,
  max_pending: 30,
  max_pending_per_recipient: 20,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 1000,
  max_attempts: 5,
  retry_base_ms: 20,
  retry_cap_ms: 100,
  poll_scan_limit: 30,
  agent_capacity: {
    max_pending_per_sender: 20,
    max_body_bytes_per_sender: 50000,
    max_records_per_sender: 100,
    max_body_bytes_per_recipient: 50000,
    max_records_per_recipient: 150,
    reservations: [],
  },
};
export async function eventually(action) {
  for (let n = 0; n < 250; n++) {
    const result = await action();
    if (result) return result;
    await delay(20);
  }
  throw Error("P7 condition did not settle");
}
export function readDb(path, action) {
  assert.notEqual(path.split("/").at(-1), "owner.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}
async function freePort() {
  const server = netServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function closeListener(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}
export async function openP7System(t, { root, brokerOnly = false } = {}) {
  const binary = process.env.HAB_NATS_SERVER;
  if (!binary) throw Error("P7 requires the verifier-staged NATS binary");
  root ??= mkdtempSync(join(tmpdir(), "p7-world-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const hostDir = join(root, "host"),
    appDir = join(root, "app");
  for (const path of [hostDir, appDir, join(root, "broker")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const configPath = join(root, "fixture.json");
  const fresh = !existsSync(configPath);
  const config = fresh
    ? {
        version: 1,
        password: randomBytes(24).toString("hex"),
        keys: Object.fromEntries(
          Object.entries({
            registry: 61,
            relay: 42,
            outbox: 71,
            inbox: 72,
            bridge: 118,
            receipts: 119,
          }).map(([name, n]) => [name, Buffer.from(key(n)).toString("hex")]),
        ),
        binding: {
          engine_id: "p7-real-task-engine",
          owner_subject: owner.subject,
          client_id: null,
        },
        agents: null,
        urls: {},
      }
    : JSON.parse(readFileSync(configPath, "utf8"));
  const material = (name) =>
    Uint8Array.from(Buffer.from(config.keys[name], "hex"));
  const instanceRegistryOptions = {
    ...registryOptions,
    fingerprint_key: material("registry"),
  };
  const persist = () =>
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const admin = Symbol("synthetic-admin"),
    operator = Symbol("explicit-recipient-operator");
  const contexts = {
    a: Symbol("origin"),
    b: Symbol("recipient"),
    c: Symbol("foreign"),
  };
  const authority = {
    administrator: (ctx) =>
      ctx === admin ? { actor_id: "p7-synthetic-admin" } : undefined,
    individual: (ctx) => {
      const name = Object.keys(contexts).find((name) => contexts[name] === ctx);
      return name
        ? {
            principal: principal(name),
            expires_at: new Date(Date.now() + 60000).toISOString(),
          }
        : undefined;
    },
  };
  if (fresh) {
    const registry = new SQLiteHabRegistry(
      join(hostDir, "registry.sqlite"),
      instanceRegistryOptions,
      authority,
    );
    try {
      registry.migrate();
      const product = registry.registerProduct(admin, {
        request_id: "product",
        agent_name: "p7-synthetic",
      });
      let id = 0;
      const request = () => `p7-seed-${++id}`;
      config.agents = {};
      for (const name of ["a", "b", "c"]) {
        const group = registry.createGroup(admin, { request_id: request() });
        registry.bindGroup(admin, {
          request_id: request(),
          group_id: group.group_id,
          expected_epoch: group.epoch,
          principal: principal(name),
        });
        let agent = registry.enroll(admin, {
          request_id: request(),
          product_id: product.product_id,
          bot_name: `p7-${name}`,
        });
        registry.addGroupMember(admin, {
          request_id: request(),
          group_id: group.group_id,
          expected_group_epoch: registry.inspectGroup(admin, group.group_id)
            .epoch,
          agent_id: agent.agent_id,
          expected_epoch: agent.epoch,
        });
        agent = registry.inspect(admin, agent.agent_id);
        agent = registry.setAccess(admin, {
          request_id: request(),
          agent_id: agent.agent_id,
          expected_epoch: agent.epoch,
          state: "active",
          operations,
        });
        registry.setGroupAccess(admin, {
          request_id: request(),
          group_id: group.group_id,
          expected_epoch: registry.inspectGroup(admin, group.group_id).epoch,
          state: "active",
          operations,
        });
        config.agents[name] = agent;
      }
    } finally {
      registry.close();
    }
    writeFileSync(
      join(hostDir, "volume.local.json"),
      JSON.stringify({ version: 1, volume_id: "p7-synthetic-ssd" }),
      { mode: 0o600 },
    );
    persist();
  }
  let phase = "opening",
    broker,
    brokerLog = "",
    observer,
    manager,
    host,
    registry,
    gatewayServer,
    sdk,
    hub,
    journal,
    receipts,
    taskPort,
    recipient,
    originReceiver;
  const stores = [];
  const pendingNative = new Set();
  let closing;
  const closure = { http_ports: [], brokers: [], stores_closed: false };
  const agents = config.agents;
  const openBroker = async () => {
    if (!["opening", "running", "broker-only"].includes(phase))
      throw Error("P7 broker start on closed system");
    if (broker && broker.exitCode === null && broker.signalCode === null)
      throw Error("P7 broker already live");
    const port =
      phase === "running" && config.urls.broker
        ? Number(new URL(config.urls.broker).port)
        : await freePort();
    const server = `nats://127.0.0.1:${port}`;
    const brokerConfig = join(root, "broker.conf");
    writeFileSync(
      brokerConfig,
      `host: 127.0.0.1\nport: ${port}\njetstream {\n store_dir: ${JSON.stringify(join(root, "broker/store"))}\n max_file_store: 64MB\n max_memory_store: 0\n sync_interval: always\n}\naccounts { HAB { jetstream: enabled\n users: [{user: backend, password: ${JSON.stringify(config.password)}}]\n} }\n`,
      { mode: 0o600 },
    );
    broker = spawn(binary, ["-c", brokerConfig], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let listening = false,
      generationLog = "";
    broker.stderr.on("data", (bytes) => {
      generationLog = (generationLog + bytes.toString()).slice(-65536);
      brokerLog = (brokerLog + bytes.toString()).slice(-65536);
      if (
        generationLog.includes(
          `Listening for client connections on 127.0.0.1:${port}`,
        )
      )
        listening = true;
    });
    await eventually(() => {
      if (broker.exitCode !== null || broker.signalCode !== null)
        throw Error(`owned broker exited before readiness: ${brokerLog}`);
      return listening;
    });
    observer = await connect({
      servers: server,
      user: "backend",
      pass: config.password,
      reconnect: false,
      timeout: 1000,
    });
    manager = await jetstreamManager(observer);
    config.urls.broker = server;
    persist();
  };
  const stopBroker = async () => {
    await observer?.close();
    observer = undefined;
    manager = undefined;
    if (!broker || broker.exitCode !== null || broker.signalCode !== null)
      return;
    const stopped = once(broker, "exit");
    broker.kill("SIGTERM");
    await stopped;
    closure.brokers.push({
      pid: broker.pid,
      exited: true,
      code: broker.exitCode,
      signal: broker.signalCode,
    });
  };
  const binding = config.binding;
  let originBox,
    recipientBox,
    originInbox,
    recipientInbox,
    originSender,
    recipientSender;
  const makeClient = (name) =>
    new HabMcpClient({
      as_address: agents[name].address,
      policy: {
        resource_url: host.url,
        agent_id: agents[name].agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2500,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
      },
      limits,
      authorization: () => `Bearer fixture-${name}`,
      fetch: globalThis.fetch,
    });
  const hostOptions = () => {
    const http = { ...httpPolicy };
    delete http.resource_url;
    delete http.allowed_origins;
    return {
      directory: hostDir,
      port: 0,
      limits,
      registry: instanceRegistryOptions,
      http,
      authority,
      verify: ({ authorization }) =>
        ({
          "Bearer fixture-a": contexts.a,
          "Bearer fixture-b": contexts.b,
          "Bearer fixture-c": contexts.c,
        })[authorization] ?? null,
      audit: { record() {} },
    };
  };
  const startApplication = async () => {
    if (phase === "closed" || phase === "disposed")
      throw Error("P7 application start on closed system");
    if (!["opening", "broker-only"].includes(phase))
      throw Error("P7 application already live");
    if (!broker || broker.exitCode !== null || broker.signalCode !== null)
      throw Error("P7 application requires owned live broker");
    phase = "starting-application";
    const delivery = createJetStreamDelivery(
      {
        broker: {
          server: config.urls.broker,
          user: "backend",
          password: config.password,
          stream: "HAB",
          subject_prefix: "hab",
          max_consumers: 20,
          max_bytes: 4000000,
          max_message_bytes: 64000,
          request_timeout_ms: 500,
        },
        pump: { interval_ms: 10, max_records_per_cycle: 30 },
        volume: {
          identity_file: join(hostDir, "volume.local.json"),
          expected_id: "p7-synthetic-ssd",
          expected_device: lstatSync(hostDir).dev,
        },
        queue: queueOptions,
      },
      material("relay"),
    );
    const capture = Object.assign(
      async (dependencies) => {
        registry = dependencies.registry;
        return delivery(dependencies);
      },
      { preflight: delivery.preflight },
    );
    assert.equal(capture.preflight, delivery.preflight);
    host = await startHostServer({ ...hostOptions(), delivery: capture });
    config.urls.hab = host.url;
    for (const name of [
      "engine.sqlite",
      "bridge.sqlite",
      "submission-receipts.sqlite",
      "a2a.sqlite",
      "outbox-a.sqlite",
      "outbox-b.sqlite",
      "inbox-a.sqlite",
      "inbox-b.sqlite",
    ])
      if (!existsSync(join(appDir, name)))
        writeFileSync(join(appDir, name), "", { mode: 0o600 });
    const box = (name) => {
      const store = new SQLiteOutbox(join(appDir, `outbox-${name}.sqlite`), {
        agent_id: agents[name].agent_id,
        fingerprint_key: material("outbox"),
        limits,
        max_records: 100,
        max_body_bytes: 100000,
        max_clock_skew_ms: 1000,
        lease_ms: 30000,
        retry_base_ms: 20,
        retry_cap_ms: 100,
        max_submit_attempts: 5,
        max_status_attempts: 5,
        status_retry_ms: 100,
      });
      store.migrate();
      stores.push(store);
      return store;
    };
    const inbox = (name) => {
      const store = new SQLiteInbox(join(appDir, `inbox-${name}.sqlite`), {
        agent_id: agents[name].agent_id,
        fingerprint_key: material("inbox"),
        limits,
        max_records: 100,
        max_body_bytes: 100000,
        max_ack_records: 200,
        ack_retry_ms: 100,
        retry_base_ms: 20,
        retry_cap_ms: 100,
        max_attempts: 20,
      });
      store.migrate();
      stores.push(store);
      return store;
    };
    originBox = box("a");
    recipientBox = box("b");
    originInbox = inbox("a");
    recipientInbox = inbox("b");
    hub = new Hub(join(appDir, "engine.sqlite"));
    taskPort = new ConnectivityTaskPort(
      {
        submit: (...args) => hub.submit(...args),
        get: (...args) => hub.get(...args),
      },
      binding,
      () => owner,
    );
    journal = new SQLiteTaskBridgeJournal(join(appDir, "bridge.sqlite"), {
      receiver_id: agents.b.agent_id,
      binding,
      fingerprint_key: material("bridge"),
      limits,
      max_records: 100,
      max_audit_records: 300,
      lease_ms: 1000,
      max_submit_attempts: 5,
    });
    journal.migrate();
    receipts = new SQLiteSubmissionReceipts(
      join(appDir, "submission-receipts.sqlite"),
      {
        receiver_id: agents.b.agent_id,
        binding,
        fingerprint_key: material("receipts"),
        max_records: 100,
      },
    );
    originSender = new DurableSender(originBox, {
      submit: (m) => makeClient("a").submit(m),
      status: (id) => makeClient("a").status(id),
    });
    recipientSender = new DurableSender(recipientBox, {
      submit: (m) => makeClient("b").submit(m),
      status: (id) => makeClient("b").status(id),
    });
    originReceiver = new DurableReceiver(originInbox, {
      poll: () => makeClient("a").poll(),
      ack: (r) => makeClient("a").ack(r),
    });
    const receiver = new DurableReceiver(recipientInbox, {
      poll: () => makeClient("b").poll(),
      ack: (r) => makeClient("b").ack(r),
    });
    recipient = createHabA2aRecipient({
      receipts,
      inbox: recipientInbox,
      receiver,
      journal,
      tasks: taskPort,
      outbox: recipientBox,
      limits,
      authorize: (ctx, operation, source) =>
        ctx === operator
          ? registry.withRelay(contexts.b, "poll", (auth) =>
              auth.authorize(
                contexts.b,
                "poll",
                source.sender_id,
                "execution_request",
              )
                ? {
                    receiver_id: agents.b.agent_id,
                    actor_id: "p7-explicit-operator",
                  }
                : undefined,
            )
          : undefined,
    });
    const evidence = {
      binding,
      async verify(source, recipientId, taskId) {
        const link = journal.get(source);
        if (
          recipientId !== agents.b.agent_id ||
          !link.task ||
          link.task.id !== taskId
        )
          throw Error("P7 execution binding mismatch");
        return {
          request_key: link.request_key,
          task: await taskPort.get(taskId, link.request_key),
        };
      },
    };
    sdk = openA2aTaskStore(join(appDir, "a2a.sqlite"));
    let handler;
    gatewayServer = httpServer((req, res) => {
      if (!["running", "starting-application"].includes(phase)) {
        res.writeHead(503);
        res.end();
        return;
      }
      const work = Promise.resolve(handler(req, res));
      pendingNative.add(work);
      void work.then(
        () => pendingNative.delete(work),
        () => pendingNative.delete(work),
      );
    });
    gatewayServer.listen(0, "127.0.0.1");
    await once(gatewayServer, "listening");
    const base = `http://127.0.0.1:${gatewayServer.address().port}`,
      endpoint = `${base}/a2a`;
    handler = createA2aNodeHandler(
      endpoint,
      createHabA2aGateway({
        endpoint,
        card: habRelayAgentCard(endpoint),
        store: sdk.store,
        authorize: (request) => {
          const ctx = {
            "Bearer fixture-a": contexts.a,
            "Bearer fixture-c": contexts.c,
          }[request.headers.get("authorization")];
          return ctx
            ? createHabRelayRoute({
                registry,
                context: ctx,
                sender: agents.a,
                recipient: agents.b,
                outbox: originBox,
                senderTransport: originSender,
                inbox: originInbox,
                evidence,
              })
            : undefined;
        },
      }),
    );
    config.urls.a2a = base;
    persist();
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
    system.client = client;
    system.base = base;
    phase = "running";
  };
  const system = {
    root,
    hostDir,
    appDir,
    config,
    agents,
    operator,
    options: { serviceParameters: { Authorization: "Bearer fixture-a" } },
    get phase() {
      return phase;
    },
    get recipient() {
      return recipient;
    },
    get hub() {
      return hub;
    },
    get journal() {
      return journal;
    },
    get relayUrl() {
      return host.url;
    },
    get manager() {
      return manager;
    },
    sourceOf: (task) => ({
      sender_id: agents.a.agent_id,
      message_id: task.metadata.hab_relay.source.message_id,
    }),
    engineCount: () =>
      hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
    recipientEntries: () => recipientInbox.inbox(),
    originEntries: () => originInbox.inbox(),
    receipt: (task) => makeClient("a").status(system.sourceOf(task).message_id),
    receiveResult: () => originReceiver.receiveOnce(),
    async publishReply(source, kind) {
      const reply = recipient.replyOnce(operator, source, kind);
      await recipientSender.sendOnce();
      return reply;
    },
    async complete(source) {
      const running = await hub.claim(worker);
      assert.ok(running);
      await hub.complete(worker, {
        id: running.id,
        fence: running.fence,
        state: "succeeded",
        result: RESPONSE,
      });
      await recipient.observeOnce(operator, source);
    },
    journalRows: () =>
      readDb(join(hostDir, "jetstream-journal.sqlite"), (db) =>
        db.prepare("SELECT * FROM nats_messages ORDER BY rowid").all(),
      ),
    /** JetStream is the only delivery backend; the retired SQLite store must never appear. */
    retiredStorePresent: () => existsSync(join(hostDir, "relay.sqlite")),
    async brokerMessage(sequence) {
      return manager.streams.getMessage("HAB", { seq: sequence });
    },
    async witness(kind, source) {
      const row = await eventually(() =>
        system
          .journalRows()
          .find(
            (r) =>
              r.kind === kind &&
              (kind === "execution_request"
                ? r.message_id === source.message_id
                : true) &&
              r.sequence > 0,
          ),
      );
      const message = await system.brokerMessage(row.sequence);
      assert.equal(message.subject, row.subject);
      const body = JSON.parse(new TextDecoder().decode(message.data));
      if (kind === "execution_request")
        assert.equal(body.message.recipient_id, agents.b.agent_id);
      else {
        assert.deepEqual(body.message.in_reply_to, source);
        assert.equal(body.sender_id, agents.b.agent_id);
        assert.equal(body.message.recipient_id, agents.a.agent_id);
      }
      assert.equal(body.message.kind, kind);
      assert.equal(body.sender_id, row.sender_id);
      assert.equal(body.message.message_id, row.message_id);
      assert.equal(system.retiredStorePresent(), false);
      return {
        sender_id: row.sender_id,
        message_id: row.message_id,
        kind,
        subject: message.subject,
        sequence: message.seq,
        body,
        sha256: sha256(message.data),
        outbox: row.outbox,
        receipt_id: row.receipt_id,
      };
    },
    rename(name, botName) {
      const management = new SQLiteHabRegistry(
        join(hostDir, "registry.sqlite"),
        instanceRegistryOptions,
        authority,
      );
      try {
        management.migrate();
        const current = management.inspect(admin, agents[name].agent_id);
        return management.renameAgent(admin, {
          request_id: `p7-rename-${randomBytes(8).toString("hex")}`,
          agent_id: current.agent_id,
          expected_epoch: current.epoch,
          expected_address: current.address,
          bot_name: botName,
        });
      } finally {
        management.close();
      }
    },
    refreshAddress(name) {
      const management = new SQLiteHabRegistry(
        join(hostDir, "registry.sqlite"),
        instanceRegistryOptions,
        authority,
      );
      try {
        management.migrate();
        const current = management.inspect(admin, agents[name].agent_id);
        assert.equal(current.agent_id, agents[name].agent_id);
        agents[name] = current;
        persist();
        return current;
      } finally {
        management.close();
      }
    },
    counts() {
      const rows = system.journalRows();
      const queuedOutboxes = ["a", "b"].reduce(
        (n, name) =>
          n +
          readDb(
            join(appDir, `outbox-${name}.sqlite`),
            (db) =>
              db
                .prepare(
                  "SELECT count(*) n FROM relay_outbox WHERE state IN ('queued','sending')",
                )
                .get().n,
          ),
        0,
      );
      return {
        pending_nats_admissions: rows.filter((row) =>
          ["staging", "pending", "leased"].includes(row.state),
        ).length,
        quarantined_nats: rows.filter((row) => row.state === "quarantined")
          .length,
        pending_body_cleanup: rows.filter(
          (row) => row.state === "acked" && row.cleaned !== 1,
        ).length,
        queued_outboxes: queuedOutboxes,
        unresolved_bridge: readDb(
          join(appDir, "bridge.sqlite"),
          (db) =>
            db
              .prepare(
                "SELECT count(*) n FROM task_bridge_links WHERE state!='linked'",
              )
              .get().n,
        ),
        unknown_submission_receipts: readDb(
          join(appDir, "submission-receipts.sqlite"),
          (db) =>
            db
              .prepare(
                "SELECT count(*) n FROM a2a_submission_receipts WHERE json_extract(data,'$.task') IS NULL",
              )
              .get().n,
        ),
      };
    },
    async settledCounts() {
      return eventually(async () => {
        const values = system.counts();
        if (!Object.values(values).every((n) => n === 0)) return undefined;
        const info = await manager.streams.info("HAB");
        if (info.state.messages !== 0) return undefined;
        assert.ok(Number.isSafeInteger(info.state.consumer_count));
        return {
          ...values,
          actual_broker: {
            messages: info.state.messages,
            logical_bytes: info.state.bytes,
            storage: info.config.storage,
            retention: info.config.retention,
            consumer_count: info.state.consumer_count,
          },
        };
      });
    },
    stopBroker,
    startBroker: openBroker,
    startApplication,
    close() {
      if (closing) return closing;
      closing = (async () => {
        phase = "closing";
        const errors = [];
        for (const action of [
          async () => {
            if (gatewayServer?.listening) {
              const port = gatewayServer.address().port;
              await closeListener(gatewayServer);
              await Promise.allSettled([...pendingNative]);
              closure.http_ports.push({ port, closed: true });
            }
          },
          async () => {
            if (host) {
              const port = Number(new URL(host.url).port);
              await host.close();
              closure.http_ports.push({ port, closed: true });
            }
          },
          async () => sdk?.close(),
          async () => {
            for (const s of stores.splice(0)) s.close();
            journal?.close();
            receipts?.close();
            hub?.close();
            closure.stores_closed = true;
          },
          stopBroker,
        ]) {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, "P7 close failed");
        phase = "closed";
        return { phase, root, closure };
      })();
      return closing;
    },
  };
  t.after(async () => {
    await system.close();
  });
  try {
    await openBroker();
    if (!brokerOnly) await startApplication();
    else phase = "broker-only";
    return system;
  } catch (error) {
    await system.close();
    throw error;
  }
}
