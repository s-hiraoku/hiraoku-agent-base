/** Owner factory used exclusively by the synthetic process-boundary regressions. */
import process from "node:process";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { syntheticStores, syntheticToken } from "./external-owner-fixture.js";

export async function createOwnerOptions(signal) {
  const config = JSON.parse(readFileSync("synthetic-config.json", "utf8"));
  assert.equal(process.env.HAB_SYNTHETIC_SECRET_CANARY, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.HTTPS_PROXY, undefined);
  writeFileSync("factory-started.json", JSON.stringify({ pid: process.pid, cleanEnvironment: true }), { mode: 0o600 });
  if (config.mode === "hang-before") { for (;;) { /* Deliberately blocks only this owned synthetic child. */ } }
  const stores = syntheticStores(process.cwd());
  let client;
  return {
    bearerToken: syntheticToken, serverName: "synthetic-dedicated-owner", lifetimeMs: 10000, shutdownTimeoutMs: 200,
    driver: {
      ownerSignal: signal,
      async create(launch) {
        writeFileSync("listener.json", JSON.stringify({ url: launch.mcp.url }), { mode: 0o600 });
        client = new Client({ name: "synthetic-owned-child", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(launch.mcp.url), { requestInit: { headers: launch.mcp.headers } }));
        if (config.mode === "secret-failure") {
          process.stdout.write(syntheticToken); process.stderr.write(syntheticToken);
          throw Error(syntheticToken);
        }
        return Object.freeze({ syntheticCommit: true });
      },
      async verifyCommitted() {
        if (config.mode === "hang-after") setTimeout(() => { for (;;) { /* Synthetic watchdog fault. */ } }, 50);
        return stores.binding;
      },
      async close() { await client?.close(); },
    },
    closeStores() { stores.close(); writeFileSync("stores-closed.json", "true", { mode: 0o600 }); },
  };
}
