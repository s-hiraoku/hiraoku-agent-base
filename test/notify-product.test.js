import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { HAB_EVENT_NAME, signWebhook } from "../src/hab/events.ts";
import {
  SessionTable,
  address,
  runProduct,
} from "../src/agent-notify/product-host.ts";
import { main } from "../scripts/hab-notify.ts";

// docs/receiver/session-routing.md 「設定」「呼び鈴の答え方」「検証」: one product file, one
// notify.json per session in sessions_dir, one doorbell that wakes only the named session.
const SECRET = "whsec_" + Buffer.alloc(32, 3).toString("base64");
const TOKEN_ENV = "HAB_NOTIFY_PRODUCT_TEST_TOKEN";
const expiredJwt = [
  "e30",
  Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url"),
  "sig",
].join(".");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-product-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = join(dir, "hermes.d");
  mkdirSync(sessions);
  const secretFile = join(dir, "wake.secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const product = join(dir, "hermes.product.json");
  writeFileSync(
    product,
    JSON.stringify({
      wake: { port, secret_file: secretFile },
      sessions_dir: sessions,
    }),
  );
  const probe = (result) => {
    const file = join(dir, `probe-${result}.mjs`);
    writeFileSync(
      file,
      `console.log(JSON.stringify({ result: ${JSON.stringify(result)} }));`,
    );
    return { command: [process.execPath, file], cwd: dir };
  };
  const session = (name, patch = {}) => {
    const config = {
      hab_url: "https://hab.example/mcp",
      agent_id: `agent-${name}`,
      as_address: `${name}@hermes.hab`,
      token: { env: TOKEN_ENV },
      store: join(dir, `${name}.sqlite`),
      screen: {
        type: "hermes-desktop",
        path: join(dir, `${name}.jsonl`),
        session_id: `conv-${name}`,
        profile: "profile",
        backend_namespace: "namespace",
        profile_scope: "scope",
      },
      interval_ms: 60_000,
      ...patch,
    };
    writeFileSync(join(sessions, `${name}.json`), JSON.stringify(config));
    return config;
  };
  const cli = async (command) => {
    const lines = [];
    const code = await main(["--product", product, command], (line) =>
      lines.push(line),
    );
    return { code, lines: lines.map((line) => JSON.parse(line)) };
  };
  return { dir, port, product, probe, session, cli };
}

const oauth = (file, patch = {}) => ({
  oauth: {
    file,
    token_endpoint: "https://issuer.example/oauth/token",
    client_id: "notifier",
    ...patch,
  },
});

test("units lists every session file with its address, conversation and ledger line", async (t) => {
  const f = fixture(t);
  f.session("alpha", {
    screen: {
      ...f.session("alpha").screen,
      session_probe: f.probe("present"),
    },
  });
  f.session("beta");
  const { code, lines } = await f.cli("units");
  assert.equal(code, 0);
  assert.deepEqual(
    lines.map(({ address, session, presence }) => [address, session, presence]),
    [
      ["alpha@hermes.hab", "conv-alpha", "present"],
      ["beta@hermes.hab", "conv-beta", "probe_not_configured"],
    ],
  );
  assert.match(
    lines[0].register,
    /^npm run hab:admin -- --config <host-config> session --address alpha@hermes\.hab --session conv-alpha --request-id session-[0-9a-f]{16}$/,
  );
  assert.equal((await f.cli("units")).lines[0].register, lines[0].register);
});

test("the product refuses a session without as_address or with its own doorbell", async (t) => {
  const f = fixture(t);
  f.session("alpha");
  f.session("beta", { as_address: undefined });
  assert.deepEqual(await f.cli("units"), {
    code: 1,
    lines: [{ error: "as_address_required", files: ["beta.json"] }],
  });
  f.session("beta", { wake: { port: 9999, secret_file: "/x" } });
  assert.deepEqual(await f.cli("run"), {
    code: 1,
    lines: [{ error: "session_wake_not_allowed", files: ["beta.json"] }],
  });
  await assert.rejects(
    globalThis.fetch(`http://127.0.0.1:${f.port}/`, { method: "POST" }),
    "the doorbell stays closed when loading fails",
  );
  f.session("beta", { as_address: "alpha@hermes.hab" });
  assert.deepEqual((await f.cli("units")).lines, [
    { error: "duplicate_address" },
  ]);
});

test("TokenPool refuses a second spender of one rotating refresh token", async (t) => {
  const f = fixture(t);
  const grantA = join(f.dir, "a.oauth.json");
  const grantB = join(f.dir, "b.oauth.json");
  const refresh = "refresh-secret-value";
  for (const file of [grantA, grantB])
    writeFileSync(file, JSON.stringify({ refresh_token: refresh }), {
      mode: 0o600,
    });

  f.session("alpha", { token: oauth(grantA) });
  f.session("beta", { token: oauth(grantA, { client_id: "other" }) });
  assert.deepEqual((await f.cli("units")).lines, [
    { error: "token_file_conflict" },
  ]);

  f.session("beta", { token: oauth(grantB) });
  const shared = await f.cli("units");
  assert.deepEqual(shared.lines, [{ error: "refresh_token_shared" }]);

  const agentFile = join(f.dir, "agent-token.json");
  writeFileSync(agentFile, JSON.stringify({ access_token: "x" }));
  f.session("beta", { token: { file: agentFile } });
  f.session("alpha", { token: oauth(agentFile) });
  assert.deepEqual((await f.cli("units")).lines, [
    { error: "agent_token_file" },
  ]);

  f.session("alpha", { token: oauth(grantA) });
  writeFileSync(
    agentFile,
    JSON.stringify({ access_token: "x", refresh_token: refresh }),
  );
  const copied = await f.cli("units");
  assert.deepEqual(copied.lines, [{ error: "refresh_token_shared" }]);
  assert.ok(!JSON.stringify([shared, copied]).includes(refresh));

  f.session("beta", { token: oauth(grantA) });
  assert.equal((await f.cli("units")).code, 0, "one grant, shared by name");
});

function signedRing(port, data) {
  const body =
    typeof data === "string"
      ? data
      : JSON.stringify({ name: HAB_EVENT_NAME, data });
  const ts = Math.floor(Date.now() / 1000);
  return globalThis
    .fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "webhook-id": "msg_product",
        "webhook-timestamp": String(ts),
        "webhook-signature": signWebhook(SECRET, "msg_product", ts, body),
      },
      body,
    })
    .then(async (response) => [response.status, await response.text()]);
}

test("one doorbell answers each signed ring by its address and conversation", async (t) => {
  const f = fixture(t);
  process.env[TOKEN_ENV] = expiredJwt;
  t.after(() => delete process.env[TOKEN_ENV]);
  const base = f.session("alpha").screen;
  f.session("alpha", {
    screen: { ...base, session_probe: f.probe("present") },
  });
  f.session("beta", {
    screen: {
      ...base,
      path: join(f.dir, "beta.jsonl"),
      session_id: "conv-beta",
      session_probe: f.probe("gone"),
    },
  });
  const lines = [];
  const running = main(["--product", f.product, "run"], (line) =>
    lines.push(JSON.parse(line)),
  );
  let answers;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await globalThis.fetch(`http://127.0.0.1:${f.port}/`);
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    const unconfirmed = JSON.stringify({ reason: "session_unconfirmed" });
    answers = [
      [
        await signedRing(f.port, {
          to: "alpha@hermes.hab",
          session: "conv-alpha",
        }),
        [200, "{}"],
      ],
      [
        await signedRing(f.port, {
          to: "nobody@hermes.hab",
          session: "conv-x",
        }),
        [200, unconfirmed],
      ],
      [
        await signedRing(f.port, {
          to: "beta@hermes.hab",
          session: "beta@hermes.hab",
        }),
        [200, unconfirmed],
      ],
      [
        await signedRing(f.port, {
          to: "beta@hermes.hab",
          session: "conv-beta",
        }),
        [410, JSON.stringify({ reason: "session_gone" })],
      ],
      [
        await signedRing(f.port, { to: "alpha@hermes.hab", session: "other" }),
        [200, unconfirmed],
      ],
      [await signedRing(f.port, '{"type":"verification"}'), [400, ""]],
    ];
  } finally {
    process.emit("SIGTERM");
  }
  assert.equal(await running, 0);
  for (const [actual, expected] of answers) assert.deepEqual(actual, expected);
  await assert.rejects(
    globalThis.fetch(`http://127.0.0.1:${f.port}/`),
    "the doorbell is closed after stop",
  );
  const per = (address) =>
    lines
      .filter((line) => line.address === address)
      .map((line) => line.session ?? line.error);
  assert.deepEqual(per("alpha@hermes.hab"), ["present", "token_expired"]);
  assert.deepEqual(per("beta@hermes.hab"), ["gone"], "a gone unit never peeks");
  assert.deepEqual(
    lines.filter((line) => line.ring).map((line) => line.ring.reason),
    ["unknown_address", "provisional", "conversation_gone", "session_mismatch"],
  );
});

test("--config run refuses a session without as_address", async (t) => {
  const f = fixture(t);
  const config = f.session("alpha", { as_address: undefined });
  const file = join(f.dir, "single.json");
  writeFileSync(file, JSON.stringify(config));
  const lines = [];
  assert.equal(await main(["--config", file, "run"], (l) => lines.push(l)), 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    error: "as_address_required",
    files: ["config"],
  });
});

function fakeUnit(name, check) {
  return {
    address: address(`${name}@agent.hab`),
    label: `conv-${name}`,
    exclusive: { store: name, screen: name, binding: name },
    interval_ms: 60_000,
    check,
    closed: 0,
    close() {
      this.closed++;
    },
  };
}

const ringFor = (name) =>
  JSON.stringify({
    name: HAB_EVENT_NAME,
    data: { to: `${name}@agent.hab`, session: `conv-${name}` },
  });

const until = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++)
    await new Promise((done) => setTimeout(done, 5));
  assert.ok(predicate());
};

test("a ring wakes only the unit it names", async (t) => {
  const checks = { a: 0, b: 0 };
  const a = fakeUnit("a", async () => (checks.a++, []));
  const b = fakeUnit("b", async () => (checks.b++, []));
  const stop = new AbortController();
  t.after(() => stop.abort());
  let answer;
  const order = [];
  const running = runProduct(SessionTable.of([a, b]), {
    stop: stop.signal,
    listen: async (handler) => {
      answer = handler;
      order.push("listen");
      return { close: async () => order.push("close") };
    },
  });
  await until(() => checks.a === 1 && checks.b === 1);
  assert.equal(await answer(ringFor("b")), "accepted");
  await until(() => checks.b === 2);
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(checks, { a: 1, b: 2 });
  stop.abort();
  await running;
  assert.deepEqual(order, ["listen", "close"]);
  assert.deepEqual([a.closed, b.closed], [1, 1]);
});

test("a failing unit keeps failing on its own while the other keeps checking", async (t) => {
  let good = 0;
  const failing = fakeUnit("a", async () => {
    throw new Error("credential expired");
  });
  const working = fakeUnit("b", async () => (good++, []));
  failing.interval_ms = working.interval_ms = 5;
  const errors = [];
  const stop = new AbortController();
  t.after(() => stop.abort());
  const running = runProduct(SessionTable.of([failing, working]), {
    stop: stop.signal,
    report: (unit, event) => {
      if ("error" in event) errors.push(unit.label);
    },
  });
  await until(() => good >= 5 && errors.length >= 5);
  stop.abort();
  await running;
  assert.ok(errors.every((label) => label === "conv-a"));
});
