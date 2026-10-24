import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PilotInspector } from "../src/pilot-inspector.ts";
import { HermesRuns, PILOT_OUTPUT } from "../src/hermes-runs.ts";
import { Adapter } from "../src/adapter.ts";
import { Journal } from "../src/journal.ts";
import { Hub, worker, owner, submit, RESPONSE } from "./fixtures.js";
import { policyFixture, pilotFixtures } from "./pilot-policy-fixture.js";
import { skipAsRoot } from "./non-root.js";
async function changeCode(policy, name, text) {
  await fs.chmod(policy.policy.sourceRoot, 0o700);
  const path = join(policy.policy.sourceRoot, name);
  await fs.chmod(path, 0o600).catch(() => {});
  await fs.writeFile(path, text, { mode: 0o400 });
  await fs.chmod(path, 0o400);
  await fs.chmod(policy.policy.sourceRoot, 0o500);
}
const opts = (fixture, policy, extra = {}) => ({
  endpoint: fixture.options.endpoint,
  scopeId: policy.inspector.scopeId,
  apiKey: "fixture-hermes",
  inspector: policy.inspector,
  now: policy.now,
  ...extra,
});
test("fixed pilot mock API roundtrip uses only fixed body, no toolsets route, exact result conversion", async (t) => {
  if (skipAsRoot(t)) return;
  const { fixture, policy } = await pilotFixtures();
  const h = new Hub();
  const receipt = new Journal(join(policy.root, "receipt.db"));
  try {
    const runs = await HermesRuns.connectPilot(opts(fixture, policy));
    assert.equal(runs.admissionContract, "hermes-hub-fixed-pilot-v1");
    const task = await submit(h);
    await new Adapter(
      h,
      { ...worker, runnerScope: runs.boundaryId },
      runs,
      receipt,
      { now: policy.now },
    ).run();
    assert.equal((await h.get(owner, task)).result, RESPONSE);
    assert.equal(fixture.state.calls, 1);
    assert.equal(receipt.load(), null);
    assert.equal(fixture.state.requests.includes("/v1/toolsets"), false);
  } finally {
    receipt.close();
    h.close();
    await fixture.close();
    await policy.cleanup();
  }
});
test("inspector never reads credential contents and returns short-lived bound evidence", async (t) => {
  if (skipAsRoot(t)) return;
  const policy = await policyFixture("http://127.0.0.1:10001/");
  const original = fs.readFile;
  let keyReads = 0;
  const replacement = mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith("/.env")) {
      keyReads++;
      throw new Error("credential_read_forbidden");
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const evidence = await policy.inspector.inspect();
    assert.equal(evidence.effectiveToolCount, 0);
    assert.equal(evidence.scopeId, policy.inspector.scopeId);
    assert.equal(evidence.expiresAt, policy.now() + 30000);
    assert.equal(keyReads, 0);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
    await policy.cleanup();
  }
});
for (const defect of [
  "stopped",
  "wildcard",
  "foreign-pid",
  "foreign-user",
  "wrong-command",
  "dirty-source",
  "wrong-commit",
  "changed-process",
])
  test(`independent inspector rejects ${defect}`, async (t) => {
    if (skipAsRoot(t)) return;
    const policy = await policyFixture("http://127.0.0.1:10001/");
    let probes = 0;
    try {
      const inspector = new PilotInspector(policy.policy, {
        now: policy.now,
        probe: async () => {
          probes++;
          const result = structuredClone(policy.observation);
          if (defect === "stopped") throw new Error("not running");
          if (defect === "wildcard") result.listeners = ["0.0.0.0:10001"];
          if (defect === "foreign-pid") result.pid++;
          if (defect === "foreign-user") result.uid++;
          if (defect === "wrong-command") result.command = "unrelated process";
          if (defect === "dirty-source")
            await changeCode(policy, "agent.py", "changed source");
          if (defect === "wrong-commit") result.sourceCommit = "wrong";
          if (defect === "changed-process" && probes > 1) result.startedAt++;
          return result;
        },
      });
      assert.equal(await inspector.inspect(), null);
    } finally {
      await policy.cleanup();
    }
  });
for (const file of ["config.yaml", ".env", "idempotency.db"])
  test(`inspector rejects changed ${file} without admission`, async (t) => {
    if (skipAsRoot(t)) return;
    const policy = await policyFixture("http://127.0.0.1:10001/");
    try {
      if (file === "idempotency.db") {
        await fs.writeFile(
          join(policy.policy.profileRoot, `${file}.replacement`),
          "replacement",
          { mode: 0o600 },
        );
        await fs.rename(
          join(policy.policy.profileRoot, `${file}.replacement`),
          join(policy.policy.profileRoot, file),
        );
      } else
        await fs.writeFile(join(policy.policy.profileRoot, file), "changed", {
          mode: 0o600,
        });
      assert.equal(await policy.inspector.inspect(), null);
    } finally {
      await policy.cleanup();
    }
  });
for (const defect of [
  "missing-policy",
  "tools",
  "input",
  "context",
  "sessions",
  "404",
])
  test(`pilot capability ${defect} never substitutes 404 as tools zero`, async (t) => {
    if (skipAsRoot(t)) return;
    const { fixture, policy } = await pilotFixtures();
    let admissions = 0;
    try {
      await assert.rejects(
        HermesRuns.connectPilot(
          opts(fixture, policy, {
            fetch: async (url, init) => {
              if (init.method === "POST") admissions++;
              const response = await globalThis.fetch(url, init);
              if (
                init.headers.Authorization &&
                url.pathname === "/v1/capabilities"
              ) {
                if (defect === "404")
                  return new Response(null, { status: 404 });
                const cap = await response.json();
                if (defect === "missing-policy") delete cap.pilot_policy;
                if (defect === "tools") cap.pilot_policy.effective_tools = 1;
                if (defect === "input") cap.pilot_policy.fixed_input = "other";
                if (defect === "context")
                  cap.pilot_policy.personal_context = true;
                if (defect === "sessions")
                  cap.pilot_policy.session_overrides = true;
                return Response.json(cap);
              }
              return response;
            },
          }),
        ),
        defect === "404" ? /hermes_http_404/ : /pilot_capabilities_unverified/,
      );
      assert.equal(admissions, 0);
    } finally {
      await fixture.close();
      await policy.cleanup();
    }
  });
test("pilot rejects nonexact output; terminal uncertainty preserves receipt and slot", async (t) => {
  if (skipAsRoot(t)) return;
  const { fixture, policy } = await pilotFixtures();
  const h = new Hub();
  const receipt = new Journal(join(policy.root, "receipt.db"));
  try {
    const runs = await HermesRuns.connectPilot(
      opts(fixture, policy, {
        fetch: async (url, init) => {
          const response = await globalThis.fetch(url, init);
          if (url.pathname.includes("/v1/runs/")) {
            const run = await response.json();
            return Response.json({ ...run, output: `${PILOT_OUTPUT}\n` });
          }
          return response;
        },
      }),
    );
    const task = await submit(h);
    await assert.rejects(
      new Adapter(
        h,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        receipt,
        { now: policy.now },
      ).run(),
      /terminal_requires_reconciliation/,
    );
    assert.ok(receipt.load().run_id);
    assert.equal((await h.get(owner, task)).execution_open, 1);
  } finally {
    receipt.close();
    h.close();
    await fixture.close();
    await policy.cleanup();
  }
});
test("old standard contract unknown receipt cannot be replayed through fixed pilot", async (t) => {
  if (skipAsRoot(t)) return;
  const { fixture, policy } = await pilotFixtures();
  const h = new Hub();
  const receipt = new Journal(join(policy.root, "receipt.db"));
  try {
    const runs = await HermesRuns.connectPilot(opts(fixture, policy));
    await submit(h);
    const task = await h.claim({ ...worker, runnerScope: runs.boundaryId });
    const admitted = policy.now();
    receipt.save({
      id: task.id,
      fence: task.fence,
      key: `hub-${task.id}`,
      run_id: null,
      runner_scope: runs.boundaryId,
      admitted_at: admitted,
      replay: {
        deadline: admitted + 86400000,
        retentionMs: 86400000,
        contract: "hermes-fixed-connectivity-v1",
      },
    });
    await assert.rejects(
      new Adapter(
        h,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        receipt,
        { now: policy.now },
      ).once(),
      /replay_contract_requires_reconciliation/,
    );
    assert.equal(fixture.state.calls, 0);
    assert.ok(receipt.load());
  } finally {
    receipt.close();
    h.close();
    await fixture.close();
    await policy.cleanup();
  }
});
test("inspector refuses source loaded while modified even when current hash/git status are restored", async (t) => {
  if (skipAsRoot(t)) return;
  const { setTimeout: wait } = await import("node:timers/promises");
  const { measureCodeTree } = await import("../src/pilot-inspector.ts");
  const policy = await policyFixture("http://127.0.0.1:10001/");
  try {
    await changeCode(policy, "agent.py", "modified at launch");
    policy.observation.startedAt = Date.now() + 10;
    await wait(25);
    await changeCode(policy, "agent.py", "fixture reviewed agent");
    assert.equal(
      await measureCodeTree(policy.policy.sourceRoot),
      policy.policy.codeTrees[0].sha256,
    );
    assert.equal(await policy.inspector.inspect(), null);
  } finally {
    await policy.cleanup();
  }
});
for (const name of ["ignored.py", "ignored.pyc", "startup.pth"])
  test(`unlisted importable ${name} cannot escape inspector`, async (t) => {
    if (skipAsRoot(t)) return;
    const policy = await policyFixture("http://127.0.0.1:10001/");
    try {
      await changeCode(policy, name, "unreviewed code");
      assert.equal(await policy.inspector.inspect(), null);
    } finally {
      await policy.cleanup();
    }
  });
test("known pilot admission reconciles by ID after journal reopen; lost ACK reuses one fixed admission", async (t) => {
  if (skipAsRoot(t)) return;
  const { fixture, policy } = await pilotFixtures();
  const h = new Hub();
  let receipt = new Journal(join(policy.root, "receipt.db"));
  let lost = false;
  try {
    const task = await submit(h);
    const runs = await HermesRuns.connectPilot(
      opts(fixture, policy, {
        fetch: async (url, init) => {
          const response = await globalThis.fetch(url, init);
          if (init.method === "POST" && !lost) {
            lost = true;
            await response.body.cancel();
            throw new Error("fixture_ack_lost");
          }
          return response;
        },
      }),
    );
    await assert.rejects(
      new Adapter(
        h,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        receipt,
        { now: policy.now },
      ).once(),
      /fixture_ack_lost/,
    );
    const original = receipt.load();
    assert.equal(original.replay.contract, "hermes-hub-fixed-pilot-v1");
    receipt.close();
    receipt = new Journal(join(policy.root, "receipt.db"));
    const recovered = await HermesRuns.connectPilot(opts(fixture, policy));
    await new Adapter(
      h,
      { ...worker, runnerScope: recovered.boundaryId },
      recovered,
      receipt,
      {
        now: policy.now,
      },
    ).once();
    assert.equal(receipt.load().run_id, "run_fixture1");
    receipt.close();
    receipt = new Journal(join(policy.root, "receipt.db"));
    await new Adapter(
      h,
      { ...worker, runnerScope: recovered.boundaryId },
      recovered,
      receipt,
      { now: policy.now },
    ).run();
    assert.equal((await h.get(owner, task)).result, RESPONSE);
    assert.equal(fixture.state.calls, 1);
    assert.equal(receipt.load(), null);
  } finally {
    receipt.close();
    h.close();
    await fixture.close();
    await policy.cleanup();
  }
});
for (const name of ["dependency.egg", "dependency.whl", "dependency.custom"])
  test(`all-file code manifest covers nonstandard archive ${name}`, async (t) => {
    if (skipAsRoot(t)) return;
    const { measureCodeTree } = await import("../src/pilot-inspector.ts");
    const policy = await policyFixture("http://127.0.0.1:10001/");
    try {
      await changeCode(policy, name, "unreviewed archive");
      assert.notEqual(
        await measureCodeTree(policy.policy.sourceRoot),
        policy.policy.codeTrees[0].sha256,
      );
      assert.equal(await policy.inspector.inspect(), null);
    } finally {
      await policy.cleanup();
    }
  });
