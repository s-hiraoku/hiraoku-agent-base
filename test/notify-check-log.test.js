import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifyCheckLog } from "../scripts/lib/notify-check-log.ts";
test("notifier timestamps failure/recovery and publication without logging each idle check", () => {
  const lines = [];
  let now = 1000;
  const log = createNotifyCheckLog(
    (line) => lines.push(JSON.parse(line)),
    () => now,
  );
  log.failed("token_expired");
  now = 16000;
  log.failed("token_expired");
  assert.equal(lines.length, 1);
  now = 77000;
  log.succeeded(["synthetic-id"], 42);
  assert.deepEqual(lines[1], {
    at: new Date(now).toISOString(),
    resumed: "token_expired",
    blocked_ms: 76000,
    duration_ms: 42,
  });
  assert.deepEqual(lines[2], {
    at: new Date(now).toISOString(),
    shown: ["synthetic-id"],
    duration_ms: 42,
  });
  log.succeeded([], 1);
  assert.equal(lines.length, 3);
  log.failed("token_expired");
  assert.equal(lines.length, 4);
});

test("the session probe's answer is logged at the first reading and on each change", () => {
  const lines = [];
  const log = createNotifyCheckLog(
    (line) => lines.push(JSON.parse(line)),
    () => 5000,
  );
  for (const presence of ["present", "present", "gone", "gone", "unknown"])
    log.session(presence);
  assert.deepEqual(
    lines.map((line) => line.session),
    ["present", "gone", "unknown"],
  );
  assert.equal(lines[0].at, new Date(5000).toISOString());
});
