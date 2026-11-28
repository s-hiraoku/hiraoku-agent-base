import { createServer } from "node:http";
import { once } from "node:events";
import { HabMcpClient } from "../src/hab/mcp-client.ts";
import { HabHttpGateway } from "../src/hab/http.ts";
import { createMcpNodeHandler } from "../src/host/mcp/http-node.ts";
import { limits, policy } from "./mcp-http-fixtures.js";

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
    handle = createMcpNodeHandler(
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
  return {
    url,
    clients,
    tools,
    start,
    stop,
    async dispose() {
      await stop();
    },
  };
}
