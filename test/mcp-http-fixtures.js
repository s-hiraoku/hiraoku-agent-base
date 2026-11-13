import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeReplayBoundMessageId } from "../src/messaging/index.ts";
import { McpHttpGateway } from "../src/host/mcp/http.ts";
import { authorizedDelivery } from "./delivery-fixture.js";
export const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  parts: 8,
  json_depth: 20,
  json_nodes: 1000,
};
export const policy = {
  resource_url: "https://hab.example/mcp",
  allowed_origins: ["https://console.example"],
  max_request_bytes: 65536,
  max_response_bytes: 131072,
  timeout_ms: 2000,
  max_active_requests: 4,
  requests_per_window: 120,
  window_ms: 60000,
};
export function message(entropy = "1".repeat(32)) {
  const at = Date.now() - 100,
    first = new Date(at).toISOString();
  return {
    version: 1,
    message_id: makeReplayBoundMessageId(first, entropy),
    recipient_id: "b",
    kind: "question",
    body: { parts: [{ type: "text", text: "synthetic private payload" }] },
    thread_id: "thread-ab",
    in_reply_to: null,
    first_sent_at: first,
    expires_at: new Date(at + 3600000).toISOString(),
  };
}
export function envelope(method = "tools/list", params = {}, modern = true) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: modern
      ? {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : params,
  };
}
export function request(method = "tools/list", params = {}, patch = {}) {
  const modern = patch.modern !== false,
    data = envelope(method, params, modern);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer fixture-a",
    ...(modern
      ? {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
        }
      : {}),
    ...patch.headers,
  };
  return new Request(patch.url ?? policy.resource_url, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
    ...patch.init,
  });
}
export async function decode(response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.startsWith("application/json"))
    return JSON.parse(text);
  const frames = text
    .split(/\r?\n/)
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice(6)));
  if (frames.length !== 1) throw Error("unexpected fixture frames");
  return frames[0];
}
export async function call(gateway, name, args = {}, patch = {}) {
  const response = await gateway.fetch(
    request("tools/call", { name, arguments: args }, patch),
  );
  return {
    response,
    body:
      response.status === 200 ? await decode(response) : await response.text(),
  };
}
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Three verified synthetic identities and an audit sink; no delivery backend. */
export function identities(t, { cleanup = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hab-http-"));
  const known = new Map(),
    contexts = {},
    active = new Set(["a", "b", "c"]);
  for (const name of active) {
    contexts[name] = Symbol(`verified-${name}`);
    known.set(contexts[name], name);
  }
  const authorization = {
    authorize(ctx) {
      const id = known.get(ctx);
      return active.has(id) ? { agent_id: id } : undefined;
    },
  };
  const events = [],
    notes = [],
    audit = {
      record(category, correlation) {
        events.push({ category, correlation });
      },
      note(category) {
        notes.push(category);
      },
    };
  const verifier = ({ authorization }) =>
    contexts[
      {
        "Bearer fixture-a": "a",
        "Bearer fixture-b": "b",
        "Bearer fixture-c": "c",
      }[authorization]
    ] ?? null;
  if (cleanup) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    contexts,
    active,
    authorization,
    events,
    notes,
    audit,
    verifier,
  };
}
/** The identities above in front of the SQLite delivery store and the four-tool gateway. */
export async function fixture(t, queue = {}) {
  const f = identities(t, { cleanup: false });
  const delivery = await authorizedDelivery(t, {
    authorization: f.authorization,
    limits,
    directory: f.dir,
    queue: {
      max_pending: 10,
      max_pending_per_recipient: 5,
      poll_scan_limit: 10,
      agent_capacity: undefined,
      ...queue,
    },
  });
  const raw = new DatabaseSync(join(f.dir, "delivery.sqlite"));
  t.after(() => {
    raw.close();
    rmSync(f.dir, { recursive: true, force: true });
  });
  const gateway = (patch = {}, verify = f.verifier, sink = f.audit) =>
    new McpHttpGateway(
      delivery.service,
      { ...policy, ...patch },
      sink,
      verify,
    );
  return {
    ...f,
    raw,
    delivery,
    service: delivery.service,
    pump: delivery.pump,
    gateway,
    count: () =>
      raw.prepare("SELECT count(*) n FROM delivery_messages").get().n,
  };
}
