import assert from "node:assert/strict";
import { test } from "node:test";
import { installCiNats } from "../../scripts/install-ci-nats.mjs";

const httpFailure = (status) => ({
  status: 1,
  stdout: "",
  stderr: `Error: official server download failed ${status}\n`,
});
const success = { status: 0, stdout: '{"binary":"verified"}\n', stderr: "" };

test("transient HTTP failures retry and preserve successful installer output", async () => {
  const results = [httpFailure(504), httpFailure(503), httpFailure(429), success];
  const delays = [];
  const messages = [];
  assert.equal(
    await installCiNats(
      () => results.shift(),
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
  const delays = [];
  await assert.rejects(
    installCiNats(
      () => {
        attempts += 1;
        return httpFailure(504);
      },
      async (delay) => delays.push(delay),
      () => {},
    ),
    (error) => error.cause.stderr === httpFailure(504).stderr,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

for (const failure of [
  httpFailure(403),
  httpFailure(404),
  { status: 1, stderr: "Error: server archive SHA-256 mismatch\n" },
  { status: 1, stderr: "Error: server version mismatch\n" },
  { status: null, error: Error("spawn failed") },
  { status: null, signal: "SIGTERM", stderr: httpFailure(504).stderr },
]) {
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
