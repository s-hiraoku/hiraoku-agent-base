import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../scripts/hab-notify.ts";

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
