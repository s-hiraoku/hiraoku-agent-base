import assert from "node:assert/strict";
import process from "node:process";
import { TextDecoder } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fixture as brokerFixture } from "../../packages/relay-nats/test/fixture.js";
import { jetStreamTextPort } from "../../packages/relay-nats/src/text-port.ts";
import { SQLiteInbox } from "../../src/relay/sqlite-inbox.ts";
import { NatsTextClient } from "../../src/generic-nats/client.ts";
import { NatsTextRecipient } from "../../src/generic-nats/recipient.ts";
import { TextNatsJournal } from "../../src/generic-nats/journal.ts";
import { createTextTaskGate } from "../../src/generic-nats/task-gate.ts";
import {
  defineRoute,
  executePacket,
  packetMessage,
  textNatsLimits,
  TEXT_NATS_CONTRACT,
} from "../../src/generic-nats/protocol.ts";
import { Adapter } from "../../src/adapter.ts";
import { Journal } from "../../src/journal.ts";
import {
  openGenericEntranceFixture,
  a2aRequest,
  unpack,
} from "../generic-entrance-fixture.js";
import { prepareNatsServer } from "../../scripts/lib/nats-input.mjs";
import { EffectRuntime } from "./effect-runtime.js";

export { a2aRequest, unpack };
export async function call(client, name, args) {
  const reply = await client.callTool({ name, arguments: args });
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return unpack(reply);
}
export async function eventually(work, label = "finite condition") {
  for (let i = 0; i < 100; i++) {
    const value = await work();
    if (value) return value;
    await delay(20);
  }
  throw Error(`timed_out: ${label}`);
}
export function inboxAt(path, agentId) {
  const inbox = new SQLiteInbox(path, {
    agent_id: agentId,
    fingerprint_key: new Uint8Array(32).fill(44),
    limits: textNatsLimits,
    max_records: 100,
    max_body_bytes: 4_000_000,
    max_ack_records: 100,
    ack_retry_ms: 10000,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_attempts: 100,
  });
  inbox.migrate();
  return inbox;
}
export function journalAt(path, binding) {
  return new TextNatsJournal(path, {
    binding,
    fingerprintKey: new Uint8Array(32).fill(45),
    maxRecords: 1000,
    maxBytes: 8_000_000,
  });
}
export async function proof(t, options = {}) {
  if (!process.env.HAB_NATS_SERVER)
    throw Error(
      "HAB_NATS_SERVER is required; supply a repository verifier-staged pinned NATS server",
    );
  mkdirSync(resolve(".runtime"), { recursive: true, mode: 0o700 });
  const staged = prepareNatsServer(
    process.env.HAB_NATS_SERVER,
    resolve(".runtime"),
  );
  const hooks = [];
  let broker,
    entrance,
    client,
    clientInbox,
    clientJournal,
    closed = false;
  const recipients = new Map(),
    adapters = new Map(),
    children = new Set();
  const f = {
    get broker() {
      return broker;
    },
    get root() {
      return broker.dir;
    },
    get entrance() {
      return entrance;
    },
    get client() {
      return client;
    },
    get clientInbox() {
      return clientInbox;
    },
    get clientJournal() {
      return clientJournal;
    },
    get hub() {
      return entrance.hub;
    },
    get state() {
      return entrance.state;
    },
    recipients,
    children,
    async close() {
      if (closed) return;
      closed = true;
      const failures = [];
      const dispose = async (work) => {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      };
      for (const child of children) await dispose(() => child.kill());
      for (const item of recipients.values()) await dispose(() => item.close());
      recipients.clear();
      await dispose(() => client?.close());
      await dispose(() => clientInbox?.close());
      await dispose(() => clientJournal?.close());
      for (const journal of adapters.values())
        await dispose(() => journal.close());
      await dispose(() => entrance?.close());
      for (const hook of hooks.reverse()) await dispose(hook);
      if (broker) {
        await dispose(() => {
          const closed = JSON.parse(
            readFileSync(join(broker.dir, "closed.json"), "utf8"),
          );
          assert.equal(closed.live_gateways, 0);
          assert.equal(closed.live_inboxes, 0);
          assert.ok(closed.exit_code !== null || closed.signal !== null);
          assert.equal(children.size, 0);
          t.diagnostic(
            JSON.stringify({
              event: "owned_process_cleanup",
              broker_exited: true,
              receivers: children.size,
              live_gateways: closed.live_gateways,
            }),
          );
        });
        rmSync(broker.dir, { recursive: true, force: true });
      }
      rmSync(staged.fixtureCwd, { recursive: true, force: true });
      if (failures.length)
        throw new AggregateError(failures, "synthetic_fixture_cleanup_failed");
    },
  };
  t.after(() => f.close());
  broker = await brokerFixture(
    { after: (fn) => hooks.push(fn) },
    {
      limits: textNatsLimits,
      broker_max_message_bytes: 524288,
      max_body_bytes: 8_000_000,
      broker_max_bytes: 16_000_000,
      max_records: 1000,
      max_pending: 100,
      max_pending_per_recipient: 50,
      lease_ms: 100,
      max_attempts: 20,
    },
    staged.stagedPath,
  );
  entrance = await openGenericEntranceFixture({ parent: broker.dir });
  if (options.clockOffset) entrance.state.now += options.clockOffset;
  f.routes = ["paper", "mirror"].map((product, i) => {
    const { sender, worker } = entrance[product];
    return defineRoute({
      id: product,
      coordinator: "a",
      recipient: i ? "c" : "b",
      ownerSubject: sender.subject,
      ownerClient: sender.clientId,
      workerSubject: worker.subject,
      workerClient: worker.clientId,
      binding: sender.textBinding,
      boundaryId: worker.runnerScope,
      runtimeBoundaryId: `synthetic-${product}-runtime-v1`,
      retentionMs: 86400000,
    });
  });
  f.route = (product) => f.routes.find((route) => route.id === product);
  f.gate = createTextTaskGate(
    {
      get authorization() {
        return entrance.hub.authorization;
      },
      get: (...args) => entrance.hub.get(...args),
    },
    (route) => (entrance.state.revoked ? null : entrance[route.id].worker),
    () => entrance.state.now,
  );
  f.transport = (name) => ({
    agentId: name,
    submit: (message) =>
      jetStreamTextPort(broker.backend, name, name).submit(message),
    status: (id) => jetStreamTextPort(broker.backend, name, name).status(id),
    poll: () => jetStreamTextPort(broker.backend, name, name).poll(),
    ack: (request) =>
      jetStreamTextPort(broker.backend, name, name).ack(request),
  });
  f.openClient = async (patch = {}) => {
    await client?.close();
    clientInbox?.close();
    clientJournal?.close();
    clientInbox = inboxAt(join(broker.dir, "coordinator-inbox.sqlite"), "a");
    clientJournal = journalAt(
      join(broker.dir, "coordinator-journal.sqlite"),
      "coordinator",
    );
    client = new NatsTextClient({
      routes: f.routes,
      transport: f.transport("a"),
      inbox: clientInbox,
      journal: clientJournal,
      gate: f.gate,
      now: () => entrance.state.now,
      ...patch,
    });
    return client;
  };
  f.openRecipient = async (product = "paper", patch = {}) => {
    await recipients.get(product)?.close();
    const route = f.route(product),
      inbox = inboxAt(
        join(broker.dir, `${product}-inbox.sqlite`),
        route.recipient,
      ),
      journal = journalAt(
        join(broker.dir, `${product}-journal.sqlite`),
        route.scope,
      );
    const runtime = new EffectRuntime(
      broker.dir,
      product,
      options.runtime?.[product],
    );
    const recipient = new NatsTextRecipient({
      route,
      transport: f.transport(route.recipient),
      inbox,
      journal,
      gate: f.gate,
      runtime,
      now: () => entrance.state.now,
      ...patch,
    });
    let done = false;
    const item = {
      recipient,
      inbox,
      journal,
      runtime,
      async close() {
        if (done) return;
        done = true;
        await recipient.close();
        inbox.close();
        journal.close();
        runtime.close();
      },
    };
    recipients.set(product, item);
    return item;
  };
  f.adapter = (product) => {
    if (!adapters.has(product))
      adapters.set(
        product,
        new Journal(join(broker.dir, `${product}-adapter.sqlite`)),
      );
    return new Adapter(
      entrance.hub,
      entrance[product].worker,
      client.runs(product),
      adapters.get(product),
      { now: () => entrance.state.now },
    );
  };
  f.prepare = async (product = "paper") => {
    const id = await f.adapter(product).once();
    assert.ok(id, "a Task was prepared and its proxy handle attached");
    const task = await entrance.hub.get(entrance[product].worker, { id });
    assert.ok(task.run_id?.startsWith("gn_"));
    const request = task.text_request,
      key = `hub-${id}`;
    const packet = executePacket(
      f.route(product),
      {
        idempotencyKey: key,
        content: {
          origin: "external_agent",
          text: request.input.text,
          messageId: request.input.messageId,
          contextId: request.input.contextId,
          senderAgent: request.binding.senderAgent,
          recipientAgent: request.binding.recipientAgent,
        },
        tools: [],
        replay: {
          deadline: Math.min(
            request.acceptedAt + 86400000,
            request.input.workDeadline,
          ),
          retentionMs: 86400000,
          contract: TEXT_NATS_CONTRACT,
        },
      },
      request.acceptedAt,
    );
    return {
      id,
      key,
      task,
      packet,
      message: packetMessage(packet, f.route(product), request.acceptedAt),
    };
  };
  f.submit = async (
    product = "paper",
    messageId = "proof-message",
    text = "hello",
  ) => {
    const mcp = await entrance.mcp(product);
    return call(mcp, "text_submit", entrance.input(messageId, text));
  };
  f.finish = async (product = "paper") => {
    const item = recipients.get(product);
    await item.recipient.executeOnce();
    await item.recipient.sendOnce();
    await client.receiveOnce();
    return f.adapter(product).once();
  };
  f.rows = () => {
    const db = new DatabaseSync(broker.options.journal_path, {
      readOnly: true,
    });
    try {
      return db.prepare("SELECT * FROM nats_messages ORDER BY rowid").all();
    } finally {
      db.close();
    }
  };
  f.witness = async (messageId) => {
    const row = f
      .rows()
      .find((row) => row.message_id === messageId && row.sequence > 0);
    assert.ok(row, "accepted message has a broker sequence");
    const stored = await broker.manager.streams.getMessage("HAB", {
      seq: row.sequence,
    });
    assert.equal(stored.subject, row.subject);
    const body = JSON.parse(new TextDecoder().decode(stored.data));
    assert.equal(body.sender_id, row.sender_id);
    assert.equal(body.message.message_id, messageId);
    const packet = body.message.body.parts[0].value;
    t.diagnostic(
      JSON.stringify({
        event: "independent_broker_witness",
        sequence: stored.seq,
        sender: body.sender_id,
        recipient: body.message.recipient_id,
        message_id: messageId,
        type: packet.type,
        key: packet.key,
        first_sent_at: body.message.first_sent_at,
      }),
    );
    return body;
  };
  f.spawnRecipient = async (product = "paper", patch = {}) => {
    await recipients.get(product)?.close();
    recipients.delete(product);
    const route = f.route(product),
      config = join(broker.dir, `${product}-child-${children.size}.json`);
    const { authorization: _authorization, ...backendOptions } = broker.options;
    void _authorization;
    writeFileSync(
      config,
      JSON.stringify({
        route,
        root: broker.dir,
        backendOptions,
        now: entrance.state.now,
        ...patch,
      }),
      { mode: 0o600 },
    );
    const processChild = spawn(
      process.execPath,
      [new URL("./recipient-process.js", import.meta.url).pathname, config],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const pending = new Map();
    let counter = 0,
      stderr = "",
      readyResolve,
      effectResolve;
    const ready = new Promise((resolve) => (readyResolve = resolve)),
      effect = new Promise((resolve) => (effectResolve = resolve));
    processChild.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    processChild.on("message", async (message) => {
      if (message.type === "ready") readyResolve();
      else if (message.type === "effect") effectResolve(message);
      else if (message.type === "gate") {
        try {
          processChild.send({
            type: "witness",
            id: message.id,
            value: await f.gate.inspect(route, message.key),
          });
        } catch (error) {
          processChild.send({
            type: "witness",
            id: message.id,
            error: error.message,
          });
        }
      } else if (message.type === "response") {
        const wait = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) wait?.reject(Error(message.error));
        else wait?.resolve(message.value);
      }
    });
    processChild.on("exit", () => {
      for (const wait of pending.values())
        wait.reject(Error("owned_receiver_exited"));
      pending.clear();
    });
    const child = {
      process: processChild,
      effect,
      stderr: () => stderr,
      command(method) {
        const id = ++counter;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          processChild.send({ type: "command", id, method });
        });
      },
      async kill(signal = "SIGKILL") {
        if (
          processChild.exitCode === null &&
          processChild.signalCode === null
        ) {
          const exited = once(processChild, "exit");
          processChild.kill(signal);
          await exited;
        }
        children.delete(child);
      },
    };
    children.add(child);
    await Promise.race([
      ready,
      once(processChild, "exit").then(() => {
        throw Error(`owned_receiver_startup_failed ${stderr}`);
      }),
      delay(5000).then(() => {
        throw Error("owned_receiver_startup_timeout");
      }),
    ]);
    return child;
  };
  f.jetStreamTextPort = jetStreamTextPort;
  await f.openClient();
  await f.openRecipient("paper");
  await f.openRecipient("mirror");
  return f;
}
