import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_UNITS,
  SessionTable,
  address,
  answerRing,
  parseRing,
} from "../src/agent-notify/product-host.ts";

// docs/receiver/session-routing.md 「呼び鈴の答え方」: one notifier, many sessions, one
// doorbell; the ring's `to` and `session` pick exactly one unit.
function unit(name, { presence: initial, ...patch } = {}) {
  let presence = initial ?? (async () => "unknown");
  return {
    address: address(`${name}@agent.hab`),
    label: `conv-${name}`,
    exclusive: {
      store: `/s/${name}.db`,
      screen: `/s/${name}.jsonl`,
      binding: `b-${name}`,
    },
    interval_ms: 1000,
    check: async () => [],
    presence: () => presence(),
    setPresence(next) {
      presence = next;
    },
    close() {},
    ...patch,
  };
}

function ring(data, name = "hab.message.received") {
  return JSON.stringify({
    eventId: "evt-1",
    name,
    timestamp: "2026-11-21T00:00:00Z",
    data: { arrived_at: "2026-11-21T00:00:00Z", ...data },
    cursor: null,
  });
}

function harness(units) {
  const table = SessionTable.of(units);
  const woken = [];
  const logs = [];
  const answer = (body, probeMs) =>
    answerRing(
      table,
      body,
      (u) => woken.push(u.label),
      (e) => logs.push(e.reason),
      probeMs,
    );
  return { table, woken, logs, answer };
}

test("a ring naming the unit's conversation wakes only that unit", async () => {
  const a = unit("a"),
    b = unit("b");
  const { woken, logs, answer } = harness([a, b]);
  assert.equal(
    await answer(ring({ to: "b@agent.hab", session: "conv-b" })),
    "accepted",
  );
  assert.deepEqual(woken, ["conv-b"]);
  assert.deepEqual(logs, []);
});

test("a provisional session (equal to the address) is accepted and logged", async () => {
  const { woken, logs, answer } = harness([unit("a"), unit("b")]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "a@agent.hab" })),
    "accepted",
  );
  assert.deepEqual(woken, ["conv-a"]);
  assert.deepEqual(logs, ["provisional"]);
});

test("another session name for a served address is session_gone and stops that unit peeking", async () => {
  const a = unit("a"),
    b = unit("b");
  const { table, woken, logs, answer } = harness([a, b]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "conv-other" })),
    "session_gone",
  );
  assert.deepEqual(woken, []);
  assert.deepEqual(logs, ["session_mismatch"]);
  assert.equal(table.mayPeek(a), false);
  assert.equal(table.mayPeek(b), true);

  a.setPresence(async () => "present");
  await answer(ring({ to: "a@agent.hab", session: "conv-other" }));
  assert.equal(
    table.mayPeek(a),
    false,
    "presence alone does not lift a mismatch",
  );
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "conv-a" })),
    "accepted",
  );
  assert.equal(
    table.mayPeek(a),
    true,
    "a ring naming its own session lifts it",
  );
});

test("an address the notifier does not serve is session_gone", async () => {
  const { woken, logs, answer } = harness([unit("a")]);
  assert.equal(
    await answer(ring({ to: "z@agent.hab", session: "conv-z" })),
    "session_gone",
  );
  assert.deepEqual(woken, []);
  assert.deepEqual(logs, ["unknown_address"]);
});

test("a finished conversation is session_gone, pauses peeking, and resumes when present again", async () => {
  const a = unit("a", { presence: async () => "gone" });
  const { table, woken, logs, answer } = harness([a]);
  const body = ring({ to: "a@agent.hab", session: "conv-a" });
  assert.equal(await answer(body), "session_gone");
  assert.deepEqual(logs, ["conversation_gone"]);
  assert.equal(table.mayPeek(a), false);

  a.setPresence(async () => "unknown");
  assert.equal(await answer(body), "accepted");
  assert.equal(table.mayPeek(a), false, "unknown does not lift the pause");

  a.setPresence(async () => "present");
  assert.equal(await answer(body), "accepted");
  assert.equal(table.mayPeek(a), true);
  assert.deepEqual(woken, ["conv-a", "conv-a"]);
});

test("the loop's own presence check lifts conversation_gone but not session_mismatch", () => {
  const a = unit("a"),
    b = unit("b");
  const table = SessionTable.of([a, b]);
  table.observe(a, "gone");
  table.observe(b, "session_mismatch");
  table.observe(b, "gone");
  table.observe(a, "present");
  table.observe(b, "present");
  assert.equal(table.mayPeek(a), true);
  assert.equal(table.mayPeek(b), false);
});

test("a slow, unknown or failing probe is accepted", async () => {
  const cases = {
    slow: () => new Promise(() => {}),
    unknown: async () => "unknown",
    rejects: async () => {
      throw new Error("state.db locked");
    },
    throws: () => {
      throw new Error("no command");
    },
  };
  for (const [name, presence] of Object.entries(cases)) {
    const a = unit("a", { presence });
    const { table, woken, answer } = harness([a]);
    const started = Date.now();
    assert.equal(
      await answer(ring({ to: "a@agent.hab", session: "conv-a" }), 20),
      "accepted",
      name,
    );
    assert.ok(Date.now() - started < 1000, `${name} is bounded`);
    assert.deepEqual(woken, ["conv-a"], name);
    assert.equal(table.mayPeek(a), true, name);
  }
});

test("a ring without session (host before #259) routes by address alone", async () => {
  const { woken, answer } = harness([unit("a"), unit("b")]);
  assert.equal(await answer(ring({ to: "a@agent.hab" })), "accepted");
  assert.deepEqual(woken, ["conv-a"]);
});

test("an unreadable ring is bad_request and wakes nothing", async () => {
  const { woken, logs, answer } = harness([unit("a")]);
  for (const body of [
    "not json",
    "[]",
    ring({ to: "a@agent.hab" }, "hab.other"),
    JSON.stringify({ name: "hab.message.received" }),
    ring({ to: "A@agent.hab" }),
    ring({ to: 7 }),
    ring({ to: "a@agent.hab", session: "" }),
    ring({ to: "a@agent.hab", session: null }),
    ring({ to: "a@agent.hab", session: 3 }),
  ])
    assert.equal(await answer(body), "bad_request", body);
  assert.deepEqual(woken, []);
  assert.deepEqual(logs, []);
});

test("parseRing keeps to and session and ignores other fields", () => {
  assert.deepEqual(
    parseRing(ring({ to: "a@agent.hab", session: "conv-a", extra: true })),
    { to: "a@agent.hab", session: "conv-a" },
  );
  assert.deepEqual(parseRing(ring({ to: "a@agent.hab" })), {
    to: "a@agent.hab",
    session: undefined,
  });
});

test("SessionTable.of refuses an empty, oversized or overlapping set", () => {
  const refuses = (units, code) =>
    assert.throws(
      () => SessionTable.of(units),
      (error) => error.name === "MessagingError" && error.code === code,
      code,
    );
  refuses([], "no_sessions");
  const many = Array.from({ length: MAX_UNITS + 1 }, (_, i) => unit(`u${i}`));
  refuses(many, "too_many_sessions");
  assert.equal(SessionTable.of(many.slice(0, MAX_UNITS)).units.length, 32);

  const a = unit("a");
  refuses([a, unit("b", { address: a.address })], "duplicate_address");
  refuses([a, unit("b", { label: a.label })], "duplicate_session");
  for (const key of ["store", "screen", "binding"])
    refuses(
      [
        a,
        unit("b", {
          exclusive: { ...unit("b").exclusive, [key]: a.exclusive[key] },
        }),
      ],
      `shared_${key}`,
    );
});

test("the table's units cannot be changed after construction", () => {
  const table = SessionTable.of([unit("a")]);
  assert.throws(() => table.units.push(unit("b")));
  assert.equal(table.units.length, 1);
});
