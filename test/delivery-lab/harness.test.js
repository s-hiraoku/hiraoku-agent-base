import assert from "node:assert/strict";
import { test } from "node:test";
import {
  labEnvironment,
  tapTotals,
  gateVerdict,
  executeNode,
  assertLoopbackPortFree,
  parseLabOptions,
} from "../../scripts/lib/delivery-lab.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout } from "node:timers";
import { createServer } from "node:net";
import { once } from "node:events";

test("H01 environment excludes real runtime, credentials, proxies and Node injection", () => {
  const env = labEnvironment(
    {
      PATH: "/bin",
      HAB_RUNTIME_CONFIG: "/real/config",
      AUTH0_TOKEN: "real",
      OPENAI_API_KEY: "real",
      HTTPS_PROXY: "http://real",
      NODE_OPTIONS: "--import=/real/code",
      HOME: "/real/home",
    },
    "/scratch",
  );
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "HAB_DELIVERY_LAB",
      "LANG",
      "NO_COLOR",
      "NODE_OPTIONS",
      "PATH",
      "TEMP",
      "TMP",
      "TMPDIR",
      "TZ",
    ].sort(),
  );
  assert.equal(env.TMPDIR, "/scratch");
  assert.equal(env.TZ, "UTC");
  assert.equal(env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");
});

test("H02 missing, empty or contradictory test output cannot turn green", () => {
  const summary =
    "# tests 3\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n";
  assert.equal(tapTotals(summary).skipped, 1);
  assert.throws(() => tapTotals(""));
  assert.throws(() => tapTotals(summary.replace("tests 3", "tests 0")));
  assert.throws(() => tapTotals(summary.replace("pass 2", "pass 1")));
});

test("H03 failures, cancellation, TODO and unimplemented backends block release", () => {
  const pass = {
    id: "one",
    exit_code: 0,
    totals: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  };
  const verdict = (groups, pending, release) =>
    gateVerdict(groups, pending, release, ["one"]);
  assert.equal(verdict([pass], ["a2a"], false), "BASELINE_PASS");
  assert.equal(verdict([pass], ["a2a"], true), "BLOCKED");
  assert.equal(verdict([pass], [], true), "RELEASE_PASS");
  assert.equal(
    verdict([{ ...pass, totals: { ...pass.totals, skipped: 1 } }], [], true),
    "BLOCKED",
  );
  for (const field of ["fail", "cancelled", "todo"])
    assert.equal(
      verdict([{ ...pass, totals: { ...pass.totals, [field]: 1 } }], [], false),
      "FAIL",
    );
  assert.equal(verdict([{ ...pass, exit_code: 1 }], [], false), "FAIL");
  assert.equal(verdict([{ id: "one", exit_code: 0 }], [], false), "FAIL");
  assert.equal(verdict([], [], false), "FAIL");
  assert.equal(gateVerdict([pass], [], false, ["one", "missing"]), "FAIL");
  assert.equal(gateVerdict([pass, pass], [], false, ["one", "two"]), "FAIL");
});

function processFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = labEnvironment(process.env, dir);
  let sequence = 0;
  return {
    async run(source, signal, testMode = true) {
      const file = join(dir, `fixture-${sequence++}.mjs`);
      const log = file + ".tap";
      writeFileSync(file, source, { mode: 0o600 });
      const result = await executeNode({
        cwd: dir,
        env,
        log,
        args: testMode ? ["--test", "--test-reporter=tap", file] : [file],
        signal,
        timeout_ms: 5000,
      });
      return { ...result, output: readFileSync(log, "utf8") };
    },
  };
}

test("H04 real passing, failing and malformed child output produce distinct verdicts", async (t) => {
  const f = processFixture(t);
  const pass = await f.run(
    "import { test } from 'node:test'; test('pass', () => {});",
  );
  assert.equal(pass.exit_code, 0);
  assert.equal(
    gateVerdict(
      [{ id: "child", ...pass, totals: tapTotals(pass.output) }],
      [],
      true,
      ["child"],
    ),
    "RELEASE_PASS",
  );
  const fail = await f.run(
    "import { test } from 'node:test'; test('fail', () => { throw Error('injected'); });",
  );
  assert.equal(fail.exit_code, 1);
  assert.equal(
    gateVerdict(
      [{ id: "child", ...fail, totals: tapTotals(fail.output) }],
      [],
      true,
      ["child"],
    ),
    "FAIL",
  );
  const malformed = await f.run(
    "console.log('malformed output');",
    undefined,
    false,
  );
  assert.equal(malformed.exit_code, 0);
  assert.throws(() => tapTotals(malformed.output));
});

test("H05 cancelling a real child closes it and cannot produce a passing gate", async (t) => {
  const f = processFixture(t);
  const controller = new AbortController();
  const running = f.run(
    "setInterval(() => {}, 1000);",
    controller.signal,
    false,
  );
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const stopped = await running;
    assert.notEqual(stopped.exit_code, 0);
    assert.equal(stopped.signal, "SIGTERM");
    assert.equal(
      gateVerdict([{ id: "child", ...stopped }], [], false, ["child"]),
      "FAIL",
    );
  } finally {
    clearTimeout(timer);
  }
});

test("H06 occupied loopback ports are refused without probing or stopping their owner", async () => {
  let connections = 0;
  const server = createServer(() => {
    connections++;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    await assert.rejects(assertLoopbackPortFree(port), { code: "EADDRINUSE" });
    assert.equal(server.listening, true);
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertLoopbackPortFree(port);
});

test("lab options accept --full and --release once each and nothing else", () => {
  assert.deepEqual(parseLabOptions([]), { full: false, release: false });
  assert.deepEqual(parseLabOptions(["--release"]), {
    full: true,
    release: true,
  });
  assert.deepEqual(parseLabOptions(["--full"]), { full: true, release: false });
  for (const args of [
    ["--full", "--full"],
    ["--"],
    ["/positional"],
    ["--nats-server", "/private/input"],
    ["--cwd", "/production"],
  ])
    assert.throws(
      () => parseLabOptions(args),
      (error) => error.code === "invalid_lab_arguments",
    );
});
