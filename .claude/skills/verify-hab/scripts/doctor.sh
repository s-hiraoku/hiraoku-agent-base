#!/usr/bin/env bash
# Read-only: is this verify-hab instance worth driving? Writes nothing.
# Usage: doctor.sh <run-dir>
set -uo pipefail
run=$(cd "$1" && pwd); state="$run/instance/state.json"; ok=1
fail() { echo "FAIL $*"; ok=0; }
[ -f "$state" ] || { echo "FAIL no state.json (not launched or cleaned up)"; exit 1; }
pid=$(cat "$run/instance/stack.pid" 2>/dev/null || true); url=$(jq -r .url "$state"); port=$(jq -r .port "$state")
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -qF "stack.mjs $run"; then
  echo "ok   process $pid is our stack.mjs for $run"
else fail "stack process not running (pid='$pid')"; fi
if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$pid"; then echo "ok   127.0.0.1:$port owned by $pid"
else fail "port $port not owned by $pid"; fi
h=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list')
b='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" "${h[@]}" --data-binary "$b")
[ "$code" = 401 ] && echo "ok   unauthenticated tools/list -> 401" || fail "unauthenticated tools/list -> $code (want 401)"
delivery=$(jq -r .delivery_url "$state")
list() { curl -s -X POST "$1" "${h[@]}" -H "Authorization: Bearer $(jq -r ".agents.$2.token" "$state")" --data-binary "$b" \
    | jq -r '[.result.tools[].name]|sort|join(",")' 2>/dev/null; }
for a in a b c; do
  tools=$(list "$url" "$a")
  [ "$tools" = hab_inbox,hab_reply,hab_send,hab_status ] \
    && echo "ok   agent $a $(jq -r ".agents.$a.address" "$state") sees the 4 agent tools at /mcp" || fail "agent $a /mcp tools='$tools'"
  tools=$(list "$delivery" "$a")
  [ "$tools" = hab_ack,hab_peek,hab_poll,hab_resolve,hab_status,hab_submit ] \
    && echo "ok   agent $a sees the 6 delivery tools at /mcp/delivery" || fail "agent $a /mcp/delivery tools='$tools'"
done
# Every published input schema must be one a ChatGPT-style connector accepts: a plain object
# root with properties, no top-level union, no $schema and no lookaround in any pattern.
for u in "$url" "$delivery"; do
  bad=$(curl -s -X POST "$u" "${h[@]}" -H "Authorization: Bearer $(jq -r ".agents.a.token" "$state")" --data-binary "$b" \
    | jq -r '.result.tools[] | select((.inputSchema.type != "object") or (.inputSchema.properties == null)
        or (.inputSchema | has("oneOf") or has("anyOf") or has("allOf") or has("$schema"))
        or ([.inputSchema | .. | objects | .pattern? // empty | test("\\(\\?[=!<]")] | any)) | .name' 2>/dev/null)
  [ -z "$bad" ] && echo "ok   $u input schemas are portable" || fail "$u non-portable input schemas: $bad"
done
[ $ok = 1 ] && echo "DOCTOR_OK $url" || { echo "DOCTOR_FAIL"; exit 1; }
