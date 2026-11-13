import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const refusals = [
  {
    name: "hab-relay",
    args: [],
    status: 1,
    diagnostic: /reason=config_required/,
  },
  {
    name: "hab-relay-admin",
    args: [],
    status: 2,
    diagnostic: /relay_admin_rejected usage/,
  },
  {
    name: "native-trial-preflight",
    args: [],
    status: 1,
    diagnostic: /invalid_or_unreadable_trial_plan/,
  },
  { name: "hab-enrollment-demo", args: [], status: 1, diagnostic: /Usage:/ },
];

for (const { name, args, status, diagnostic } of refusals) {
  test(`${name}: TypeScript and legacy CLI preserve refusal status and output`, () => {
    const run = (extension: string) => {
      const result = spawnSync(
        process.execPath,
        [`scripts/${name}.${extension}`, ...args],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, status);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, diagnostic);
      return result.stderr;
    };
    assert.equal(run("mjs"), run("ts"));
  });
}

test("enrollment demo resumes on both entry points using disposable synthetic state", () => {
  for (const extension of ["ts", "mjs"]) {
    const result = spawnSync(
      process.execPath,
      [`scripts/hab-enrollment-demo.${extension}`, "--simulate"],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /再開後の模擬確認: activate research@grok-bot\.hab/,
    );
    assert.match(
      result.stdout,
      /模擬登録完了: research@grok-bot\.hab \/ active/,
    );
  }
});

test("importing the legacy operator modules preserves exports without starting a CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { main as relay } from "./scripts/hab-relay.mjs";
    import { main as admin } from "./scripts/hab-relay-admin.mjs";
    for (const entry of [relay, admin]) assert.equal(typeof entry, "function");
  `,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
