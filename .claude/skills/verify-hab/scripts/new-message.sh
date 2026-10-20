#!/usr/bin/env bash
# Print relay_submit arguments for a fresh message (replay-bound id rm1.<ms>.<32hex>,
# one-hour deadline). Usage: new-message.sh <run-dir> <to:a|b|c> [text] [kind:question|answer|notice]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); . "$here/_node.sh"
run=$(cd "$1" && pwd)
rid=$(jq -r --arg t "$2" '.agents[$t].agent_id' "$run/instance/state.json")
node -e '
const [rid, text, kind] = process.argv.slice(1), at = Date.now() - 100;
const entropy = require("node:crypto").randomBytes(16).toString("hex");
process.stdout.write(JSON.stringify({ version: 1, message_id: `rm1.${at}.${entropy}`,
  recipient_id: rid, kind, body: { parts: [{ type: "text", text }] },
  thread_id: `verify-thread-${at}`, in_reply_to: null,
  first_sent_at: new Date(at).toISOString(), expires_at: new Date(at + 3600000).toISOString() }) + "\n");
' "$rid" "${3:-verify-hab synthetic text}" "${4:-question}"
