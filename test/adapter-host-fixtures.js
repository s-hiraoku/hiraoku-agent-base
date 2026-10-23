import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { fixture, limits } from "./task-bridge-fixtures.js";
import { message as sourceMessage, policy } from "./relay-http-fixtures.js";
import { SQLiteHostControl } from "../src/adapter-host/sqlite-control.ts";
import { AdapterHostCycle } from "../src/adapter-host/cycle.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteReplyBudget } from "../src/adapter-policy/sqlite-reply-budget.ts";
import { RelayMcpClient } from "../src/relay/mcp-client.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
export { limits };
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function hostFixture(t, patch = {}) {
  const f = fixture(t, { lease_ms: 50 });
  const outbox = new SQLiteOutbox(join(f.dir, "host-outbox.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(62),
    limits,
    max_records: 50,
    max_body_bytes: 1000000,
    max_clock_skew_ms: 1000,
    lease_ms: 50,
    retry_base_ms: 1,
    retry_cap_ms: 10,
    max_submit_attempts: 3,
    max_status_attempts: 3,
    status_retry_ms: 86400000,
  });
  outbox.migrate();
  const budget = new SQLiteReplyBudget(join(f.dir, "host-budget.sqlite"), {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(63),
    limits,
    max_records: 50,
    max_thread_replies: 8,
    max_per_window: 20,
    window_ms: 60000,
    max_clock_skew_ms: 1000,
  });
  budget.migrate();
  const path = join(f.dir, "host-control.sqlite"),
    controls = new Set();
  const controlOptions = {
    agent_id: "b",
    fingerprint_key: new Uint8Array(32).fill(64),
    max_audit_records: 20,
    ...patch,
  };
  const open = (extra = {}, file = path) => {
    const s = new SQLiteHostControl(file, { ...controlOptions, ...extra });
    controls.add(s);
    return s;
  };
  const control = open();
  control.migrate();
  const controlRaw = new DatabaseSync(path),
    outboxRaw = new DatabaseSync(join(f.dir, "host-outbox.sqlite"));
  const inboxRaw = new DatabaseSync(join(f.dir, "bridge-inbox.sqlite")),
    serverRaw = new DatabaseSync(join(f.dir, "relay.sqlite"));
  const state = {
    enabled: true,
    denied: new Set(),
    actor: "synthetic-host-operator",
    credential: () => "Bearer fixture-b",
    tools: [],
    clients: [],
    fetchPorts: [],
    afterNetwork: null,
    resource_url: policy.resource_url,
    timeout_ms: 1000,
  };
  const authorize = (ctx, op) =>
    ctx === f.context && state.enabled && !state.denied.has(op)
      ? { agent_id: "b", actor_id: state.actor }
      : undefined;
  const makeHost = (extra = {}) =>
    new AdapterHostCycle({
      control,
      inbox: f.inbox,
      outbox,
      budget,
      limits,
      transport: (fetch) => {
        state.fetchPorts.push(fetch);
        const c = new RelayMcpClient({
          limits,
          policy: {
            resource_url: state.resource_url,
            agent_id: "b",
            max_request_bytes: 65536,
            max_response_bytes: 131072,
            timeout_ms: state.timeout_ms,
            max_active_requests: 1,
            max_sse_events: 16,
            max_sse_lines: 128,
            max_json_depth: 64,
            max_json_nodes: 10000,
          },
          authorization: (input) => state.credential(input),
          fetch,
        });
        state.clients.push(c);
        return c;
      },
      network: async (input, init) => {
        const req = new Request(input, init);
        const tool = req.headers.get("Mcp-Name");
        state.tools.push(tool);
        const response = await f.gateway().fetch(req);
        if (state.afterNetwork) await state.afterNetwork(tool, response);
        return response;
      },
      task: { journal: f.journal, tasks: f.tasks },
      authorization: authorize,
      ...extra,
    });
  const host = makeHost();
  const resume = (h = host) =>
    h.setPaused(f.context, false, h.status(f.context).epoch);
  const pause = (h = host) =>
    h.setPaused(f.context, true, h.status(f.context).epoch);
  const submit = (kind = "question", patch = {}) => {
    const m = { ...sourceMessage(), kind, ...patch };
    m.message_id = makeReplayBoundMessageId(
      m.first_sent_at,
      randomUUID().replaceAll("-", ""),
    );
    f.service.submit(f.contexts.a, m);
    return { key: { sender_id: "a", message_id: m.message_id }, message: m };
  };
  const answer = (key, patch = {}) => {
    const first = new Date(Date.now() - 100).toISOString();
    return {
      version: 1,
      message_id: makeReplayBoundMessageId(
        first,
        randomUUID().replaceAll("-", ""),
      ),
      recipient_id: "a",
      kind: "answer",
      thread_id: "thread-ab",
      in_reply_to: key,
      first_sent_at: first,
      expires_at: new Date(Date.parse(first) + 3600000).toISOString(),
      body: { parts: [{ type: "text", text: "synthetic host reply" }] },
      ...patch,
    };
  };
  const step = (command) => host.stepOnce(f.context, command);
  t.after(() => {
    controlRaw.close();
    outboxRaw.close();
    inboxRaw.close();
    serverRaw.close();
    for (const s of controls) s.close();
    outbox.close();
    budget.close();
  });
  return {
    ...f,
    host,
    makeHost,
    state,
    authorize,
    resume,
    pause,
    submit,
    answer,
    step,
    control,
    controlOptions,
    path,
    open,
    closeControl: (s) => {
      s.close();
      controls.delete(s);
    },
    outbox,
    budget,
    controlRaw,
    outboxRaw,
    inboxRaw,
    serverRaw,
    queued: () => outboxRaw.prepare("SELECT * FROM relay_outbox").all(),
    audit: () => controlRaw.prepare("SELECT * FROM adapter_host_audit").all(),
  };
}
