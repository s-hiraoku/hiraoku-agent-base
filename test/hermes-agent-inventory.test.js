import process from "node:process";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { InventoryInspector } from "../src/inventory-inspector.ts";
import { HermesAgentInventoryRuns } from "../src/hermes-agent-inventory-runs.ts";
import { Adapter } from "../src/adapter.ts";
import { Hub, journal } from "./fixtures.js";
import { inventoryOwner, inventoryWorker } from "./inventory-suite.js";
import { inventoryPolicyFixture } from "./inventory-policy-fixture.js";
import { INVENTORY_REQUEST } from "../src/task-contract.ts";
import { skipAsRoot } from "./non-root.js";
const endpoint = "http://127.0.0.1:8645/";
const policy = {
  contract: "hermes-agent-inventory-v1",
  fixed_input: INVENTORY_REQUEST,
  effective_tool_names: ["hub_shift_log_inventory"],
  collector: "fixed-lstat-v1",
  session_overrides: false,
  personal_context: false,
  max_iterations: 3,
  max_tokens: 256,
  run_budget_seconds: 60,
  max_concurrent_runs: 1,
};
function proof(body, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "hermes_bridge.mock_api_proof"], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (bytes) => (output += bytes));
    child.stderr.on("data", (bytes) => (errors += bytes));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(Error(errors)),
    );
    child.stdin.end(JSON.stringify({ body, mode }));
  });
}
function apiStub(mode = "tool") {
  const state = {
    admissions: 0,
    proofs: 0,
    byKey: new Map(),
    rows: new Map(),
    cap: structuredClone(policy),
    lostAck: false,
  };
  const fetch = async (url, init) => {
    if (init.headers.Authorization !== "Bearer mock-only")
      return new Response("", { status: 401 });
    const path = new URL(url).pathname;
    if (path === "/v1/capabilities")
      return Response.json({
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        auth: { type: "bearer", required: true },
        inventory_policy: state.cap,
        features: {
          run_submission: true,
          run_status: true,
          runs_idempotency: {
            supported: true,
            durable: true,
            retention_seconds: 86400,
          },
        },
      });
    if (path === "/v1/runs" && init.method === "POST") {
      const key = init.headers["Idempotency-Key"];
      assert.deepEqual(JSON.parse(init.body), { input: INVENTORY_REQUEST });
      if (!state.byKey.has(key)) {
        const result = await proof(JSON.parse(init.body), mode);
        state.proofs++;
        const id = `run_integrated_${++state.admissions}`;
        state.byKey.set(key, id);
        state.rows.set(id, { object: "hermes.run", run_id: id, ...result });
      }
      if (state.lostAck) {
        state.lostAck = false;
        throw Error("mock_lost_ack");
      }
      return Response.json(
        { run_id: state.byKey.get(key), status: "started" },
        { status: 202 },
      );
    }
    if (path.startsWith("/v1/runs/"))
      return Response.json(state.rows.get(path.split("/").at(-1)));
    return new Response("", { status: 404 });
  };
  return { state, fetch };
}
const connect = (p, api) =>
  HermesAgentInventoryRuns.connect({
    endpoint,
    scopeId: p.inspector.scopeId,
    apiKey: "mock-only",
    inspector: p.inspector,
    now: p.now,
    fetch: api.fetch,
  });
test("Hub → inspector-bound inventory Runs → no-socket API stub → Python one-tool Agent mock → evidence → Hub get", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint),
    api = apiStub(),
    hub = new Hub();
  try {
    const runs = await connect(p, api);
    const task = await hub.submit(inventoryOwner, {
      task_type: "shift_log_inventory",
      request_key: "integrated",
    });
    await new Adapter(
      hub,
      { ...inventoryWorker, runnerScope: runs.boundaryId },
      runs,
      journal(),
      { now: p.now },
    ).run();
    const result = await hub.get(inventoryOwner, task);
    assert.equal(result.state, "succeeded");
    assert.equal(JSON.parse(result.result).status, "unknown");
    assert.equal(api.state.proofs, 1);
    assert.equal(api.state.admissions, 1);
    assert.equal([...api.state.rows.values()][0].metadata_probes, 14);
  } finally {
    hub.close();
    await p.cleanup();
  }
});
test("lost admission ACK/reconnect retains original contract and does not invoke Agent twice", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint),
    api = apiStub(),
    hub = new Hub(),
    receipt = journal();
  try {
    const runs = await connect(p, api);
    const worker = { ...inventoryWorker, runnerScope: runs.boundaryId };
    const task = await hub.submit(inventoryOwner, {
      task_type: "shift_log_inventory",
      request_key: "lost",
    });
    api.state.lostAck = true;
    await assert.rejects(
      new Adapter(hub, worker, runs, receipt, { now: p.now }).run(),
      /mock_lost_ack/,
    );
    const replay = structuredClone(receipt.load().replay);
    const reopened = await connect(p, api);
    await new Adapter(hub, worker, reopened, receipt, { now: p.now }).run();
    assert.equal((await hub.get(inventoryOwner, task)).state, "succeeded");
    assert.equal(api.state.proofs, 1);
    assert.equal(api.state.admissions, 1);
    assert.equal(replay.contract, "hermes-agent-inventory-v1");
  } finally {
    hub.close();
    await p.cleanup();
  }
});
test("Agent missing tool evidence never completes Hub and keeps receipt for reconciliation", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint),
    api = apiStub("skip"),
    hub = new Hub(),
    receipt = journal();
  try {
    const runs = await connect(p, api);
    const task = await hub.submit(inventoryOwner, {
      task_type: "shift_log_inventory",
      request_key: "skip",
    });
    await assert.rejects(
      new Adapter(
        hub,
        { ...inventoryWorker, runnerScope: runs.boundaryId },
        runs,
        receipt,
        { now: p.now },
      ).run(),
      /terminal_requires_reconciliation/,
    );
    assert.equal((await hub.get(inventoryOwner, task)).state, "running");
    assert.ok(receipt.load().run_id);
  } finally {
    hub.close();
    await p.cleanup();
  }
});
test("inspector rejects startup manifest/model/tool/budget drift; never reads any credentials", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint);
  const original = fs.readFile;
  const replacement = mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith(".env"))
      throw Error("credentials_read_forbidden");
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await p.inspector.inspect()).effectiveToolCount, 1);
    await fs.writeFile(
      p.policy.manifestPath,
      JSON.stringify({ ...p.manifest, maxTokens: 257 }),
    );
    assert.equal(await p.inspector.inspect(), null);
    const replacementPolicy = { ...p.policy, manifestSHA256: "f".repeat(64) };
    assert.equal(
      await new InventoryInspector(replacementPolicy, p.options).inspect(),
      null,
    );
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
    await p.cleanup();
  }
});
test("wrong capabilities and changed pinned credential scope block admission", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint),
    api = apiStub();
  try {
    api.state.cap.max_iterations = 4;
    await assert.rejects(connect(p, api), /capabilities_unverified/);
    api.state.cap = structuredClone(policy);
    const runs = await connect(p, api);
    await fs.writeFile(
      join(p.policy.profileRoot, "credential.scope"),
      "b".repeat(64),
    );
    await assert.rejects(runs.get("run_fixture"), /isolation_unverified/);
    assert.equal(api.state.admissions, 0);
  } finally {
    await p.cleanup();
  }
});
test("reviewed wrong manifest still fails semantic policy; marker symlinks/oversize are refused before open", async (t) => {
  if (skipAsRoot(t)) return;
  const p = await inventoryPolicyFixture(endpoint);
  const { createHash } = await import("node:crypto");
  try {
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(p.manifest).reverse()),
    );
    await fs.writeFile(p.policy.manifestPath, reordered);
    const orderedInspector = new InventoryInspector(
      {
        ...p.policy,
        manifestSHA256: createHash("sha256").update(reordered).digest("hex"),
      },
      p.options,
    );
    assert.equal((await orderedInspector.inspect()).effectiveToolCount, 1);
    for (const defect of [
      { model: "other" },
      { tools: ["terminal"] },
      { maxTokens: 257 },
      { concurrency: 2 },
    ]) {
      const bytes = JSON.stringify({ ...p.manifest, ...defect });
      await fs.writeFile(p.policy.manifestPath, bytes);
      const inspector = new InventoryInspector(
        {
          ...p.policy,
          manifestSHA256: createHash("sha256").update(bytes).digest("hex"),
        },
        p.options,
      );
      assert.equal(await inspector.inspect(), null);
    }
    await fs.writeFile(p.policy.manifestPath, JSON.stringify(p.manifest));
    const scope = join(p.policy.profileRoot, "credential.scope");
    await fs.unlink(scope);
    await fs.symlink(p.policy.wrapperPath, scope);
    let scopeOpens = 0;
    const original = fs.open;
    const replacement = mock.method(fs, "open", async (path, ...args) => {
      if (String(path) === scope) scopeOpens++;
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await p.inspector.inspect(), null);
      assert.equal(scopeOpens, 0);
      await fs.unlink(scope);
      await fs.writeFile(scope, "a".repeat(1000), { mode: 0o600 });
      assert.equal(await p.inspector.inspect(), null);
      assert.equal(scopeOpens, 0);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await p.cleanup();
  }
});
