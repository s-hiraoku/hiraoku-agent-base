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
for a in a b c; do
  tools=$(curl -s -X POST "$url" "${h[@]}" -H "Authorization: Bearer $(jq -r ".agents.$a.token" "$state")" --data-binary "$b" \
    | jq -r '[.result.tools[].name]|sort|join(",")' 2>/dev/null)
  [ "$tools" = relay_ack,relay_poll,relay_resolve,relay_status,relay_submit ] \
    && echo "ok   agent $a $(jq -r ".agents.$a.address" "$state") sees 5 relay tools" || fail "agent $a tools='$tools'"
done
[ $ok = 1 ] && echo "DOCTOR_OK $url" || { echo "DOCTOR_FAIL"; exit 1; }
