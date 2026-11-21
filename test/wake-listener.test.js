import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWebhook } from "../src/hab/events.ts";
import {
  startWakeListener,
  verifyWebhook,
  wakeableSleep,
} from "../src/agent-notify/wake-listener.ts";
import { readWakeSecret } from "../scripts/hab-notify.ts";

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
