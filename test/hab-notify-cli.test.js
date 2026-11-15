import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HabNotifierClient } from "../src/agent-notify/index.ts";
import { main, tokenProblem } from "../scripts/hab-notify.ts";

test("hab-notify prints usage, lists no notices and refuses a decision it never showed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
    }),
  );
  const lines = [];
  const out = (line) => lines.push(line);
  assert.equal(await main([], out), 2);
  assert.match(lines.at(-1), /^usage:/);
  assert.equal(await main(["--config", config, "list"], out), 0);
  assert.equal(lines.at(-1), "[]");
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "maybe"], out),
    2,
  );
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "accept"], out),
    1,
  );
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "invalid_request" });
  // No token configured: the check fails without printing anything secret.
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_unavailable" });
  assert.equal(lines.at(-1).includes("Bearer"), false);
});

test("hab-notify names an expired or missing file token instead of a transport failure", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "hab.json");
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      // Nothing listens here: a call that went out would end as transport_failed.
      hab_url: "http://127.0.0.1:9/mcp",
      agent_id: "agent-b",
      token: {
        file: tokenFile,
        field: "access_token",
        expires_at_field: "expires_at",
      },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
    }),
  );
  const lines = [];
  const out = (line) => lines.push(line);
  const now = Date.now() / 1000;
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: "synthetic-expired", expires_at: now - 1 }),
  );
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_expired" });
  // A choice for a notice never shown is still refused for that reason, before any call.
  assert.equal(
    await main(["--config", config, "decide", "rm1.x", "accept"], out),
    1,
  );
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "invalid_request" });
  assert.equal(lines.join("\n").includes("synthetic-expired"), false);
  writeFileSync(tokenFile, JSON.stringify({ expires_at: now + 600 }));
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "token_unavailable" });
  // A current token is sent, so an unreachable host is still a transport failure.
  writeFileSync(
    tokenFile,
    JSON.stringify({
      access_token: "synthetic-current",
      expires_at: now + 600,
    }),
  );
  assert.equal(await main(["--config", config, "check"], out), 1);
  assert.deepEqual(JSON.parse(lines.at(-1)), { error: "transport_failed" });
});

const jwt = (payload) =>
  [
    "e30",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

test("an expired or missing token is named, and HAB is not called", async (t) => {
  const config = {
    token: { env: "HAB_NOTIFY_TEST_TOKEN_EXP" },
  };
  t.after(() => delete process.env.HAB_NOTIFY_TEST_TOKEN_EXP);
  const now = Date.parse("2026-11-14T13:00:00Z");
  assert.equal(tokenProblem(config, now), "token_unavailable");
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 - 1 });
  assert.equal(tokenProblem(config, now), "token_expired");
  // Expiring within the 5 s margin counts as expired.
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 + 3 });
  assert.equal(tokenProblem(config, now), "token_expired");
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ exp: now / 1000 + 600 });
  assert.equal(tokenProblem(config, now), undefined);
  // An opaque token, or a JWT without exp, is left to HAB to judge.
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = "opaque-token";
  assert.equal(tokenProblem(config, now), undefined);
  process.env.HAB_NOTIFY_TEST_TOKEN_EXP = jwt({ sub: "agent-b" });
  assert.equal(tokenProblem(config, now), undefined);

  let fetched = 0;
  const hab = new HabNotifierClient(
    {
      policy: {
        resource_url: "https://hab.example/mcp/delivery",
        agent_id: "agent-b",
        max_request_bytes: 65536,
        max_response_bytes: 65536,
        timeout_ms: 1000,
        max_active_requests: 1,
        max_sse_events: 4,
        max_sse_lines: 64,
        max_json_depth: 16,
        max_json_nodes: 1000,
      },
      limits: {
        envelope_bytes: 65536,
        text_bytes: 32768,
        data_bytes: 32768,
        parts: 4,
        json_depth: 16,
        json_nodes: 1000,
      },
      authorization: () => "Bearer x",
      fetch: async () => {
        fetched++;
        return new Response(null, { status: 401 });
      },
    },
    () => "token_expired",
  );
  await assert.rejects(hab.peek(10), { code: "token_expired" });
  await assert.rejects(hab.markRead("rm1.x", "agent-a"), {
    code: "token_expired",
  });
  assert.equal(fetched, 0);
});

test("run logs a repeating error once, not on every check", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-run-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAB_NOTIFY_TEST_TOKEN_RUN;
  });
  process.env.HAB_NOTIFY_TEST_TOKEN_RUN = jwt({ exp: 1 });
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_TEST_TOKEN_RUN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "synthetic:desktop-1",
      },
      interval_ms: 1000,
    }),
  );
  const lines = [];
  const running = main(["--config", config, "run"], (line) => lines.push(line));
  await new Promise((done) => setTimeout(done, 2500));
  process.emit("SIGTERM");
  assert.equal(await running, 0);
  assert.deepEqual(lines, [JSON.stringify({ error: "token_expired" })]);
});
