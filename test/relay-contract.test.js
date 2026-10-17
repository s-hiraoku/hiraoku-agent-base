import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSubmission,
  comparisonMaterial,
  DELIVERY_TTL_MS,
} from "../src/relay/index.ts";

// Test policy only: deployment capacity has deliberately not been selected.
const limits = {
  envelope_bytes: 32768,
  text_bytes: 1000,
  data_bytes: 1000,
  attachment_bytes: 10000,
  total_attachment_bytes: 15000,
  parts: 8,
  attachments: 3,
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
        type: "attachment",
        attachment_id: "file-1",
        media_type: "image/png",
        size_bytes: 8000,
        sha256: "a".repeat(64),
        filename: "画像.png",
      },
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
const rejects = (input, code = "invalid_contract", policy = limits) =>
  assert.throws(
    () => parseSubmission(input, policy),
    (e) => e.code === code,
  );

test("public contract preserves multipart order, UTF-8, binary references and arbitrary structured keys", () => {
  const input = message();
  input.body.parts[2].value = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":"literal"}',
  );
  const output = parseSubmission(input, limits);
  assert.equal(output.body.parts[0].text, input.body.parts[0].text);
  assert.deepEqual(
    output.body.parts.map((x) => x.type),
    ["text", "attachment", "data"],
  );
  assert.equal(output.body.parts[2].value.__proto__.safe, true);
  output.body.parts[0].text = "changed";
  assert.notEqual(input.body.parts[0].text, "changed");
  assert.equal(DELIVERY_TTL_MS, 3600000);
});
test("comparison ignores object key order, preserves part order, sender, deadline and text bytes", () => {
  const original = message();
  const reordered = message();
  reordered.body.parts[2].value = { a: "選択", b: [true, null, 2] };
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
test("one-hour lifetime is exact; invalid dates and optional TTL cannot bypass it", () => {
  rejects({ ...message(), expires_at: "2030-01-01T01:00:00.001Z" });
  rejects({ ...message(), expires_at: "2030-02-30T01:00:00.000Z" });
  rejects({ ...message(), ttl_ms: 1000 });
});
test("all quota dimensions fail explicitly, measuring UTF-8 and aggregate attachments", () => {
  for (const key of [
    "envelope_bytes",
    "text_bytes",
    "data_bytes",
    "attachment_bytes",
    "total_attachment_bytes",
    "parts",
    "json_depth",
    "json_nodes",
  ])
    rejects(message(), "capacity_exceeded", { ...limits, [key]: 1 });
  const m = message();
  m.body.parts.push({ ...m.body.parts[1], attachment_id: "file-2" });
  rejects(m, "capacity_exceeded");
  rejects(m, "capacity_exceeded", {
    ...limits,
    total_attachment_bytes: 20000,
    attachments: 1,
  });
  const text = message();
  text.body.parts = [{ type: "text", text: "ああ" }];
  rejects(text, "capacity_exceeded", { ...limits, text_bytes: 5 });
  assert.equal(
    parseSubmission(text, { ...limits, text_bytes: 6 }).body.parts[0].text,
    "ああ",
  );
});
test("invalid attachment metadata and unsafe file names are refused without fetching anything", () => {
  for (const patch of [
    { size_bytes: -1 },
    { sha256: "wrong" },
    { media_type: "image/png\r\nX:evil" },
    { filename: "../secret" },
    { filename: ".." },
  ]) {
    const m = message();
    Object.assign(m.body.parts[1], patch);
    rejects(m);
  }
});
test("cyclic, non-JSON and accessor inputs are rejected without executing user code", () => {
  const m = message();
  m.body.parts[2].value = m;
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
    n.body.parts[2].value = value;
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
