#!/usr/bin/env bash
# Start the verify-hab Relay stack in the background and wait until it is usable.
# Usage: launch.sh <run-dir> [port]     (run-dir is created; reuse it to test restart)
# Ready = "HAB_VERIFY_READY <url>" in <run-dir>/evidence/stack.log AND doctor passes.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); . "$here/_node.sh"
mkdir -p "$1/evidence"; run=$(cd "$1" && pwd)
if [ -f "$run/instance/stack.pid" ] && kill -0 "$(cat "$run/instance/stack.pid")" 2>/dev/null; then
  echo "already_running pid=$(cat "$run/instance/stack.pid")" >&2; exit 4
fi
log="$run/evidence/stack.log"; echo "--- launch $(date -u +%FT%TZ)" >> "$log"
start=$(wc -l < "$log" | tr -d '[:space:]')
nohup node "$here/stack.mjs" "$run" ${2:-} >> "$log" 2>&1 < /dev/null &
for _ in $(seq 1 60); do
  if tail -n +"$start" "$log" | grep -q '^HAB_VERIFY_READY '; then exec "$here/doctor.sh" "$run"; fi
  kill -0 $! 2>/dev/null || { echo "stack_exited; see $log" >&2; tail -n 20 "$log" >&2; exit 5; }
  sleep 0.25
done
echo "not_ready_after_15s; see $log" >&2; exit 6
