import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WriterAdmission } from "../src/relay/writer-admission.ts";
import { RelayHttpGateway } from "../src/relay/http.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { HabAttachmentHttpGateway } from "../src/hab/attachment-http.ts";
import { AttachmentHttpGateway } from "../src/relay/attachment-http.ts";
import { habWriterIdentity } from "../src/hab/writer-admission.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import {
  fixture as httpFixture,
  policy,
  call,
  request,
  decode,
  message,
  tick,
} from "./relay-http-fixtures.js";
import { fixture as registryFixture } from "./hab-registry-fixtures.js";
import {
  fixture as attachmentFixture,
  wire,
} from "./relay-attachment-mcp-fixtures.js";
const admissionPolicy = {
  max_individuals: 4,
  max_waiting_per_individual: 4,
  requests_per_window: 20,
  window_ms: 60000,
  max_wait_ms: 2000,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), "fixture condition did not become ready");
}
function fixture(t, limits = {}, http = {}) {
  const f = httpFixture(t),
    lookups = [],
    state = { override: null };
  const admission = new WriterAdmission(
    { ...admissionPolicy, ...limits },
    (ctx, op) => {
      const id =
        state.override ??
        Object.keys(f.contexts).find(
          (id) => f.contexts[id] === ctx && f.active.has(id),
        );
      lookups.push({ id, op });
      return id;
    },
  );
  t.after(() => admission.close());
  const gateway = (patch = {}, sink = f.audit, service = f.service) =>
    new RelayHttpGateway(
      service,
      { ...policy, max_active_requests: 20, ...http, ...patch },
      sink,
      f.verifier,
      admission,
    );
  return { ...f, admission, lookups, state, gateway, g: gateway() };
}
async function hold(admission, context) {
  const started = deferred(),
    done = deferred();
  const task = admission.run(
    context,
    "submit",
    new AbortController().signal,
    () => {
      started.resolve();
      return done.promise;
    },
  );
  await started.promise;
  return async () => {
    done.resolve();
    await task;
  };
}
const as = (who) => ({ headers: { Authorization: "Bearer fixture-" + who } });

test("writer HTTP: explicit missing identity fails closed while omitted admission retains default behavior", async (t) => {
  const f = httpFixture(t),
    admission = new WriterAdmission(admissionPolicy);
  t.after(() => admission.close());
  const g = new RelayHttpGateway(
    f.service,
    policy,
    f.audit,
    f.verifier,
    admission,
  );
  assert.equal((await call(g, "relay_poll")).response.status, 403);
  assert.equal((await call(f.gateway(), "relay_poll")).response.status, 200);
  assert.throws(
    () => new RelayHttpGateway(f.service, policy, f.audit, f.verifier, {}),
    /invalid_relay_http_policy/,
  );
});
test("writer HTTP: unauthenticated requests and forwarded identity cannot create another bucket", async (t) => {
  const f = fixture(t, { requests_per_window: 1 });
  const r = await call(
    f.g,
    "relay_poll",
    {},
    { headers: { Authorization: "", "X-Agent-ID": "b" } },
  );
  assert.equal(r.response.status, 401);
  assert.equal(f.lookups.length, 0);
  assert.equal(
    (await call(f.g, "relay_poll", {}, { headers: { "X-Agent-ID": "b" } }))
      .response.status,
    200,
  );
  assert.equal((await call(f.g, "relay_poll")).response.status, 429);
  assert.equal(
    (await call(f.g, "relay_poll", {}, as("b"))).response.status,
    200,
  );
});
test("writer HTTP: modern, legacy, operation switching and another gateway share one individual budget", async (t) => {
  const f = fixture(t, { requests_per_window: 2 }),
    m = message();
  const first = await call(f.g, "relay_submit", m);
  assert.equal(first.body.result.structuredContent.sender_id, "a");
  assert.equal(
    (
      await call(
        f.gateway(),
        "relay_status",
        { message_id: m.message_id },
        { modern: false },
      )
    ).response.status,
    200,
  );
  const denied = await call(f.g, "relay_submit", m);
  assert.equal(denied.response.status, 429);
  assert.equal(denied.body, "");
  assert.equal(
    (await call(f.g, "relay_poll", {}, as("b"))).response.status,
    200,
  );
  assert.equal(f.count(), 1);
});
test("writer HTTP: queued SDK calls rotate individuals before a hot sender's second turn", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c),
    order = [];
  const service = {
    ...f.service,
    submit: (ctx, value) => {
      order.push(value.thread_id);
      return f.service.submit(ctx, value);
    },
  };
  const g = f.gateway({}, f.audit, service);
  const m = (digit, thread) => ({
    ...message(digit.repeat(32)),
    thread_id: thread,
  });
  const a1 = call(g, "relay_submit", m("2", "a1")),
    a2 = call(g, "relay_submit", m("3", "a2"));
  await until(() => f.lookups.filter((v) => v.id === "a").length === 2);
  const b1 = call(g, "relay_submit", m("4", "b1"), as("b"));
  await until(() => f.lookups.some((v) => v.id === "b"));
  await release();
  const results = await Promise.all([a1, a2, b1]);
  assert.ok(results.every((v) => v.response.status === 200));
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  assert.equal(f.count(), 3);
});
test("writer HTTP: per-individual queue overflow does not consume a peer's queue", async (t) => {
  const f = fixture(t, { max_waiting_per_individual: 1 }),
    release = await hold(f.admission, f.contexts.c);
  const a = call(f.g, "relay_poll");
  await until(() => f.lookups.some((v) => v.id === "a"));
  assert.equal((await call(f.g, "relay_poll")).response.status, 503);
  const b = call(f.g, "relay_poll", {}, as("b"));
  await release();
  assert.equal((await a).response.status, 200);
  assert.equal((await b).response.status, 200);
});
test("writer HTTP: disconnect while queued removes the candidate without later storage effects", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c),
    controller = new AbortController();
  const pending = call(f.g, "relay_submit", message(), {
    init: { signal: controller.signal },
  });
  await until(() => f.lookups.some((v) => v.id === "a"));
  controller.abort();
  assert.equal((await pending).response.status, 408);
  await release();
  await tick();
  assert.equal(f.count(), 0);
});
test("writer HTTP: request timeout while queued cannot later dispatch a tool", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c);
  const pending = call(
    f.gateway({ timeout_ms: 200 }),
    "relay_submit",
    message(),
  );
  await until(() => f.lookups.some((v) => v.id === "a"));
  assert.equal((await pending).response.status, 504);
  await release();
  await tick();
  assert.equal(f.count(), 0);
});
test("writer HTTP: queue's own finite deadline returns backpressure before HTTP timeout", async (t) => {
  const f = fixture(t, { max_wait_ms: 200 }),
    release = await hold(f.admission, f.contexts.c);
  assert.equal(
    (await call(f.g, "relay_submit", message())).response.status,
    503,
  );
  await release();
  assert.equal(f.count(), 0);
});
test("writer HTTP: current revocation after enqueue prevents SDK dispatch", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c);
  const pending = call(f.g, "relay_submit", message());
  await until(() => f.lookups.some((v) => v.id === "a"));
  f.active.delete("a");
  await release();
  assert.equal((await pending).response.status, 403);
  assert.equal(f.count(), 0);
});
test("writer HTTP: changed individual binding does not move a queued candidate into a new budget", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c);
  const pending = call(f.g, "relay_submit", message());
  await until(() => f.lookups.some((v) => v.id === "a"));
  f.state.override = "b";
  await release();
  assert.equal((await pending).response.status, 403);
  assert.equal(f.count(), 0);
});
test("writer HTTP: closed scheduler rejects queued tools but catalog discovery remains authenticated", async (t) => {
  const f = fixture(t),
    release = await hold(f.admission, f.contexts.c);
  const pending = call(f.g, "relay_poll");
  await until(() => f.lookups.some((v) => v.id === "a"));
  f.admission.close();
  assert.equal((await pending).response.status, 503);
  await release();
  assert.equal((await f.g.fetch(request())).status, 200);
  assert.equal((await call(f.g, "relay_poll")).response.status, 503);
});
for (const stage of ["tool_started", "tool_succeeded"]) {
  test(
    "writer HTTP: timed out " +
      stage +
      " audit retains the shared slot until actual settlement",
    async (t) => {
      const f = fixture(t),
        auditHeld = deferred(),
        auditStarted = deferred();
      let once = true;
      const audit = {
        record(category, correlation) {
          f.audit.record(category, correlation);
          if (once && category === stage) {
            once = false;
            auditStarted.resolve();
            return auditHeld.promise;
          }
        },
      };
      const first = call(
        f.gateway({ timeout_ms: 200 }, audit),
        "relay_submit",
        message(),
      );
      await auditStarted.promise;
      assert.equal((await first).response.status, 504);
      let completed = false;
      const second = call(f.gateway(), "relay_poll", {}, as("b")).then(
        (value) => {
          completed = true;
          return value;
        },
      );
      await until(() => f.lookups.some((v) => v.id === "b"));
      await tick();
      assert.equal(completed, false);
      auditHeld.resolve();
      const result = await second;
      assert.equal(result.response.status, 200);
      assert.equal(f.count(), stage === "tool_started" ? 0 : 1);
      assert.equal(
        result.body.result.structuredContent.delivery !== null,
        stage === "tool_succeeded",
      );
    },
  );
}
test("writer HTTP: HAB queue holds no registry lock and independent revocation wins before commit", async (t) => {
  const f = registryFixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  f.enroll("c");
  const identity = habWriterIdentity(f.registry),
    queued = deferred();
  const admission = new WriterAdmission(admissionPolicy, (ctx, op) => {
    const id = identity(ctx, op);
    if (id === a.agent_id) queued.resolve();
    return id;
  });
  t.after(() => admission.close());
  const release = await hold(admission, f.contexts.c);
  const g = new HabHttpGateway(f.hab, policy, f.audit, f.verifier, admission);
  const m = { ...message(), recipient_id: b.agent_id },
    pending = call(g, "relay_submit", m);
  await queued.promise;
  const other = f.open();
  other.migrate();
  const current = other.inspect(f.admin, a.agent_id);
  other.setAccess(f.admin, {
    request_id: "synthetic-queued-stop",
    agent_id: a.agent_id,
    expected_epoch: current.epoch,
    state: "stopped",
    operations: [],
  });
  await release();
  assert.equal((await pending).response.status, 403);
  assert.equal(f.count(), 0);
});
test("writer HTTP: HAB identity port honors operation-specific rights without granting submit or resolve", async (t) => {
  const f = registryFixture(t),
    a = f.enroll("a"),
    b = f.enroll("b");
  const current = f.registry.inspect(f.admin, b.agent_id);
  f.registry.setAccess(f.admin, {
    request_id: "synthetic-poll-only",
    agent_id: b.agent_id,
    expected_epoch: current.epoch,
    state: "active",
    operations: ["poll", "ack"],
  });
  const admission = new WriterAdmission(
    admissionPolicy,
    habWriterIdentity(f.registry),
  );
  t.after(() => admission.close());
  const g = new HabHttpGateway(f.hab, policy, f.audit, f.verifier, admission);
  assert.equal((await call(g, "relay_poll", {}, as("b"))).response.status, 200);
  assert.equal(
    (
      await call(
        g,
        "relay_submit",
        { ...message(), recipient_id: a.agent_id },
        as("b"),
      )
    ).response.status,
    403,
  );
  assert.equal(
    (await call(g, "relay_resolve", { address: a.address }, as("b"))).response
      .status,
    403,
  );
});
const attachmentCalls = [
  "begin",
  "status",
  "put",
  "finalize",
  "cancel",
  "read",
];
for (const tool of attachmentCalls) {
  test(
    "writer HTTP: optional attachment " +
      tool +
      " shares the verified individual's tool budget",
    async (t) => {
      const f = attachmentFixture(t),
        admission = new WriterAdmission(
          { ...admissionPolicy, requests_per_window: 1 },
          habWriterIdentity(f.registry),
        );
      t.after(() => admission.close());
      const g = new HabAttachmentHttpGateway(
        f.service,
        f.operations,
        wire,
        policy,
        f.audit,
        f.verifier,
        admission,
      );
      const r = await f.begin(),
        who = tool === "read" ? "b" : "a";
      const args = {
        begin: f.beginInput(),
        status: f.ref(r),
        put: {
          ...f.ref(r),
          offset: 0,
          data_base64: "AP+AAQ==",
        },
        finalize: f.ref(r),
        cancel: f.ref(r),
        read: f.readInput(r),
      };
      assert.equal(
        (await call(g, "relay_poll", {}, as(who))).response.status,
        200,
      );
      assert.equal(
        (await call(g, "relay_attachment_" + tool, args[tool], as(who)))
          .response.status,
        429,
      );
      assert.equal((await f.list(g)).length, 11);
    },
  );
}
test("writer HTTP: directory lookup and attachment uploads share the same HAB budget", async (t) => {
  const f = attachmentFixture(t),
    admission = new WriterAdmission(
      { ...admissionPolicy, requests_per_window: 1 },
      habWriterIdentity(f.registry),
    );
  t.after(() => admission.close());
  const g = new HabAttachmentHttpGateway(
    f.service,
    f.operations,
    wire,
    policy,
    f.audit,
    f.verifier,
    admission,
  );
  assert.equal(
    (await call(g, "relay_resolve", { address: f.b.address })).response.status,
    200,
  );
  assert.equal(
    (await call(g, "relay_attachment_begin", f.beginInput())).response.status,
    429,
  );
});
test("writer HTTP: standalone Relay attachment catalog also enforces optional admission", async (t) => {
  const f = attachmentFixture(t),
    admission = new WriterAdmission(
      { ...admissionPolicy, requests_per_window: 1 },
      habWriterIdentity(f.registry),
    );
  t.after(() => admission.close());
  const g = new AttachmentHttpGateway(
    f.service,
    f.operations,
    wire,
    policy,
    f.audit,
    f.verifier,
    admission,
  );
  const first = await call(g, "relay_attachment_begin", f.beginInput());
  assert.equal(first.body.result.structuredContent.owner_id, f.a.agent_id);
  assert.equal((await call(g, "relay_poll")).response.status, 429);
  assert.equal(
    (await decode(await g.fetch(request()))).result.tools.length,
    10,
  );
});
test("writer HTTP: native loopback listener applies independent authenticated budgets", async (t) => {
  const f = fixture(t, { requests_per_window: 1 });
  let handle;
  const server = createServer((req, res) => {
    if (!handle) {
      res.writeHead(503);
      res.end();
    } else void handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = "http://127.0.0.1:" + server.address().port + "/mcp";
  handle = createRelayNodeHandler(f.gateway({ resource_url: url }));
  const send = (who) =>
    globalThis.fetch(
      request(
        "tools/call",
        { name: "relay_poll", arguments: {} },
        { url, ...as(who) },
      ),
    );
  assert.equal((await send("a")).status, 200);
  const limited = await send("a");
  assert.equal(limited.status, 429);
  assert.equal(await limited.text(), "");
  assert.equal((await send("b")).status, 200);
});
test("writer HTTP: claimed sender argument consumes only the real verified individual's budget", async (t) => {
  const f = fixture(t, { requests_per_window: 1 });
  const invalid = await call(f.g, "relay_submit", {
    ...message(),
    sender_id: "b",
  });
  assert.equal(invalid.response.status, 200);
  assert.ok(invalid.body.error || invalid.body.result?.isError);
  assert.equal(f.count(), 0);
  assert.equal((await call(f.g, "relay_poll")).response.status, 429);
  assert.equal(
    (await call(f.g, "relay_poll", {}, as("b"))).response.status,
    200,
  );
});
test("writer HTTP: replacing volatile admission restores burst but replays the same durable receipt", async (t) => {
  const f = fixture(t, { requests_per_window: 1 }),
    m = message(),
    first = await call(f.g, "relay_submit", m);
  assert.equal((await call(f.g, "relay_submit", m)).response.status, 429);
  f.admission.close();
  const restarted = new WriterAdmission(
    { ...admissionPolicy, requests_per_window: 1 },
    (ctx) =>
      Object.keys(f.contexts).find(
        (id) => f.contexts[id] === ctx && f.active.has(id),
      ),
  );
  t.after(() => restarted.close());
  const g = new RelayHttpGateway(
    f.service,
    policy,
    f.audit,
    f.verifier,
    restarted,
  );
  const replay = await call(g, "relay_submit", m);
  assert.deepEqual(
    replay.body.result.structuredContent,
    first.body.result.structuredContent,
  );
  assert.equal(f.count(), 1);
});
