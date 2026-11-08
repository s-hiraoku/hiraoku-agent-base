#!/usr/bin/env bash
# Drive the shipped Relay CLI (npm run relay:local) and the operator CLI (relay:admin)
# instead of the stack.mjs scaffolding. Synthetic 15-minute tokens only, all under the run dir.
# The Relay delivers only through JetStream, so start also runs a private nats-server
# (HAB_NATS_SERVER or .runtime/nats-install.json) with its store under instance/broker.
# Usage: configured.sh <run-dir> start [port]   -> instance/state.json usable by mcp.sh/new-message.sh
#        HAB_VERIFY_GROUPS=1 configured.sh <run-dir> start -> registry.authentication_groups on, plus an
#          unconnected spare credential "c" (state.agents.c.connection_id) for group reconnects
#        HAB_VERIFY_A2A=1 configured.sh <run-dir> start -> adds the config `a2a` section (identity
#          a2a@hab-host.hab, recipient hermes@hermes.hab) and caller "x": a second connection of
#          codex@codex.hab whose audience is the A2A endpoint (state.a2a_url, state.agents.x)
#        configured.sh <run-dir> admin <args...> -> runs relay:admin with this run's config
#        configured.sh <run-dir> restart         -> SIGTERM the relay only, start it again on the same config and broker
#        configured.sh <run-dir> stop            -> SIGTERM the relay, then the broker, this run started (by pid + cmdline)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); . "$here/_node.sh"
repo=$(cd "$here/../../../.." && pwd)
mkdir -p "$1"; run=$(cd "$1" && pwd); inst="$run/instance"; cfg="$inst/service.local.json"
relay_start() {
  local before; before=$(grep -c '"ready"' "$run/evidence/relay.log" 2>/dev/null || true)
  (cd "$repo" && exec node scripts/hab-relay.ts --config "$cfg") >> "$run/evidence/relay.log" 2>&1 &
  echo $! > "$inst/relay.pid"
  for _ in $(seq 1 40); do [ "$(grep -c '"ready"' "$run/evidence/relay.log")" -gt "${before:-0}" ] && return 0; sleep 0.25; done
  cat "$run/evidence/relay.log" >&2; return 1
}
relay_stop() {
  pidf="$inst/relay.pid"; [ -f "$pidf" ] || { echo "no relay.pid"; return 0; }
  pid=$(cat "$pidf")
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -qF -- "--config $cfg"; then
    kill -TERM "$pid"; for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    echo "stopped $pid"
  else echo "pid $pid not our relay; nothing killed"; fi
  rm -f "$pidf"
}
case "${2:-}" in
start)
  [ -e "$inst" ] && { echo "instance_exists: $inst (stop + rm first)" >&2; exit 2; }
  mkdir -p -m 700 "$inst" "$inst/state" "$inst/audit" "$inst/broker" "$run/evidence"
  freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
  port=${3:-$(freeport)}; nport=$(freeport); aport=$(freeport)
  nats=$(cd "$repo" && node --input-type=module -e 'import { natsServerBinary } from "./scripts/lib/nats-broker.ts"; console.log(natsServerBinary())')
  node - "$repo" "$inst" "$port" "$nport" "${HAB_VERIFY_GROUPS:-}" "${HAB_VERIFY_A2A:-}" "$aport" <<'JS'
const fs = require("fs"), c = require("crypto"), [repo, inst, port, nport, groups, a2a, aport] = process.argv.slice(2);
const w = (p, o) => fs.writeFileSync(`${inst}/${p}`, JSON.stringify(o), { mode: 0o600 });
const cfg = JSON.parse(fs.readFileSync(`${repo}/config/relay-service.example.json`, "utf8"));
Object.assign(cfg, { directory: `${inst}/state`, port: Number(port), keys_file: `${inst}/keys.local.json`,
  credentials_file: `${inst}/individuals.local.json`, audit_directory: `${inst}/audit` });
if (groups === "1") cfg.registry.authentication_groups = true;
if (a2a === "1")
  cfg.a2a = { ...JSON.parse(fs.readFileSync(`${repo}/config/relay-a2a.example.json`, "utf8")).a2a,
    port: Number(aport), recipient: "hermes@hermes.hab", poll_interval_ms: 100 };
// Private broker for this run only: random password, loopback port, file store under instance/broker.
const password = c.randomBytes(24).toString("hex");
fs.writeFileSync(`${inst}/broker/broker.conf`, `host: 127.0.0.1\nport: ${nport}\njetstream {\n store_dir: ${JSON.stringify(`${inst}/broker/store`)}\n max_file_store: 256MB\n max_memory_store: 0\n sync_interval: always\n}\naccounts { HAB {\n jetstream: enabled\n users: [{user: backend, password: ${JSON.stringify(password)}}]\n} }\n`, { mode: 0o600 });
w("state/volume.local.json", { version: 1, volume_id: "verify-hab-volume" });
Object.assign(cfg.delivery.broker, { server: `nats://127.0.0.1:${nport}`, user: "backend", password });
cfg.delivery.volume = { identity_file: `${inst}/state/volume.local.json`, expected_id: "verify-hab-volume",
  expected_device: fs.lstatSync(`${inst}/state`).dev };
w("service.local.json", cfg);
w("keys.local.json", { version: 1, registry_fingerprint_key: c.randomBytes(32).toString("hex"),
  relay_fingerprint_key: c.randomBytes(32).toString("hex") });
const now = Date.now(), agents = { a: "codex@codex.hab", b: "hermes@hermes.hab" }, tokens = {};
const spare = groups === "1" ? ["c"] : [];
const callers = a2a === "1" ? ["x"] : [];
w("individuals.local.json", { version: 1, credentials: [...Object.keys(agents), ...spare, ...callers].map((k) => {
  tokens[k] = c.randomBytes(32).toString("hex");
  const audience = callers.includes(k) ? `http://127.0.0.1:${aport}/a2a` : `http://127.0.0.1:${port}/mcp`;
  return { sha256: c.createHash("sha256").update(tokens[k]).digest("hex"),
    principal: { issuer: "urn:verify-hab:local", audience,
      subject: `verify-${k}`, client_id: `verify-${k}`, connection_id: `verify-${k}-${now}` },
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 899000).toISOString() };
}) });
w("pending.local.json", { agents, tokens, now, spare, callers });
JS
  "$nats" -c "$inst/broker/broker.conf" > "$run/evidence/broker.log" 2>&1 &
  echo $! > "$inst/broker.pid"
  for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$nport") 2>/dev/null && break; sleep 0.25; done
  : > "$run/evidence/relay.log"
  relay_start || exit 1
  url=$(head -1 "$run/evidence/relay.log" | jq -r .url)
  a2a_url=$(head -1 "$run/evidence/relay.log" | jq -r '.a2a_url // ""')
  pend="$inst/pending.local.json"; now=$(jq -r .now "$pend")
  state=$(jq -n --arg url "$url" --arg port "$port" --arg pid "$(cat "$inst/relay.pid")" --arg a2a "$a2a_url" \
    '{url:$url,port:($port|tonumber),pid:($pid|tonumber),agents:{}} + (if $a2a == "" then {} else {a2a_url:$a2a} end)')
  for k in a b; do
    addr=$(jq -r --arg k "$k" '.agents[$k]' "$pend")
    out=$(cd "$repo" && node scripts/hab-relay-admin.ts --config "$cfg" connect --address "$addr" --connection-id "verify-$k-$now")
    printf '%s\n' "$out" > "$run/evidence/admin-connect-$k.json"
    state=$(jq --arg k "$k" --argjson o "$out" --arg t "$(jq -r --arg k "$k" '.tokens[$k]' "$pend")" \
      '.agents[$k]={agent_id:$o.address.agent_id,address:$o.address.address,token:$t}' <<<"$state")
  done
  for k in $(jq -r '.spare[]' "$pend"); do
    state=$(jq --arg k "$k" --arg t "$(jq -r --arg k "$k" '.tokens[$k]' "$pend")" --arg c "verify-$k-$now"       '.agents[$k]={token:$t,connection_id:$c}' <<<"$state")
  done
  for k in $(jq -r '.callers[]' "$pend"); do
    out=$(cd "$repo" && node scripts/hab-relay-admin.ts --config "$cfg" connect --address codex@codex.hab --connection-id "verify-$k-$now")
    printf '%s\n' "$out" > "$run/evidence/admin-connect-$k.json"
    state=$(jq --arg k "$k" --argjson o "$out" --arg t "$(jq -r --arg k "$k" '.tokens[$k]' "$pend")" \
      '.agents[$k]={agent_id:$o.address.agent_id,address:$o.address.address,token:$t}' <<<"$state")
  done
  rm -f "$pend"; (umask 077; printf '%s\n' "$state" > "$inst/state.json")
  echo "CONFIGURED_READY $url" ;;
admin) shift 2; cd "$repo" && node scripts/hab-relay-admin.ts --config "$cfg" "$@" ;;
restart)
  [ -f "$inst/state.json" ] || { echo "no_state: start first" >&2; exit 2; }
  relay_stop
  relay_start || exit 1
  state=$(jq --arg pid "$(cat "$inst/relay.pid")" '.pid=($pid|tonumber)' "$inst/state.json")
  (umask 077; printf '%s\n' "$state" > "$inst/state.json")
  echo "CONFIGURED_READY $(jq -r .url "$inst/state.json")" ;;
stop)
  relay_stop
  bpidf="$inst/broker.pid"
  if [ -f "$bpidf" ]; then
    bpid=$(cat "$bpidf")
    if kill -0 "$bpid" 2>/dev/null && ps -o command= -p "$bpid" | grep -qF -- "-c $inst/broker/broker.conf"; then
      kill -TERM "$bpid"; for _ in $(seq 1 40); do kill -0 "$bpid" 2>/dev/null || break; sleep 0.25; done
      echo "stopped broker $bpid"
    else echo "pid $bpid not our broker; nothing killed"; fi
    rm -f "$bpidf"
  fi ;;
*) echo "usage: configured.sh <run-dir> start [port] | admin <args> | restart | stop" >&2; exit 2 ;;
esac
