import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
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
  let presence = initial;
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
    ...(initial ? { presence: () => presence() } : {}),
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

test("a provisional session can wake its unit while its binding remains unconfirmed", async () => {
  const { woken, logs, answer } = harness([unit("a"), unit("b")]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "a@agent.hab" })),
    "session_unconfirmed",
  );
  assert.deepEqual(woken, ["conv-a"]);
  assert.deepEqual(logs, ["provisional"]);
});

test("a different session name pauses that unit and leaves HAB presence unconfirmed", async () => {
  const a = unit("a", { presence: async () => "present" }),
    b = unit("b");
  const { table, woken, logs, answer } = harness([a, b]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "conv-other" })),
    "session_unconfirmed",
  );
  assert.deepEqual(woken, []);
  assert.deepEqual(logs, ["session_mismatch"]);
  assert.equal(table.mayPeek(a), false);
  assert.equal(table.mayPeek(b), true);

  assert.equal(await table.refreshPresence(a), "present");
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "a@agent.hab" })),
    "session_unconfirmed",
  );
  assert.deepEqual(woken, []);
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

test("an address the notifier does not serve leaves HAB presence unconfirmed", async () => {
  const { woken, logs, answer } = harness([unit("a")]);
  assert.equal(
    await answer(ring({ to: "z@agent.hab", session: "conv-z" })),
    "session_unconfirmed",
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
  assert.equal(await answer(body), "session_unconfirmed");
  assert.equal(table.mayPeek(a), false, "unknown does not lift the pause");

  a.setPresence(async () => "present");
  assert.equal(await answer(body), "accepted");
  assert.equal(table.mayPeek(a), true);
  assert.deepEqual(woken, ["conv-a"]);
});

test("scheduled presence checks require a positive result and preserve the routing pause", async () => {
  const a = unit("a", { presence: async () => "gone" });
  const b = unit("b", { presence: async () => "gone" });
  const { table, answer } = harness([a, b]);
  assert.equal(table.mayPeek(a), false, "a configured probe must run first");
  await answer(ring({ to: "b@agent.hab", session: "conv-other" }));
  assert.equal(await table.refreshPresence(a), "gone");
  assert.equal(await table.refreshPresence(b), "gone");
  a.setPresence(async () => "present");
  b.setPresence(async () => "present");
  assert.equal(await table.refreshPresence(a), "present");
  assert.equal(await table.refreshPresence(b), "present");
  assert.equal(table.mayPeek(a), true);
  assert.equal(table.mayPeek(b), false);
});

test("fixing the session name does not lift an outstanding conversation_gone", async () => {
  const a = unit("a", { presence: async () => "gone" });
  const { table, answer } = harness([a]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "conv-a" })),
    "session_gone",
  );
  await answer(ring({ to: "a@agent.hab", session: "conv-other" }));
  a.setPresence(async () => "unknown");
  assert.equal(
    await answer(ring({ to: "a@agent.hab", session: "conv-a" })),
    "session_unconfirmed",
  );
  assert.equal(table.mayPeek(a), false, "still waits for present");
  a.setPresence(async () => "present");
  assert.equal(await table.refreshPresence(a), "present");
  assert.equal(table.mayPeek(a), true);
});

test("a slow, unknown or failing configured probe leaves presence unconfirmed", async () => {
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
      "session_unconfirmed",
      name,
    );
    assert.ok(Date.now() - started < 1000, `${name} is bounded`);
    assert.deepEqual(woken, [], name);
    assert.equal(table.mayPeek(a), false, name);
  }
});

test("a legacy ring routes by address alone and leaves HAB presence unconfirmed", async () => {
  const { woken, answer } = harness([unit("a"), unit("b")]);
  assert.equal(
    await answer(ring({ to: "a@agent.hab" })),
    "session_unconfirmed",
  );
  assert.deepEqual(woken, ["conv-a"]);
});

test("legacy and provisional rings cannot report that the bound session ended", async () => {
  const a = unit("a", { label: "a@agent.hab", presence: async () => "gone" });
  const { woken, table, answer } = harness([a]);
  for (const session of [undefined, "a@agent.hab"]) {
    assert.equal(
      await answer(ring({ to: "a@agent.hab", session })),
      "session_unconfirmed",
    );
  }
  assert.deepEqual(woken, []);
  assert.equal(table.mayPeek(a), false);
});

test("ring and scheduled check share a probe without blocking another unit", async () => {
  const probe = Promise.withResolvers();
  let reads = 0;
  const a = unit("a", {
    presence: () => {
      reads++;
      return probe.promise;
    },
  });
  const b = unit("b");
  const { table, woken, answer } = harness([a, b]);
  const scheduled = table.refreshPresence(a);
  const first = answer(ring({ to: a.address, session: a.label }));
  const duplicate = answer(ring({ to: a.address, session: a.label }));
  assert.equal(
    await answer(ring({ to: b.address, session: b.label })),
    "accepted",
  );
  assert.equal(reads, 1);
  assert.deepEqual(woken, ["conv-b"]);
  probe.resolve("present");
  assert.deepEqual(await Promise.all([scheduled, first, duplicate]), [
    "present",
    "accepted",
    "accepted",
  ]);
  assert.equal(reads, 1);
  assert.equal(table.mayPeek(a), true);
});

test("an older ring's probe cannot override a later routing mismatch", async () => {
  for (const outcome of ["gone", "present"]) {
    const probe = Promise.withResolvers();
    const a = unit("a", { presence: () => probe.promise });
    const { table, woken, answer } = harness([a]);
    const first = answer(ring({ to: a.address, session: a.label }));
    assert.equal(
      await answer(ring({ to: a.address, session: "different" })),
      "session_unconfirmed",
    );
    probe.resolve(outcome);
    assert.equal(await first, "session_unconfirmed");
    assert.equal(table.mayPeek(a), false);
    assert.deepEqual(woken, []);
  }
});

test("a timed-out presence result cannot overwrite a newer gone observation", async () => {
  const late = Promise.withResolvers();
  const a = unit("a", { presence: () => late.promise });
  const { table, woken, answer } = harness([a]);
  const body = ring({ to: a.address, session: a.label });
  assert.equal(await answer(body, 10), "session_unconfirmed");
  a.setPresence(async () => "gone");
  assert.equal(await answer(body), "session_gone");
  late.resolve("present");
  await setImmediate();
  assert.equal(table.mayPeek(a), false);
  assert.deepEqual(woken, []);
});

test("an unreadable ring is bad_request and wakes nothing", async () => {
  const { woken, logs, answer } = harness([unit("a")]);
  for (const body of [
    "not json",
    "[]",
    JSON.stringify({ type: "verification", challenge: "fixture" }),
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
