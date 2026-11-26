import test from "node:test";
import assert from "node:assert/strict";
import { mcpMethodCode } from "../src/protocol.ts";

const rpc = (method, params = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

test("known MCP methods map to fixed audit codes", () => {
  assert.equal(mcpMethodCode(rpc("tools/list"), undefined), "tools_list");
  assert.equal(mcpMethodCode(rpc("tools/call"), "tools/call"), "tools_call");
  assert.equal(
    mcpMethodCode(rpc("logging/setLevel"), undefined),
    "logging_setlevel",
  );
  assert.equal(
    mcpMethodCode(rpc("notifications/roots/list_changed"), undefined),
    "notifications_roots_list_changed",
  );
  // Newer MCP client methods (a host retrying an unknown one showed only as `other`).
  assert.equal(
    mcpMethodCode(rpc("subscriptions/listen"), undefined),
    "subscriptions_listen",
  );
  assert.equal(
    mcpMethodCode(rpc("notifications/elicitation/complete"), undefined),
    "notifications_elicitation_complete",
  );
});

test("resources/read keeps only whether a ui:// card was read, never the URI", () => {
  assert.equal(
    mcpMethodCode(
      rpc("resources/read", { uri: "ui://hab/inbox-v1" }),
      undefined,
    ),
    "resources_read_ui",
  );
  assert.equal(
    mcpMethodCode(
      rpc("resources/read", { uri: "file:///etc/passwd" }),
      undefined,
    ),
    "resources_read_other",
  );
  assert.equal(
    mcpMethodCode(rpc("resources/read"), undefined),
    "resources_read_other",
  );
});

test("caller-chosen method text never becomes an audit code", () => {
  for (const method of ["x-secret/token-abc", "Tools/List", "", "tools/list "])
    assert.equal(mcpMethodCode(rpc(method), undefined), "other");
  assert.equal(mcpMethodCode(rpc("tools/list"), "tools/call"), "mismatch");
  for (const body of [null, [], "tools/list", { jsonrpc: "2.0", id: 1 }])
    assert.equal(mcpMethodCode(body, undefined), "invalid");
});

test("every code fits the audit reason format", () => {
  const methods = [
    "initialize",
    "ping",
    "server/discover",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/subscribe",
    "resources/unsubscribe",
    "prompts/list",
    "prompts/get",
    "completion/complete",
    "logging/setLevel",
    "events/list",
    "events/subscribe",
    "events/unsubscribe",
    "tasks/get",
    "tasks/list",
    "tasks/result",
    "tasks/cancel",
    "roots/list",
    "sampling/createMessage",
    "elicitation/create",
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
    "notifications/roots/list_changed",
    "notifications/tasks/status",
    "notifications/message",
    "notifications/elicitation/complete",
    "notifications/prompts/list_changed",
    "notifications/resources/list_changed",
    "notifications/resources/updated",
    "notifications/tools/list_changed",
    "notifications/subscriptions/acknowledged",
    "subscriptions/listen",
    "unknown/method",
  ];
  for (const method of methods)
    assert.match(
      mcpMethodCode(rpc(method), undefined),
      /^[a-z][a-z0-9_]{0,47}$/,
    );
});
