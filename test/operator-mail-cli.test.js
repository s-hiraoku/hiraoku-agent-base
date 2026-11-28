import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { operatorFixture } from "./host-operator-fixtures.js";

const execute = promisify(execFile);

test("ping reports a generated ID that the legacy CLI can reuse", async (t) => {
  const f = await operatorFixture(t);
  const run = (extension, ...args) =>
    execute(
      process.execPath,
      [
        "scripts/hab-admin." + extension,
        "--config",
        f.configPath,
        "ping",
        ...args,
      ],
      { timeout: 8_000 },
    );

  await assert.rejects(run("ts", "--address", f.recipient, "--wait", "61"), {
    code: 2,
  });
  const { stdout, stderr } = await run("ts", "--address", f.recipient);
  const operationId = stderr.match(
    /^ping_request_id (rm1\.\d+\.[a-f0-9]{32})\n$/,
  )?.[1];
  assert.ok(operationId);
  const sent = JSON.parse(stdout);
  assert.equal(sent.operation_id, operationId);
  assert.equal(sent.state, "pending");

  const replay = await run(
    "mjs",
    "--address",
    f.recipient,
    "--request-id",
    operationId,
  );
  assert.equal(replay.stderr, "");
  assert.deepEqual(JSON.parse(replay.stdout), sent);
  const { messages } = await f.call("recipient", "hab_inbox");
  assert.deepEqual(
    messages.map((message) => message.message_id),
    [sent.message_id],
  );
});
