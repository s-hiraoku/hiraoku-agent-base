import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { DatabaseTaskStore } from "@a2a-js/sdk/server/database";
import { startHost } from "../src/host/start.ts";
import { replySafeCollectionLimit } from "../src/host/a2a.ts";
import { readHostConfig } from "../src/host/config.ts";
import {
  hostAdminConnect,
  hostAdminDisconnect,
  hostAdminStatus,
} from "../src/host/admin.ts";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { HabJetStreamService } from "../src/host/hab-delivery-service.ts";
import { DurableSender, DurableReceiver } from "../src/agent-sdk/index.ts";
import { SQLiteOutbox } from "../src/agent-sdk/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/agent-sdk/sqlite-inbox.ts";
import {
  makeReplayBoundMessageId,
  RECORD_RETENTION_MS,
} from "../src/messaging/contract.ts";
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
    /** Restarts the host; `offline` runs while it is stopped. */
    async restart(offline) {
      await host.close();
      host = undefined;
      await offline?.();
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
    /**
     * Sends `kind` to the entry's sender; a null kind value sends a text notice instead.
     * The message expires `expiresInMs` from now, its first send backdated to match.
     */
    async send(
      entry,
      kind,
      value,
      expiresInMs = 3600000,
      entropy = randomUUID().replaceAll("-", ""),
    ) {
      const at = new Date(Date.now() - 3600000 + expiresInMs).toISOString();
      const message = {
        version: 1,
        message_id: makeReplayBoundMessageId(at, entropy),
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
    async reply(entry, kind, value, expiresInMs, entropy) {
      const { message, record } = await this.send(
        entry,
        kind,
        value,
        expiresInMs,
        entropy,
      );
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
    send: (messageId, text = "connectivity_check", returnImmediately = true) =>
      client.sendMessage(
        SendMessageRequest.fromJSON({
          message: { messageId, role: "ROLE_USER", parts: [{ text }] },
          configuration: { returnImmediately },
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

/** Reads a sent message's relay status slowly enough to stay under the MCP rate limit. */
async function untilAcked(client, messageId) {
  for (let i = 0; i < 40; i++) {
    const state = await client.status(messageId).then(
      (receipt) => receipt.state,
      () => undefined,
    );
    if (state === "acked") return state;
    await new Promise((done) => setTimeout(done, 200));
  }
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
  const notice = await spoofer.send(hostMessage, "notice", null);
  assert.equal(notice.record.state, "accepted");
  await recipient.receiver.receiveOnce();
  assert.equal(
    await untilAcked(spoofer.client, notice.message.message_id),
    "acked",
  );
  const inbox = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      inbox.prepare("SELECT count(*) n FROM relay_inbox").get().n,
      0,
      "the unsolicited notice was ACKed without an inbox record",
    );
  } finally {
    inbox.close();
  }
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
  const hostEntry = {
    sender_id: identity.agent_id,
    message: { thread_id: "unrelated", message_id: "unrelated" },
  };
  const notices = async (count) => {
    for (let i = 0; i < count; i++) {
      const { message } = await spoofer.send(hostEntry, "notice", null);
      assert.equal(
        await untilAcked(spoofer.client, message.message_id),
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
      await untilAcked(recipient.client, result.message_id),
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

test("a caller revoked from another connection between its check and the host submit never reaches the recipient", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  // Runs a real operator disconnect, on its own Registry connection, at the moment
  // the host identity submits: after the route checked the caller.
  const submit = HabJetStreamService.prototype.submit;
  let revoked, refusal;
  HabJetStreamService.prototype.submit = function (context, input) {
    if (revoked === undefined && input?.kind === "execution_request") {
      try {
        hostAdminDisconnect(f.configPath, "caller@caller.hab");
        revoked = true;
      } catch (error) {
        revoked = false;
        refusal = error.code;
      }
    }
    return submit.call(this, context, input);
  };
  t.after(() => {
    HabJetStreamService.prototype.submit = submit;
  });
  await client.send("revoked_in_gap").catch(() => undefined);
  assert.notEqual(revoked, undefined, "the host reached its submit");
  await recipient.receiver.receiveOnce();
  const delivered = recipient.receiver
    .inbox()
    .some((entry) => entry.message.kind === "execution_request");
  assert.ok(
    !(revoked && delivered),
    "a revocation that committed before admission blocks delivery",
  );
  assert.deepEqual(
    { revoked, refusal },
    { revoked: false, refusal: "registry_unavailable" },
    "the revocation cannot take the Registry lock the admission holds",
  );
  hostAdminDisconnect(f.configPath, "caller@caller.hab");
  assert.equal(
    (
      await raw(f, "SendMessage", sendParams("after_revoke"), {
        Authorization: `Bearer ${tokens.caller}`,
      })
    ).status,
    403,
  );
});

/** Sends `count` Tasks and returns each with the request the recipient received for it. */
async function inFlight(client, recipient, prefix, count) {
  const sent = [];
  for (let i = 0; i < count; i++)
    sent.push(await client.send(`${prefix}_${i}`));
  const requests = await eventually(async () => {
    await recipient.receiver.receiveOnce();
    const found = sent.map((task) =>
      recipient.receiver
        .inbox()
        .find(
          (entry) =>
            entry.message.message_id ===
            task.metadata.hab_relay.source.message_id,
        ),
    );
    return found.every(Boolean) ? found : undefined;
  }, 8000);
  assert.ok(requests, "the recipient received every request");
  return sent.map((task, i) => ({ task, request: requests[i] }));
}
const accepted = (name) => ({
  task_type: "connectivity_check",
  task_id: `engine-${name}`,
});
const succeeded = (name) => ({
  ...accepted(name),
  state: "succeeded",
  result: "connectivity_ok",
});

test("even when accepted replies fill the cap, the matching results are saved and ACKed and every Task completes", async (t) => {
  const max = 2;
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const client = await a2aClient(f, "caller");
  const flights = await inFlight(client, recipient, "accepted_cap", max);
  for (const [i, { request }] of flights.entries()) {
    const reply = await recipient.reply(
      request,
      "execution_accepted",
      accepted(i),
    );
    assert.equal(
      await untilAcked(recipient.client, reply.message_id),
      "acked",
      "the host saved and ACKed the accepted reply",
    );
  }
  for (const [i, { request }] of flights.entries()) {
    const reply = await recipient.reply(
      request,
      "execution_result",
      succeeded(i),
    );
    assert.equal(
      await untilAcked(recipient.client, reply.message_id),
      "acked",
      "the host saved and ACKed the result while accepted replies filled the cap",
    );
  }
  for (const { task } of flights)
    await untilState(() => client.get(task.id), TaskState.TASK_STATE_COMPLETED);
});

const inboxRows = (f) => {
  const db = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare("SELECT count(*) n FROM relay_inbox").get().n;
  } finally {
    db.close();
  }
};

test("a flood of fresh-ID replies that would not change the Task takes no ACK history, so the valid result still completes it", async (t) => {
  const max = 2;
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "flood", 1);
  const first = await recipient.reply(
    request,
    "execution_accepted",
    accepted("flood"),
  );
  assert.equal(await untilAcked(recipient.client, first.message_id), "acked");
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);

  // More fresh IDs than the whole ACK history (3 × max_records) holds: repeats of the
  // acceptance, an acceptance naming another engine Task, and results the Task refuses.
  const flood = [];
  for (let i = 0; i < max * 3 + 2; i++) {
    const [kind, value] = [
      ["execution_accepted", accepted("flood")],
      ["execution_accepted", accepted(`other${i}`)],
      ["execution_result", { ...succeeded("flood"), state: "unknown" }],
    ][i % 3];
    flood.push(await recipient.reply(request, kind, value));
  }
  const result = await recipient.reply(
    request,
    "execution_result",
    succeeded("flood"),
  );
  assert.equal(
    await untilAcked(recipient.client, result.message_id),
    "acked",
    "the host saved and ACKed the valid result behind the flood",
  );
  const done = await untilState(
    () => client.get(task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
  assert.equal(done.metadata.hab_relay.result_message_id, result.message_id);
  for (const reply of flood)
    assert.equal(
      await untilAcked(recipient.client, reply.message_id),
      "acked",
      "every flood reply was ACKed",
    );
  assert.equal(
    inboxRows(f),
    2,
    "only the acceptance and the result entered the inbox and its ACK history",
  );
});

const unreleasedReplies = (f) => {
  const db = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT count(*) n FROM relay_inbox WHERE released_at IS NULL")
      .get().n;
  } finally {
    db.close();
  }
};

test("Tasks that complete but are never read free their inbox slots, so new Tasks still complete after the outbox purge", async (t) => {
  const max = 2;
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const client = await a2aClient(f, "caller");
  const finish = async (flights, prefix) => {
    for (const [i, { request }] of flights.entries())
      for (const [kind, value] of [
        ["execution_accepted", accepted(`${prefix}${i}`)],
        ["execution_result", succeeded(`${prefix}${i}`)],
      ]) {
        const reply = await recipient.reply(request, kind, value);
        assert.equal(
          await untilAcked(recipient.client, reply.message_id),
          "acked",
          `the host saved and ACKed ${prefix} ${kind} ${i}`,
        );
      }
  };
  const unread = await inFlight(client, recipient, "unread", max);
  await finish(unread, "unread");

  // Maintenance purges outbox records and confirmed ACK history about 30 days after
  // expiry; delete them as it would. Unreleased bodies are never collected.
  const outbox = new DatabaseSync(
    join(f.config.directory, "a2a-outbox.sqlite"),
  );
  outbox.exec("DELETE FROM relay_outbox");
  outbox.close();
  const inbox = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
  inbox.exec("DELETE FROM relay_receiver_acks WHERE state='confirmed'");
  inbox.close();

  const fresh = await inFlight(client, recipient, "fresh", max);
  await finish(fresh, "fresh");
  for (const { task } of [...unread, ...fresh]) {
    const done = await untilState(
      () => client.get(task.id),
      TaskState.TASK_STATE_COMPLETED,
    );
    assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
  }

  const late = await recipient.reply(
    fresh[0].request,
    "execution_accepted",
    accepted("fresh0"),
  );
  assert.equal(await untilAcked(recipient.client, late.message_id), "acked");
  assert.ok(
    await eventually(async () => unreleasedReplies(f) === 0 || undefined, 8000),
    "a late reply to a terminal Task is released at once",
  );
});

/** The first time outbox maintenance may delete this record. */
const purgeHorizon = (record) =>
  Math.max(
    record.retain_until,
    record.status_until + RECORD_RETENTION_MS,
    record.expires_at + RECORD_RETENTION_MS,
    record.terminal_at + RECORD_RETENTION_MS,
  );

test("a Task admitted once an outbox record is purged still gets its replies saved, even after a late reply", async (t) => {
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: 1 }),
  });
  const client = await a2aClient(f, "caller");
  const [old] = await inFlight(client, recipient, "late_source", 1);
  const source = old.task.metadata.hab_relay.source.message_id;
  const day = 86400000;
  const outbox = new DatabaseSync(
    join(f.config.directory, "a2a-outbox.sqlite"),
  );
  // The request was sent two days ago, so the replies below come long after it expired.
  outbox
    .prepare(
      "UPDATE relay_outbox SET expires_at=expires_at-?,first_sent_at=first_sent_at-?,status_until=status_until-?,terminal_at=terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
    )
    .run(2 * day, 2 * day, 2 * day, 2 * day, 2 * day, source);
  for (const [kind, value] of [
    ["execution_accepted", accepted("late")],
    ["execution_result", succeeded("late")],
  ]) {
    const reply = await recipient.reply(old.request, kind, value);
    assert.equal(await untilAcked(recipient.client, reply.message_id), "acked");
  }

  // Maintenance at the first moment it may purge that outbox record: it deletes the
  // record and every ACK row whose own retention has also ended by then.
  const record = outbox
    .prepare("SELECT * FROM relay_outbox WHERE message_id=?")
    .get(source);
  const purgeAt = purgeHorizon(record);
  outbox.prepare("DELETE FROM relay_outbox WHERE message_id=?").run(source);
  outbox.close();
  const inbox = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
  inbox
    .prepare(
      "DELETE FROM relay_receiver_acks WHERE state!='pending' AND retain_until<=? AND retry_until+?<=?",
    )
    .run(purgeAt, RECORD_RETENTION_MS, purgeAt);
  inbox.close();

  const [next] = await inFlight(client, recipient, "after_purge", 1);
  for (const [kind, value] of [
    ["execution_accepted", accepted("next")],
    ["execution_result", succeeded("next")],
  ]) {
    const reply = await recipient.reply(next.request, kind, value);
    assert.equal(
      await untilAcked(recipient.client, reply.message_id),
      "acked",
      `the host saved and ACKed the admitted Task's ${kind}`,
    );
  }
  await untilState(
    () => client.get(next.task.id),
    TaskState.TASK_STATE_COMPLETED,
  );

  const db = new DatabaseSync(join(f.config.directory, "a2a-outbox.sqlite"), {
    readOnly: true,
  });
  const horizon = purgeHorizon(
    db
      .prepare("SELECT * FROM relay_outbox WHERE message_id=?")
      .get(next.task.metadata.hab_relay.source.message_id),
  );
  db.close();
  const acks = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  assert.ok(
    acks.prepare("SELECT max(retain_until) n FROM relay_receiver_acks").get()
      .n <= horizon,
    "on-time replies' ACK history is collectable before their outbox record",
  );
  acks.close();
});

/** The host's own A2A inbox, opened with the key the host derives from the fixture's Registry key. */
function hostInbox(f, agentId, maxRecords) {
  const a2aKey = createHmac("sha256", Buffer.from("11".repeat(32), "hex"))
    .update("hab-host-a2a-v1")
    .digest();
  const inbox = new SQLiteInbox(join(f.config.directory, "a2a-inbox.sqlite"), {
    agent_id: agentId,
    fingerprint_key: createHmac("sha256", a2aKey)
      .update("hab-host-a2a-inbox-v1")
      .digest(),
    limits,
    max_records: maxRecords * 2,
    max_body_bytes: maxRecords * 2 * limits.envelope_bytes,
    max_ack_records: maxRecords * 3,
    ack_retry_ms: 86400000,
    retry_base_ms: 1000,
    retry_cap_ms: 60000,
    max_attempts: 5,
  });
  inbox.migrate();
  return inbox;
}

/** A reply to `entry` first sent almost an hour ago, so it expires in `msLeft`. */
function expiringReply(entry, kind, value, msLeft) {
  const at = new Date(Date.now() - 3600000 + msLeft).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(at, randomUUID().replaceAll("-", "")),
    recipient_id: entry.sender_id,
    kind,
    thread_id: entry.message.thread_id,
    in_reply_to: {
      sender_id: entry.sender_id,
      message_id: entry.message.message_id,
    },
    first_sent_at: at,
    expires_at: new Date(Date.parse(at) + 3600000).toISOString(),
    body: {
      parts: [
        { type: "data", schema_id: `task.${kind}`, schema_version: 1, value },
      ],
    },
  };
}

test("saved replies whose ACK can never be confirmed release their slots, so a later reply is still saved and completes its Task", async (t) => {
  const max = 2;
  const { f, worker, recipient, identity } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const client = await a2aClient(f, "caller");
  const flights = await inFlight(client, recipient, "unconfirmable", max);
  await f.restart(async () => {
    // A previous run saved these replies, then its ACK came back invalid_ack and the
    // replies expired, so no redelivery can confirm them. They fill every body slot.
    const inbox = hostInbox(f, identity.agent_id, max);
    try {
      for (const [i, { request }] of flights.entries())
        for (const [kind, value] of [
          ["execution_accepted", accepted(`lost${i}`)],
          ["execution_result", succeeded(`lost${i}`)],
        ]) {
          const m = expiringReply(request, kind, value, 1500);
          inbox.save({
            message: { ...m, sender_id: worker.agent_id },
            generation: 1,
            lease_token: "x".repeat(43),
            lease_until: m.expires_at,
          });
          inbox.rejectAck(inbox.claimAck(), "invalid_ack");
        }
    } finally {
      inbox.close();
    }
    assert.equal(unreleasedReplies(f), 2 * max);
    await new Promise((done) => setTimeout(done, 1600));
  });
  const [{ task, request }] = flights;
  for (const [kind, value] of [
    ["execution_accepted", accepted("fresh")],
    ["execution_result", succeeded("fresh")],
  ]) {
    const reply = await recipient.reply(request, kind, value);
    assert.equal(
      await untilAcked(recipient.client, reply.message_id),
      "acked",
      `the host saved and ACKed the new ${kind}`,
    );
  }
  const done = await untilState(
    () => client.get(task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
  assert.equal(unreleasedReplies(f), 0);
  assert.equal(
    (await client.get(flights[1].task.id)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
    "an unconfirmed reply is never applied to its Task",
  );
});

test("a saved confirmed reply that breaks the A2A contract limits is released as refused and leaves its Task unchanged", async (t) => {
  const max = 1;
  const { f, worker, recipient, identity } = await connected(t, {
    a2a: a2aSection({ max_records: max }),
  });
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "oversized", 1);
  await f.restart(async () => {
    // Saved and ACK-confirmed under the wider delivery limits, but its data part is
    // over HAB_A2A_LIMITS, so applying it raises ContractError on every attempt.
    const inbox = hostInbox(f, identity.agent_id, max);
    try {
      const m = expiringReply(
        request,
        "execution_result",
        { ...succeeded("oversized"), result: "x".repeat(5000) },
        3600000 - 1000,
      );
      inbox.save({
        message: { ...m, sender_id: worker.agent_id },
        generation: 1,
        lease_token: "x".repeat(43),
        lease_until: m.expires_at,
      });
      const ack = inbox.claimAck();
      inbox.confirmAck(ack, {
        state: "acked",
        recipient_id: identity.agent_id,
        sender_id: ack.sender_id,
        message_id: ack.message_id,
        request_id: ack.request_id,
        receipt_id: "receipt-oversized",
        acked_at: new Date().toISOString(),
      });
    } finally {
      inbox.close();
    }
    assert.equal(unreleasedReplies(f), 1);
  });
  assert.ok(
    await eventually(async () => unreleasedReplies(f) === 0 || undefined, 8000),
    "the refused body is released instead of being retried every cycle",
  );
  assert.equal(
    (await client.get(task.id)).status.state,
    TaskState.TASK_STATE_SUBMITTED,
    "a refused reply does not change its Task",
  );
});

/**
 * Drops the running host's ACKs of the message whose replay-bound ID ends in `entropy`
 * at its delivery-service transport while that message is live, as a lost request
 * would. Once it has expired, its ACKs reach the real relay again. Returns the drops.
 */
function loseHostAcks(t, entropy) {
  const ack = HabJetStreamService.prototype.ack;
  const dropped = [];
  HabJetStreamService.prototype.ack = function (context, input) {
    const [, first, tail] = String(input?.message_id).split(".");
    if (
      (Array.isArray(entropy) ? entropy.includes(tail) : tail === entropy) &&
      Date.now() < Number(first) + 3600000
    ) {
      dropped.push(input);
      throw Error("ack lost in transport");
    }
    return ack.call(this, context, input);
  };
  t.after(() => {
    HabJetStreamService.prototype.ack = ack;
  });
  return dropped;
}

const hostAck = (f, messageId) => {
  const db = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      inbox: db
        .prepare(
          "SELECT receipt_confirmed,released_at FROM relay_inbox WHERE message_id=?",
        )
        .get(messageId),
      acks: db
        .prepare(
          "SELECT state,reason FROM relay_receiver_acks WHERE message_id=? ORDER BY generation",
        )
        .all(messageId),
    };
  } finally {
    db.close();
  }
};

test("when the running host loses its own ACK of a saved result, the reply expires unapplied and a new result still completes the Task", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "lost", 1);
  await recipient.reply(request, "execution_accepted", accepted("lost"));
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);

  const ttl = 6000;
  const entropy = randomUUID().replaceAll("-", "");
  const dropped = loseHostAcks(t, entropy);
  const sent = await recipient.reply(
    request,
    "execution_result",
    succeeded("lost"),
    ttl,
    entropy,
  );
  assert.ok(
    await eventually(async () => dropped.length > 0 || undefined, 8000),
    "the host saved the result and its ACK was lost",
  );
  assert.equal(
    hostAck(f, sent.message_id).inbox?.receipt_confirmed,
    0,
    "the result is saved unconfirmed",
  );
  assert.ok(
    await eventually(
      async () =>
        hostAck(f, sent.message_id).acks.every(
          (row) => row.state !== "pending",
        ) || undefined,
      ttl + 20000,
    ),
    "every ACK attempt of the lost result ended",
  );
  const { inbox, acks } = hostAck(f, sent.message_id);
  assert.ok(
    acks.some(
      (row) => row.state === "obsolete" && row.reason === "invalid_ack",
    ),
    `after the reply expired the relay refused the ACK as invalid_ack: ${JSON.stringify(acks)}`,
  );
  assert.equal(inbox.receipt_confirmed, 0);
  assert.equal(
    (await recipient.client.status(sent.message_id)).state,
    "expired",
    "the relay never recorded the lost result as acked",
  );
  assert.ok(
    await eventually(async () => unreleasedReplies(f) === 0 || undefined, 8000),
    "the unconfirmable result's body was released",
  );
  assert.equal(
    (await client.get(task.id)).status.state,
    TaskState.TASK_STATE_WORKING,
    "an unconfirmed result is never applied",
  );

  const fresh = await recipient.reply(
    request,
    "execution_result",
    succeeded("lost"),
  );
  assert.equal(
    await untilAcked(recipient.client, fresh.message_id),
    "acked",
    "the host saved and ACKed the new result",
  );
  const done = await untilState(
    () => client.get(task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(done.metadata.hab_relay.result_message_id, fresh.message_id);
  assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
});

test("an unconfirmed held result does not cause a fresh result to be ACKed and discarded", async (t) => {
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: 1 }),
  });
  // Quarantine R1 after its first lost lease so R2 can be delivered while
  // R1 is still locally held. R1's short TTL later permits unread release.
  f.config.delivery.queue.lease_ms = 1000;
  f.config.delivery.queue.max_attempts = 1;
  f.write("service.local.json", f.config);
  await f.restart();
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "recover", 1);
  await recipient.reply(request, "execution_accepted", accepted("recover"));
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);

  const entropy = randomUUID().replaceAll("-", "");
  const dropped = loseHostAcks(t, entropy);
  const first = await recipient.reply(
    request,
    "execution_result",
    succeeded("recover"),
    6000,
    entropy,
  );
  assert.ok(await eventually(async () => dropped.length > 0 || undefined));
  assert.equal(hostAck(f, first.message_id).inbox?.receipt_confirmed, 0);
  assert.equal(storedState(f, task.id), "TASK_STATE_WORKING");

  // R1 is still saved and unconfirmed when the recipient sends R2 under a new ID.
  // R2 is a recovery opportunity, not evidence that the failed ACK of R1 succeeded.
  const polled = new Set();
  const poll = HabJetStreamService.prototype.poll;
  t.mock.method(HabJetStreamService.prototype, "poll", function (context) {
    const delivery = poll.call(this, context);
    if (delivery) polled.add(delivery.message.message_id);
    return delivery;
  });
  const replacement = await recipient.reply(
    request,
    "execution_result",
    succeeded("recover"),
  );
  assert.ok(
    await eventually(
      async () => polled.has(replacement.message_id) || undefined,
    ),
  );
  await new Promise((done) => setTimeout(done, 200));
  assert.notEqual(
    (await recipient.client.status(replacement.message_id)).state,
    "acked",
    "R2 is deferred, not ACKed based on unconfirmed R1",
  );
  assert.equal(hostAck(f, replacement.message_id).inbox, undefined);
  assert.equal(inboxRows(f), 2, "a deferred fresh ID spends no local capacity");
  assert.equal(hostAck(f, first.message_id).inbox?.receipt_confirmed, 0);
  assert.ok(
    await eventually(
      async () =>
        Number.isSafeInteger(hostAck(f, first.message_id).inbox?.released_at) ||
        undefined,
      15000,
    ),
    "R1 expires and is safely released unread",
  );
  assert.equal(
    (await recipient.client.status(replacement.message_id)).state,
    "quarantined",
  );
  const recovery = await recipient.reply(
    request,
    "execution_result",
    succeeded("recover"),
  );
  assert.equal(
    await untilAcked(recipient.client, recovery.message_id),
    "acked",
  );
  assert.equal(
    hostAck(f, recovery.message_id).inbox?.receipt_confirmed,
    1,
    "a new recovery result is saved before ACK after R1's unread release",
  );
  assert.ok(
    await eventually(
      async () =>
        storedState(f, task.id) === "TASK_STATE_COMPLETED" || undefined,
    ),
    "the background receiver applies the recovery result without a caller read",
  );
  const done = await client.get(task.id);
  assert.deepEqual(
    done.metadata.hab_relay.source,
    task.metadata.hab_relay.source,
  );
  assert.equal(done.metadata.hab_relay.result_message_id, recovery.message_id);
  assert.equal(done.artifacts[0].parts[0].content.value, "connectivity_ok");
  assert.equal(
    inboxRows(f),
    3,
    "acceptance plus two results stay within the configured history cap",
  );
  assert.equal(hostAck(f, first.message_id).inbox?.receipt_confirmed, 0);
  assert.notEqual(hostAck(f, first.message_id).inbox?.released_at, null);
});

test("a deferred fresh result can exhaust its relay leases without being falsely ACKed", async (t) => {
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: 1 }),
  });
  f.config.delivery.queue.lease_ms = 1000;
  f.config.delivery.queue.max_attempts = 1;
  f.write("service.local.json", f.config);
  await f.restart();
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "deferred", 1);
  await recipient.reply(request, "execution_accepted", accepted("deferred"));
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);
  const entropy = randomUUID().replaceAll("-", "");
  const dropped = loseHostAcks(t, entropy);
  await recipient.reply(
    request,
    "execution_result",
    succeeded("deferred"),
    3600000,
    entropy,
  );
  assert.ok(await eventually(async () => dropped.length > 0 || undefined));
  const second = await recipient.reply(
    request,
    "execution_result",
    succeeded("deferred"),
  );
  assert.ok(
    await eventually(async () => {
      const { state } = await recipient.client.status(second.message_id);
      assert.notEqual(
        state,
        "acked",
        "unconfirmed R1 cannot justify dropping R2",
      );
      await new Promise((done) => setTimeout(done, 200));
      return state === "quarantined" || undefined;
    }, 5000),
    "the deferred reply still obeys the configured finite relay attempts",
  );
  assert.equal(hostAck(f, second.message_id).inbox, undefined);
  assert.equal(
    inboxRows(f),
    2,
    "deferred deliveries spend no local body or ACK slot",
  );
  assert.equal(storedState(f, task.id), "TASK_STATE_WORKING");
});

test("after a long stop, retained ACK histories keep the outbox full instead of admitting a Task whose result would not fit", async (t) => {
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: 1 }),
  });
  await f.restart(async () => {
    f.config.delivery.queue.lease_ms = 500;
    f.write("service.local.json", f.config);
  });
  const client = await a2aClient(f, "caller");
  const [{ task: stoppedTask, request }] = await inFlight(
    client,
    recipient,
    "before_stop",
    1,
  );
  const entropies = [
    randomUUID().replaceAll("-", ""),
    randomUUID().replaceAll("-", ""),
  ];
  loseHostAcks(t, entropies);
  const replies = [];
  for (const [i, [kind, value]] of [
    ["execution_accepted", accepted("stopped")],
    ["execution_result", succeeded("stopped")],
  ].entries()) {
    const reply = await recipient.reply(
      request,
      kind,
      value,
      3600000 - 100,
      entropies[i],
    );
    replies.push(reply);
    assert.ok(
      await eventually(
        async () =>
          hostAck(f, reply.message_id).acks.some(
            (row) => row.state === "pending",
          ) || undefined,
        8000,
      ),
      `pending ${kind}: ${JSON.stringify(hostAck(f, reply.message_id))}; relay=${JSON.stringify(await recipient.client.status(reply.message_id))}`,
    );
  }
  assert.ok(
    replies.every((reply) =>
      hostAck(f, reply.message_id).acks.some((row) => row.state === "pending"),
    ),
    "the running host saved both replies with pending ACKs before one stop",
  );
  // Model 40 days of offline time in owned state. Preserve replay-bound IDs and
  // timestamps together, so normal maintenance, not test-side deletion, reclaims rows.
  const shift = 40 * 86400000;
  const agedId = (id) => {
    const [, first, entropy] = id.split(".");
    return `rm1.${Number(first) - shift}.${entropy}`;
  };
  const agedTime = (at) => new Date(Date.parse(at) - shift).toISOString();
  await f.restart(async () => {
    const out = new DatabaseSync(join(f.config.directory, "a2a-outbox.sqlite"));
    for (const row of out.prepare("SELECT message_id FROM relay_outbox").all())
      out
        .prepare(
          "UPDATE relay_outbox SET message_id=?,first_sent_at=first_sent_at-?,expires_at=expires_at-?,status_until=status_until-?,terminal_at=terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
        )
        .run(
          agedId(row.message_id),
          shift,
          shift,
          shift,
          shift,
          shift,
          row.message_id,
        );
    out.close();
    const mail = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
    mail.exec("PRAGMA foreign_keys=OFF");
    for (const row of mail
      .prepare("SELECT message_id,body FROM relay_inbox")
      .all()) {
      const m = JSON.parse(row.body);
      m.message_id = agedId(m.message_id);
      m.first_sent_at = agedTime(m.first_sent_at);
      m.expires_at = agedTime(m.expires_at);
      m.in_reply_to.message_id = agedId(m.in_reply_to.message_id);
      mail
        .prepare(
          "UPDATE relay_inbox SET message_id=?,body=?,received_at=received_at-?,expires_at=expires_at-?,ack_retry_until=ack_retry_until-?,retain_until=retain_until-? WHERE message_id=?",
        )
        .run(
          m.message_id,
          JSON.stringify(m),
          shift,
          shift,
          shift,
          shift,
          row.message_id,
        );
    }
    for (const row of mail
      .prepare("SELECT request_id,message_id,request FROM relay_receiver_acks")
      .all()) {
      const req = JSON.parse(row.request);
      req.message_id = agedId(req.message_id);
      mail
        .prepare(
          "UPDATE relay_receiver_acks SET message_id=?,request=?,next_retry_at=next_retry_at-?,retry_until=retry_until-?,retain_until=retain_until-? WHERE request_id=?",
        )
        .run(
          agedId(row.message_id),
          JSON.stringify(req),
          shift,
          shift,
          shift,
          row.request_id,
        );
    }
    assert.deepEqual(mail.prepare("PRAGMA foreign_key_check").all(), []);
    mail.close();
    // Use the same driver as the host for the offline Task-store fixture.
    const tasks = new Database(join(f.config.directory, "a2a-tasks.sqlite"));
    for (const row of tasks
      .prepare("SELECT id,metadata FROM hab_a2a_tasks")
      .all()) {
      const meta = JSON.parse(row.metadata);
      meta.hab_relay.source.message_id = agedId(
        meta.hab_relay.source.message_id,
      );
      meta.hab_relay.source.first_sent_at = agedTime(
        meta.hab_relay.source.first_sent_at,
      );
      meta.hab_relay.source.expires_at = agedTime(
        meta.hab_relay.source.expires_at,
      );
      tasks
        .prepare("UPDATE hab_a2a_tasks SET metadata=? WHERE id=?")
        .run(JSON.stringify(meta), row.id);
    }
    assert.deepEqual(tasks.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
    tasks.close();
  });
  assert.ok(
    await eventually(async () => unreleasedReplies(f) === 0 || undefined, 8000),
  );
  const mail = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
  assert.equal(
    mail
      .prepare("SELECT count(DISTINCT message_id) n FROM relay_receiver_acks")
      .get().n,
    2,
  );
  assert.ok(
    mail.prepare("SELECT min(terminal_at) at FROM relay_receiver_acks").get()
      .at >
      Date.now() - 10000,
  );
  mail.close();
  await untilState(
    () => client.get(stoppedTask.id),
    TaskState.TASK_STATE_FAILED,
  );
  await assert.rejects(
    () => client.send("capacity_not_admitted"),
    /outbox_capacity_exceeded/,
  );
  // Retention is not shortened. Once another 31 days pass, ACK maintenance makes
  // room first, then outbox maintenance may admit the next Task and both replies.
  await f.restart(async () => {
    const mail = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
    const elapsed = 31 * 86400000;
    mail
      .prepare(
        "UPDATE relay_receiver_acks SET terminal_at=terminal_at-?,retain_until=retain_until-?",
      )
      .run(elapsed, elapsed);
    mail
      .prepare(
        "UPDATE relay_inbox SET released_at=released_at-?,ack_terminal_at=ack_terminal_at-?,retain_until=retain_until-?",
      )
      .run(elapsed, elapsed, elapsed);
    mail.close();
  });
  let admissionError;
  const next = await eventually(async () => {
    try {
      return await client.send("after_history_retention");
    } catch (error) {
      if (!/outbox_capacity_exceeded/.test(String(error))) throw error;
      admissionError = String(error);
      return undefined;
    }
  }, 8000);
  assert.ok(
    next,
    `new Task admission resumes after retained histories become collectable: ${admissionError ?? "no response"}`,
  );
  const received = await eventually(async () => {
    await recipient.receiver.receiveOnce();
    return recipient.receiver
      .inbox()
      .find(
        (entry) =>
          entry.message.message_id ===
          next.metadata.hab_relay.source.message_id,
      );
  }, 8000);
  assert.ok(received);
  for (const [kind, value] of [
    ["execution_accepted", accepted("recovered")],
    ["execution_result", succeeded("recovered")],
  ]) {
    const reply = await recipient.reply(received, kind, value);
    assert.equal(await untilAcked(recipient.client, reply.message_id), "acked");
  }
  await untilState(() => client.get(next.id), TaskState.TASK_STATE_COMPLETED);
});

test("a blocking SendMessage completes from a result that arrives in a later receive cycle than its acceptance", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const started = Date.now();
  const blocking = client.send("blocking_cycles", "connectivity_check", false);
  const request = await eventually(async () => {
    await recipient.receiver.receiveOnce();
    return recipient.receiver.inbox()[0];
  }, 4000);
  assert.ok(request, "the recipient received the request");
  const acceptance = await recipient.reply(
    request,
    "execution_accepted",
    accepted("blocking"),
  );
  assert.equal(
    await untilAcked(recipient.client, acceptance.message_id),
    "acked",
  );
  await recipient.reply(request, "execution_result", succeeded("blocking"));
  const task = await blocking;
  assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(task.artifacts[0].parts[0].content.value, "connectivity_ok");
  assert.ok(
    Date.now() - started < 4500,
    `completed before the five-second wait ran out, after ${Date.now() - started} ms`,
  );
});

const storedState = (f, id) => {
  const db = new DatabaseSync(join(f.config.directory, "a2a-tasks.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT status_state FROM hab_a2a_tasks WHERE id=?")
      .get(id).status_state;
  } finally {
    db.close();
  }
};

test("a WORKING Task whose reply window closes without a result fails as result_window_expired, and a late result does not revive it", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "window", 1);
  await recipient.reply(request, "execution_accepted", accepted("window"));
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);

  const day = 86400000;
  await f.restart(() => {
    // Two days pass. The request's ID embeds its send time, so the Task's copy of the
    // request gets an equivalent two-day-old ID; the outbox record is aged in place.
    const at = Date.parse(request.message.first_sent_at) - 2 * day;
    const tasks = new DatabaseSync(
      join(f.config.directory, "a2a-tasks.sqlite"),
    );
    tasks
      .prepare(
        "UPDATE hab_a2a_tasks SET metadata=json_set(metadata,'$.hab_relay.source.message_id',?,'$.hab_relay.source.first_sent_at',?,'$.hab_relay.source.expires_at',?) WHERE id=?",
      )
      .run(
        makeReplayBoundMessageId(
          new Date(at).toISOString(),
          randomUUID().replaceAll("-", ""),
        ),
        new Date(at).toISOString(),
        new Date(at + 3600000).toISOString(),
        task.id,
      );
    tasks.close();
    const outbox = new DatabaseSync(
      join(f.config.directory, "a2a-outbox.sqlite"),
    );
    outbox
      .prepare(
        "UPDATE relay_outbox SET expires_at=expires_at-?,first_sent_at=first_sent_at-?,status_until=status_until-?,terminal_at=terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
      )
      .run(
        2 * day,
        2 * day,
        2 * day,
        2 * day,
        2 * day,
        request.message.message_id,
      );
    outbox.close();
  });
  assert.ok(
    await eventually(
      async () => storedState(f, task.id) === "TASK_STATE_FAILED" || undefined,
      8000,
    ),
    "the host fails the Task without a caller read",
  );
  const failed = await client.get(task.id);
  assert.equal(failed.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(failed.metadata.hab_relay.reason, "result_window_expired");
  const text = failed.status.message.parts[0].content.value;
  assert.match(text, /result_window_expired/);
  assert.match(text, /outcome is unknown/);
  assert.deepEqual(failed.artifacts, []);

  const late = await recipient.reply(
    request,
    "execution_result",
    succeeded("window"),
  );
  assert.equal(await untilAcked(recipient.client, late.message_id), "acked");
  await new Promise((done) => setTimeout(done, 200));
  const after = await client.get(task.id);
  assert.equal(after.status.state, TaskState.TASK_STATE_FAILED);
  assert.deepEqual(
    after.status,
    failed.status,
    "the late result changes nothing",
  );
  assert.equal(
    unreleasedReplies(f),
    0,
    "the late result was ACKed without a record",
  );
});

test("a Task whose reply window closes while the host runs fails within seconds, not at the next once-a-minute maintenance", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const [{ task, request }] = await inFlight(client, recipient, "due", 1);
  await recipient.reply(request, "execution_accepted", accepted("due"));
  await untilState(() => client.get(task.id), TaskState.TASK_STATE_WORKING);

  const day = 86400000;
  const lead = 5000;
  let due;
  await f.restart(() => {
    // The request is aged so that its reply window closes `lead` ms after the host
    // restarts, which is after the restart's first maintenance pass has run.
    due = Date.now() + lead;
    const at = due - day - 3600000;
    const tasks = new DatabaseSync(
      join(f.config.directory, "a2a-tasks.sqlite"),
    );
    tasks
      .prepare(
        "UPDATE hab_a2a_tasks SET metadata=json_set(metadata,'$.hab_relay.source.message_id',?,'$.hab_relay.source.first_sent_at',?,'$.hab_relay.source.expires_at',?) WHERE id=?",
      )
      .run(
        makeReplayBoundMessageId(
          new Date(at).toISOString(),
          randomUUID().replaceAll("-", ""),
        ),
        new Date(at).toISOString(),
        new Date(at + 3600000).toISOString(),
        task.id,
      );
    tasks.close();
    const outbox = new DatabaseSync(
      join(f.config.directory, "a2a-outbox.sqlite"),
    );
    const shift =
      outbox
        .prepare("SELECT expires_at FROM relay_outbox WHERE message_id=?")
        .get(request.message.message_id).expires_at -
      (at + 3600000);
    outbox
      .prepare(
        "UPDATE relay_outbox SET expires_at=expires_at-?,first_sent_at=first_sent_at-?,status_until=status_until-?,terminal_at=terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
      )
      .run(shift, shift, shift, shift, shift, request.message.message_id);
    outbox.close();
  });
  if (Date.now() < due)
    assert.equal(storedState(f, task.id), "TASK_STATE_WORKING");
  assert.ok(
    await eventually(
      async () => storedState(f, task.id) === "TASK_STATE_FAILED" || undefined,
      lead + 20000,
    ),
    "the host fails the Task without a caller read",
  );
  const lag = Date.now() - due;
  assert.ok(lag < 20000, `failed ${lag} ms after the window closed`);
  const failed = await client.get(task.id);
  assert.equal(failed.metadata.hab_relay.reason, "result_window_expired");
});

test("mixed retention cohorts reclaim only affordable sender slots while one failed Task save keeps its body", async (t) => {
  const { f, recipient } = await connected(t, {
    a2a: a2aSection({ max_records: 3 }),
  });
  const client = await a2aClient(f, "caller");
  const flights = await inFlight(client, recipient, "cohort", 3);
  const old = flights[0],
    shifts = new Map(),
    replies = new Map();
  let blockOldSave = false;
  const save = DatabaseTaskStore.prototype.save;
  DatabaseTaskStore.prototype.save = function (task, ...args) {
    if (blockOldSave && task.id === old.task.id)
      return Promise.reject(Error("synthetic per-Task storage failure"));
    return save.call(this, task, ...args);
  };
  t.after(() => {
    DatabaseTaskStore.prototype.save = save;
  });
  for (const [i, flight] of flights.entries()) {
    const shift = (i === 0 ? 40 : 2) * 86400000;
    shifts.set(flight.task.metadata.hab_relay.source.message_id, shift);
    for (const [kind, value] of [
      ["execution_accepted", accepted(`cohort${i}`)],
      ["execution_result", succeeded(`cohort${i}`)],
    ]) {
      if (i === 0 && kind === "execution_result") {
        await untilState(
          () => client.get(old.task.id),
          TaskState.TASK_STATE_WORKING,
        );
        blockOldSave = true;
      }
      const reply = await recipient.reply(flight.request, kind, value);
      replies.set(reply.message_id, shift);
      assert.equal(
        await untilAcked(recipient.client, reply.message_id),
        "acked",
      );
    }
    if (i !== 0)
      await untilState(
        () => client.get(flight.task.id),
        TaskState.TASK_STATE_COMPLETED,
      );
  }
  assert.equal(unreleasedReplies(f), 1);
  const agedId = (id, shift) => {
    const [, first, entropy] = id.split(".");
    return `rm1.${Number(first) - shift}.${entropy}`;
  };
  const agedTime = (at, shift) =>
    new Date(Date.parse(at) - shift).toISOString();
  // Model two retention cohorts in owned state, not a wall-clock or HMAC restore test.
  await f.restart(() => {
    const out = new DatabaseSync(join(f.config.directory, "a2a-outbox.sqlite"));
    for (const [id, shift] of shifts)
      out
        .prepare(
          "UPDATE relay_outbox SET message_id=?,first_sent_at=first_sent_at-?,expires_at=expires_at-?,status_until=status_until-?,terminal_at=terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
        )
        .run(agedId(id, shift), shift, shift, shift, shift, shift, id);
    out.close();
    const mail = new DatabaseSync(join(f.config.directory, "a2a-inbox.sqlite"));
    mail.exec("PRAGMA foreign_keys=OFF");
    for (const [id, shift] of replies) {
      const row = mail
        .prepare("SELECT body FROM relay_inbox WHERE message_id=?")
        .get(id);
      let body = row.body;
      if (body) {
        const message = JSON.parse(body);
        message.message_id = agedId(message.message_id, shift);
        message.first_sent_at = agedTime(message.first_sent_at, shift);
        message.expires_at = agedTime(message.expires_at, shift);
        message.in_reply_to.message_id = agedId(
          message.in_reply_to.message_id,
          shift,
        );
        body = JSON.stringify(message);
      }
      mail
        .prepare(
          "UPDATE relay_inbox SET message_id=?,body=?,received_at=received_at-?,expires_at=expires_at-?,released_at=released_at-?,ack_retry_until=ack_retry_until-?,ack_terminal_at=ack_terminal_at-?,retain_until=retain_until-? WHERE message_id=?",
        )
        .run(
          agedId(id, shift),
          body,
          shift,
          shift,
          shift,
          shift,
          shift,
          shift,
          id,
        );
      mail
        .prepare(
          "UPDATE relay_receiver_acks SET message_id=?,terminal_at=terminal_at-?,retry_until=retry_until-?,next_retry_at=next_retry_at-?,retain_until=retain_until-? WHERE message_id=?",
        )
        .run(agedId(id, shift), shift, shift, shift, shift, id);
    }
    assert.deepEqual(mail.prepare("PRAGMA foreign_key_check").all(), []);
    mail.close();
    const tasks = new Database(join(f.config.directory, "a2a-tasks.sqlite"));
    for (const row of tasks
      .prepare("SELECT id,metadata FROM hab_a2a_tasks")
      .all()) {
      const meta = JSON.parse(row.metadata);
      const source = meta.hab_relay.source;
      const shift = shifts.get(source.message_id);
      source.message_id = agedId(source.message_id, shift);
      source.first_sent_at = agedTime(source.first_sent_at, shift);
      source.expires_at = agedTime(source.expires_at, shift);
      if (meta.hab_relay.result_message_id)
        meta.hab_relay.result_message_id = agedId(
          meta.hab_relay.result_message_id,
          shift,
        );
      tasks
        .prepare("UPDATE hab_a2a_tasks SET metadata=? WHERE id=?")
        .run(JSON.stringify(meta), row.id);
    }
    assert.deepEqual(tasks.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
    tasks.close();
  });
  assert.ok(
    await eventually(async () => {
      const db = new DatabaseSync(
        join(f.config.directory, "a2a-outbox.sqlite"),
      );
      const count = db.prepare("SELECT count(*) n FROM relay_outbox").get().n;
      db.close();
      return count === 2 || undefined;
    }, 8000),
    "the old eligible source is collected despite younger ACK histories and one held body",
  );
  assert.equal(
    unreleasedReplies(f),
    1,
    "storage failure never discards the confirmed body",
  );
  const [fresh] = await inFlight(client, recipient, "cohort_fresh", 1);
  for (const [kind, value] of [
    ["execution_accepted", accepted("cohort_fresh")],
    ["execution_result", succeeded("cohort_fresh")],
  ]) {
    const reply = await recipient.reply(fresh.request, kind, value);
    assert.equal(await untilAcked(recipient.client, reply.message_id), "acked");
  }
  await untilState(
    () => client.get(fresh.task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.equal(unreleasedReplies(f), 1);
  blockOldSave = false;
  await untilState(
    () => client.get(old.task.id),
    TaskState.TASK_STATE_COMPLETED,
  );
  assert.ok(
    await eventually(async () => unreleasedReplies(f) === 0 || undefined, 8000),
  );
});

test("partial collection reserves both existing free slots and every still-open source window", () => {
  const capacity = (records, bytes) => records <= 7 && bytes <= 7 * 1024;
  assert.equal(
    replySafeCollectionLimit({ total: 4, expires_after: 2 }, 4, 1024, capacity),
    1,
  );
  assert.equal(
    replySafeCollectionLimit({ total: 3, expires_after: 2 }, 4, 1024, capacity),
    0,
    "one already-free slot is reserved before another can be collected",
  );
  assert.equal(
    replySafeCollectionLimit({ total: 4, expires_after: 3 }, 4, 1024, capacity),
    0,
    "enqueue exchanges that free slot for an open source without losing reservation",
  );
  assert.equal(
    replySafeCollectionLimit({ total: 4, expires_after: 0 }, 4, 1024, capacity),
    3,
    "closed reply windows no longer reserve future arrivals",
  );
  assert.equal(
    replySafeCollectionLimit(
      { total: 1000, expires_after: 0 },
      1000,
      1024,
      (records, bytes) => records <= 1000 && bytes <= 1024,
    ),
    0,
    "byte pressure still protects the next pair of replies",
  );
  assert.equal(
    replySafeCollectionLimit(
      { total: 1000, expires_after: 0 },
      1000,
      1024,
      () => true,
    ),
    100,
    "the maintenance collection budget stays bounded",
  );
  assert.equal(
    replySafeCollectionLimit(
      { total: 1000, expires_after: 0 },
      4,
      1024,
      capacity,
    ),
    100,
    "collecting rows above a lowered quota does not yet create new admission slots",
  );
});
/** Read the host's committed sender state without changing its retry clock or body. */
function hostOutboxRows(f) {
  const db = new DatabaseSync(join(f.config.directory, "a2a-outbox.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT message_id,state,reason,submit_attempts FROM relay_outbox ORDER BY message_id",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test("closing after a Task save leaves its original unsent intent retryable after restart", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const save = DatabaseTaskStore.prototype.save;
  let saved, closing;
  const mocked = t.mock.method(
    DatabaseTaskStore.prototype,
    "save",
    async function (task, context) {
      await save.call(this, task, context);
      if (
        !saved &&
        task.metadata?.hab_relay?.message_id === "close_after_save"
      ) {
        saved = structuredClone(task);
        // This is an actual asynchronous boundary: close can run while save resolves.
        closing = f.host.close();
      }
    },
  );
  await client.send("close_after_save").catch(() => undefined);
  assert.ok(saved, "the Task was durably saved before shutdown");
  await closing;
  mocked.mock.restore();
  assert.deepEqual(
    hostOutboxRows(f),
    [],
    "shutdown refuses before a sender claim",
  );

  await f.restart();
  const replay = await (await a2aClient(f, "caller")).send("close_after_save");
  assert.equal(replay.id, saved.id);
  assert.deepEqual(
    replay.metadata.hab_relay.source,
    saved.metadata.hab_relay.source,
  );
  assert.equal(replay.status.state, TaskState.TASK_STATE_SUBMITTED);
  await recipient.receiver.receiveOnce();
  assert.deepEqual(
    recipient.receiver.inbox().map((entry) => entry.message.message_id),
    [saved.metadata.hab_relay.source.message_id],
    "the retry sends the one original intent, without a replacement ID or deadline",
  );
});

test("close scheduled at claim runs only after synchronous submit admission and does not quarantine the intent", async (t) => {
  const { f, recipient } = await connected(t);
  const client = await a2aClient(f, "caller");
  const claim = SQLiteOutbox.prototype.claim;
  let claimed, closing;
  const mocked = t.mock.method(
    SQLiteOutbox.prototype,
    "claim",
    function (messageId) {
      const job = claim.call(this, messageId);
      if (!claimed && job?.operation === "submit") {
        claimed = structuredClone(job.message);
        // The earliest legal asynchronous close after claim. There is no await from
        // claim through the caller guard and the host's synchronous admission.
        globalThis.queueMicrotask(() => {
          closing = f.host.close();
        });
      }
      return job;
    },
  );
  await client.send("close_after_claim").catch(() => undefined);
  assert.ok(claimed, "the sender claimed the intent");
  assert.ok(closing, "shutdown ran at the next asynchronous boundary");
  await closing;
  mocked.mock.restore();
  assert.deepEqual(
    hostOutboxRows(f),
    [
      {
        message_id: claimed.message_id,
        state: "accepted",
        reason: null,
        submit_attempts: 1,
      },
    ],
    "admission completed before close and its receipt remains durable",
  );

  await f.restart();
  const replay = await (await a2aClient(f, "caller")).send("close_after_claim");
  assert.deepEqual(replay.metadata.hab_relay.source, claimed);
  assert.equal(replay.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(
    hostOutboxRows(f)[0].submit_attempts,
    1,
    "replay does not resubmit an accepted intent",
  );
  await recipient.receiver.receiveOnce();
  assert.deepEqual(
    recipient.receiver.inbox().map((entry) => entry.message.message_id),
    [claimed.message_id],
  );
});

test("disconnecting the host identity is permanent and changing its configured address cannot undo revocation", async (t) => {
  const f = await a2aHost(t);
  const [before] = identityRow(f);
  const disconnected = hostAdminDisconnect(f.configPath, IDENTITY);
  assert.equal(disconnected.revoked_bindings, 1);
  assert.equal(disconnected.address.state, "stopped");
  assert.equal(
    hostAdminDisconnect(f.configPath, IDENTITY).already_disconnected,
    true,
  );
  await f.host.close();
  await assert.rejects(startHost(f.configPath), {
    reason: "a2a_identity_revoked",
  });
  assert.deepEqual(
    identityRow(f).map((row) => ({
      agent_id: row.agent_id,
      bindings: row.bindings,
      state: row.state,
    })),
    [{ agent_id: before.agent_id, bindings: 0, state: "stopped" }],
    "startup must not silently rebind or re-enable the revoked identity",
  );

  f.config.a2a.identity = "replacement@hab-host.hab";
  f.write("service.local.json", f.config);
  await assert.rejects(startHost(f.configPath), {
    reason: "a2a_identity_conflict",
  });
  // Revocation turns off A2A, not the host's independent MCP operation.
  delete f.config.a2a;
  f.write("service.local.json", f.config);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  assert.equal(host.a2a_url, undefined);
  assert.ok(host.url.endsWith("/mcp"));
});
test("a full batch of per-Task store failures does not starve later overdue Tasks", async (t) => {
  const { f } = await connected(t);
  const client = await a2aClient(f, "caller");
  const seed = await client.send("window_fairness");
  const blocked = new Set();
  const attempts = new Set();
  const normal = "00000000-0000-4000-8000-000000000100";
  let recovered = false;
  const save = DatabaseTaskStore.prototype.save;
  t.mock.method(DatabaseTaskStore.prototype, "save", function (task, context) {
    if (
      !recovered &&
      blocked.has(task.id) &&
      task.status.state === TaskState.TASK_STATE_FAILED
    ) {
      attempts.add(task.id);
      throw Error("injected per-Task store failure");
    }
    return save.call(this, task, context);
  });
  await f.restart(() => {
    // Model 101 expired Tasks and one whose window closes shortly, without
    // waiting a day or sending 102 relay requests. The fault is a selected
    // TaskStore save failure, not a claim that malformed Task metadata is
    // reachable through the public A2A API.
    const db = new Database(join(f.config.directory, "a2a-tasks.sqlite"));
    try {
      const row = db
        .prepare("SELECT * FROM hab_a2a_tasks WHERE id=?")
        .get(seed.id);
      db.prepare("DELETE FROM hab_a2a_tasks WHERE id=?").run(seed.id);
      const columns = Object.keys(row);
      const insert = db.prepare(
        `INSERT INTO hab_a2a_tasks (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      );
      for (let i = 0; i < 102; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        if (i < 100) blocked.add(id);
        const metadata = JSON.parse(row.metadata);
        const at = new Date(
          i === 101
            ? Date.now() + 3000 - 86400000 - 3600000
            : Date.now() - 2 * 86400000,
        ).toISOString();
        const source = metadata.hab_relay.source;
        source.first_sent_at = at;
        source.expires_at = new Date(Date.parse(at) + 3600000).toISOString();
        source.message_id = makeReplayBoundMessageId(
          at,
          i.toString(16).padStart(32, "0"),
        );
        const copy = { ...row, id, metadata: JSON.stringify(metadata) };
        insert.run(...columns.map((column) => copy[column]));
      }
    } finally {
      db.close();
    }
  });
  assert.ok(
    await eventually(
      async () => storedState(f, normal) === "TASK_STATE_FAILED" || undefined,
      5000,
    ),
    "the 101st Task closes without a caller read despite the failed first batch",
  );
  assert.equal(attempts.size, 100);
  for (const id of blocked)
    assert.equal(storedState(f, id), "TASK_STATE_SUBMITTED");
  recovered = true;
  // The next window deadline starts a new pass while this same host is running.
  // Its cursor must wrap and retry held failures, not permanently skip them.
  assert.ok(
    await eventually(
      async () =>
        [...blocked].every(
          (id) => storedState(f, id) === "TASK_STATE_FAILED",
        ) || undefined,
    ),
  );
});
