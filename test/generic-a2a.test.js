import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import {
  SendMessageRequest,
  ListTasksRequest,
  CancelTaskRequest,
  TaskState,
} from "@a2a-js/sdk";
import { GenericTextJobs, GENERIC_TEXT_PROFILE } from "../src/generic-jobs.ts";
import {
  createGenericTextA2aGateway,
  genericTextAgentCard,
} from "../src/a2a/generic-http.ts";
import { createA2aNodeHandler } from "../src/a2a/http-node.ts";
import { Hub } from "../src/sqlite.ts";
import { Adapter } from "../src/adapter.ts";
import { Journal } from "../src/journal.ts";
import {
  identities,
  request as input,
  SyntheticTextRuns,
} from "./generic-async/fixtures.js";

const wire = (data = input()) => ({
  message: {
    messageId: data.messageId,
    contextId: data.contextId,
    role: "ROLE_USER",
    parts: [{ text: data.text, mediaType: "text/plain" }],
  },
  configuration: {
    returnImmediately: true,
    acceptedOutputModes: ["text/plain"],
    historyLength: 0,
  },
  metadata: {
    [GENERIC_TEXT_PROFILE]: { version: 1, workDeadline: data.workDeadline },
  },
});
const headers = {
  Authorization: "Bearer synthetic-owner",
  "Content-Type": "application/json",
  "A2A-Version": "1.0",
  "A2A-Extensions": GENERIC_TEXT_PROFILE,
};
const options = {
  serviceParameters: {
    Authorization: headers.Authorization,
    "A2A-Extensions": GENERIC_TEXT_PROFILE,
  },
};
const meta = (task) => task.metadata[GENERIC_TEXT_PROFILE];
const noPrivateFields = (value) => {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "text_request",
    "ownerClient",
    "textBinding",
    "runnerScope",
    "run_id",
    "fingerprint",
    "conversationBinding",
    "synthetic-owner-scope",
    "synthetic-sender-client",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
};
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "generic-a2a-"));
  const identity = identities();
  const state = {
    clock: Date.now(),
    revoked: false,
    revokeAfterDiscovery: false,
    owner: identity.sender,
  };
  let hub, gateway, nodeHandler;
  const server = createServer((req, res) => nodeHandler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`,
    endpoint = `${base}/a2a`;
  const open = () => {
    hub = new Hub(join(root, "hub.db"), () => state.clock);
    const jobs = new GenericTextJobs(hub, (request, operation) => {
      if (
        state.revoked ||
        request.headers.get("authorization") !== headers.Authorization
      )
        return null;
      const owner = state.owner;
      if (operation === "discover" && state.revokeAfterDiscovery)
        state.revoked = true;
      return owner;
    });
    gateway = createGenericTextA2aGateway({ endpoint, jobs });
    nodeHandler = createA2aNodeHandler(endpoint, gateway);
  };
  open();
  const client = await new ClientFactory({
    ...new ClientFactory().options,
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: (url, init) =>
        globalThis.fetch(url, {
          ...init,
          headers: { ...init?.headers, Authorization: headers.Authorization },
        }),
    }),
  }).createFromUrl(base);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    state,
    client,
    endpoint,
    get hub() {
      return hub;
    },
    direct(request) {
      return gateway(request);
    },
    async raw(method, params, patch = {}) {
      const response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: { ...headers, ...patch },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "request-1",
          method,
          params,
        }),
      });
      return { response, body: await response.json() };
    },
    restart() {
      hub.close();
      open();
    },
    count() {
      return Number(
        hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
      );
    },
    async execute(mode = "complete") {
      const journal = new Journal(join(root, "journal.db"));
      const runs = new SyntheticTextRuns(join(root, "runs.db"), "paper", mode);
      try {
        return await new Adapter(hub, identity.worker, runs, journal).once();
      } finally {
        runs.close();
        journal.close();
      }
    },
    async claim() {
      return hub.claim(identity.worker, {}, { textRetentionMs: 86_400_000 });
    },
  };
}

test("official A2A SDK uses the real job engine and synthetic execution runtime through loopback HTTP", async (t) => {
  const f = await fixture(t),
    data = input("official-message", "a real synthetic job");
  const accepted = await f.client.sendMessage(
    SendMessageRequest.fromJSON(wire(data)),
    options,
  );
  assert.equal(accepted.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(accepted.contextId, data.contextId);
  assert.equal(meta(accepted).sourceMessageId, data.messageId);
  assert.equal(accepted.artifacts.length, 0);
  const actual = await f.hub.get(identities().sender, { id: accepted.id });
  assert.equal(actual.id, accepted.id);
  assert.equal(actual.task_type, "generic_text");
  await f.execute();
  f.restart();
  const completed = await f.client.getTask(
    { id: accepted.id, historyLength: 0 },
    options,
  );
  assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed.artifacts[0].artifactId, `${accepted.id}:result:1`);
  assert.equal(
    completed.artifacts[0].parts[0].content.value,
    "paper:a real synthetic job",
  );
  assert.equal(meta(completed).outcome, "confirmed");
  assert.equal(completed.history.length, 0);
  const replay = await f.client.sendMessage(
    SendMessageRequest.fromJSON(wire(data)),
    options,
  );
  assert.equal(replay.id, accepted.id);
  assert.equal(replay.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(replay.artifacts.length, 0);
  assert.equal(f.count(), 1);
  const listed = await f.client.listTasks(
    ListTasksRequest.fromJSON({
      pageSize: 1,
      historyLength: 0,
      includeArtifacts: false,
    }),
    options,
  );
  assert.equal(listed.totalSize, 1);
  assert.equal(listed.tasks[0].id, accepted.id);
  assert.equal(listed.tasks[0].artifacts.length, 0);
  noPrivateFields(completed);
});

test("raw inputs are rejected before SDK defaulting or coercion and before mutation", async (t) => {
  const f = await fixture(t);
  const cases = [
    (x) => {
      x.message.role = 1;
    },
    (x) => {
      x.message.parts[0].text = 42;
    },
    (x) => {
      x.message.parts[0].text = "unsafe\u0000suffix";
    },
    (x) => {
      x.message.parts[0].text = "unsafe\ud800suffix";
    },
    (x) => {
      x.message.parts[0].text = "x".repeat(32769);
    },
    (x) => {
      x.message.parts[0].data = { text: "forged" };
    },
    (x) => {
      x.message.parts.push({ text: "second" });
    },
    (x) => {
      x.message.taskId = "forged-task";
    },
    (x) => {
      x.message.authority = "owner";
    },
    (x) => {
      x.message.extensions = ["unrecognized"];
    },
    (x) => {
      x.tenant = "other-tenant";
    },
    (x) => {
      x.configuration.returnImmediately = false;
    },
    (x) => {
      delete x.configuration;
    },
    (x) => {
      x.configuration.historyLength = 1;
    },
    (x) => {
      x.configuration.acceptedOutputModes = ["application/json"];
    },
    (x) => {
      x.metadata[GENERIC_TEXT_PROFILE].workDeadline = "123";
    },
    (x) => {
      x.metadata[GENERIC_TEXT_PROFILE].approved = true;
    },
    (x) => {
      x.metadata.session = "forged-session";
    },
    (x) => {
      delete x.metadata;
    },
  ];
  for (const mutate of cases) {
    const value = wire();
    mutate(value);
    const { body } = await f.raw("SendMessage", value);
    assert.equal(body.error.code, -32602);
  }
  assert.equal(f.count(), 0);
});

test("required extension negotiation, protocol, routing and current authorization fail closed", async (t) => {
  const f = await fixture(t);
  for (const extension of [
    "",
    "https://unknown.invalid/profile",
    `${GENERIC_TEXT_PROFILE}, https://unknown.invalid/profile`,
  ]) {
    const { body } = await f.raw("SendMessage", wire(), {
      "A2A-Extensions": extension,
    });
    assert.equal(body.error.code, -32008);
  }
  assert.equal(
    (await f.raw("SendMessage", wire(), { "A2A-Version": "0.3" })).response
      .status,
    400,
  );
  assert.equal(
    (await f.raw("SendMessage", wire(), { Origin: f.endpoint })).response
      .status,
    403,
  );
  assert.equal(
    (await f.raw("SendMessage", wire(), { "Content-Type": "text/plain" }))
      .response.status,
    415,
  );
  assert.equal(
    (await f.raw("SendMessage", wire(), { Authorization: "Bearer stranger" }))
      .response.status,
    401,
  );
  assert.equal(
    (await f.direct(new Request(`${f.endpoint}?tenant=other`, { headers })))
      .status,
    400,
  );
  assert.equal(
    (await f.direct(new Request(`${f.endpoint}/other`, { headers }))).status,
    404,
  );
  f.state.revokeAfterDiscovery = true;
  const revoked = await f.raw("SendMessage", wire());
  assert.equal(revoked.body.error.code, -32001);
  assert.equal(f.count(), 0);
  assert.equal(
    (
      await f.direct(
        new Request(new URL("/.well-known/agent-card.json", f.endpoint), {
          headers,
        }),
      )
    ).status,
    401,
  );
});

test("ListTasks paginates owner-bound summaries and excludes even completed artifacts", async (t) => {
  const f = await fixture(t),
    ids = [];
  for (let n = 0; n < 3; n++)
    ids.push(
      (await f.raw("SendMessage", wire(input(`page-${n}`)))).body.result.task
        .id,
    );
  await f.execute();
  const first = await f.raw("ListTasks", {
    pageSize: 1,
    historyLength: 0,
    includeArtifacts: false,
  });
  assert.equal(first.body.result.tasks.length, 1);
  assert.equal(first.body.result.totalSize, 3);
  assert.ok(first.body.result.nextPageToken);
  assert.equal(first.body.result.tasks[0].artifacts, undefined);
  const second = await f.raw("ListTasks", {
    pageSize: 1,
    pageToken: first.body.result.nextPageToken,
  });
  assert.notEqual(
    first.body.result.tasks[0].id,
    second.body.result.tasks[0].id,
  );
  noPrivateFields(first.body);
  f.state.owner = { ...identities().sender, clientId: "unrelated-client" };
  assert.equal(
    (await f.raw("GetTask", { id: ids[0] })).body.error.code,
    -32001,
  );
  assert.equal(
    (await f.raw("CancelTask", { id: ids[0] })).body.error.code,
    -32001,
  );
  assert.deepEqual((await f.raw("ListTasks", {})).body.result.tasks, []);
  assert.ok(
    (await f.raw("ListTasks", { pageToken: first.body.result.nextPageToken }))
      .body.error,
  );
});

test("queued cancellation is confirmed while an open execution reports working and unknown", async (t) => {
  const f = await fixture(t);
  const queued = (await f.raw("SendMessage", wire(input("queued")))).body.result
    .task;
  const canceled = (await f.raw("CancelTask", { id: queued.id })).body.result;
  assert.equal(canceled.status.state, "TASK_STATE_CANCELED");
  assert.equal(meta(canceled).cancellationConfirmed, true);
  const confirmed = await f.client.cancelTask(
    CancelTaskRequest.fromJSON({ id: queued.id }),
    options,
  );
  assert.equal(confirmed.status.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(
    (await f.raw("CancelTask", { id: queued.id })).body.result.status.state,
    "TASK_STATE_CANCELED",
  );
  const running = (await f.raw("SendMessage", wire(input("running")))).body
    .result.task;
  await f.claim();
  const pending = (await f.raw("CancelTask", { id: running.id })).body.result;
  assert.equal(pending.status.state, "TASK_STATE_WORKING");
  assert.equal(meta(pending).outcome, "unknown");
  assert.equal(meta(pending).waitReason, "cancellation_confirmation");
  assert.equal(meta(pending).cancellationConfirmed, false);
  assert.equal(pending.artifacts, undefined);
  noPrivateFields(pending);
});

test("confirmed terminal execution cannot be canceled and artifacts appear only on GetTask", async (t) => {
  const f = await fixture(t);
  const task = (await f.raw("SendMessage", wire())).body.result.task;
  await f.execute();
  assert.equal(
    (await f.raw("CancelTask", { id: task.id })).body.error.code,
    -32002,
  );
  assert.equal(
    (await f.raw("ListTasks", { includeArtifacts: true })).body.error.code,
    -32004,
  );
  assert.equal(
    (await f.raw("GetTask", { id: task.id })).body.result.artifacts[0].parts[0]
      .text,
    "paper:hello",
  );
});

test("unsupported streaming, subscriptions, push and extended cards return explicit SDK errors", async (t) => {
  const f = await fixture(t);
  for (const [method, code] of [
    ["SendStreamingMessage", -32004],
    ["SubscribeToTask", -32004],
    ["CreateTaskPushNotificationConfig", -32003],
    ["GetExtendedAgentCard", -32007],
    ["UnknownMethod", -32601],
    ["__proto__", -32601],
    ["constructor", -32601],
    ["toString", -32601],
  ]) {
    assert.equal((await f.raw(method, {})).body.error.code, code);
  }
  assert.equal(f.count(), 0);
  const card = genericTextAgentCard(f.endpoint);
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.capabilities.extensions[0].uri, GENERIC_TEXT_PROFILE);
  assert.equal(card.capabilities.extensions[0].required, true);
});

test("gateway bounds body bytes and cancels oversized readers without exposing internal errors", async (t) => {
  const f = await fixture(t);
  const response = await f.direct(
    new Request(f.endpoint, {
      method: "POST",
      headers,
      body: "x".repeat(256 * 1024 + 1),
    }),
  );
  assert.equal(response.status, 413);
  const submitText = f.hub.submitText;
  f.hub.submitText = async () => {
    throw new Error("private-owner credential /private/runtime/path");
  };
  const unavailable = await f.raw("SendMessage", wire());
  assert.equal(unavailable.body.error.code, -32603);
  assert.equal(
    JSON.stringify(unavailable.body).includes("private-owner"),
    false,
  );
  f.hub.submitText = submitText;
  assert.equal(f.count(), 0);
});

test("expired execution leases project unknown reconciliation without requesting human input", async (t) => {
  const f = await fixture(t);
  const task = (await f.raw("SendMessage", wire())).body.result.task;
  await f.claim();
  f.state.clock += 40_000;
  await f.claim();
  f.restart();
  const current = (await f.raw("GetTask", { id: task.id })).body.result;
  assert.equal(current.status.state, "TASK_STATE_WORKING");
  assert.equal(meta(current).outcome, "unknown");
  assert.equal(meta(current).waitReason, "execution_reconciliation");
  assert.equal(current.artifacts, undefined);
  assert.equal(JSON.stringify(current).includes("approval"), false);
});

test("submission-only discovery grants neither reads nor cancellation", async (t) => {
  const f = await fixture(t);
  f.state.owner = { ...identities().sender, operations: ["submit"] };
  const accepted = await f.raw("SendMessage", wire());
  assert.equal(accepted.body.result.task.status.state, "TASK_STATE_SUBMITTED");
  for (const [method, params] of [
    ["GetTask", { id: accepted.body.result.task.id }],
    ["CancelTask", { id: accepted.body.result.task.id }],
    ["ListTasks", {}],
  ])
    assert.equal((await f.raw(method, params)).body.error.code, -32001);
  assert.equal(f.count(), 1);
});

test("maximum escaped UTF-8 text and confirmed result fit the bounded real SDK transport", async (t) => {
  const f = await fixture(t),
    text = "\u0001".repeat(32768);
  const accepted = await f.client.sendMessage(
    SendMessageRequest.fromJSON(wire(input("maximum", text))),
    options,
  );
  const lease = await f.claim();
  await f.hub.complete(identities().worker, {
    ...lease,
    state: "succeeded",
    result: text,
  });
  const result = await f.client.getTask(
    { id: accepted.id, historyLength: 0 },
    options,
  );
  assert.equal(result.artifacts[0].parts[0].content.value, text);
  noPrivateFields(result);
});

test("failed execution exposes a confirmed failure without private runtime details or artifact", async (t) => {
  const f = await fixture(t);
  const task = (await f.raw("SendMessage", wire())).body.result.task;
  const lease = await f.claim();
  await f.hub.complete(identities().worker, {
    ...lease,
    state: "failed",
    result: "generic_text_failed",
  });
  const current = (await f.raw("GetTask", { id: task.id })).body.result;
  assert.equal(current.status.state, "TASK_STATE_FAILED");
  assert.equal(meta(current).outcome, "confirmed");
  assert.equal(current.artifacts, undefined);
  assert.equal(
    (await f.raw("CancelTask", { id: task.id })).body.error.code,
    -32002,
  );
  noPrivateFields(current);
});

test("oversized streamed body is canceled without waiting for its producer", async (t) => {
  const f = await fixture(t);
  let canceled = false;
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await f.direct(
    new Request(f.endpoint, {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 413);
  assert.equal(canceled, true);
  assert.equal(f.count(), 0);
});

test(
  "incomplete streamed body times out and cancels its reader",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    let canceled = false;
    const stream = new globalThis.ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    const response = await f.direct(
      new Request(f.endpoint, {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      }),
    );
    assert.equal(response.status, 408);
    assert.equal(canceled, true);
    assert.equal(f.count(), 0);
  },
);

test("completed SendMessage replay exposes metadata with no artifact even for submit-only callers", async (t) => {
  const f = await fixture(t),
    data = input("completed-replay", "private confirmed result");
  const accepted = (await f.raw("SendMessage", wire(data))).body.result.task;
  await f.execute();
  f.state.owner = { ...identities().sender, operations: ["submit"] };
  const replay = (await f.raw("SendMessage", wire(data))).body.result.task;
  assert.equal(replay.id, accepted.id);
  assert.equal(replay.status.state, "TASK_STATE_COMPLETED");
  assert.equal(replay.artifacts, undefined);
  assert.equal(
    JSON.stringify(replay).includes("private confirmed result"),
    false,
  );
  assert.equal(
    (await f.raw("GetTask", { id: accepted.id })).body.error.code,
    -32001,
  );
});

test("read list and cancel reject raw coercion and authority fields before mutation", async (t) => {
  const f = await fixture(t);
  const task = (await f.raw("SendMessage", wire())).body.result.task;
  const cases = [
    ["GetTask", { id: task.id, tenant: "forged" }],
    ["GetTask", { id: task.id, historyLength: "0" }],
    ["GetTask", { id: 123 }],
    ["ListTasks", { pageSize: "1" }],
    ["ListTasks", { pageSize: 21 }],
    ["ListTasks", { includeArtifacts: "false" }],
    ["ListTasks", { ownerScope: "forged" }],
    ["CancelTask", { id: task.id, metadata: { approved: true } }],
    ["CancelTask", { id: task.id, clientId: "forged" }],
  ];
  for (const [method, params] of cases)
    assert.equal((await f.raw(method, params)).body.error.code, -32602);
  assert.equal(
    (await f.raw("GetTask", { id: task.id })).body.result.status.state,
    "TASK_STATE_SUBMITTED",
  );
  assert.equal(f.count(), 1);
});
