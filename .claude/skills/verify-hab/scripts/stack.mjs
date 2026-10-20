#!/usr/bin/env node
/**
 * VERIFICATION SCAFFOLDING ONLY. Composes the repo's own HAB Relay classes
 * (SQLiteHabRegistry, SQLiteRelayStore, runHabEnrollment, HabRelayService,
 * HabHttpGateway, createRelayNodeHandler) on a loopback port, the same way
 * test/hab-journey-fixtures.js does, and keeps it listening for an agent to
 * drive over real MCP HTTP. Synthetic authority and static bearer tokens;
 * never reads config/*.local.json, .env or any credential.
 *
 * Usage: node stack.mjs <run-dir> [port]
 *   First start enrolls three agents (a: grok-bot, b: dot, c: hermes).
 *   Re-running on the same <run-dir> reopens the same DBs (restart test).
 * Writes <run-dir>/instance/{state.json,*.sqlite,stack.pid} and appends
 * audit categories to <run-dir>/evidence/audit.jsonl. Prints
 * "HAB_VERIFY_READY <url>" once every agent is active and the port listens.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const src = (p) => join(repo, "src", p);
const { SQLiteHabRegistry } = await import(src("hab/sqlite-registry.ts"));
const { SQLiteEnrollmentJournal } = await import(
  src("hab/sqlite-enrollment-journal.ts")
);
const { runHabEnrollment } = await import(src("hab/enrollment.ts"));
const { HabRelayService } = await import(src("hab/relay.ts"));
const { HabHttpGateway } = await import(src("hab/http.ts"));
const { SQLiteRelayStore } = await import(src("relay/sqlite-store.ts"));
const { createRelayNodeHandler } = await import(src("relay/http-node.ts"));

const [runArg, portArg] = process.argv.slice(2);
if (!runArg) {
  process.stderr.write("usage: node stack.mjs <run-dir> [port]\n");
  process.exit(2);
}
const run = resolve(runArg),
  instance = join(run, "instance"),
  evidence = join(run, "evidence");
mkdirSync(instance, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true, mode: 0o700 });
chmodSync(instance, 0o700);
const statePath = join(instance, "state.json");
const reopening = existsSync(statePath);
const previous = reopening ? JSON.parse(readFileSync(statePath, "utf8")) : {};

// Same bounded limits the integration tests use (test/relay-http-fixtures.js).
const limits = {
  envelope_bytes: 32768,
  text_bytes: 16000,
  data_bytes: 16000,
  attachment_bytes: 1000,
  total_attachment_bytes: 1000,
  parts: 8,
  attachments: 3,
  json_depth: 20,
  json_nodes: 1000,
};
const names = { a: "grok-bot", b: "dot", c: "hermes" };
const admin = Symbol("verify-administrator"),
  contexts = {},
  tokens = new Map();
for (const name of Object.keys(names)) {
  contexts[name] = Symbol(`verify-${name}`);
  tokens.set(`Bearer verify-${name}`, contexts[name]);
}
const principal = (name) => ({
  issuer: "https://issuer.example/",
  audience: "https://relay.example/mcp",
  subject: "verify-owner",
  client_id: "verify-client",
  connection_id: `verify-${name}`,
});
const authority = {
  administrator: (ctx) =>
    ctx === admin ? { actor_id: "verify-administrator" } : undefined,
  individual: (ctx) => {
    const name = Object.keys(contexts).find((n) => contexts[n] === ctx);
    return name
      ? {
          principal: principal(name),
          expires_at: new Date(Date.now() + 30000).toISOString(),
        }
      : undefined;
  },
};

const registry = new SQLiteHabRegistry(
  join(instance, "registry.sqlite"),
  {
    fingerprint_key: new Uint8Array(32).fill(61),
    max_products: 10,
    max_agents: 20,
    max_bindings: 40,
    max_requests: 200,
    max_blocks: 20,
    max_audit_records: 200,
    max_context_ms: 60000,
    busy_timeout_ms: 100,
    allowed_kinds: ["question", "answer", "notice"],
  },
  authority,
);
registry.migrate();
const store = new SQLiteRelayStore(join(instance, "relay.sqlite"), {
  fingerprint_key: new Uint8Array(32).fill(43),
  max_pending: 20,
  max_records: 100,
  max_pending_per_recipient: 10,
  max_body_bytes: 100000,
  max_clock_skew_ms: 1000,
  lease_ms: 30000,
  max_attempts: 3,
  retry_base_ms: 10,
  retry_cap_ms: 100,
  poll_scan_limit: 20,
});
store.migrate();
const journal = new SQLiteEnrollmentJournal(
  join(instance, "enrollment.sqlite"),
  { max_sessions: 10, busy_timeout_ms: 100 },
);
journal.migrate();

const agents = {};
if (reopening) {
  Object.assign(agents, previous.agents);
} else {
  for (const [name, agent_name] of Object.entries(names)) {
    const product = registry.registerProduct(admin, {
      request_id: `verify-product-${agent_name}`,
      agent_name,
    });
    // The real enrollment workflow, with a scripted (non-terminal) UI.
    const result = await runHabEnrollment(
      {
        registry,
        journal,
        managementContext: () => admin,
        connection: async () => ({
          context: contexts[name],
          label: `Verify ${name}`,
        }),
        ui: {
          product: async () => product.product_id,
          botName: async () => `verify-${name}`,
          confirm: async () => true,
          operations: async () => [
            "submit",
            "status",
            "poll",
            "ack",
            "resolve",
          ],
        },
      },
      `verify-flow-${name}`,
    );
    if (result.status !== "complete")
      throw Error(`enrollment_incomplete_${name}_${result.stage}`);
    agents[name] = {
      agent_id: result.agent.agent_id,
      address: result.agent.address,
      state: result.agent.state,
      token: `verify-${name}`,
    };
  }
}

const server = createServer(
  { maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 },
  (req, res) => void handle(req, res),
);
server.maxConnections = 8;
server.listen(Number(portArg ?? previous.port ?? 0), "127.0.0.1");
await once(server, "listening");
const port = server.address().port,
  url = `http://127.0.0.1:${port}/mcp`;
const handle = createRelayNodeHandler(
  new HabHttpGateway(
    new HabRelayService(registry, store, limits),
    {
      resource_url: url,
      allowed_origins: [],
      max_request_bytes: 65536,
      max_response_bytes: 131072,
      timeout_ms: 2000,
      max_active_requests: 4,
      requests_per_window: 120,
      window_ms: 60000,
    },
    {
      record: (category, correlation) =>
        appendFileSync(
          join(evidence, "audit.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            category,
            correlation,
          }) + "\n",
        ),
    },
    ({ authorization }) => tokens.get(authorization) ?? null,
  ),
);

writeFileSync(
  statePath,
  JSON.stringify({ pid: process.pid, port, url, agents }, null, 2),
  { mode: 0o600 },
);
writeFileSync(join(instance, "stack.pid"), `${process.pid}\n`);
process.stdout.write(
  `${reopening ? "reopened" : "enrolled"} ${Object.values(agents)
    .map((a) => `${a.address}=${a.agent_id}`)
    .join(" ")}\nHAB_VERIFY_READY ${url}\n`,
);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => {
    for (const s of [journal, store, registry]) s.close();
    rmSync(join(instance, "stack.pid"), { force: true });
    process.stdout.write("HAB_VERIFY_STOPPED\n");
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
