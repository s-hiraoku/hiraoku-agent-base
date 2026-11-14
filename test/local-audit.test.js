import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAudit } from "../src/local-audit.ts";

// The host audit keeps a fixed refusal reason on tool errors only, never bodies or secrets.
test("a tool error keeps its fixed reason; other categories and free text are refused", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "local-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audit = new LocalAudit(join(dir, "audit"));
  const id = "11111111-1111-4111-8111-111111111111";
  audit.record("tool_error", id, "kind_not_allowed");
  audit.record("tool_error", id);
  for (const [category, reason] of [
    ["tool_succeeded", "kind_not_allowed"],
    ["tool_error", "Contains Secret text"],
    ["tool_error", "x".repeat(49)],
  ])
    assert.throws(
      () => audit.record(category, id, reason),
      /Invalid audit event/,
    );
  const lines = readFileSync(join(dir, "audit", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((line) => line.correlation === id);
  assert.deepEqual(
    lines.map((line) => [line.category, line.reason]),
    [
      ["tool_error", "kind_not_allowed"],
      ["tool_error", undefined],
    ],
  );
});

test("authenticated keeps only a registered connection ID, written as connection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "local-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audit = new LocalAudit(join(dir, "audit"));
  const id = "22222222-2222-4222-8222-222222222222";
  audit.record("authenticated", id, "dots-chatgpt.v2");
  audit.record("authenticated", id);
  for (const value of ["has space", "Bearer abc", "x".repeat(129), "-lead"])
    assert.throws(
      () => audit.record("authenticated", id, value),
      /Invalid audit event/,
    );
  const lines = readFileSync(join(dir, "audit", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((line) => line.correlation === id);
  assert.deepEqual(
    lines.map(({ category, connection, reason }) => ({
      category,
      connection,
      reason,
    })),
    [
      {
        category: "authenticated",
        connection: "dots-chatgpt.v2",
        reason: undefined,
      },
      { category: "authenticated", connection: undefined, reason: undefined },
    ],
  );
});
