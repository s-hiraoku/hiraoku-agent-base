#!/usr/bin/env bash
# Stop the stack THIS run started (by its pid file, never by name) and remove
# <run-dir>/instance. <run-dir>/evidence is always kept.
# Usage: cleanup.sh <run-dir> [--stop-only]   (--stop-only keeps instance DBs for a restart test)
set -uo pipefail
run=$(cd "$1" && pwd); pidf="$run/instance/stack.pid"
if [ -f "$pidf" ]; then
  pid=$(cat "$pidf")
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -qF "stack.mjs $run"; then
    kill -TERM "$pid"
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && { echo "pid $pid ignored SIGTERM; sending SIGKILL"; kill -KILL "$pid"; }
    echo "stopped $pid"
  else echo "pid $pid not our stack (stale pid file); nothing killed"; rm -f "$pidf"; fi
fi
[ "${2:-}" = --stop-only ] || { rm -rf "$run/instance"; echo "removed $run/instance"; }
echo "evidence kept: $run/evidence"; ls "$run/evidence" 2>/dev/null | sed 's/^/  /'
