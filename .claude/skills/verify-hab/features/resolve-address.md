# Resolve an address

An agent turns a canonical HAB address such as `verify-b@dot.hab` into the recipient's immutable agent id, which it stores before sending. Resolution grants no delivery rights.

## Sub-features

- `resolve-ok` returns `recipient_id`, `address` and `normalization_version` for an active agent.
- `resolve-unknown` refuses a well-formed address that is not registered.
- `resolve-malformed` rejects input that does not match `<slug>@<slug>.hab` at schema validation.

## How to get to it (user POV)

- MCP tool `relay_resolve` with `{"address": "<bot>@<product>.hab"}` on `POST /mcp`.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Resolve a peer.** Agent `a` resolves `b`. Run `$S/mcp.sh "$RUN" a relay_resolve '{"address":"verify-b@dot.hab"}'`. HTTP 200, `structuredContent.recipient_id` equals `jq -r .agents.b.agent_id $RUN/instance/state.json`, `address` echoes `verify-b@dot.hab`, `normalization_version` is `1`.
- **Unknown address.** Run `$S/mcp.sh "$RUN" a relay_resolve '{"address":"nobody@dot.hab"}'`. `isError: true`, `{"error":"forbidden"}` (no existence oracle: unknown and unauthorized look the same).
- **Malformed address.** Run `$S/mcp.sh "$RUN" a relay_resolve '{"address":"Not An Address"}'`. `isError: true` with an `Input validation error` naming the address pattern.
- **Proof.** Keep the three `NNN-a-relay_resolve.res` files; compare the first against `state.json`.

## Gotchas

- Addresses are lowercase only; uppercase input is a validation error, not normalized.
- `resolve` is one of the five operations an agent must be granted at activation; an agent enrolled without it gets `forbidden` even for valid addresses.
