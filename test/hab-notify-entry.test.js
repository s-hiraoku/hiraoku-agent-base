import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { freePort } from "./free-port.js";

// The CLI is started as a program, the way launchd starts it. Imported as a module (as
// other tests do) its top-level `await main()` never runs, so a cycle through it hides.
const cli = resolve("scripts/hab-notify.ts");
const jwt = (payload) =>
  [
    "e30",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "hab-notify-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function start(args, env = {}) {
  const child = spawn(process.execPath, ["--no-warnings", cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  const exited = once(child, "exit").then(([code, signal]) => ({
    code,
    signal,
  }));
  return { child, exited, output: () => out };
}
const listening = (port) =>
  new Promise((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });

test("hab-notify run started as a program reaches its wake listener instead of exiting 13", async (t) => {
  const dir = setup(t);
  const port = await freePort();
  const secretFile = join(dir, "wake.secret");
  writeFileSync(secretFile, "whsec_" + Buffer.alloc(32, 3).toString("base64"), {
    mode: 0o600,
  });
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      token: { env: "HAB_NOTIFY_ENTRY_TOKEN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "entry-test:session",
      },
      interval_ms: 60_000,
      wake: { port, secret_file: secretFile },
    }),
  );
  const run = start(["--config", config, "run"], {
    HAB_NOTIFY_ENTRY_TOKEN: jwt({ exp: 1 }),
  });
  t.after(() => run.child.kill("SIGKILL"));
  let ended;
  run.exited.then((result) => (ended = result));
  let up = false;
  for (const deadline = Date.now() + 15_000; !up && Date.now() < deadline;) {
    if (ended)
      assert.fail(
        `run ended before listening: ${JSON.stringify(ended)} ${run.output()}`,
      );
    up = await listening(port);
    if (!up) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(up, `run listened on ${port}: ${run.output()}`);
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.exited, { code: 0, signal: null }, run.output());
});

test("hab-notify units started as a program prints its session and exits 0", async (t) => {
  const dir = setup(t);
  const config = join(dir, "notify.json");
  writeFileSync(
    config,
    JSON.stringify({
      hab_url: "https://hab.example/mcp",
      agent_id: "agent-b",
      as_address: "hermes@hermes.hab",
      token: { env: "HAB_NOTIFY_ENTRY_TOKEN" },
      store: join(dir, "notices.sqlite"),
      screen: {
        type: "jsonl",
        path: join(dir, "screen.jsonl"),
        target: "entry-test:session",
      },
    }),
  );
  const units = start(["--config", config, "units"], {
    HAB_NOTIFY_ENTRY_TOKEN: jwt({ exp: 1 }),
  });
  const result = await units.exited;
  assert.notEqual(result.code, 13, "a top-level await that never settled");
  assert.equal(result.code, 0, units.output());
  assert.ok(units.output().trim().length > 0, "units printed something");
});
