# Resolve an address

An agent turns a canonical HAB address such as `verify-b@dot.hab` into the recipient's immutable agent id, which it stores before sending. Resolution grants no delivery rights.

## Sub-features

- `resolve-ok` returns `recipient_id`, `address` and `normalization_version` for an active agent.
- `resolve-unknown` refuses a well-formed address that is not registered with `unknown_address` (the same answer for a blocked pair or an inactive peer).
- `resolve-malformed` rejects input that does not match `<slug>@<slug>.hab` at schema validation.
- `resolve-previous-name` resolves a renamed agent's previous name to the same `recipient_id` during the rename grace period, echoing the requested address. It is refused after the grace period ends.

## How to get to it (user POV)

- MCP tool `hab_resolve` with `{"address": "<bot_name>@<agent_name>.hab"}` on `POST /mcp/delivery`.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Resolve a peer.** Agent `a` resolves `b`. Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"verify-b@dot.hab"}'`. HTTP 200, `structuredContent.recipient_id` equals `jq -r .agents.b.agent_id $RUN/instance/state.json`, `address` echoes `verify-b@dot.hab`, `normalization_version` is `1`.
- **Unknown address.** Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"nobody@dot.hab"}'`. `isError: true`, `{"error":"unknown_address"}` with the fixed public message (it may mention optional `hab_discover`). Since ADR-025 `hab_discover` `directory` (when discovery is on) lists every active address by default — other groups with `relationship: "other_group"` and names/state only; `registry.discovery.directory: "group"` restores the group-only list. Covered by `node --test test/hab-discovery.test.js`.
- **Malformed address.** Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"Not An Address"}'`. `isError: true` with an `Input validation error` naming the address pattern.
- **Previous name (configured host only; the stack has no `registry` config).** Use a fresh configured run, so the names below are `hermes@hermes.hab` (`b`) and `codex@codex.hab` (`a`).
  1. `$S/configured.sh "$RUN" start`, then `$S/configured.sh "$RUN" stop`, set `registry.agent_rename: true` in `$RUN/instance/service.local.json` (keep it 0600), and `$S/configured.sh "$RUN" restart` (it prints `no host.pid` and starts the host; the Registry gains the names tables when it opens).
  2. `B=$(jq -r .agents.b.agent_id "$RUN/instance/state.json")`, `EP=$($S/configured.sh "$RUN" admin status | jq -r --arg b "$B" '.addresses[]|select(.agent_id==$b)|.epoch')`, then `$S/configured.sh "$RUN" admin rename --agent-id "$B" --expected-address hermes@hermes.hab --bot-name hermes2 --expected-epoch "$EP" --request-id verify-rename-1`.
  3. Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"hermes@hermes.hab"}'`. It returns the same `recipient_id` (`$B`) and echoes `hermes@hermes.hab`.
  4. `admin status` lists the old name under `previous_names` with `current_address: "hermes2@hermes.hab"`, `resolves: true`, a `grace_until` 30 days after `renamed_at`, and `a`'s agent ID under `callers`.
  5. Stop, set `registry.rename_grace_days: 0`, restart: the same resolve returns `{"error":"unknown_address"}`.
- **Proof.** Keep the three `NNN-a-hab_resolve.res` files; compare the first against `state.json`.

## Gotchas

- Addresses are lowercase only; uppercase input is a validation error, not normalized.
- A previous name is never an alias to another agent and stays reserved forever; the grace period only decides whether it still resolves.
- `resolve` is one of the five operations an agent must be granted at activation; an agent enrolled without it gets `forbidden` even for valid addresses.
