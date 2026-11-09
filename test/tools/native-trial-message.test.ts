import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkNativeTrialMessage,
  prepareNativeTrialMessage,
} from "../../scripts/lib/native-trial-message.ts";
import {
  DELIVERY_TTL_MS,
  parseSubmission,
} from "../../src/messaging/contract.ts";

const limits = {
  envelope_bytes: 8192,
  text_bytes: 1024,
  data_bytes: 1024,
  parts: 4,
  json_depth: 16,
  json_nodes: 100,
};
const template = {
  recipient_id: "synthetic-recipient",
  kind: "answer",
  body: { parts: [{ type: "text", text: "synthetic reply" }] },
  thread_id: "synthetic-thread",
  in_reply_to: {
    sender_id: "synthetic-sender",
    message_id: "synthetic-question",
  },
};
const at = Date.parse("2030-01-02T03:04:05.043Z");
const entropy = () => "a".repeat(32);
const command = new URL(
  "../../scripts/native-trial-message.ts",
  import.meta.url,
);
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [fileURLToPath(command), ...args], {
    encoding: "utf8",
  });

test("trial producer samples the clock once even when the next sample advances 1 ms", () => {
  let reads = 0;
  const message = prepareNativeTrialMessage(template, limits, {
    now: () => at + reads++,
    entropy,
  });
  assert.equal(reads, 1);
  assert.equal(message.first_sent_at, new Date(at).toISOString());
  assert.equal(Date.parse(message.expires_at), at + DELIVERY_TTL_MS);
  assert.deepEqual(parseSubmission(message, limits), message);
  assert.deepEqual(message.in_reply_to, template.in_reply_to);
});

test("saved 1 ms ID/timestamp mismatch is rejected without changing the intent", () => {
  const message = prepareNativeTrialMessage(template, limits, {
    now: () => at,
    entropy,
  });
  message.message_id = `rm1.${at + 1}.${entropy()}`;
  const original = structuredClone(message);
  assert.throws(() => checkNativeTrialMessage(message, limits, () => at), {
    code: "invalid_contract",
  });
  assert.deepEqual(message, original);
});

test("preparation refuses a saved intent and check rejects the exact expiry boundary", () => {
  const message = prepareNativeTrialMessage(template, limits, {
    now: () => at,
    entropy,
  });
  assert.throws(() => prepareNativeTrialMessage(message, limits));
  assert.deepEqual(
    checkNativeTrialMessage(message, limits, () => at + DELIVERY_TTL_MS - 1),
    message,
  );
  assert.throws(
    () => checkNativeTrialMessage(message, limits, () => at + DELIVERY_TTL_MS),
    /trial_message_expired/,
  );
});

test("offline CLI prepares and checks a private new artifact without overwriting files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hab-trial-message-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "template.json"),
    policy = join(dir, "limits.json"),
    output = join(dir, "message.json");
  writeFileSync(input, JSON.stringify(template));
  writeFileSync(policy, JSON.stringify(limits));
  const prepared = cli("prepare", input, policy, output);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout), {
    prepared: true,
    submitted: false,
  });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const before = readFileSync(output, "utf8");
  const checked = cli("check", output, policy);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), {
    schema_valid: true,
    unexpired: true,
    authorization_verified: false,
    submitted: false,
  });
  assert.equal(cli("prepare", input, policy, output).status, 1);
  assert.equal(readFileSync(output, "utf8"), before);
  const message = JSON.parse(before);
  message.message_id = message.message_id.replace(
    String(Date.parse(message.first_sent_at)),
    String(Date.parse(message.first_sent_at) + 1),
  );
  writeFileSync(output, JSON.stringify(message));
  const invalidBefore = readFileSync(output, "utf8");
  const rejected = cli("check", output, policy);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.trim(), "invalid_contract");
  assert.equal(rejected.stdout, "");
  assert.equal(readFileSync(output, "utf8"), invalidBefore);
});

for (const failure of ["empty", "partial", "fsync", "close"]) {
  test(`offline CLI identifies and preserves output after ${failure} failure`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hab-trial-write-failure-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const input = join(dir, "template.json"),
      policy = join(dir, "limits.json"),
      output = join(dir, "failed-message.json");
    writeFileSync(input, JSON.stringify(template));
    writeFileSync(policy, JSON.stringify(limits));
    // Patch builtins only in this synthetic child, without a production fault hook.
    const preload = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const failure = ${JSON.stringify(failure)};
      const write = fs.writeFileSync;
      const close = fs.closeSync;
      const open = fs.openSync;
      let outputFd;
      fs.openSync = (...args) => {
        const fd = open(...args);
        if (args[0] === ${JSON.stringify(output)} && args[1] === "wx") outputFd = fd;
        return fd;
      };
      const fail = () => { throw Error("synthetic I/O failure"); };
      if (failure === "fsync") fs.fsyncSync = fail;
      else if (failure === "close") fs.closeSync = (fd) => {
        close(fd);
        if (fd === outputFd) fail();
      };
      else fs.writeFileSync = (fd, data) => {
        if (failure === "partial") write(fd, data.slice(0, 12));
        fail();
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(command), "prepare", input, policy, output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.error, "trial_message_output_write_failed");
    assert.equal(diagnostic.output_path, output);
    assert.equal(diagnostic.submitted, false);
    assert.match(diagnostic.recovery, /Do not submit/);
    assert.match(diagnostic.recovery, /new unused output path/);
    const retained = readFileSync(output, "utf8");
    assert.equal(statSync(output).mode & 0o777, 0o600);
    if (failure === "empty") assert.equal(retained, "");
    else if (failure === "partial") assert.equal(retained.length, 12);
    else assert.doesNotThrow(() => JSON.parse(retained));
    const retry = cli("prepare", input, policy, output);
    assert.equal(retry.status, 1);
    assert.equal(retry.stderr.trim(), "invalid_or_unreadable_trial_message");
    assert.equal(readFileSync(output, "utf8"), retained);
    const fresh = cli("prepare", input, policy, join(dir, "fresh-message.json"));
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(readFileSync(input, "utf8"), JSON.stringify(template));
  });
}
