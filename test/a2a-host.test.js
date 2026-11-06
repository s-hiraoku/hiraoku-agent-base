import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { startHost } from "../src/host/start.ts";
import { readHostConfig } from "../src/host/config.ts";
import {
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminStatus,
} from "../src/host/admin.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { DurableSender, DurableReceiver } from "../src/agent-sdk/index.ts";
import { SQLiteOutbox } from "../src/agent-sdk/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import { makeReplayBoundMessageId } from "../src/messaging/contract.ts";
import { limits } from "./relay-http-fixtures.js";
import { fixture } from "./local-relay-service-fixtures.js";
import { eventually, pollUntilDelivered } from "./jetstream-delivery.js";

const IDENTITY = "a2a@hab-host.hab";
const RECIPIENT = "worker@worker.hab";
const tokens = {
  caller: "a".repeat(64),
  other: "b".repeat(64),
  worker: "c".repeat(64),
  spoofer: "d".repeat(64),
  reserved: "e".repeat(64),
  mcpCaller: "f".repeat(64),
};
const a2aSection = (patch = {}) => ({
  port: 0,
  identity: IDENTITY,
  recipient: RECIPIENT,
  poll_interval_ms: 20,
  max_active_requests: 4,
  max_records: 50,
  ...patch,
});
const executionKinds = [
  "question",
  "answer",
  "notice",
  "execution_request",
  "execution_accepted",
  "execution_result",
];

/** Starts the real host with A2A on, pins its ports in the config and writes credentials. */
async function a2aHost(t, { a2a = a2aSection() } = {}) {
  const f = await fixture(t);
  f.config.registry.allowed_kinds = executionKinds;
  f.config.a2a = a2a;
  f.write("service.local.json", f.config);
  let host = await startHost(f.configPath);
  t.after(() => host?.close());
  f.config.port = Number(new URL(host.url).port);
  f.config.a2a = { ...a2a, port: Number(new URL(host.a2a_url).port) };
  f.write("service.local.json", f.config);
  const now = Date.now();
  const credential = (name, audience, issuer = "urn:synthetic:local") => ({
    sha256: createHash("sha256").update(tokens[name]).digest("hex"),
    principal: {
      issuer,
      audience,
      subject: `synthetic-${name}`,
      client_id: `client-${name}`,
      connection_id: `conn-${name}`,
    },
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 600000).toISOString(),
  });
  f.write("credentials.local.json", {
    version: 1,
    credentials: [
      credential("caller", host.a2a_url),
      credential("other", host.a2a_url),
      credential("worker", host.url),
      credential("spoofer", host.url),
      credential("reserved", host.url, "urn:hab:host"),
      credential("mcpCaller", host.url),
    ],
  });
  return {
    ...f,
    get host() {
      return host;
    },
    async restart() {
      await host.close();
      host = undefined;
      host = await startHost(f.configPath);
    },
    connect(name, address, operations) {
      return hostAdminConnect(f.configPath, {
        address,
        connection_id: `conn-${name}`,
        ...(operations ? { operations } : {}),
      }).address;
    },
  };
}

function identityRow(f) {
  const db = new DatabaseSync(join(f.config.directory, "registry.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT a.agent_id,a.state,a.epoch,a.operations,(SELECT count(*) FROM hab_bindings b WHERE b.agent_id=a.agent_id AND b.state='active') bindings FROM hab_agents a WHERE a.bot_name='a2a'",
      )
      .all();
  } finally {
    db.close();
  }
}

/** A recipient agent using only the agent SDK over the host's MCP entry. */
function agent(t, f, name, agentId) {
  const client = new HabMcpClient({
    policy: {
      resource_url: f.host.url,
      agent_id: agentId,
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
    authorization: () => `Bearer ${tokens[name]}`,
  });
  const outbox = new SQLiteOutbox(join(f.dir, `outbox-${name}.sqlite`), {
    agent_id: agentId,
    fingerprint_key: new Uint8Array(32).fill(71),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    retry_base_ms: 1000,
    retry_cap_ms: 60000,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  });
  outbox.migrate();
  const inbox = new SQLiteInbox(join(f.dir, `inbox-${name}.sqlite`), {
    agent_id: agentId,
    fingerprint_key: new Uint8Array(32).fill(72),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_ack_records: 30,
    ack_retry_ms: 86400000,
    retry_base_ms: 1000,
    retry_cap_ms: 60000,
    max_attempts: 5,
  });
  inbox.migrate();
  t.after(() => {
    outbox.close();
    inbox.close();
  });
  const sender = new DurableSender(outbox, client);
  const receiver = new DurableReceiver(inbox, {
    poll: () => pollUntilDelivered(client),
    ack: (request) => client.ack(request),
  });
  return {
    client,
    receiver,
    /** Sends `kind` to the entry's sender; a null kind value sends a text notice instead. */
    async send(entry, kind, value) {
      const at = new Date().toISOString();
      const message = {
        version: 1,
        message_id: makeReplayBoundMessageId(
          at,
          randomUUID().replaceAll("-", ""),
        ),
        recipient_id: entry.sender_id,
        kind,
        thread_id: entry.message.thread_id,
        in_reply_to: value
          ? {
              sender_id: entry.sender_id,
              message_id: entry.message.message_id,
            }
          : null,
        first_sent_at: at,
        expires_at: new Date(Date.parse(at) + 3600000).toISOString(),
        body: {
          parts: [
            value
              ? {
                  type: "data",
                  schema_id: `task.${kind}`,
                  schema_version: 1,
                  value,
                }
              : { type: "text", text: "unsolicited" },
          ],
        },
      };
      sender.enqueue(message);
      await sender.sendOnce();
      return { message, record: outbox.get(message.message_id) };
    },
    async reply(entry, kind, value) {
      const { message, record } = await this.send(entry, kind, value);
      assert.equal(record.state, "accepted");
      return message;
    },
  };
}

async function a2aClient(f, name) {
  const authorization = `Bearer ${tokens[name]}`;
  const client = await new ClientFactory({
    ...new ClientFactory().options,
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: (url, init) =>
        globalThis.fetch(url, {
          ...init,
          headers: { ...init?.headers, Authorization: authorization },
        }),
    }),
  }).createFromUrl(new URL(f.host.a2a_url).origin);
  const options = { serviceParameters: { Authorization: authorization } };
  return {
    send: (messageId, text = "connectivity_check") =>
      client.sendMessage(
        SendMessageRequest.fromJSON({
          message: { messageId, role: "ROLE_USER", parts: [{ text }] },
          configuration: { returnImmediately: true },
        }),
        options,
      ),
    get: (id) => client.getTask({ id }, options),
  };
}

function raw(f, method, params, headers = {}) {
  return globalThis.fetch(f.host.a2a_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "check", method, params }),
  });
}
const sendParams = (messageId) => ({
  message: {
    messageId,
    role: "ROLE_USER",
    parts: [{ text: "connectivity_check" }],
  },
  configuration: { returnImmediately: true },
});

async function untilState(read, state) {
  const task = await eventually(async () => {
    const current = await read();
    return current.status.state === state ? current : undefined;
  }, 8000);
  assert.ok(task, `task reached state ${state}`);
  return task;
}

async function connected(t, options) {
  const f = await a2aHost(t, options);
  const caller = f.connect("caller", "caller@caller.hab");
  const worker = f.connect("worker", RECIPIENT);
  return {
    f,
    caller,
    worker,
    recipient: agent(t, f, "worker", worker.agent_id),
    identity: identityRow(f)[0],
  };
}

test("a shared outbox sends only the named intent", async (t) => {
  const f = await fixture(t);
  const outbox = new SQLiteOutbox(join(f.dir, "shared-outbox.sqlite"), {
    agent_id: "host-identity",
    fingerprint_key: new Uint8Array(32).fill(73),
    limits,
    max_records: 10,
    max_body_bytes: 100000,
    max_clock_skew_ms: 1000,
    lease_ms: 30000,
    retry_base_ms: 1000,
    retry_cap_ms: 60000,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  });
  outbox.migrate();
  t.after(() => outbox.close());
  const intent = (entropy) => {
    const at = new Date().toISOString();
    return {
      version: 1,
      message_id: makeReplayBoundMessageId(at, entropy),
      recipient_id: "recipient",
      kind: "notice",
      thread_id: `thread_${entropy}`,
      in_reply_to: null,
      first_sent_at: at,
      expires_at: new Date(Date.parse(at) + 3600000).toISOString(),
      body: { parts: [{ type: "text", text: entropy }] },
    };
  };
  const first = intent("1".repeat(32)),
    second = intent("2".repeat(32));
  outbox.enqueue(first);
  outbox.enqueue(second);
  const submitted = [];
  const sender = new DurableSender(outbox, {
    async submit(message) {
      submitted.push(message.message_id);
      throw Object.assign(Error("offline"), { code: "unavailable" });
    },
    status: async () => assert.fail("no status lookup"),
  });
  await assert.rejects(() => sender.sendOnce(second.message_id));
  assert.deepEqual(submitted, [second.message_id]);
  assert.equal(outbox.get(first.message_id).submit_attempts, 0);
  assert.throws(() => outbox.claim("not valid!"), { code: "invalid_request" });
});

test("the example a2a section is a valid host config section", async (t) => {
  const f = await fixture(t);
  const { a2a } = JSON.parse(
    readFileSync(resolve("config/relay-a2a.example.json"), "utf8"),
  );
  f.write("service.local.json", { ...f.config, a2a });
  assert.deepEqual(readHostConfig(f.configPath).config.a2a, a2a);
  f.write("service.local.json", {
    ...f.config,
    a2a: { ...a2a, recipient: a2a.identity },
  });
  assert.throws(() => readHostConfig(f.configPath), {
    reason: "config_invalid",
    fields: ["a2a.recipient"],
  });
});

test("A2A is off by default: no listener, mailbox or host identity", async (t) => {
  const f = await fixture(t);
  const host = await startHost(f.configPath);
  try {
    assert.equal(host.a2a_url, undefined);
    assert.deepEqual(Object.keys(host).sort(), ["close", "url"]);
  } finally {
    await host.close();
  }
  assert.deepEqual(
    readdirSync(f.config.directory).filter((name) => name.startsWith("a2a")),
    [],
  );
  assert.deepEqual(identityRow(f), []);
});

test("an A2A Task is sent from the host identity and completes from the recipient's agent-sdk replies", async (t) => {
  const { f, caller, recipient, identity } = await connected(t);
  assert.equal(identity.state, "active");
  const client = await a2aClient(f, "caller");
  const task = await client.send("host_roundtrip");
  assert.equal(task.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(task.metadata.hab_relay.sender_id, identity.agent_id);
  assert.equal(task.metadata.hab_relay.attestation, "recipient_reply");

  await recipient.receiver.receiveOnce();
  const [request] = recipient.receiver.inbox();
  assert.equal(request.sender_id, identity.agent_id);
  assert.notEqual(request.sender_id, caller.agent_id);
  assert.equal(request.message.kind, "execution_request");
  assert.equal(
    request.message.message_id,
    task.metadata.hab_relay.source.message_id,
  );
  assert.equal(
    (await client.get(task.id)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
    "storage ACK alone does not accept execution",
  );

  await recipient.reply(request, "execution_accepted", {
    task_type: "connectivity_check",
    task_id: "engine-task-1",
  });
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);
  const result = await recipient.reply(request, "execution_result", {
    task_type: "connectivity_check",
    task_id: "engine-task-1",
    state: "succeeded",
    result: "connectivity_ok",
  });
  const done = await untilState(
    () => client.get(task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
  assert.equal(done.metadata.hab_relay.result_message_id, result.message_id);
  const inbox = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      inbox
        .prepare("SELECT count(*) n FROM relay_inbox WHERE released_at IS NULL")
        .get().n,
      0,
      "a terminal Task releases the reply bodies it consumed",
    );
  } finally {
    inbox.close();
  }
  const replay = await client.send("host_roundtrip");
  assert.equal(replay.id, task.id);
  assert.equal(replay.status.state, TaskState.TASK_STATE_COMPLETED);
});

test("a pending A2A Task survives a host restart and completes afterwards", async (t) => {
  const { f, recipient, identity } = await connected(t);
  const before = await (await a2aClient(f, "caller")).send("host_restart");
  assert.equal(before.status.state, TaskState.TASK_STATE_SUBMITTED);
  await f.restart();
  assert.deepEqual(identityRow(f), [identity]);
  const client = await a2aClient(f, "caller");
  assert.equal(
    (await client.get(before.id)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  const replay = await client.send("host_restart");
  assert.equal(replay.id, before.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    before.metadata.hab_relay.source,
  );
  await recipient.receiver.receiveOnce();
  const [request] = recipient.receiver.inbox();
  assert.equal(recipient.receiver.inbox().length, 1);
  await recipient.reply(request, "execution_result", {
    task_type: "connectivity_check",
    task_id: "engine-task-2",
    state: "failed",
    result: null,
  });
  const done = await untilState(
    () => client.get(before.id),
    TaskState.TASK_STATE_FAILED,
  );
  assert.deepEqual(done.artifacts, []);
});

test("host identity provisioning is idempotent and the identity stays host-only", async (t) => {
  const f = await a2aHost(t);
  const [first] = identityRow(f);
  assert.deepEqual(
    { state: first.state, bindings: first.bindings },
    { state: "active", bindings: 1 },
  );
  assert.deepEqual(JSON.parse(first.operations), [
    "ack",
    "poll",
    "status",
    "submit",
  ]);
  await f.restart();
  await f.restart();
  assert.deepEqual(identityRow(f), [first], "restart changes nothing");
  assert.throws(() => f.connect("caller", IDENTITY), {
    code: "a2a_identity_reserved",
  });
  const listed = hostAdminStatus(f.configPath).addresses.find(
    (a) => a.address === IDENTITY,
  );
  assert.equal(listed.active_bindings, 1);

  // A bound operator credential with the reserved host issuer authenticates as nobody.
  const reserved = f.connect("reserved", "reserved@reserved.hab");
  const impostor = agent(t, f, "reserved", reserved.agent_id);
  await assert.rejects(() => impostor.client.poll(), { code: "forbidden" });
});

test("an identity address an operator already connected is refused at start", async (t) => {
  const f = await fixture(t);
  f.config.registry.allowed_kinds = executionKinds;
  const host = await startHost(f.configPath);
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);
  const now = Date.now();
  f.write("credentials.local.json", {
    version: 1,
    credentials: [
      {
        sha256: createHash("sha256").update(tokens.worker).digest("hex"),
        principal: {
          issuer: "urn:synthetic:local",
          audience: host.url,
          subject: "synthetic-squatter",
          client_id: "client-squatter",
          connection_id: "conn-squatter",
        },
        issued_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 600000).toISOString(),
      },
    ],
  });
  hostAdminConnect(f.configPath, {
    address: IDENTITY,
    connection_id: "conn-squatter",
  });
  await host.close();
  f.config.a2a = a2aSection();
  f.write("service.local.json", f.config);
  await assert.rejects(startHost(f.configPath), {
    reason: "a2a_identity_conflict",
  });
});

test("A2A refuses unauthenticated, wrong-audience, unauthorized and cross-owner requests", async (t) => {
  const { f, recipient, identity } = await connected(t);
  f.connect("other", "other@other.hab");
  f.connect("mcpCaller", "mcp@caller.hab");
  const bearer = (name) => ({ Authorization: `Bearer ${tokens[name]}` });

  assert.equal((await raw(f, "SendMessage", sendParams("anon"))).status, 401);
  assert.equal(
    (await raw(f, "SendMessage", sendParams("mcp"), bearer("mcpCaller")))
      .status,
    401,
    "an MCP-audience credential is not an A2A credential",
  );
  assert.equal(
    (
      await raw(f, "SendMessage", sendParams("origin"), {
        ...bearer("caller"),
        Origin: "http://127.0.0.1",
      })
    ).status,
    403,
  );

  const client = await a2aClient(f, "caller");
  const task = await client.send("owned_task");
  const foreign = await raw(f, "GetTask", { id: task.id }, bearer("other"));
  assert.equal(foreign.status, 200);
  assert.ok((await foreign.json()).error, "another caller cannot read it");

  // Only the recipient can reply to the host's message; anyone else's mail is dropped.
  const spoofer = agent(
    t,
    f,
    "spoofer",
    f.connect("spoofer", "spoofer@spoofer.hab").agent_id,
  );
  const hostMessage = {
    sender_id: identity.agent_id,
    message: {
      thread_id: task.metadata.hab_relay.source.thread_id,
      message_id: task.metadata.hab_relay.source.message_id,
    },
  };
  const forged = await spoofer.send(hostMessage, "execution_result", {
    task_type: "connectivity_check",
    task_id: "spoofed",
    state: "succeeded",
    result: "spoofed",
  });
  assert.equal(forged.record.state, "quarantined");
  assert.equal(
    (await spoofer.send(hostMessage, "notice", null)).record.state,
    "accepted",
  );
  await recipient.receiver.receiveOnce();
  const hostInbox = () => {
    const db = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          "SELECT body,receipt_confirmed acked,released_at IS NOT NULL released FROM relay_inbox",
        )
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  assert.deepEqual(
    await eventually(() => {
      const rows = hostInbox();
      return rows.length && rows.every((row) => row.released && row.acked)
        ? rows
        : undefined;
    }),
    [{ body: "", acked: 1, released: 1 }],
    "the unsolicited notice was saved, ACKed and released",
  );
  assert.equal(
    (await client.get(task.id)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
  );

  // Without the resolve grant the caller cannot reach the recipient through the host.
  f.connect("other", "other@other.hab", ["submit", "status", "poll", "ack"]);
  assert.equal(
    (await raw(f, "SendMessage", sendParams("no_resolve"), bearer("other")))
      .status,
    403,
  );

  // After disconnection the caller's existing Task is no longer reachable.
  hostAdminDisconnect(f.configPath, "caller@caller.hab");
  assert.equal(
    (await raw(f, "GetTask", { id: task.id }, bearer("caller"))).status,
    403,
  );
});

test("after unrelated notices reach the cap, a valid reply is still saved and ACKed", async (t) => {
  const max = 2;
  const { f, recipient, identity } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const spoofer = agent(
    t,
    f,
    "spoofer",
    f.connect("spoofer", "spoofer@spoofer.hab").agent_id,
  );
  const acked = async (client, messageId) => {
    for (let i = 0; i < 40; i++) {
      const state = await client.status(messageId).then(
        (receipt) => receipt.state,
        () => undefined,
      );
      if (state === "acked") return state;
      await new Promise((done) => setTimeout(done, 200));
    }
  };
  const hostEntry = {
    sender_id: identity.agent_id,
    message: { thread_id: "unrelated", message_id: "unrelated" },
  };
  const notices = async (count) => {
    for (let i = 0; i < count; i++) {
      const { message } = await spoofer.send(hostEntry, "notice", null);
      assert.equal(
        await acked(spoofer.client, message.message_id),
        "acked",
        "the host consumed the unrelated notice",
      );
    }
  };
  const client = await a2aClient(f, "caller");
  const roundtrip = async (name) => {
    const task = await client.send(name);
    await recipient.receiver.receiveOnce();
    const request = recipient.receiver
      .inbox()
      .find(
        (entry) =>
          entry.message.message_id ===
          task.metadata.hab_relay.source.message_id,
      );
    const result = await recipient.reply(request, "execution_result", {
      task_type: "connectivity_check",
      task_id: `engine-${name}`,
      state: "succeeded",
      result: "connectivity_ok",
    });
    assert.equal(
      await acked(recipient.client, result.message_id),
      "acked",
      "the host saved and ACKed the valid reply",
    );
    await untilState(() => client.get(task.id), TaskState.TASK_STATE_COMPLETED);
  };

  await notices(max);
  await roundtrip("after_record_cap");
  // The host inbox keeps three ACK records per record slot; spend all of them too.
  await notices(max * 3);
  await roundtrip("after_ack_cap");
});
