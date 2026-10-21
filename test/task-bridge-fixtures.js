import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fixture as relayFixture,
  message,
  limits,
} from "./relay-http-fixtures.js";
import { Hub, owner, worker, RESPONSE } from "./fixtures.js";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { makeReplayBoundMessageId } from "../src/relay/contract.ts";
import { SQLiteTaskBridgeJournal } from "../src/task-bridge/sqlite-journal.ts";
import { ConnectivityTaskPort } from "../src/task-bridge/task-port.ts";
import { TaskBridge } from "../src/task-bridge/bridge.ts";
export { owner, worker, RESPONSE, limits };
export const code = (wanted) => (error) =>
  error.code === wanted || error.message === wanted;
export function fixture(t, patch = {}) {
  const f = relayFixture(t),
    inbox = new SQLiteInbox(join(f.dir, "bridge-inbox.sqlite"), {
      agent_id: "b",
      fingerprint_key: new Uint8Array(32).fill(44),
      limits,
      max_records: 20,
      max_body_bytes: 100000,
      max_ack_records: 40,
      ack_retry_ms: 86400000,
      retry_base_ms: 1,
      retry_cap_ms: 10,
      max_attempts: 3,
    });
  inbox.migrate();
  const hub = new Hub(join(f.dir, "bridge-tasks.sqlite"));
  const binding = {
    engine_id: "synthetic-task-engine",
    owner_subject: owner.subject,
    client_id: null,
  };
  const options = {
    receiver_id: "b",
    binding,
    fingerprint_key: new Uint8Array(32).fill(118),
    limits,
    max_records: 10,
    max_audit_records: 100,
    lease_ms: 1000,
    max_submit_attempts: 3,
    ...patch,
  };
  const path = join(f.dir, "bridge.sqlite"),
    stores = new Set();
  const open = (extra = {}) => {
    const s = new SQLiteTaskBridgeJournal(path, { ...options, ...extra });
    stores.add(s);
    return s;
  };
  const journal = open();
  journal.migrate();
  const raw = new DatabaseSync(path);
  const state = { enabled: true, task_enabled: true, denied: new Set() },
    context = Symbol("explicit-acceptance");
  const authorize = (ctx, op) =>
    ctx === context && state.enabled && !state.denied.has(op)
      ? { receiver_id: "b", actor_id: "synthetic-operator" }
      : undefined;
  const tasks = new ConnectivityTaskPort(hub, binding, () =>
      state.task_enabled ? owner : undefined,
    ),
    calls = [];
  const makeBridge = (
    extra = {},
    selected = journal,
    auth = authorize,
    source = inbox,
  ) =>
    new TaskBridge(
      selected,
      source,
      {
        binding,
        submit: (key) => {
          calls.push({ op: "submit", key });
          return tasks.submit(key);
        },
        get: (id, key) => {
          calls.push({ op: "get", id, key });
          return tasks.get(id, key);
        },
        ...extra,
      },
      auth,
    );
  const bridge = makeBridge();
  const receive = (patch = {}, ack = true) => {
    const v = {
      ...message(),
      kind: "execution_request",
      body: {
        parts: [
          {
            type: "data",
            schema_id: "task.execution_request",
            schema_version: 1,
            value: { task_type: "connectivity_check" },
          },
        ],
      },
      ...patch,
    };
    v.message_id = makeReplayBoundMessageId(
      v.first_sent_at,
      randomUUID().replaceAll("-", ""),
    );
    f.service.submit(f.contexts.a, v);
    const delivery = f.service.poll(f.contexts.b);
    inbox.save(delivery);
    if (ack) {
      const request = inbox.claimAck();
      inbox.confirmAck(request, f.service.ack(f.contexts.b, request));
    }
    return { sender_id: "a", message_id: v.message_id };
  };
  t.after(() => {
    raw.close();
    for (const s of stores) s.close();
    inbox.close();
    hub.close();
  });
  return {
    ...f,
    inbox,
    hub,
    binding,
    options,
    path,
    journal,
    raw,
    state,
    context,
    authorize,
    tasks,
    calls,
    bridge,
    makeBridge,
    receive,
    open,
    close: (s) => {
      s.close();
      stores.delete(s);
    },
    count: () => hub.sqlite.db.prepare("SELECT count(*) n FROM tasks").get().n,
    audit: () =>
      raw
        .prepare("SELECT event FROM task_bridge_audit ORDER BY rowid")
        .all()
        .map((r) => r.event),
  };
}
