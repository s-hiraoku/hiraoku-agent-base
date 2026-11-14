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
