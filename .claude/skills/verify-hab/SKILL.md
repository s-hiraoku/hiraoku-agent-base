---
name: verify-hab
description: Launch and drive HAB (hiraoku-agent-base) the way a connected agent does — the HAB Relay MCP over loopback HTTP (relay_resolve/submit/status/poll/ack) with three enrolled synthetic agents — plus the human enrollment terminal and the deny-all Hub server. Use it to prove a Relay, registry, enrollment or MCP-transport change works end to end in the real app, not just in unit tests, and to capture request/response/DB evidence.
---

# Verify HAB

HAB is a personal agent hub. Its user-facing surfaces today are:

1. **HAB Relay MCP over HTTP** (primary). Agents call `relay_resolve`, `relay_submit`, `relay_status`, `relay_poll`, `relay_ack` on `POST /mcp`. This is what Grok Bot / Dots / Hermes will use.
2. **Enrollment terminal** (`npm run demo:hab-enrollment -- --interactive`). A human picks a product, reserves `<bot>@<product>.hab`, binds and activates it.
3. **Hub server** (`node src/server.ts`, fixed `127.0.0.1:8787`). Without an operator config it denies everything; only the deny-all boundary is drivable locally.

The repo now ships a configured Relay CLI (`npm run relay:local`) and an operator CLI (`npm run relay:admin`); drive those with `configured.sh` per [features/configured-relay.md](features/configured-relay.md). For everything else, `scripts/stack.mjs` in this skill is **verification scaffolding**: it composes the repo's own classes (`SQLiteHabRegistry`, `SQLiteRelayStore`, `runHabEnrollment`, `HabRelayService`, `HabHttpGateway`, `createRelayNodeHandler`) exactly as `test/hab-journey-fixtures.js` does, enrolls three agents through the real enrollment workflow, and listens on a loopback port. Authority is synthetic and tokens are static (`Bearer verify-a|b|c`). It never reads `config/*.local.json`, `.env`, Auth0 or any real agent. Do not present a pass here as a production-connection result.

All helpers live in `.claude/skills/verify-hab/scripts/` (below: `S=.claude/skills/verify-hab/scripts`, run from the repo root). They need Node ≥ 24 (they source nvm if `node` is older), `jq`, `curl`, `lsof`, `ps`. `tmux` is needed only for the enrollment terminal.

## Launch

```sh
npm ci                                   # once per checkout (Node >= 24)
RUN=/tmp/hab-verify/$(date +%Y%m%d-%H%M%S)   # one run dir per verification run
S=.claude/skills/verify-hab/scripts
$S/launch.sh "$RUN"                      # optional 2nd arg: fixed port (default: free port)
```

`launch.sh` starts `stack.mjs` in the background from an empty run dir: it migrates three fresh SQLite DBs, registers products `grok-bot`, `dot`, `hermes`, enrolls `verify-a@grok-bot.hab` (agent `a`), `verify-b@dot.hab` (`b`), `verify-c@hermes.hab` (`c`) with all five operations, and listens. **Ready** means the log line `HAB_VERIFY_READY <url>` appeared **and** the doctor (run automatically) prints `DOCTOR_OK <url>`. Anything else exits non-zero with the log tail.

Layout of a run dir:

- `$RUN/instance/` — `state.json` (url, port, pid, agent ids/addresses/tokens), `stack.pid`, `registry.sqlite`, `relay.sqlite`, `enrollment.sqlite`. Disposable.
- `$RUN/evidence/` — every request/response, DB snapshots, `audit.jsonl` (HTTP gateway audit categories), `stack.log`. Survives cleanup.

Re-running `launch.sh "$RUN"` on a run dir whose instance was stopped with `cleanup.sh --stop-only` **reopens the same DBs on the same port** without re-enrolling (restart test).

Isolation: each run dir is its own instance on its own port, so parallel runs are safe. Never drive a run dir you did not launch.

## Doctor

```sh
$S/doctor.sh "$RUN"
```

Read-only; writes nothing. Checks: the pid in `stack.pid` is alive and is `stack.mjs` for this run dir; that pid owns the listening port; unauthenticated `tools/list` → `401`; each of `a`,`b`,`c` sees exactly the five `relay_*` tools. Run it first whenever anything looks off. `DOCTOR_FAIL` means do not drive — clean up and relaunch.

## Drive

Every call is a real MCP `tools/call` (protocol `2026-07-28`, `Mcp-Method`/`Mcp-Name` headers, `_meta` in params) over HTTP:

```sh
$S/mcp.sh "$RUN" <a|b|c|none|BAD> <tool|tools/list> '<json-arguments>'
```

`none` sends no `Authorization`; `BAD` sends an unknown bearer. It prints `HTTP <code>` then the JSON-RPC body, and saves `NNN-<agent>-<tool>.{req,headers,res}` in evidence. Tool results are in `.result.structuredContent`; a tool-level refusal has `"isError":true` and `{"error":"<code>"}` with HTTP 200.

Build a valid message (replay-bound id `rm1.<ms>.<32hex>`, one-hour deadline):

```sh
MSG=$($S/new-message.sh "$RUN" b "hello from a")       # to agent b; optional 4th arg kind: question|answer|notice
```

Minimal round trip (a → b):

```sh
$S/mcp.sh "$RUN" a relay_resolve '{"address":"verify-b@dot.hab"}'
$S/mcp.sh "$RUN" a relay_submit "$MSG"                       # state "pending"
ID=$(jq -r .message_id <<<"$MSG")
$S/mcp.sh "$RUN" b relay_poll '{}' | tee /dev/stderr | sed 1d > "$RUN/poll.json"
ACK=$(jq -c '.result.structuredContent.delivery | {sender_id:.message.sender_id, message_id:.message.message_id, generation, lease_token, request_id:"verify-ack-1"}' "$RUN/poll.json")
$S/mcp.sh "$RUN" b relay_ack "$ACK"                          # state "acked"
$S/mcp.sh "$RUN" a relay_status "{\"message_id\":\"$ID\"}"   # sender sees "acked"
node $S/inspect.mjs "$RUN" after-ack                          # DB side effects
```

Feature-by-feature recipes: [`features/README.md`](features/README.md).

## Evidence

- Where: `$RUN/evidence/` (numbered `NNN-*` in call order, plus `audit.jsonl`, `stack.log`).
- Exercise the user path: only MCP HTTP calls through `mcp.sh` (or the enrollment terminal in tmux). Do not call service classes, write DB rows, or edit `state.json` to make a step pass.
- Capture the action **and** the resulting state: the request/response of the action, then a second, independent view — another agent's tool call (e.g. sender `relay_status` after receiver `relay_ack`) and `inspect.mjs` (read-only DB snapshot: agents, bindings, messages, deliveries with state/generation, delivery audit events, ack receipt count; bodies omitted).
- Check side effects, not just the response: delivery rows and audit events in `inspect.mjs`, gateway categories (`request`, `tool_started`, `tool_succeeded`, …) in `audit.jsonl`.
- Mocks: only identity is synthetic (static bearer → synthetic verified connection), because Auth0/production identity binding is not built yet. Storage, HTTP, MCP framing, registry authorization and enrollment are the real code.
- Report the feature/sub-feature ID and the evidence file names with every claim.

## Cleanup

```sh
$S/cleanup.sh "$RUN"               # stop our stack (by pid file, never by name), delete $RUN/instance, keep $RUN/evidence
$S/cleanup.sh "$RUN" --stop-only   # stop only; keep DBs for a restart test
```

It kills only the pid in `stack.pid`, and only if that pid's command line is `stack.mjs <this run dir>`; a stale pid file is removed without killing anything. After cleanup, `ls "$RUN/evidence"` must still list the proof. Run cleanup after every failed attempt too. For the enrollment terminal, kill only the tmux session you named (`tmux kill-session -t <name>`); the demo deletes its own temp DB on exit.

## Helpers

| Script           | Invocation                                                               | Does                                           |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `launch.sh`      | `$S/launch.sh <run-dir> [port]`                                          | start/reopen stack, wait for ready, run doctor |
| `doctor.sh`      | `$S/doctor.sh <run-dir>`                                                 | read-only health check                         |
| `mcp.sh`         | `$S/mcp.sh <run-dir> <a\|b\|c\|none\|BAD> <tool\|tools/list> ['<json>']` | one MCP call, saved as evidence                |
| `new-message.sh` | `$S/new-message.sh <run-dir> <to> [text] [kind]`                         | print valid `relay_submit` arguments           |
| `inspect.mjs`    | `node $S/inspect.mjs <run-dir> [label]`                                  | read-only DB snapshot, saved as evidence       |
| `cleanup.sh`     | `$S/cleanup.sh <run-dir> [--stop-only]`                                  | stop what this run started, keep evidence      |
| `stack.mjs`      | (via `launch.sh`) `node $S/stack.mjs <run-dir> [port]`                   | the scaffolding host itself                    |
| `configured.sh`  | `$S/configured.sh <run-dir> start [port] \| admin <args> \| stop`        | shipped Relay + operator CLI, same state.json  |

## Other surfaces

- **Hub server** (`node src/server.ts`): binds the fixed port `127.0.0.1:8787` and writes `runtime/` relative to its **cwd** — start it from a scratch dir (`cd "$(mktemp -d)" && node <repo>/src/server.ts &`, remember `$!`) so it never touches the repo's `runtime/`. Only one instance can run per host; if 8787 is already taken by something you did not start, do not drive it. Without `HAB_RUNTIME_CONFIG`, `POST /mcp` → `401`, a foreign `Host` → `403`. Authenticated Hub calls need Auth0 and are out of reach locally. Kill it by the pid you recorded.
- **Unit/integration suites** (`npm test`, `npm run test:hab-integration`) are not a substitute for this skill's proof; run them in addition.
