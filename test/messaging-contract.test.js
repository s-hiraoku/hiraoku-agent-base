import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSubmission,
  comparisonMaterial,
  DELIVERY_TTL_MS,
  MAX_DELIVERY_TTL_MS,
  makeReplayBoundMessageId,
  isReplayBoundMessageId,
  replayBoundSentAt,
} from "../src/messaging/index.ts";

// Test policy only: deployment capacity has deliberately not been selected.
const limits = {
  envelope_bytes: 32768,
  text_bytes: 1000,
  data_bytes: 1000,
  parts: 8,
  json_depth: 20,
  json_nodes: 1000,
};
const message = () => ({
  version: 1,
  message_id: "m-1",
  recipient_id: "recipient-opaque",
  kind: "question",
  body: {
    parts: [
      { type: "text", text: "日本語\r\nそのまま" },
      {
        type: "data",
        schema_id: "example:form",
        schema_version: 1,
        value: { b: [true, null, 2], a: "選択" },
      },
    ],
  },
  thread_id: "thread-1",
  in_reply_to: null,
  first_sent_at: "2030-01-01T00:00:00.000Z",
  expires_at: "2030-01-01T01:00:00.000Z",
});
const attachment = {
  type: "attachment",
  attachment_id: "file-1",
  media_type: "image/png",
  size_bytes: 8000,
  sha256: "a".repeat(64),
  filename: "画像.png",
};
const rejects = (input, code = "invalid_contract", policy = limits) =>
  assert.throws(
    () => parseSubmission(input, policy),
    (e) => e.code === code,
  );

test("public contract preserves multipart order, UTF-8 and arbitrary structured keys", () => {
  const input = message();
  input.body.parts[1].value = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":"literal"}',
  );
  const output = parseSubmission(input, limits);
  assert.equal(output.body.parts[0].text, input.body.parts[0].text);
  assert.deepEqual(
    output.body.parts.map((x) => x.type),
    ["text", "data"],
  );
  assert.equal(output.body.parts[1].value.__proto__.safe, true);
  output.body.parts[0].text = "changed";
  assert.notEqual(input.body.parts[0].text, "changed");
  assert.equal(DELIVERY_TTL_MS, 3600000);
});
test("comparison ignores object key order, preserves part order, sender, deadline and text bytes", () => {
  const original = message();
  const reordered = message();
  reordered.body.parts[1].value = { a: "選択", b: [true, null, 2] };
  const base = comparisonMaterial("sender-a", original, limits);
  assert.equal(base, comparisonMaterial("sender-a", reordered, limits));
  assert.notEqual(base, comparisonMaterial("sender-b", reordered, limits));
  reordered.body.parts.reverse();
  assert.notEqual(base, comparisonMaterial("sender-a", reordered, limits));
  const changed = message();
  changed.body.parts[0].text = changed.body.parts[0].text.replace("\r\n", "\n");
  assert.notEqual(base, comparisonMaterial("sender-a", changed, limits));
  changed.first_sent_at = "2030-01-01T00:00:01.000Z";
  changed.expires_at = "2030-01-01T01:00:01.000Z";
  assert.notEqual(base, comparisonMaterial("sender-a", changed, limits));
});
test("caller identity, unknown control fields and unsupported parts or wire versions are refused", () => {
  rejects({ ...message(), sender_id: "spoofed" });
  rejects({ ...message(), version: 2 }, "unsupported_version");
  const p = message();
  p.body.parts.push({ type: "url", url: "https://example.invalid" });
  rejects(p);
  const q = message();
  q.body.parts[1].url = "https://example.invalid";
  rejects(q);
  rejects({ ...message(), in_reply_to: { message_id: "m-0" } });
});
test("a deadline is after the first send and at most seven days later; invalid dates and optional TTL cannot bypass it", () => {
  rejects({ ...message(), expires_at: "2030-01-08T00:00:00.001Z" });
  rejects({ ...message(), expires_at: "2030-01-01T00:00:00.000Z" });
  rejects({ ...message(), expires_at: "2029-12-31T23:59:59.999Z" });
  rejects({ ...message(), expires_at: "2030-02-30T01:00:00.000Z" });
  rejects({ ...message(), ttl_ms: 1000 });
  assert.equal(
    parseSubmission(
      { ...message(), expires_at: "2030-01-08T00:00:00.000Z" },
      limits,
    ).expires_at,
    "2030-01-08T00:00:00.000Z",
  );
  assert.equal(
    parseSubmission(
      { ...message(), expires_at: "2030-01-01T00:00:01.000Z" },
      limits,
    ).expires_at,
    "2030-01-01T00:00:01.000Z",
  );
});
test("all quota dimensions fail explicitly, measuring UTF-8", () => {
  for (const key of [
    "envelope_bytes",
    "text_bytes",
    "data_bytes",
    "parts",
    "json_depth",
    "json_nodes",
  ])
    rejects(message(), "capacity_exceeded", { ...limits, [key]: 1 });
  const text = message();
  text.body.parts = [{ type: "text", text: "ああ" }];
  rejects(text, "capacity_exceeded", { ...limits, text_bytes: 5 });
  assert.equal(
    parseSubmission(text, { ...limits, text_bytes: 6 }).body.parts[0].text,
    "ああ",
  );
});
test("attachment parts are not part of the contract and are refused in any position", () => {
  for (const at of [0, 1, 2]) {
    const m = message();
    m.body.parts.splice(at, 0, structuredClone(attachment));
    rejects(m);
  }
  const only = message();
  only.body.parts = [structuredClone(attachment)];
  rejects(only);
});
test("former attachment limit keys are rejected as invalid policy", () => {
  for (const key of [
    "attachment_bytes",
    "total_attachment_bytes",
    "attachments",
  ])
    rejects(message(), "invalid_limits", { ...limits, [key]: 1000 });
});
test("cyclic, non-JSON and accessor inputs are rejected without executing user code", () => {
  const m = message();
  m.body.parts[1].value = m;
  rejects(m);
  for (const value of [
    NaN,
    Infinity,
    undefined,
    1n,
    new Date(),
    () => 1,
    [, 1],
  ]) {
    const n = message();
    n.body.parts[1].value = value;
    rejects(n);
  }
  let invoked = false;
  const n = message();
  Object.defineProperty(n, "sender_id", {
    enumerable: true,
    get() {
      invoked = true;
      return "spoof";
    },
  });
  rejects(n);
  assert.equal(invoked, false);
});
test("capacity configuration is mandatory and invalid policy fails closed", () => {
  rejects(message(), "invalid_limits", { ...limits, text_bytes: 0 });
  rejects(message(), "invalid_limits", { ...limits, envelope_bytes: Infinity });
  const p = { ...limits };
  delete p.parts;
  rejects(message(), "invalid_limits", p);
});
test("a replay-bound ID carries its first send time and allows any deadline up to seven days", () => {
  const sent = Date.parse("2030-01-01T00:00:00.000Z");
  const id = makeReplayBoundMessageId(
    "2030-01-01T00:00:00.000Z",
    "a".repeat(32),
  );
  assert.equal(replayBoundSentAt(id), sent);
  assert.equal(isReplayBoundMessageId(id, sent + 3_600_000), true);
  assert.equal(isReplayBoundMessageId(id, sent + MAX_DELIVERY_TTL_MS), true);
  assert.equal(
    isReplayBoundMessageId(id, sent + MAX_DELIVERY_TTL_MS + 1),
    false,
  );
  assert.equal(isReplayBoundMessageId(id, sent), false);
  const week = {
    ...message(),
    message_id: id,
    expires_at: new Date(sent + MAX_DELIVERY_TTL_MS).toISOString(),
  };
  assert.equal(parseSubmission(week, limits).message_id, id);
  // The ID's time must be the message's own first send time.
  rejects({ ...week, first_sent_at: "2030-01-01T00:00:00.001Z" });
});
