import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { NativeHabStdioPort } from "./native_stdio.ts";

const options = {
  resource_url: "https://hab.example/mcp",
  max_frame_bytes: 4096,
  shutdown_timeout_ms: 100,
};
const peer = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
const frames = new Map();
const send = frame => {
  const encoded = Buffer.from(JSON.stringify(frame) + '\n');
  if (mode === 'fragment') for (const byte of encoded) process.stdout.write(Buffer.from([byte]));
  else process.stdout.write(encoded);
};
if (mode === 'ignore_sigterm') process.on('SIGTERM', () => {});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'call' || frame.type === 'project') {
    frames.set(frame.id, frame);
    if (mode === 'malformed') return process.stdout.write('PRIVATE_PROVIDER_DETAIL\n');
    if (mode === 'oversized') return process.stdout.write('x'.repeat(5000) + '\n');
    if (mode === 'crash') return process.exit(3);
    if (mode === 'wrong_id') return send({ version: 1, type: 'result', id: frame.id + 1, result: '{}' });
    if (mode === 'no_check') return send({ version: 1, type: 'result', id: frame.id, result: '{}' });
    const check = () => send({ version: 1, type: 'check', id: frame.id, check_id: 1 });
    if (mode === 'credential_wait') setTimeout(check, 70);
    else check();
    if (mode === 'duplicate_check') check();
  } else if (frame.type === 'checked') {
    const request = frames.get(frame.id);
    if (!request) process.exit(4);
    if (!frame.allowed) return send({ version: 1, type: 'failure', id: frame.id, reason: request.type === 'project' ? 'projection_failed' : 'native_call_failed' });
    if (mode === 'ignore_sigterm') return;
    const complete = () => {
      const result = request.type === 'project'
        ? JSON.stringify({ projected: true, event_id: 'event-fixture' })
        : JSON.stringify({ content: [{type:'text',text:'{"delivery":null,"label":"受信"}'}], structuredContent: {delivery:null,label:'受信'} });
      send({ version: 1, type: 'result', id: frame.id, result });
    };
    if (mode === 'late') setTimeout(complete, 100);
    else complete();
  }
});
`;
function start(t, mode = "normal", patch = {}) {
  const port = NativeHabStdioPort.start({
    ...options,
    command: process.execPath,
    args: ["-e", peer, mode],
    cwd: process.cwd(),
    env: {},
    ...patch,
  });
  t.after(async () => port.close());
  return port;
}
function control(check = () => {}, controller = new AbortController()) {
  return { signal: controller.signal, check };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("fixture_did_not_reach_expected_state");
}

test("Native stdio: explicit child has fixed HAB tools and guarded requests", async (t) => {
  const port = start(t);
  let checked = 0;
  const guard = control(() => {
    checked++;
  });
  assert.equal(port.version, 1);
  assert.equal(port.resource_url, options.resource_url);
  const result = JSON.parse(
    await port.callTool("hab_poll", { as_address: "worker@demo.hab" }, guard),
  );
  assert.equal(result.structuredContent.delivery, null);
  assert.equal(checked, 3); // local admission, peer RPC boundary, final settlement
  assert.equal(port.activeRequests, 0);
  for (const name of ['hab_submit','hab_status']) {
    const value=JSON.parse(await port.callTool(name,{},guard));
    assert.equal(value.structuredContent.delivery,null);
  }
  await assert.rejects(port.callTool("hab_register", {}, guard), {code: "native_stdio_forbidden"});

});

test("Native stdio: fragmented multibyte frames preserve exact result strings", async (t) => {
  const port = start(t, "fragment");
  const result = await port.callTool("hab_poll", {}, control());
  assert.equal(JSON.parse(result).structuredContent.label, "受信");
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: guard is checked again after native credential wait", async (t) => {
  const port = start(t, "credential_wait");
  let allowed = true,
    checks = 0;
  const pending = port.callTool(
    "hab_poll",
    {},
    control(() => {
      checks++;
      if (!allowed) throw new Error("PRIVATE_ACTOR_DETAIL");
    }),
  );
  const outcome = assert.rejects(pending, { code: "native_call_failed" });
  allowed = false;
  await outcome;
  assert.equal(checks, 2);
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: abort terminates only the owned child and retains admission until actual exit", async (t) => {
  const port = start(t, "late");
  const controller = new AbortController();
  let checks = 0,
    settled = false;
  const pending = port.callTool(
    "hab_poll",
    {},
    control(() => {
      checks++;
    }, controller),
  );
  const outcome = assert.rejects(pending, { code: "native_stdio_cancelled" });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitUntil(() => checks >= 2);
  controller.abort();
  assert.equal(port.activeRequests, 1);
  assert.equal(settled, false);
  await assert.rejects(port.callTool("hab_poll", {}, control()), {
    code: "native_stdio_closed",
  });
  await outcome;
  await port.close();
  assert.equal(port.activeRequests, 0);
  assert.equal(settled, true);
});

test("Native stdio: malformed, oversized, stale and duplicate frames fail closed without exposing content", async (t) => {
  for (const mode of [
    "malformed",
    "oversized",
    "wrong_id",
    "duplicate_check",
  ]) {
    const port = start(t, mode);
    await assert.rejects(
      port.callTool("hab_poll", {}, control()),
      (error) => error.message === "native_stdio_failed",
    );
    await port.close();
    assert.equal(port.activeRequests, 0);
    await assert.rejects(port.callTool("hab_poll", {}, control()), {
      code: "native_stdio_closed",
    });
  }
});

test("Native stdio: result without a guard cannot become native receive success", async (t) => {
  const port = start(t, "no_check");
  await assert.rejects(port.callTool("hab_poll", {}, control()), {
    code: "native_stdio_cancelled",
  });
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: child exit settles uncertain work and close does not target any other process", async (t) => {
  const port = start(t, "crash");
  await assert.rejects(port.callTool("hab_ack", {}, control()), (error) =>
    ["native_stdio_failed", "native_stdio_closed"].includes(error.code),
  );
  await port.close();
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: owned child which ignores SIGTERM is closed before admission is released", async (t) => {
  const child = spawn(process.execPath, ["-e", peer, "ignore_sigterm"], {
    cwd: process.cwd(),
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  const port = new NativeHabStdioPort(child, {
    ...options,
    shutdown_timeout_ms: 20,
  });
  t.after(async () => port.close());
  let checks = 0;
  const pending = port.callTool(
    "hab_poll",
    {},
    control(() => {
      checks++;
    }),
  );
  const outcome = assert.rejects(pending, (error) =>
    ["native_stdio_closed", "native_stdio_failed"].includes(error.code),
  );
  await waitUntil(() => checks >= 2);
  assert.equal(port.activeRequests, 1);
  await port.close();
  await outcome;
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: outbound oversized request refuses before dispatch without breaking the native session", async (t) => {
  const port = start(t, "normal", { max_frame_bytes: 512 });
  await assert.rejects(
    port.callTool("hab_poll", { injected: "x".repeat(600) }, control()),
    { code: "native_stdio_frame_limit" },
  );
  assert.equal(port.activeRequests, 0);
  await port.callTool("hab_poll", {}, control());
  assert.equal(port.activeRequests, 0);
});

test("Native stdio: unsafe or incomplete launch configuration fails before spawning", () => {
  const valid = {
    ...options,
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: {},
  };
  for (const patch of [
    { command: "relative-python" },
    { cwd: "relative" },
    { resource_url: "https://hab.example/mcp?token=x" },
    { max_frame_bytes: 0 },
    { shutdown_timeout_ms: 0 },
    { env: { TOKEN: "bad\0value" } },
  ]) {
    assert.throws(() => NativeHabStdioPort.start({ ...valid, ...patch }), {
      code: "invalid_native_stdio_composition",
    });
  }
});

test("Native stdio: cancellation interrupts a stuck credential wait with no further peer checks", async (t) => {
  const port = start(t, "ignore_sigterm");
  const controller = new AbortController(); let checks = 0;
  const pending = port.callTool("hab_status", {}, control(() => { checks++; }, controller));
  const outcome = assert.rejects(pending, {code:"native_stdio_cancelled"});
  await waitUntil(() => checks >= 2);
  controller.abort();
  assert.equal(port.activeRequests, 1);
  await outcome;
  assert.equal(port.activeRequests, 1);
  await port.close();
  assert.equal(port.activeRequests, 0);
  assert.equal(port.failed, true);
});
