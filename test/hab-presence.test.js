import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_READ_RECENT_MS,
  POLL_OVERDUE_FACTOR,
  derivePresence,
} from "../src/hab/presence.ts";

// ADR-034: hab_discover presence comes only from what HAB observed itself.
const NOW = Date.parse("2026-11-26T06:00:00.000Z");
const facts = (patch = {}) => ({
  live: 0,
  lapsed_at: null,
  rang_at: null,
  status: null,
  delivered_at: null,
  inbox_read_at: null,
  absent_since: null,
  ...patch,
});
const receive = (
  mode,
  interval_ms = null,
  updated_at = "2026-11-01T00:00:00.000Z",
) => ({
  mode,
  interval_ms,
  updated_at,
});
const at = (ms) => new Date(ms).toISOString();
const pick = (p) => [p.state, p.reason, p.observed_at];

test("nothing observed stays unknown", () => {
  assert.deepEqual(pick(derivePresence(undefined, null, NOW)), [
    "unknown",
    "not_observed",
    null,
  ]);
  assert.deepEqual(pick(derivePresence(facts(), null, NOW)), [
    "unknown",
    "not_observed",
    null,
  ]);
});

test("a session the product reported gone wins over everything else", () => {
  const p = derivePresence(
    facts({ absent_since: NOW - 5, live: 1, inbox_read_at: NOW - 1 }),
    receive("hook"),
    NOW,
  );
  assert.deepEqual(pick(p), ["unavailable", "session_gone", at(NOW - 5)]);
});

test("a live doorbell is available unless its latest ring was not taken", () => {
  assert.deepEqual(
    pick(
      derivePresence(
        facts({
          live: 1,
          rang_at: NOW - 10,
          status: 200,
          delivered_at: NOW - 10,
        }),
        receive("hook"),
        NOW,
      ),
    ),
    ["available", "doorbell_live", at(NOW - 10)],
  );
  // Never rung yet: still reachable, nothing observed to date it.
  assert.deepEqual(pick(derivePresence(facts({ live: 1 }), null, NOW)), [
    "available",
    "doorbell_live",
    null,
  ]);
  for (const status of [0, 401, 503])
    assert.deepEqual(
      pick(
        derivePresence(
          facts({ live: 1, rang_at: NOW - 3, status, delivered_at: NOW - 99 }),
          null,
          NOW,
        ),
      ),
      ["unavailable", "doorbell_failing", at(NOW - 3)],
      String(status),
    );
});

test("a failed ring for a doorbell since replaced does not count", () => {
  const p = derivePresence(
    facts({ live: 1, rang_at: NOW - 50, status: 503, live_since: NOW - 10 }),
    null,
    NOW,
  );
  assert.deepEqual(pick(p), ["available", "doorbell_live", null]);
});

test("a polling product is available until two intervals pass without a read", () => {
  const interval = 15 * 60_000;
  const ok = facts({ inbox_read_at: NOW - POLL_OVERDUE_FACTOR * interval });
  assert.deepEqual(pick(derivePresence(ok, receive("poll", interval), NOW)), [
    "available",
    "polling",
    at(NOW - 2 * interval),
  ]);
  const late = facts({
    inbox_read_at: NOW - POLL_OVERDUE_FACTOR * interval - 1,
  });
  assert.deepEqual(pick(derivePresence(late, receive("poll", interval), NOW)), [
    "unavailable",
    "poll_overdue",
    at(NOW - 2 * interval - 1),
  ]);
  // Just configured: the interval counts from the ledger change, as poll_overdue does.
  assert.deepEqual(
    pick(
      derivePresence(undefined, receive("poll", interval, at(NOW - 1000)), NOW),
    ),
    ["available", "polling", null],
  );
});

test("a recent hab_inbox read is available for any other product", () => {
  for (const r of [null, receive("hook"), receive("on_request")])
    assert.deepEqual(
      pick(
        derivePresence(
          facts({ inbox_read_at: NOW - INBOX_READ_RECENT_MS }),
          r,
          NOW,
        ),
      ),
      ["available", "inbox_read_recently", at(NOW - INBOX_READ_RECENT_MS)],
    );
});

test("lapsed, missing and on-request doorbells say why HAB cannot reach the address", () => {
  const old = NOW - INBOX_READ_RECENT_MS - 1;
  assert.deepEqual(
    pick(
      derivePresence(
        facts({ lapsed_at: NOW - 7, inbox_read_at: old }),
        receive("hook"),
        NOW,
      ),
    ),
    ["unavailable", "doorbell_lapsed", at(NOW - 7)],
  );
  assert.deepEqual(
    pick(derivePresence(facts({ inbox_read_at: old }), receive("hook"), NOW)),
    ["unavailable", "doorbell_missing", null],
  );
  assert.deepEqual(
    pick(
      derivePresence(facts({ inbox_read_at: old }), receive("on_request"), NOW),
    ),
    ["unknown", "on_request", at(old)],
  );
  assert.deepEqual(
    pick(derivePresence(facts({ inbox_read_at: old }), null, NOW)),
    ["unknown", "inbox_read_earlier", at(old)],
  );
});
