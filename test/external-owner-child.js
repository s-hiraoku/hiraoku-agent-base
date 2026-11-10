/** Owner factory used exclusively by the synthetic process-boundary regressions. */
import process from "node:process";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
  if (config.mode === "local-controls-malformed") {
    process.send?.({ type: "ready", url: "http://127.0.0.1:1/mcp" });
    process.send?.({ type: "ready", url: "http://127.0.0.1:1/mcp", phase: "active" });
  }
  const stores = syntheticStores(process.cwd());
  let client, settleStartup;
  const pending = () => {
    writeFileSync("startup-pending.json", "true", { mode: 0o600 });
    return new Promise(resolve => { settleStartup = resolve; });
  };
  const trace = event => appendFileSync("cleanup.jsonl", JSON.stringify(event) + "\n", { mode: 0o600 });
  const late = config.mode.startsWith("late-");
  const nativeOwner = new AbortController();
  if (late) {
    writeFileSync("factory-pending.json", "true", { mode: 0o600 });
    if (config.mode === "late-owner-loss") nativeOwner.abort();
    else {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (config.mode === "late-reject") {
      // A rejected factory still owns its allocation; entry never receives it.
      stores.close(); trace("factory-rejected-cleanup"); throw Error(syntheticToken);
    }
  }
  return {
    bearerToken: syntheticToken, serverName: "synthetic-dedicated-owner", lifetimeMs: 10000, shutdownTimeoutMs: 200,
    driver: {
      ownerSignal: late ? nativeOwner.signal : signal,
      async create(launch) {
        writeFileSync("listener.json", JSON.stringify({ url: launch.mcp.url }), { mode: 0o600 });
        client = new Client({ name: "synthetic-owned-child", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(launch.mcp.url), { requestInit: { headers: launch.mcp.headers } }));
        if (config.mode === "secret-failure") {
          process.stdout.write(syntheticToken); process.stderr.write(syntheticToken);
          throw Error(syntheticToken);
        }
        if (config.mode === "pending-create") await pending();
        return Object.freeze({ syntheticCommit: true });
      },
      async verifyCommitted() {
        if (config.mode === "pending-verify") await pending();
        if (config.mode === "hang-after") setTimeout(() => { for (;;) { /* Synthetic watchdog fault. */ } }, 50);
        return stores.binding;
      },
      async close() {
        if (late) trace("driver-close-start");
        if (config.mode === "late-driver-failure") throw Error(syntheticToken);
        if (config.mode === "late-driver-timeout") await new Promise(() => {});
        settleStartup?.(); await client?.close();
        if (late) trace("driver-close-end");
      },
    },
    onBound: config.mode.startsWith("local-controls") ? controls => {
      const paused = controls.updatePermission(controls.status().epoch, true);
      controls.resume(paused.epoch);
      writeFileSync("local-controls.json", JSON.stringify({ paused: controls.status().paused }), { mode: 0o600 });
    } : undefined,
    async closeStores() {
      if (late) trace("stores-close-start");
      if (config.mode === "late-store-failure") throw Error(syntheticToken);
      if (config.mode === "late-store-timeout") await new Promise(() => {});
      stores.close(); writeFileSync("stores-closed.json", "true", { mode: 0o600 }); },
  };
}
