# Resolve an address

An agent turns a canonical HAB address such as `verify-b@dot.hab` into the recipient's immutable agent id, which it stores before sending. Resolution grants no delivery rights.

## Sub-features

- `resolve-ok` returns `recipient_id`, `address` and `normalization_version` for an active agent.
- `resolve-unknown` refuses a well-formed address that is not registered.
- `resolve-malformed` rejects input that does not match `<slug>@<slug>.hab` at schema validation.
- `resolve-previous-name` resolves a renamed agent's previous name to the same `recipient_id` during the rename grace period, echoing the requested address. It is refused after the grace period ends.

## How to get to it (user POV)

- MCP tool `hab_resolve` with `{"address": "<bot_name>@<agent_name>.hab"}` on `POST /mcp`.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Resolve a peer.** Agent `a` resolves `b`. Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"verify-b@dot.hab"}'`. HTTP 200, `structuredContent.recipient_id` equals `jq -r .agents.b.agent_id $RUN/instance/state.json`, `address` echoes `verify-b@dot.hab`, `normalization_version` is `1`.
- **Unknown address.** Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"nobody@dot.hab"}'`. `isError: true`, `{"error":"forbidden"}` (no existence oracle: unknown and unauthorized look the same).
- **Malformed address.** Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"Not An Address"}'`. `isError: true` with an `Input validation error` naming the address pattern.
- **Previous name (needs `registry.agent_rename: true` in the run's config before the first start).**
  1. Rename `b` with `npm run hab:admin -- --config <run config> rename`, passing the `agent_id`, the `--expected-address verify-b@dot.hab`, the current epoch from `hab:admin status`, `--bot-name verify-b2` and a fixed `--request-id`.
  2. Run `$S/mcp.sh "$RUN" a hab_resolve '{"address":"verify-b@dot.hab"}'`. It returns the same `recipient_id` and echoes `verify-b@dot.hab`.
  3. `hab:admin status` lists the old name under `previous_names` with `resolves: true`, a `grace_until` 30 days after `renamed_at`, and `a`'s agent ID under `callers`.
  4. With `registry.rename_grace_days: 0` the same resolve returns `{"error":"forbidden"}`.
- **Proof.** Keep the three `NNN-a-hab_resolve.res` files; compare the first against `state.json`.

## Gotchas

- Addresses are lowercase only; uppercase input is a validation error, not normalized.
- A previous name is never an alias to another agent and stays reserved forever; the grace period only decides whether it still resolves.
- `resolve` is one of the five operations an agent must be granted at activation; an agent enrolled without it gets `forbidden` even for valid addresses.
