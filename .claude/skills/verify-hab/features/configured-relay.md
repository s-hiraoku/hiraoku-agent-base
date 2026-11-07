# Configured Relay and operator CLI

The shipped Relay (`npm run relay:local -- --config …`) refuses a bad start with a fixed reason line, and the operator CLI (`npm run relay:admin -- --config … status|connect|disconnect`) registers an address, binds a mapped connection, grants operations and revokes it again — all against the same private config while the Relay runs. This is the path a real Codex ⇄ Hermes trial uses, unlike the `stack.mjs` scaffolding.

## Sub-features

- `start-reason` a refused start prints `local_relay_start_rejected reason=<code>[ fields=<paths>]` (e.g. missing `delivery.queue.agent_capacity` → `reason=config_invalid fields=delivery.queue.agent_capacity`), never values or paths.
- `retired-config` a config that still has the retired SQLite `store` section (and no `delivery`) is refused with `reason=config_invalid fields=delivery,store` before any state is created.
- `admin-connect` `connect --address <a> --connection-id <id>` registers product/address, binds and grants; rerun returns `steps: []`.
- `admin-status` `status` lists addresses, credential lifetime/audience/binding and `problems` (`credential_unbound`, `credential_expired`, `credential_audience_mismatch`, `credential_revoked`, `address_unbound`, `address_stopped`).
- `admin-disconnect` `disconnect --address <a>` revokes with current epochs; works after the token mapping was deleted; rerun → `already_disconnected: true`; the old token then gets `forbidden`.
- `group-disconnect` with `registry.authentication_groups: true`, disconnecting one member of a shared connection stops **every** member (`state: stopped`, `operations: []`) and lists them in `affected_addresses`. Reconnecting one address with a new connection id re-grants only that address; its sibling stays `stopped` and polling as it is `forbidden`. A poll without `as_address` selects the only active member.
- `admin-refusals` `connect … --operations ""` → `relay_admin_rejected invalid_operations`; a group connect refused by binding capacity creates no group (a retry converges); group mode follows `registry.authentication_groups`, not the registry schema version.
- `registry-limits` an out-of-range `registry.*` limit (e.g. `busy_timeout_ms` above 1000) is refused at start with `reason=config_invalid fields=registry.<field>`.
- `configured-roundtrip` a → b submit / poll / ack / sender status `acked` through the shipped Relay and its JetStream broker. A submit with an `attachment` part is refused (`isError`, nothing stored), as in `send-attachment-refused`.
- `host-exact` `Host: localhost:<port>` → HTTP 403; only `127.0.0.1:<port>` is accepted.

## How to get to it (user POV)

- Operator shell: `npm run relay:local -- --config <service.local.json>` and `npm run relay:admin -- --config <service.local.json> <command>`.
- Agents: each agent's MCP client at `http://127.0.0.1:<port>/mcp` with its own bearer.

## Driving it with verify-hab

Preconditions:

- `npm ci` and `npm ci --prefix packages/relay-nats --ignore-scripts` with Node ≥ 26, plus the pinned `nats-server` (`HAB_NATS_SERVER` or `.runtime/nats-install.json`, see `SKILL.md`). A fresh `RUN=/tmp/hab-verify/<id>` (do not reuse a stack.mjs run dir).

- **Start.** `$S/configured.sh "$RUN" start` writes example-based config, random keys and two synthetic 15-minute credentials under `$RUN/instance/`, starts a private `nats-server` (random password, loopback port, store in `instance/broker/`) and fills `delivery.broker` and `delivery.volume` for it, starts `scripts/hab-relay.mjs`, runs `relay:admin connect` for `a` = `codex@codex.hab` and `b` = `hermes@hermes.hab`, and prints `CONFIGURED_READY <url>`. `instance/state.json` has the same shape as the stack's, so `mcp.sh` and `new-message.sh` work unchanged. Connect output is saved as `evidence/admin-connect-{a,b}.json` (`steps` lists what was created).
- **Roundtrip.** Use the minimal round trip from `SKILL.md` with agents `a` and `b` (target `hermes@hermes.hab`). Sender `relay_status` ends `"acked"`. `instance/state/` holds `jetstream-journal.sqlite` and `jetstream-health.local.json` and no `relay.sqlite`.
- **Status.** `$S/configured.sh "$RUN" admin status` → `problems: []` while both are connected.
- **Disconnect.** `$S/configured.sh "$RUN" admin disconnect --address hermes@hermes.hab` → `revoked_bindings: 1`; again → `already_disconnected: true`; `$S/mcp.sh "$RUN" b relay_poll '{}'` → `{"error":"forbidden"}`; `status` shows `credential_revoked` and `address_stopped`.
- **Group disconnect.** Start a separate run with `HAB_VERIFY_GROUPS=1 $S/configured.sh "$RUN" start`: groups are on and `state.json` has an unconnected spare credential `c` (`.agents.c.connection_id`). Read `a`'s connection id from `admin status` (`.credentials[] | select(.addresses == ["codex@codex.hab"]) | .connection_id`), then `admin connect --address second@codex.hab --connection-id <it>` → `steps: [address_enrolled, group_member_added, address_access_granted]`. `admin disconnect --address second@codex.hab` → `affected_addresses` both, and `admin status` shows both `stopped` with `operations: []`. `admin connect --address codex@codex.hab --connection-id <c's id>` → `steps: [connection_bound, group_access_granted, address_access_granted]`; then `$S/mcp.sh "$RUN" c relay_poll '{"as_address":"second@codex.hab"}'` → `forbidden`, `as_address` codex and an empty selector → `{"delivery":null}`.
- **Start reason.** Copy `instance/service.local.json` to `instance/bad.local.json` (0600) with `delivery.queue.agent_capacity` removed and run `node scripts/hab-relay.mjs --config "$RUN/instance/bad.local.json"`: exit 1, the single stderr line above.
- **Retired config.** `jq '.store = .delivery.queue | del(.delivery) | .port = 0' instance/service.local.json > instance/old.local.json` (0600), then start with it: exit 1, `local_relay_start_rejected reason=config_invalid fields=delivery,store`.
- **Host.** `curl -s -o /dev/null -w '%{http_code}' -H "Host: localhost:<port>" -H "Authorization: Bearer $(jq -r .agents.a.token "$RUN/instance/state.json")" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$(jq -r .url "$RUN/instance/state.json")" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` → `403`.
- **Stop.** `$S/configured.sh "$RUN" stop` stops the Relay and then its broker (each by pid + cmdline) and prints `stopped <pid>` and `stopped broker <pid>`. It leaves `$RUN/instance`; run `rm -rf "$RUN/instance"` yourself afterwards. `evidence/relay.log` keeps `ready`/`stopped`; `evidence/broker.log` keeps the broker output.

## Gotchas

- `inspect.mjs` and `doctor.sh`/`cleanup.sh` target the stack layout; use `configured.sh … admin status` and `configured.sh … stop` here.
- A poll right after a submit can return `{"delivery":null}` until the pump's next cycle (`delivery.pump.interval_ms`, 100 ms in the example config). Poll again.
- If `start` fails after the broker came up, run `configured.sh "$RUN" stop` anyway; it stops the broker too.
- Credentials expire 15 minutes after `start`; after that every call is 401 and `status` shows `credential_expired`. Relaunch with a new run dir.
- A group stop or its last disconnect stops every member; reconnect each member address you still want (one `connect` per address).
- A revoked connection id can never be bound again (`credential_revoked_use_new_connection_id`); a new credential needs a new `connection_id`.
- `limits` no longer has `attachment_bytes`, `total_attachment_bytes` or `attachments`. A config that still carries any of them is refused at start with `reason=config_invalid fields=limits`. Delete those keys.
- Tokens are synthetic and local; a pass is not evidence of a real Codex/Hermes client or model choosing tools.
