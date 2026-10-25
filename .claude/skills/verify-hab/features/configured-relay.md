# Configured Relay and operator CLI

The shipped Relay (`npm run relay:local -- --config …`) refuses a bad start with a fixed reason line, and the operator CLI (`npm run relay:admin -- --config … status|connect|disconnect`) registers an address, binds a mapped connection, grants operations and revokes it again — all against the same private config while the Relay runs. This is the path a real Codex ⇄ Hermes trial uses, unlike the `stack.mjs` scaffolding.

## Sub-features

- `start-reason` a refused start prints `local_relay_start_rejected reason=<code>[ fields=<paths>]` (e.g. missing `store.agent_capacity` → `reason=config_invalid fields=store.agent_capacity`), never values or paths.
- `admin-connect` `connect --address <a> --connection-id <id>` registers product/address, binds and grants; rerun returns `steps: []`.
- `admin-status` `status` lists addresses, credential lifetime/audience/binding and `problems` (`credential_unbound`, `credential_expired`, `credential_audience_mismatch`, `credential_revoked`, `address_unbound`, `address_stopped`).
- `admin-disconnect` `disconnect --address <a>` revokes with current epochs; works after the token mapping was deleted; rerun → `already_disconnected: true`; the old token then gets `forbidden`.
- `configured-roundtrip` a → b submit / poll / ack / sender status `acked` through the shipped Relay.
- `host-exact` `Host: localhost:<port>` → HTTP 403; only `127.0.0.1:<port>` is accepted.

## How to get to it (user POV)

- Operator shell: `npm run relay:local -- --config <service.local.json>` and `npm run relay:admin -- --config <service.local.json> <command>`.
- Agents: each agent's MCP client at `http://127.0.0.1:<port>/mcp` with its own bearer.

## Driving it with verify-hab

Preconditions:

- `npm ci` with Node ≥ 24. A fresh `RUN=/tmp/hab-verify/<id>` (do not reuse a stack.mjs run dir).

- **Start.** `$S/configured.sh "$RUN" start` writes example-based config, random keys and two synthetic 15-minute credentials under `$RUN/instance/`, starts `scripts/hab-relay.mjs`, runs `relay:admin connect` for `a` = `codex@codex.hab` and `b` = `hermes@hermes.hab`, and prints `CONFIGURED_READY <url>`. `instance/state.json` has the same shape as the stack's, so `mcp.sh` and `new-message.sh` work unchanged. Connect output is saved as `evidence/admin-connect-{a,b}.json` (`steps` lists what was created).
- **Roundtrip.** Use the minimal round trip from `SKILL.md` with agents `a` and `b` (target `hermes@hermes.hab`). Sender `relay_status` ends `"acked"`.
- **Status.** `$S/configured.sh "$RUN" admin status` → `problems: []` while both are connected.
- **Disconnect.** `$S/configured.sh "$RUN" admin disconnect --address hermes@hermes.hab` → `revoked_bindings: 1`; again → `already_disconnected: true`; `$S/mcp.sh "$RUN" b relay_poll '{}'` → `{"error":"forbidden"}`; `status` shows `credential_revoked` and `address_stopped`.
- **Start reason.** Copy `instance/service.local.json` to `instance/bad.local.json` (0600) with `store.agent_capacity` removed and run `node scripts/hab-relay.mjs --config "$RUN/instance/bad.local.json"`: exit 1, the single stderr line above.
- **Host.** `curl -s -o /dev/null -w '%{http_code}' -H "Host: localhost:<port>" -H "Authorization: Bearer $(jq -r .agents.a.token "$RUN/instance/state.json")" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$(jq -r .url "$RUN/instance/state.json")" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` → `403`.
- **Stop.** `$S/configured.sh "$RUN" stop` (pid + cmdline checked), then `rm -rf "$RUN/instance"`. `evidence/relay.log` keeps `ready`/`stopped`.

## Gotchas

- `inspect.mjs` and `doctor.sh`/`cleanup.sh` target the stack layout; use `configured.sh … admin status` and `configured.sh … stop` here.
- Credentials expire 15 minutes after `start`; after that every call is 401 and `status` shows `credential_expired`. Relaunch with a new run dir.
- A revoked connection id can never be bound again (`credential_revoked_use_new_connection_id`); a new credential needs a new `connection_id`.
- Tokens are synthetic and local; a pass is not evidence of a real Codex/Hermes client or model choosing tools.
