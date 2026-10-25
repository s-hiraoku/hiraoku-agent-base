import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { SQLiteOutbox } from "../src/relay/sqlite-outbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import { limits, policy } from "./relay-http-fixtures.js";

export async function setup(t, f, hab = f.hab) {
  let handle;
  const tools = [];
  let server;
  let url;
  let port = 0;
  const start = async (service = hab) => {
    if (server?.listening) throw Error("fixture_already_listening");
    server = createServer(
      { maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 },
      (req, res) => {
        tools.push(req.headers["mcp-name"]);
        void handle(req, res);
      },
    );
    server.maxConnections = 4;
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
    url = `http://127.0.0.1:${port}/mcp`;
    handle = createRelayNodeHandler(
      new HabHttpGateway(
        service,
        { ...policy, resource_url: url },
        f.audit,
        f.verifier,
      ),
    );
  };
  const stop = async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  await start();
  t.after(stop);
  const clients = (name, agent, fetch = globalThis.fetch, as_address) =>
    new HabMcpClient({
      as_address,
      policy: {
        resource_url: url,
        agent_id: agent.agent_id,
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
      fetch,
    });
  const stores = new Set();
  const outbox = (name, agent) => {
    const s = new SQLiteOutbox(join(f.dir, `outbox-${name}.sqlite`), {
      agent_id: agent.agent_id,
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
    s.migrate();
    stores.add(s);
    return s;
  };
  const inbox = (name, agent) => {
    const s = new SQLiteInbox(join(f.dir, `inbox-${name}.sqlite`), {
      agent_id: agent.agent_id,
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
    s.migrate();
    stores.add(s);
    return s;
  };
  const closeStores = () => {
    for (const s of stores) s.close();
    stores.clear();
  };
  t.after(closeStores);
  return {
    url,
    clients,
    outbox,
    inbox,
    tools,
    start,
    stop,
    async dispose() {
      await stop();
      closeStores();
    },
    close(store) {
      store.close();
      stores.delete(store);
    },
  };
}
