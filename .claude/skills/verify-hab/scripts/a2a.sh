#!/usr/bin/env bash
# Drive the configured host's A2A entry (HAB_VERIFY_A2A=1 configured.sh start) over HTTP.
# Usage: a2a.sh <run-dir> <x|a|b|none|BAD> <SendMessage|GetTask|card> ['<json-params>']
#   SendMessage params default to the fixed connectivity_check with returnImmediately.
#   "card" GETs /.well-known/agent-card.json. "none" sends no Authorization; "BAD" an unknown bearer.
# Saves request + response under <run-dir>/evidence/NNN-<agent>-a2a-<method>.{req,res}
# and prints "HTTP <code>" then the body. Exit 0 on any HTTP answer.
set -euo pipefail
run=$(cd "$1" && pwd); agent=$2; method=$3; params=${4:-}
state="$run/instance/state.json"
[ -f "$state" ] || { echo "no_state: run configured.sh start first ($state)" >&2; exit 2; }
endpoint=$(jq -r '.a2a_url // empty' "$state")
[ -n "$endpoint" ] || { echo "no_a2a: start with HAB_VERIFY_A2A=1" >&2; exit 2; }
case "$agent" in
  none) auth=() ;;
  BAD) auth=(-H "Authorization: Bearer $(printf '0%.0s' {1..64})") ;;
  *) auth=(-H "Authorization: Bearer $(jq -r --arg a "$agent" '.agents[$a].token' "$state")") ;;
esac
mkdir -p "$run/evidence"
last=$(ls "$run/evidence" | sed -n 's/^\([0-9][0-9][0-9]\)-.*/\1/p' | sort -n | tail -1)
n=$(printf '%03d' $(( 10#${last:-0} + 1 )))
base="$run/evidence/$n-$agent-a2a-$method"
if [ "$method" = card ]; then
  printf 'GET %s\n' "${endpoint%/a2a}/.well-known/agent-card.json" > "$base.req"
  curl -sS "${endpoint%/a2a}/.well-known/agent-card.json" -o "$base.body" -w '%{http_code}' \
    ${auth[@]+"${auth[@]}"} > "$base.status"
else
  if [ -z "$params" ] && [ "$method" = SendMessage ]; then
    params=$(jq -nc --arg id "verify_$(date +%s%N)" \
      '{message:{messageId:$id,role:"ROLE_USER",parts:[{text:"connectivity_check"}]},configuration:{returnImmediately:true}}')
  fi
  body=$(jq -nc --arg m "$method" --argjson p "${params:-{\}}" '{jsonrpc:"2.0",id:"verify",method:$m,params:$p}')
  printf '%s\n' "$body" > "$base.req"
  curl -sS -X POST "$endpoint" -o "$base.body" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    ${auth[@]+"${auth[@]}"} --data-binary "$body" > "$base.status"
fi
{ echo "HTTP $(cat "$base.status")"; cat "$base.body"; echo; } > "$base.res"
rm -f "$base.body" "$base.status"
cat "$base.res"
