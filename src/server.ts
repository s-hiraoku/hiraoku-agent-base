import { AsyncAudit } from "./async-audit.ts";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { Hub } from "./sqlite.ts";
import { createRuntime } from "./runtime.ts";
import { readRuntimeConfig } from "./runtime-config.ts";
function main() {
  // Read explicitly selected config before binding. Missing config remains deny-all;
  // an explicitly supplied invalid config terminates instead of silently downgrading.
  const config = process.env.HAB_RUNTIME_CONFIG
    ? readRuntimeConfig(process.env.HAB_RUNTIME_CONFIG)
    : undefined;
  mkdirSync("runtime", { recursive: true, mode: 0o700 });
  const audit = new AsyncAudit("runtime/audit");
  const hub = new Hub("runtime/hub.db"),
    runtime = createRuntime(hub, config, {
      audit,
    });
  const server = createServer(
    { requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384 },
    (req, res) => {
      void runtime.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    },
  ).listen(8787, "127.0.0.1");

  server.maxConnections = 32;
  server.maxRequestsPerSocket = 60;
  server.keepAliveTimeout = 5000;

  server.on("close", () => {
    void audit.close();
  });
  server.on("error", () => {
    void audit.close();
    process.stderr.write("startup_rejected\n");
    process.exitCode = 1;
  });
}
try {
  main();
} catch {
  process.stderr.write("startup_rejected\n");
  process.exitCode = 1;
}
