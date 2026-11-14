#!/usr/bin/env bash
# Print hab_submit arguments that reply to a polled execution_request.
# Usage: new-reply.sh <poll-response-file> <execution_accepted|execution_result> <engine-task-id> [state] [result]
#   <poll-response-file> is the JSON-RPC body of a hab_poll (mcp.sh output without its HTTP line).
#   For execution_result, state is succeeded|failed|cancelled (default succeeded), result is text or "null".
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); . "$here/_node.sh"
node -e '
const fs = require("node:fs");
const [file, kind, taskId, state = "succeeded", result = "connectivity_ok"] = process.argv.slice(1);
const request = JSON.parse(fs.readFileSync(file, "utf8")).result.structuredContent.delivery.message;
const at = Date.now() - 100, entropy = require("node:crypto").randomBytes(16).toString("hex");
const value = kind === "execution_result"
  ? { task_type: "connectivity_check", task_id: taskId, state, result: result === "null" ? null : result }
  : { task_type: "connectivity_check", task_id: taskId };
process.stdout.write(JSON.stringify({ version: 1, message_id: `rm1.${at}.${entropy}`,
  recipient_id: request.sender_id, kind, thread_id: request.thread_id,
  in_reply_to: { sender_id: request.sender_id, message_id: request.message_id },
  first_sent_at: new Date(at).toISOString(), expires_at: new Date(at + 3600000).toISOString(),
  body: { parts: [{ type: "data", schema_id: `task.${kind}`, schema_version: 1, value }] } }) + "\n");
' "$@"
