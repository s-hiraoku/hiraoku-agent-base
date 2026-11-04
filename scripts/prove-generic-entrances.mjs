import assert from "node:assert/strict";
import { resolve } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import {
  openGenericEntranceFixture,
  a2aRequest,
  unpack,
} from "../test/generic-entrance-fixture.js";

const fixture = await openGenericEntranceFixture({
  parent: resolve(".runtime"),
});
try {
  const a2a = await fixture.a2a();
  const mcp = await fixture.mcp();
  const first = await a2a.client.sendMessage(
    a2aRequest(fixture.input("proof-a2a", "from A2A")),
    a2a.options,
  );
  const submitted = await mcp.callTool({
    name: "text_submit",
    arguments: fixture.input("proof-mcp", "from MCP"),
  });
  assert.notEqual(submitted.isError, true);
  const second = unpack(submitted);
  assert.equal(first.status.state, TaskState.TASK_STATE_SUBMITTED);
  assert.equal(second.state, "submitted");
  const executions = [await fixture.execute(), await fixture.execute()];
  assert.equal(executions[1].admissions, 2);
  await fixture.restart();
  const a2aResult = await a2a.client.getTask({ id: second.id }, a2a.options);
  const result = await mcp.callTool({
    name: "text_get",
    arguments: { id: first.id },
  });
  assert.notEqual(result.isError, true);
  const mcpResult = unpack(result);
  assert.equal(a2aResult.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(a2aResult.artifacts[0].parts[0].content.value, "paper:from MCP");
  assert.equal(mcpResult.result.text, "paper:from A2A");
  assert.equal(mcpResult.sourceMessageId, "proof-a2a");
  console.log(
    JSON.stringify(
      {
        verdict: "PASS",
        transport: "official A2A and MCP SDK clients over loopback HTTP",
        authority: "shared TaskService with durable SQLite",
        authentication: "synthetic verified principals",
        execution: "synthetic text runtime without LLM or tools",
        restart: "host and SQLite reopened",
        jobs: [
          {
            id: first.id,
            acceptedVia: "A2A",
            resultVia: "MCP",
            state: mcpResult.state,
          },
          {
            id: second.id,
            acceptedVia: "MCP",
            resultVia: "A2A",
            state: "completed",
          },
        ],
        productionChanged: false,
      },
      null,
      2,
    ),
  );
} finally {
  await fixture.close();
}
