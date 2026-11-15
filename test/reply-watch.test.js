import assert from "node:assert/strict";
import { test } from "node:test";
import { replyWatchPlan } from "../src/hab/reply-watch.ts";
const start = Date.parse("2026-01-01T00:00:00Z");
const iso = (offset) => new Date(start + offset).toISOString();
const plan = (age, state = "waiting", deadline = 7 * 86400000) =>
  replyWatchPlan(iso(0), iso(deadline), state, start + age);
test("reply watch is fast initially, backs off, and ends without inbox effects", () => {
  for (const [age, delay] of [
    [0, 15000],
    [119999, 15000],
    [120000, 60000],
    [599999, 60000],
    [600000, 300000],
  ]) {
    const result = plan(age);
    assert.equal(result.action, "check_status");
    assert.equal(result.next_check_at, iso(age + delay));
    assert.equal(result.stop_at, iso(1800000));
  }
  for (const age of [1500000, 1800000, 604800001])
    assert.equal(plan(age).action, "stop");
  assert.equal(plan(0, "waiting", 15000).action, "stop");
  for (const state of ["no_reply", "not_expected"])
    assert.equal(plan(0, state).action, "stop");
  assert.equal(plan(1800001, "replied").action, "read_reply");
  assert.equal(plan(-1000).next_check_at, iso(14000));
  assert.throws(
    () => replyWatchPlan("bad", iso(0), "waiting", start),
    /invalid_reply_watch_time/,
  );
});
