import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  portableInputJsonSchema,
  publishedInputSchema,
} from "../src/host/mcp/published-schema.ts";
import { habDiscoverySchema } from "../src/hab/discovery.ts";

test("a discriminated union is published as one object with an action enum", () => {
  const json = portableInputJsonSchema(habDiscoverySchema);
  assert.equal(json.type, "object");
  assert.equal("oneOf" in json || "anyOf" in json || "$schema" in json, false);
  assert.deepEqual(json.properties.action.enum, [
    "whoami",
    "directory",
    "check_address",
  ]);
  assert.deepEqual(json.required, ["action"]);
  assert.equal(json.additionalProperties, false);
  assert.match(
    json.properties.address.description,
    /Required with action check_address/,
  );
  assert.match(
    json.properties.limit.description,
    /Optional with action directory/,
  );
});

test("JavaScript end-of-input lookaheads become a plain $ and nothing else changes", () => {
  const schema = z.strictObject({
    id: z
      .string()
      .regex(/^[a-z]+$(?![\s\S])/)
      .describe("An id."),
  });
  const json = portableInputJsonSchema(schema);
  assert.equal(json.properties.id.pattern, "^[a-z]+$");
  assert.equal(json.properties.id.description, "An id.");
  assert.deepEqual(json.required, ["id"]);
});

test("validation stays the strict zod schema, not the published flat one", async () => {
  const wrapped = publishedInputSchema(habDiscoverySchema)["~standard"];
  const ok = await wrapped.validate({ action: "directory" });
  assert.deepEqual(ok.value, { action: "directory", limit: 25 });
  // Fields from another action are refused even though the flat schema lists them.
  const mixed = await wrapped.validate({
    action: "whoami",
    address: "a@b.hab",
  });
  assert.ok(mixed.issues?.length);
  // The lookahead still refuses a trailing newline that a plain $ might allow.
  const newline = await wrapped.validate({
    action: "check_address",
    address: "a@b.hab\n",
  });
  assert.ok(newline.issues?.length);
});
