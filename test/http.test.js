import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub, RESPONSE } from "./fixtures.js";
import { handler } from "../src/mcp.ts";
import { Adapter } from "../src/adapter.ts";
import { HermesRuns } from "../src/hermes-runs.ts";
import { pilotFixtures } from "./pilot-policy-fixture.js";
import { hermesFixture } from "./hermes-fixture.js";
import { MCPHubClient } from "../src/client.ts";
import { skipAsRoot } from "./non-root.js";
for (const pilot of [false, true])
  test(`official MCP client HTTP fixed roundtrip: ${pilot ? "constrained pilot" : "standard"}`, async (t) => {
    if (pilot && skipAsRoot(t)) return;
    const hub = new Hub();
    const { fixture: hermes, policy } = pilot
      ? await pilotFixtures()
      : { fixture: await hermesFixture(false), policy: null };
    const owner = {
      subject: "dummy-owner",
      operations: ["submit", "get", "cancel"],
      destination: "hermes",
    };
    const worker = {
      subject: "dummy-worker",
      worker: "hermes",
      operations: ["get", "claim", "heartbeat", "complete"],
    };
    // Fixture-only verifier; the runnable server does not contain this dummy credential mapping.
    const handle = handler(hub, async (req) =>
      req.headers.authorization === "Bearer fixture-requester"
        ? owner
        : req.headers.authorization === "Bearer fixture-worker"
          ? worker
          : null,
    );
    const server = createServer((req, res) =>
      handle(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      }),
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    const a = new Client({ name: "fixture", version: "1" }),
      b = new Client({ name: "fixture-worker", version: "1" });
    const call = async (client, name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError);
      return JSON.parse(r.content[0].text);
    };
    try {
      await a.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: { Authorization: "Bearer fixture-requester" },
          },
        }),
      );
      await b.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: "Bearer fixture-worker" } },
        }),
      );
      assert.equal((await a.listTools()).tools.length, 6);
      const t = await call(a, "submit", {
        task_type: "connectivity_check",
        request_key: "http-1",
      });
      assert.equal(
        (await a.callTool({ name: "claim", arguments: {} })).isError,
        true,
      );
      const claimed = await call(b, "claim", {});
      await call(b, "heartbeat", {
        id: t.id,
        fence: claimed.fence,
        run_id: `run_${"a".repeat(120)}`,
      });
      await call(b, "complete", {
        id: t.id,
        fence: claimed.fence,
        state: "succeeded",
        result: RESPONSE,
      });
      assert.equal((await call(a, "get", { id: t.id })).state, "succeeded");
      const adapterTask = await call(a, "submit", {
        task_type: "connectivity_check",
        request_key: "http-adapter",
      });
      const journal = {
        entry: null,
        load() {
          return this.entry;
        },
        save(entry) {
          this.entry = structuredClone(entry);
        },
        clear() {
          this.entry = null;
        },
      };
      const runs = policy
        ? await HermesRuns.connectPilot({
            endpoint: hermes.options.endpoint,
            apiKey: hermes.options.apiKey,
            scopeId: policy.inspector.scopeId,
            inspector: policy.inspector,
            now: policy.now,
          })
        : await HermesRuns.connect(hermes.options);
      const remote = new MCPHubClient(b);
      worker.runnerScope = runs.boundaryId;
      const heartbeats = [];
      const heartbeat = remote.heartbeat.bind(remote);
      remote.heartbeat = async (principal, args) => {
        heartbeats.push(structuredClone(args));
        return heartbeat(principal, args);
      };
      await new Adapter(
        remote,
        { ...worker, runnerScope: runs.boundaryId },
        runs,
        journal,
      ).run();
      assert.equal(
        (await call(a, "get", { id: adapterTask.id })).state,
        "succeeded",
      );
      assert.equal(journal.load(), null);
      assert.equal(hermes.state.calls, 1);
      assert.deepEqual(heartbeats.slice(0, 2), [
        { id: adapterTask.id, fence: 1 },
        { id: adapterTask.id, fence: 1, run_id: "run_fixture1" },
      ]);

      assert.equal(
        (
          await a.callTool({
            name: "submit",
            arguments: {
              task_type: "connectivity_check",
              request_key: "http-2",
              agent: "hermes",
            },
          })
        ).isError,
        true,
      );
    } finally {
      await a.close();
      await b.close();
      await new Promise((r) => server.close(r));
      await hermes.close();
      await policy?.cleanup();
      hub.close();
    }
  });
