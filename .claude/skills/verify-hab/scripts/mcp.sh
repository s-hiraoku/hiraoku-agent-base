#!/usr/bin/env bash
# Drive the running verify-hab stack over real MCP HTTP (JSON-RPC POST /mcp).
# Usage: mcp.sh <run-dir> <a|b|c|none|BAD> <tool|tools/list> ['<json-arguments>']
#   agent "none" sends no Authorization header; "BAD" sends an unknown bearer.
# Saves request + response under <run-dir>/evidence/NNN-<agent>-<tool>.{req,res}
# and prints the response body (JSON-RPC envelope). Exit 0 on any HTTP answer.
set -euo pipefail
run=$(cd "$1" && pwd); agent=$2; tool=$3; args=${4:-'{}'}
state="$run/instance/state.json"
[ -f "$state" ] || { echo "no_state: run launch first ($state)" >&2; exit 2; }
url=$(jq -r .url "$state")
meta='{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}'
if [ "$tool" = tools/list ]; then
  method=tools/list
  body=$(jq -nc --argjson m "$meta" '{jsonrpc:"2.0",id:1,method:"tools/list",params:{_meta:$m}}')
  hdr=(-H "Mcp-Method: tools/list")
else
  method=tools/call
  body=$(jq -nc --argjson m "$meta" --arg n "$tool" --argjson a "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a,_meta:$m}}')
  hdr=(-H "Mcp-Method: tools/call" -H "Mcp-Name: $tool")
fi
case "$agent" in
  none) auth=() ;;
  BAD) auth=(-H "Authorization: Bearer not-enrolled") ;;
  *) auth=(-H "Authorization: Bearer $(jq -r --arg a "$agent" '.agents[$a].token' "$state")") ;;
esac
mkdir -p "$run/evidence"
last=$(ls "$run/evidence" | sed -n 's/^\([0-9][0-9][0-9]\)-.*/\1/p' | sort -n | tail -1)
n=$(printf '%03d' $(( 10#${last:-0} + 1 )))
base="$run/evidence/$n-$agent-${tool//\//_}"
printf '%s\n' "$body" > "$base.req"
curl -sS -X POST "$url" -o "$base.body" -D "$base.headers" -w '%{http_code}' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' "${hdr[@]}" "${auth[@]}" --data-binary "$body" > "$base.status"
{ echo "HTTP $(cat "$base.status")"; cat "$base.body"; echo; } > "$base.res"
rm -f "$base.body" "$base.status"
cat "$base.res"
