import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  installCiNats,
  type InstallerResult,
} from "../../scripts/install-ci-nats.ts";

const httpFailure = (status: number) => ({
  status: 1,
  stdout: "",
  stderr: `Error: official server download failed ${status}\n`,
});
const success = { status: 0, stdout: '{"binary":"verified"}\n', stderr: "" };
// Pinned Node 26 diagnostic observed in main's Design CI run 42472004750.
const refusedStreamFailure = {
  status: 1,
  stdout: "",
  stderr: `[TypeError: fetch failed] {
  [cause]: Error [ERR_HTTP2_STREAM_ERROR]: Stream closed with error code NGHTTP2_REFUSED_STREAM
      at ClientHttp2Stream._destroy (node:internal/http2/core:2544:13) {
    code: 'ERR_HTTP2_STREAM_ERROR',
    http2ErrorCode: 7
  }
}
`,
};

test("HTTP/2 REFUSED_STREAM shares the existing bounded retry budget", async () => {
  const results = [
    refusedStreamFailure,
    httpFailure(504),
    refusedStreamFailure,
    success,
  ];
  const delays: number[] = [];
  assert.equal(
    await installCiNats(
      () => {
        const next = results.shift();
        assert.ok(next, "unexpected extra installation attempt");
        return next;
      },
      async (delay) => delays.push(delay),
      () => {},
    ),
    success.stdout,
  );
  assert.equal(results.length, 0);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test("persistent HTTP/2 REFUSED_STREAM fails after four attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    installCiNats(
      () => {
        attempts += 1;
        return refusedStreamFailure;
      },
      async (delay) => delays.push(delay),
      () => {},
    ),
    (error: unknown) =>
      error instanceof Error && error.cause === refusedStreamFailure,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test("the real CLI reports a child spawn failure without retrying", () => {
  const directory = mkdtempSync(join(tmpdir(), "hab-ci-spawn-"));
  try {
    const setup = `process.execPath = ${JSON.stringify(join(directory, "missing-node"))}`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(setup)}`,
        fileURLToPath(
          new URL("../../scripts/install-ci-nats.ts", import.meta.url),
        ),
      ],
      { cwd: directory, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /retrying/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real CLI refuses a corrupt cached archive before extraction", () => {
  const directory = mkdtempSync(join(tmpdir(), "hab-ci-nats-"));
  try {
    mkdirSync(join(directory, ".runtime"), { mode: 0o700 });
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    writeFileSync(
      join(
        directory,
        ".runtime",
        `nats-server-v2.15.2-${process.platform}-${arch}.tar.gz`,
      ),
      "unverified cache bytes",
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/install-ci-nats.ts", import.meta.url),
        ),
      ],
      { cwd: directory, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /server archive SHA-256 mismatch/);
    assert.doesNotMatch(result.stderr, /retrying/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transient HTTP failures retry and preserve successful installer output", async () => {
  const results = [
    httpFailure(504),
    httpFailure(503),
    httpFailure(429),
    success,
  ];
  const delays: number[] = [];
  const messages: string[] = [];
  assert.equal(
    await installCiNats(
      () => {
        const next = results.shift();
        assert.ok(next, "unexpected extra installation attempt");
        return next;
      },
      async (delay) => delays.push(delay),
      (message) => messages.push(message),
    ),
    success.stdout,
  );
  assert.equal(results.length, 0);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(messages.length, 3);
});

test("a persistent 504 fails after four attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    installCiNats(
      () => {
        attempts += 1;
        return httpFailure(504);
      },
      async (delay) => delays.push(delay),
      () => {},
    ),
    (error: unknown) =>
      error instanceof Error &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "stderr" in error.cause &&
      error.cause.stderr === httpFailure(504).stderr,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test("408, 500 and 502 each recover on the next attempt", async () => {
  for (const status of [408, 500, 502]) {
    const results = [httpFailure(status), success];
    const delays: number[] = [];
    assert.equal(
      await installCiNats(
        () => {
          const next = results.shift();
          assert.ok(next, "unexpected extra installation attempt");
          return next;
        },
        async (delay) => delays.push(delay),
        () => {},
      ),
      success.stdout,
    );
    assert.equal(results.length, 0);
    assert.deepEqual(delays, [1000]);
  }
});

const failures: InstallerResult[] = [
  httpFailure(403),
  httpFailure(404),
  { status: 1, stderr: "Error: server archive SHA-256 mismatch\n" },
  { status: 1, stderr: "Error: server version mismatch\n" },
  { status: null, error: Error("spawn failed") },
  { status: null, signal: "SIGTERM", stderr: httpFailure(504).stderr },
  {
    status: 1,
    stderr: refusedStreamFailure.stderr.replace(
      "http2ErrorCode: 7",
      "http2ErrorCode: 8",
    ),
  },
  {
    status: 1,
    stderr: refusedStreamFailure.stderr.replace(
      "http2ErrorCode: 7",
      "http2ErrorCode: 70",
    ),
  },
  {
    status: 1,
    stderr: "[TypeError: fetch failed] { code: 'CERT_HAS_EXPIRED' }\n",
  },
];
for (const failure of failures) {
  test(`permanent failure is not retried: ${failure.stderr ?? failure.error}`, async () => {
    let attempts = 0;
    await assert.rejects(
      installCiNats(
        () => {
          attempts += 1;
          return failure;
        },
        async () => assert.fail("must not wait"),
        () => assert.fail("must not report retry"),
      ),
    );
    assert.equal(attempts, 1);
  });
}
