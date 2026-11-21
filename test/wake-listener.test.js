import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { HAB_EVENT_NAME, signWebhook } from "../src/hab/events.ts";
import {
  startWakeListener,
  verifyWebhook,
  wakeableSleep,
} from "../src/agent-notify/wake-listener.ts";
import { readWakeSecret } from "../scripts/hab-notify.ts";
import { sessionProbe } from "../src/agent-notify/session-probe.ts";

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");

function signed(
  body,
  { secret = SECRET, ts = Math.floor(Date.now() / 1000), id = "msg_1" } = {},
) {
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signWebhook(secret, id, ts, body),
  };
}

test("a ring signed with the shared key and recent timestamp is accepted", () => {
  const body = '{"to":"hermes@hermes.hab"}';
  assert.equal(verifyWebhook(SECRET, signed(body), body), true);
  const other = "whsec_" + Buffer.alloc(32, 9).toString("base64");
  assert.equal(
    verifyWebhook(SECRET, signed(body, { secret: other }), body),
    false,
  );
  assert.equal(verifyWebhook(SECRET, signed(body), body + " "), false);
  const old = Math.floor(Date.now() / 1000) - 301;
  assert.equal(verifyWebhook(SECRET, signed(body, { ts: old }), body), false);
  assert.equal(verifyWebhook(SECRET, { "webhook-id": "x" }, body), false);
});

test("the listener wakes on a valid ring and refuses everything else", async (t) => {
  let wakes = 0;
  const listener = await startWakeListener({
    port: 0,
    secret: SECRET,
    onWake: () => wakes++,
  });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.port}/wake`;
  const body = '{"to":"hermes@hermes.hab"}';
  const ok = await globalThis.fetch(url, {
    method: "POST",
    headers: signed(body),
    body,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {});
  assert.equal(wakes, 1);
  const bad = await globalThis.fetch(url, {
    method: "POST",
    headers: { ...signed(body), "webhook-signature": "v1,AAAA" },
    body,
  });
  assert.equal(bad.status, 401);
  assert.equal((await globalThis.fetch(url)).status, 405);
  const big = "x".repeat(20_000);
  await globalThis
    .fetch(url, { method: "POST", headers: signed(big), body: big })
    .catch(() => {});
  assert.equal(wakes, 1);
});

test("a ring ends the current sleep, and a ring during a check ends the next one at once", async () => {
  const timer = wakeableSleep();
  const started = Date.now();
  const sleeping = timer.sleep(10_000);
  timer.ring();
  assert.equal(await sleeping, "rung");
  assert.ok(Date.now() - started < 1000);
  timer.ring();
  assert.equal(await timer.sleep(10_000), "rung");
  assert.equal(await timer.sleep(20), "interval");
});

test("the wake key must be a whsec_ key in an owner-only file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "wake.secret");
  writeFileSync(file, SECRET + "\n", { mode: 0o600 });
  assert.equal(readWakeSecret(file), SECRET);
  chmodSync(file, 0o644);
  assert.throws(() => readWakeSecret(file), /wake_secret_unsafe/);
  chmodSync(file, 0o600);
  writeFileSync(file, "bearer-token-value");
  assert.throws(() => readWakeSecret(file), /wake_secret_invalid/);
  assert.throws(() =>
    startWakeListener({ port: 0, secret: "plain", onWake() {} }),
  );
});

const BINDING = { address: "hermes@hermes.hab", session: "bound-session" };

function ringBody(overrides = {}) {
  return JSON.stringify({
    name: HAB_EVENT_NAME,
    data: { to: BINDING.address, session: BINDING.session, ...overrides },
  });
}

function ring(port, body) {
  return globalThis.fetch("http://127.0.0.1:" + port + "/wake", {
    method: "POST",
    headers: signed(body),
    body,
  });
}

test("only a matching signed ring for a gone session is answered 410", async (t) => {
  const answers = ["session_gone", "accepted", undefined];
  const thrown = [];
  const listener = await startWakeListener({
    port: 0,
    secret: SECRET,
    binding: BINDING,
    onWake: async () => {
      if (!answers.length) {
        thrown.push(1);
        throw new Error("probe crashed");
      }
      return answers.shift();
    },
  });
  t.after(() => listener.close());
  const gone = await ring(listener.port, ringBody());
  assert.equal(gone.status, 410);
  assert.deepEqual(await gone.json(), { reason: "session_gone" });
  const accepted = await ring(listener.port, ringBody());
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {});
  for (let index = 0; index < 2; index++) {
    const unknown = await ring(listener.port, ringBody());
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { reason: "session_unconfirmed" });
  }
  assert.equal(thrown.length, 1);
});

test("signed rings without the configured address and session cannot report presence", async (t) => {
  const listener = await startWakeListener({
    port: 0,
    secret: SECRET,
    binding: BINDING,
    onWake: () => "session_gone",
  });
  t.after(() => listener.close());
  for (const body of [
    ringBody({ to: "other@hermes.hab" }),
    ringBody({ session: "other-session" }),
    ringBody({ session: undefined }),
    '{"to":"hermes@hermes.hab"}',
    '{"type":"verification","challenge":"fixture"}',
  ]) {
    const response = await ring(listener.port, body);
    assert.equal(response.status, 200, body);
    assert.deepEqual(await response.json(), { reason: "session_unconfirmed" });
  }
  const unbound = await startWakeListener({
    port: 0,
    secret: SECRET,
    binding: { address: undefined, session: BINDING.session },
    onWake: () => "session_gone",
  });
  t.after(() => unbound.close());
  const response = await ring(unbound.port, ringBody());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reason: "session_unconfirmed" });
});

test("the session probe trusts only an explicit gone or present", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name, source) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return { command: [process.execPath, file], cwd: dir };
  };
  const echo = script(
    "echo.mjs",
    `let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const { session_id } = JSON.parse(raw);
  console.log("noise");
  console.log(JSON.stringify({ result: session_id === "alive" ? "present" : "gone" }));
});`,
  );
  assert.equal(await sessionProbe(echo, "alive", { reuseMs: 0 })(), "present");
  assert.equal(await sessionProbe(echo, "ended", { reuseMs: 0 })(), "gone");
  const odd = script(
    "odd.mjs",
    'console.log(JSON.stringify({result:"maybe"}))',
  );
  assert.equal(await sessionProbe(odd, "x")(), "unknown");
  const fails = script(
    "fails.mjs",
    'console.log(JSON.stringify({result:"gone"})); process.exit(3)',
  );
  assert.equal(await sessionProbe(fails, "x")(), "unknown");
  const slow = script(
    "slow.mjs",
    'process.on("SIGTERM", () => {}); setTimeout(() => console.log(JSON.stringify({result:"gone"})), 60_000)',
  );
  const started = Date.now();
  assert.equal(
    await sessionProbe({ ...slow, timeout_ms: 300_000 }, "x")(),
    "unknown",
  );
  assert.ok(Date.now() - started < 5000);
});

test("a ring and the check it starts run the probe once; a later check asks again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const counter = join(dir, "count");
  const file = join(dir, "count.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
console.log(JSON.stringify({ result: "present" }));`,
  );
  let now = 0;
  const probe = sessionProbe(
    { command: [process.execPath, file], cwd: dir },
    "s",
    { now: () => now },
  );
  await probe();
  now = 1000;
  await probe();
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(counter, "utf8"), "x");
  now = 60_000;
  await probe();
  assert.equal(readFileSync(counter, "utf8"), "xx");
});
