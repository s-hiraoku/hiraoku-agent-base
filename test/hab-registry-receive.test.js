import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { startHost } from "../src/host/start.ts";
import {
  hostAdminStatus,
  hostAdminConnect,
  hostAdminReceive,
  hostAdminSession,
} from "../src/host/admin.ts";
import { main as runHabAdmin } from "../scripts/hab-admin.ts";
import { fixture } from "./host-service-fixtures.js";

async function started(t) {
  const f = await fixture(t);
  const host = await startHost(f.configPath);
  t.after(() => host.close());
  f.config.port = Number(new URL(host.url).port);
  f.write("service.local.json", f.config);
  const names = ["one", "two", "grok", "three"];
  const now = Date.now();
  f.write("credentials.local.json", {
    version: 1,
    credentials: names.map((name) => ({
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
  for (const [address, name] of [
    ["one@dot.hab", "one"],
    ["two@dot.hab", "two"],
    ["grok@grok.hab", "grok"],
  ])
    hostAdminConnect(f.configPath, { address, connection_id: `conn-${name}` });
  return { ...f, host };
}

const address = (status, name) =>
  status.addresses.find((entry) => entry.address === name);

test("every address starts as a provisional session named after itself; products have no mode", async (t) => {
  const f = await started(t);
  const status = hostAdminStatus(f.configPath);
  assert.deepEqual(
    status.products.map((p) => [p.agent_name, p.receive]),
    [
      ["dot", null],
      ["grok", null],
    ],
  );
  for (const name of ["one@dot.hab", "two@dot.hab", "grok@grok.hab"]) {
    const session = address(status, name).session;
    assert.equal(session.session, name);
    assert.equal(session.provisional, true);
    assert.ok(Date.parse(session.bound_at) > 0);
  }
});

test("a product's receive mode is set, shown, and interval only goes with poll", async (t) => {
  const f = await started(t);
  const set = hostAdminReceive(f.configPath, {
    agent_name: "dot",
    mode: "poll",
    interval_ms: 60000,
    request_id: "r1",
  });
  assert.equal(set.receive.mode, "poll");
  assert.equal(set.receive.interval_ms, 60000);
  hostAdminReceive(f.configPath, {
    agent_name: "grok",
    mode: "hook",
    request_id: "r2",
  });
  const status = hostAdminStatus(f.configPath);
  assert.deepEqual(
    status.products.map((p) => [p.agent_name, p.receive?.mode]),
    [
      ["dot", "poll"],
      ["grok", "hook"],
    ],
  );
  for (const bad of [
    { mode: "poll" },
    { mode: "hook", interval_ms: 60000 },
    { mode: "poll", interval_ms: 1000 },
    { mode: "push" },
  ])
    assert.throws(
      () =>
        hostAdminReceive(f.configPath, {
          agent_name: "dot",
          request_id: `bad-${JSON.stringify(bad)}`.replace(
            /[^A-Za-z0-9_.:-]/g,
            "_",
          ),
          ...bad,
        }),
      { code: "invalid_registry_request" },
    );
  assert.throws(
    () =>
      hostAdminReceive(f.configPath, {
        agent_name: "nobody",
        mode: "hook",
        request_id: "r3",
      }),
    { code: "registry_not_found" },
  );
});

test("a session is named once per address and never shared within a product", async (t) => {
  const f = await started(t);
  const bound = hostAdminSession(f.configPath, {
    address: "one@dot.hab",
    session: "stallone",
    request_id: "s1",
  });
  assert.equal(bound.session.session, "stallone");
  assert.equal(bound.session.provisional, false);
  assert.throws(
    () =>
      hostAdminSession(f.configPath, {
        address: "one@dot.hab",
        session: "other",
        request_id: "s2",
      }),
    { code: "registry_session_bound" },
  );
  assert.throws(
    () =>
      hostAdminSession(f.configPath, {
        address: "two@dot.hab",
        session: "stallone",
        request_id: "s3",
      }),
    { code: "registry_session_taken" },
  );
  // The same name is fine in another product: sessions are per product.
  hostAdminSession(f.configPath, {
    address: "grok@grok.hab",
    session: "stallone",
    request_id: "s4",
  });
  const replaced = hostAdminSession(f.configPath, {
    address: "one@dot.hab",
    session: "other",
    replace: true,
    request_id: "s5",
  });
  assert.equal(replaced.session.session, "other");
  // A journaled request replays its first answer instead of acting twice.
  assert.equal(
    hostAdminSession(f.configPath, {
      address: "one@dot.hab",
      session: "stallone",
      request_id: "s1",
    }).session.session,
    "stallone",
  );
  assert.equal(
    address(hostAdminStatus(f.configPath), "one@dot.hab").session.session,
    "other",
  );
  for (const session of ["", "x".repeat(129), "bad\nname"])
    assert.throws(
      () =>
        hostAdminSession(f.configPath, {
          address: "two@dot.hab",
          session,
          request_id: `s-bad-${session.length}`,
        }),
      { code: "invalid_registry_request" },
    );
});

test("a provisional name never blocks enrolling or naming another address", async (t) => {
  const f = await started(t);
  // The operator names one address's session after an address not enrolled yet.
  hostAdminSession(f.configPath, {
    address: "one@dot.hab",
    session: "three@dot.hab",
    request_id: "p1",
  });
  // Enrolling that address still works; its provisional name repeats the string.
  hostAdminConnect(f.configPath, {
    address: "three@dot.hab",
    connection_id: "conn-three",
  });
  const three = address(hostAdminStatus(f.configPath), "three@dot.hab");
  assert.equal(three.session.provisional, true);
  // A named session still cannot be taken by another address of the product.
  assert.throws(
    () =>
      hostAdminSession(f.configPath, {
        address: "three@dot.hab",
        session: "three@dot.hab",
        request_id: "p2",
      }),
    { code: "registry_session_taken" },
  );
  // Naming over another address's provisional name is fine.
  hostAdminSession(f.configPath, {
    address: "one@dot.hab",
    session: "two@dot.hab",
    replace: true,
    request_id: "p3",
  });
});

test("settings survive a host restart", async (t) => {
  const f = await started(t);
  hostAdminReceive(f.configPath, {
    agent_name: "dot",
    mode: "on_request",
    request_id: "r1",
  });
  hostAdminSession(f.configPath, {
    address: "two@dot.hab",
    session: "work",
    request_id: "s1",
  });
  await f.host.close();
  const again = await startHost(f.configPath);
  t.after(() => again.close());
  const status = hostAdminStatus(f.configPath);
  assert.equal(
    status.products.find((p) => p.agent_name === "dot").receive.mode,
    "on_request",
  );
  assert.equal(address(status, "two@dot.hab").session.session, "work");
});

test("a registry from before ADR-032 waits for the host, which adds sessions once", async (t) => {
  const f = await started(t);
  await f.host.close();
  // Rebuild the state an older build left: no receive tables at all.
  const db = new DatabaseSync(join(f.config.directory, "registry.sqlite"));
  db.exec(`DROP TRIGGER hab_agent_sessions_reserved;
    DROP TRIGGER hab_agent_sessions_identity;
    DROP TRIGGER hab_product_receive_reserved;
    DROP TABLE hab_agent_sessions;
    DROP TABLE hab_product_receive;
    DROP TABLE hab_receive_meta;`);
  db.close();
  assert.throws(() => hostAdminStatus(f.configPath), {
    code: "registry_upgrade_pending",
  });
  const first = await startHost(f.configPath);
  await first.close();
  const once = hostAdminStatus(f.configPath);
  assert.deepEqual(
    once.addresses.map((a) => [
      a.address,
      a.session.session,
      a.session.provisional,
    ]),
    [
      ["grok@grok.hab", "grok@grok.hab", true],
      ["one@dot.hab", "one@dot.hab", true],
      ["two@dot.hab", "two@dot.hab", true],
    ],
  );
  const second = await startHost(f.configPath);
  t.after(() => second.close());
  assert.deepEqual(
    hostAdminStatus(f.configPath).addresses.map((a) => a.session),
    once.addresses.map((a) => a.session),
  );
});

test("hab-admin CLI sets receive and session and refuses malformed flags", async (t) => {
  const f = await started(t);
  const out = runHabAdmin([
    "--config",
    f.configPath,
    "receive",
    "--agent-name",
    "dot",
    "--mode",
    "poll",
    "--interval-ms",
    "120000",
    "--request-id",
    "cli-r1",
  ]);
  assert.deepEqual(out.receive.interval_ms, 120000);
  const bound = runHabAdmin([
    "--config",
    f.configPath,
    "session",
    "--address",
    "two@dot.hab",
    "--session",
    "work",
    "--request-id",
    "cli-s1",
  ]);
  assert.equal(bound.session.session, "work");
  assert.throws(
    () =>
      runHabAdmin([
        "--config",
        f.configPath,
        "session",
        "--address",
        "two@dot.hab",
        "--session",
        "x",
        "--replace",
        "yes",
        "--request-id",
        "cli-s2",
      ]),
    { code: "usage" },
  );
  assert.throws(
    () =>
      runHabAdmin([
        "--config",
        f.configPath,
        "session",
        "--address",
        "nobody@dot.hab",
        "--session",
        "x",
        "--request-id",
        "cli-s3",
      ]),
    { code: "address_not_found" },
  );
});

test("naming a session looks the address up exactly, not through the capped overview", async (t) => {
  const f = await started(t);
  assert.throws(
    () =>
      hostAdminSession(f.configPath, {
        address: "nobody@dot.hab",
        session: "x",
        request_id: "n1",
      }),
    { code: "address_not_found" },
  );
  assert.throws(
    () =>
      hostAdminSession(f.configPath, {
        address: "not an address",
        session: "x",
        request_id: "n2",
      }),
    { code: "invalid_registry_request" },
  );
  const bound = hostAdminSession(f.configPath, {
    address: "grok@grok.hab",
    session: "main",
    request_id: "n3",
  });
  assert.equal(bound.address, "grok@grok.hab");
  assert.equal(bound.session.session, "main");
});
