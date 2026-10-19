import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fixture as mcpFixture,
  wire,
} from "./relay-attachment-mcp-fixtures.js";
import { limits, decode } from "./relay-http-fixtures.js";
import { payload } from "./relay-attachment-fixtures.js";
import { inboxOptions } from "./relay-attachment-inbox-fixtures.js";
import { deletionPolicy } from "./relay-attachment-deletion-fixtures.js";
import { HabAttachmentMcpClient } from "../src/hab/attachment-mcp-client.ts";
import { createRelayNodeHandler } from "../src/relay/http-node.ts";
import { SQLiteAttachmentInbox } from "../src/relay/sqlite-attachment-inbox.ts";
import { SQLiteInbox } from "../src/relay/sqlite-inbox.ts";
import { AttachmentStager } from "../src/relay/attachment-stager.ts";
import { AttachmentDeletionWorker } from "../src/relay/attachment-deletion-worker.ts";
export async function fixture(t) {
  const f = mcpFixture(t),
    tools = [];
  let server,
    handler,
    port = 0,
    url;
  const stop = async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  const start = async () => {
    server = createServer(
      { maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 },
      (req, res) => {
        tools.push(req.headers["mcp-name"]);
        void handler(req, res);
      },
    );
    server.maxConnections = 8;
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
    url = "http://127.0.0.1:" + port + "/mcp";
    handler = createRelayNodeHandler(
      f.gateway({ resource_url: url, requests_per_window: 500 }),
    );
  };
  await start();
  t.after(stop);
  const found = f.service.resolve(f.contexts.a, "c@grok-bot.hab");
  const c = { agent_id: found.recipient_id, address: found.address };
  const client = (who = "a", patch = {}) => {
    const { policy: policyPatch, ...extra } = patch;
    return new HabAttachmentMcpClient({
      limits,
      attachments: wire,
      authorization: () => "Bearer fixture-" + who,
      fetch: globalThis.fetch,
      ...extra,
      policy: {
        resource_url: url,
        agent_id: { a: f.a, b: f.b, c }[who]?.agent_id ?? f.a.agent_id,
        max_request_bytes: 65536,
        max_response_bytes: 131072,
        timeout_ms: 2000,
        max_active_requests: 1,
        max_sse_events: 16,
        max_sse_lines: 128,
        max_json_depth: 64,
        max_json_nodes: 10000,
        ...policyPatch,
      },
    });
  };
  const complete = async (
    c = client(),
    input = f.beginInput(),
    bytes = payload,
  ) => {
    const r = await c.beginUpload(input);
    for (let i = 0; i < bytes.length; i += wire.chunk_bytes)
      await c.putUploadChunk(
        r.attachment_id,
        i,
        bytes.subarray(i, i + wire.chunk_bytes),
      );
    return c.finalizeUpload(r.attachment_id);
  };
  const local = () => {
    const filePath = join(f.dir, "native-files.sqlite"),
      bodyPath = join(f.dir, "native-body.sqlite"),
      filesSet = new Set(),
      bodySet = new Set();
    const openFiles = () => {
      const s = new SQLiteAttachmentInbox(filePath, {
        ...inboxOptions,
        agent_id: f.b.agent_id,
      });
      s.migrate();
      filesSet.add(s);
      return s;
    };
    const files = openFiles();
    const openBody = (selected = files) => {
      const s = new SQLiteInbox(
        bodyPath,
        {
          agent_id: f.b.agent_id,
          fingerprint_key: new Uint8Array(32).fill(101),
          limits,
          max_records: 10,
          max_body_bytes: 100000,
          max_ack_records: 20,
          ack_retry_ms: 86400000,
          retry_base_ms: 1,
          retry_cap_ms: 10,
          max_attempts: 5,
        },
        selected,
      );
      s.migrate();
      bodySet.add(s);
      return s;
    };
    const body = openBody(),
      raw = new DatabaseSync(bodyPath);
    t.after(() => {
      raw.close();
      for (const s of bodySet) s.close();
      for (const s of filesSet) s.close();
    });
    return {
      files,
      body,
      raw,
      openFiles,
      openBody,
      close(s) {
        s.close();
        filesSet.delete(s);
        bodySet.delete(s);
      },
      stage: (c, m, store = files) =>
        new AttachmentStager(store, c, limits).stageOnce(f.a.agent_id, m),
    };
  };
  const operator = Symbol("synthetic-maintenance"),
    worker = () =>
      new AttachmentDeletionWorker(f.relay, f.blob, deletionPolicy, {
        authorize(ctx, op) {
          return ctx === operator && op === "maintenance"
            ? { agent_id: "synthetic-operator" }
            : undefined;
        },
      });
  return {
    ...f,
    c,
    url,
    tools,
    client,
    completeNative: complete,
    local,
    stop,
    start,
    worker,
    operator,
  };
}
export function transform(name, change) {
  return async (url, init) => {
    const r = await globalThis.fetch(url, init);
    if (init.headers["Mcp-Name"] !== name || r.status !== 200) return r;
    const data = await decode(r),
      value = data.result.structuredContent;
    change(value, data);
    data.result.content = [{ type: "text", text: JSON.stringify(value) }];
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
export function loseOnce(name, condition = () => true) {
  let lost = false;
  const fetch = async (url, init) => {
    const r = await globalThis.fetch(url, init);
    if (
      !lost &&
      init.headers["Mcp-Name"] === name &&
      condition(JSON.parse(init.body).params.arguments)
    ) {
      lost = true;
      await r.arrayBuffer();
      throw Error("synthetic-response-loss");
    }
    return r;
  };
  return {
    fetch,
    get lost() {
      return lost;
    },
  };
}
