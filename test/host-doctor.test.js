import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { startHost } from "../src/host/start.ts";
import { hostAdminConnect, hostAdminReceive } from "../src/host/admin.ts";
import { diagnose, hostAdminDoctor } from "../src/host/doctor.ts";
import { main as runHabAdmin } from "../scripts/hab-admin.ts";
import { fixture } from "./host-service-fixtures.js";

const NOW = Date.parse("2026-11-21T00:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000,
  DAY = 86_400_000;
const ADDRESS = "bot@dot.hab";

/** A `hostAdminStatus` result for one healthy Hook address, changed by `patch`. */
function status(patch = {}) {
  const base = {
    products: [{ agent_name: "dot", receive: { mode: "hook" } }],
    addresses: [
      {
        address: ADDRESS,
        state: "active",
        operations: ["resolve", "submit", "status", "poll", "ack"],
        active_bindings: 1,
        session: { session: ADDRESS, provisional: true },
      },
    ],
    credentials: [
      {
        connection_id: "conn-bot",
        participation: {
          state: "active",
          approved_until: at(300 * DAY),
          expires_in_seconds: (300 * DAY) / 1000,
        },
        binding: { state: "active" },
        addresses: [ADDRESS],
      },
    ],
    inboxes: [
      {
        address: ADDRESS,
        unread: 0,
        oldest_unread_at: null,
        doorbell: "live",
        last_inbox_read_at: at(-10 * MIN),
      },
    ],
    problems: [],
  };
  const merged = { ...base, ...patch };
  for (const key of ["addresses", "inboxes", "credentials"])
    if (patch[key] && !Array.isArray(patch[key]))
      merged[key] = [{ ...base[key][0], ...patch[key] }];
  return merged;
}
const reasons = (s) =>
  Object.fromEntries(
    Object.entries(diagnose(s, ADDRESS, NOW).checks).map(([k, c]) => [
      k,
      `${c.state}:${c.reason}`,
    ]),
  );

test("a healthy Hook address is ok everywhere but the unobserved session", () => {
  assert.deepEqual(reasons(status()), {
    registration: "ok:registered",
    receive: "ok:doorbell_live",
    reading: "ok:no_unread",
    session: "unknown:session_not_reported",
  });
  const { checks } = diagnose(status(), ADDRESS, NOW);
  assert.equal(checks.registration.next_action, null);
  assert.equal(typeof checks.session.evidence.session, "string");
});

test("registration names the first thing that stops the address", () => {
  const cases = [
    [{ addresses: { state: "suspended" } }, "problem:address_inactive"],
    [{ addresses: { active_bindings: 0 } }, "problem:address_unbound"],
    [{ addresses: { operations: ["resolve"] } }, "problem:operations_missing"],
    [{ credentials: [] }, "unknown:connection_unlisted"],
    [
      {
        credentials: {
          participation: {
            state: "revoked",
            approved_until: at(DAY),
            expires_in_seconds: 86400,
          },
        },
      },
      "problem:approval_revoked",
    ],
    [
      {
        credentials: {
          participation: {
            state: "active",
            approved_until: at(-DAY),
            expires_in_seconds: 0,
          },
        },
      },
      "problem:approval_expired",
    ],
    [
      {
        credentials: {
          participation: {
            state: "active",
            approved_until: at(10 * DAY),
            expires_in_seconds: 864000,
          },
        },
      },
      "problem:approval_expiring",
    ],
  ];
  for (const [patch, want] of cases)
    assert.equal(
      reasons(status(patch)).registration,
      want,
      JSON.stringify(patch),
    );
  const problem = diagnose(
    status({ addresses: { active_bindings: 0 } }),
    ADDRESS,
    NOW,
  ).checks.registration;
  assert.match(problem.next_action, /hab:admin connect/);
});

test("a waiting sign-in turns a missing connection into an approval to make", () => {
  const unbound = { addresses: { active_bindings: 0 } };
  assert.equal(
    reasons(status({ ...unbound, pending_connections: 2 })).registration,
    "problem:pending_approval",
  );
  const { registration } = diagnose(
    status({ ...unbound, pending_connections: 2 }),
    ADDRESS,
    NOW,
  ).checks;
  assert.match(registration.next_action, /hab:admin approve --pending/);
  assert.equal(registration.evidence.pending_connections, 2);
  // A working address is not held up by someone else's waiting sign-in.
  assert.equal(
    reasons(status({ pending_connections: 2 })).registration,
    "ok:registered",
  );
});

test("receive follows the product's mode and the doorbell's state", () => {
  const hook = (inbox, problems = []) =>
    reasons(status({ inboxes: inbox, problems })).receive;
  assert.equal(
    reasons(status({ products: [{ agent_name: "dot", receive: null }] }))
      .receive,
    "problem:receive_unset",
  );
  assert.equal(hook({ doorbell: "off" }), "problem:events_off");
  assert.equal(hook({ doorbell: "none" }), "problem:doorbell_missing");
  assert.equal(hook({ doorbell: "lapsed" }), "problem:doorbell_lapsed");
  assert.equal(
    hook({}, [{ code: "doorbell_failing", subject: ADDRESS }]),
    "problem:doorbell_failing",
  );
  const poll = (inbox, problems = []) =>
    reasons(
      status({
        products: [
          { agent_name: "dot", receive: { mode: "poll", interval_ms: 900000 } },
        ],
        inboxes: inbox,
        problems,
      }),
    ).receive;
  assert.equal(poll({}), "ok:poll_reading");
  assert.equal(poll({ last_inbox_read_at: null }), "unknown:poll_never_read");
  assert.equal(poll({ doorbell: "off" }), "unknown:reads_untracked");
  assert.equal(
    poll({}, [{ code: "poll_overdue", subject: ADDRESS }]),
    "problem:poll_overdue",
  );
  assert.equal(
    reasons(
      status({
        products: [{ agent_name: "dot", receive: { mode: "on_request" } }],
      }),
    ).receive,
    "ok:on_request",
  );
});

test("reading tells a taken ring that was never read from mail still in time", () => {
  const unread = {
    unread: 1,
    oldest_unread_at: at(-10 * MIN),
    doorbell_last_delivered_at: at(-9 * MIN),
    last_inbox_read_at: at(-60 * MIN),
  };
  assert.equal(
    reasons(status({ inboxes: unread })).reading,
    "problem:rang_not_read",
  );
  // Never seen reading with hab_inbox (a notifier reads through the delivery tools):
  // a card awaiting its user's choice is not a missed ring.
  assert.equal(
    reasons(status({ inboxes: { ...unread, last_inbox_read_at: null } }))
      .reading,
    "ok:unread_recent",
  );
  // Within the grace after the ring, the product may still be on its way.
  assert.equal(
    reasons(
      status({ inboxes: { ...unread, doorbell_last_delivered_at: at(-MIN) } }),
    ).reading,
    "ok:unread_recent",
  );
  // Read after the ring: whatever is unread came later.
  assert.equal(
    reasons(
      status({ inboxes: { ...unread, last_inbox_read_at: at(-5 * MIN) } }),
    ).reading,
    "ok:unread_recent",
  );
  assert.equal(
    reasons(
      status({
        inboxes: { ...unread, doorbell_last_delivered_at: null },
        problems: [{ code: "unread_waiting", subject: ADDRESS }],
      }),
    ).reading,
    "problem:unread_waiting",
  );
  assert.equal(
    reasons(
      status({
        products: [{ agent_name: "dot", receive: { mode: "on_request" } }],
        inboxes: unread,
      }),
    ).reading,
    "ok:waiting_for_request",
  );
});

test("an absent recipient is a session problem with its time", () => {
  const s = status({ inboxes: { recipient_absent_since: at(-MIN) } });
  const { session } = diagnose(s, ADDRESS, NOW).checks;
  assert.equal(
    `${session.state}:${session.reason}`,
    "problem:recipient_absent",
  );
  assert.equal(session.evidence.absent_since, at(-MIN));
});

test("an unknown address is refused", () => {
  assert.throws(() => diagnose(status(), "nobody@dot.hab", NOW), {
    code: "address_not_found",
  });
});

/** Every row of every table, so a read that wrote anything shows up. */
function contents(path) {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    return Object.fromEntries(
      tables.map((name) => [
        name,
        JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()),
      ]),
    );
  } finally {
    db.close();
  }
}

test("doctor on a running host reads only, lists every address and refuses bad input", async (t) => {
  const f = await fixture(t);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);
  const now = Date.now();
  f.write("credentials.local.json", {
    version: 1,
    credentials: ["one", "two"].map((name) => ({
      sha256: createHash("sha256").update(name.repeat(32)).digest("hex"),
      principal: {
        issuer: "urn:synthetic:local",
        audience: host.url,
        subject: `synthetic-${name}`,
        client_id: `client-${name}`,
        connection_id: `conn-${name}`,
      },
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 600000).toISOString(),
    })),
  });
  for (const name of ["one", "two"])
    hostAdminConnect(f.configPath, {
      address: `${name}@dot.hab`,
      connection_id: `conn-${name}`,
    });
  hostAdminReceive(f.configPath, {
    agent_name: "dot",
    mode: "on_request",
    request_id: "doctor-r1",
  });
  const stores = ["registry", "events", "delivery"].map((name) =>
    join(f.config.directory, `${name}.sqlite`),
  );
  const before = stores.map(contents);
  const summary = runHabAdmin(["--config", f.configPath, "doctor"]);
  assert.deepEqual(
    summary.addresses.map((a) => [a.address, a.receive, a.reading]),
    [
      ["one@dot.hab", "ok", "ok"],
      ["two@dot.hab", "ok", "ok"],
    ],
  );
  const one = runHabAdmin([
    "--config",
    f.configPath,
    "doctor",
    "--address",
    "one@dot.hab",
  ]);
  assert.equal(one.address, "one@dot.hab");
  assert.equal(one.checks.receive.reason, "on_request");
  // A short-lived local credential (not a 1-year approval) still registers.
  assert.equal(one.checks.registration.state, "ok");
  assert.deepEqual(stores.map(contents), before, "doctor wrote nothing");
  assert.throws(() => hostAdminDoctor(f.configPath, "nobody@dot.hab"), {
    code: "address_not_found",
  });
  assert.throws(() => hostAdminDoctor(f.configPath, "not an address"), {
    code: "invalid_address",
  });
  assert.throws(
    () => runHabAdmin(["--config", f.configPath, "doctor", "--session", "x"]),
    { code: "usage" },
  );
});
