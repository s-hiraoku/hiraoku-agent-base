# Receive and acknowledge

A recipient polls for at most one message at a time; the host leases it for 30 seconds with a generation number and a lease token. The recipient must save it before acknowledging with that exact lease, which removes the server body. The raw calls below exercise lease and ACK wire semantics; they do not perform or prove the recipient save. An unacknowledged lease expires and the message is redelivered with a higher generation.

## Sub-features

- `recv-durable-save` uses the boundary recipe to observe the agent SDK receiver's committed body and original ACK request (`src/agent-sdk`) through an independent SQLite connection before the network ACK.

- `recv-poll` returns `{delivery: {message, generation, lease_token, lease_until}}` for the recipient.
- `recv-empty` returns `{delivery: null}` when nothing is deliverable (including while the only message is leased).
- `recv-ack` acknowledges with the exact returned lease; the response and the sender's `hab_status` show `acked`.
- `recv-ack-replay` repeating the same ack request returns the same receipt. After that ack has consumed the lease, a different `request_id` with the old lease fields is `invalid_ack`. A different `request_id` while the lease is still open would ack successfully; a same `request_id` with other fields changed is `ack_idempotency_conflict`.
- `recv-ack-refused` a wrong `lease_token` or another agent acking is `invalid_ack`.
- `recv-redeliver` after `lease_until` (plus the stack's short `retry_base_ms` backoff) the next poll returns the same message with `generation` + 1. The recipe's ≈31 s wait clears that window on the verify stack.

## How to get to it (user POV)

- MCP tools `hab_poll` (`{}`) and `hab_ack` (`{sender_id, message_id, generation, lease_token, request_id}`).

## Driving it with verify-hab

For `recv-durable-save`, use [the boundary recipe](communication-boundary.md) and retain its TAP. It runs fresh isolated instances, verifies pre-ACK receiver storage and post-ACK sender status, and closes its owned listeners/stores. This is separate from the raw wire cases below.

The following cases prove only HAB wire behavior. `poll.json` and server snapshots do not establish recipient durable inbox commit or processing. Use a fresh baseline for these raw cases; do not reuse a message already ACKed by the durable recipe.

Preconditions:

- Baseline run, doctor OK, and agent `a` has submitted one message to `b` (`send-ok` from [send-message.md](./send-message.md)) with `ID` set.

- **Poll.** Run `$S/mcp.sh "$RUN" b hab_poll | sed 1d > "$RUN/poll.json"`. `.result.structuredContent.delivery.message.message_id` equals `$ID`, `generation` is `1`, body text is what `a` sent.
- **Poll while leased.** Run `$S/mcp.sh "$RUN" b hab_poll`. `{"delivery":null}`.
- **Build the ack.** Run `ACK=$(jq -c '.result.structuredContent.delivery | {sender_id:.message.sender_id, message_id:.message.message_id, generation, lease_token, request_id:"verify-ack-1"}' "$RUN/poll.json")`.
- **Wrong token.** Run `$S/mcp.sh "$RUN" b hab_ack "$(jq -c '.lease_token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' <<<"$ACK")"`. `{"error":"invalid_ack"}`.
- **Wrong agent.** Run `$S/mcp.sh "$RUN" c hab_ack "$ACK"`. `{"error":"invalid_ack"}`.
- **Ack.** Run `$S/mcp.sh "$RUN" b hab_ack "$ACK"`. `state: "acked"`, `request_id: "verify-ack-1"`.
- **Ack replay.** Run the same command again: identical `receipt_id`. Then `$S/mcp.sh "$RUN" b hab_ack "$(jq -c '.request_id="verify-ack-2"' <<<"$ACK")"`: `{"error":"invalid_ack"}`.
- **Sender view.** Run `HAB_CATALOG=delivery $S/mcp.sh "$RUN" a hab_status "{\"message_id\":\"$ID\"}"`. `state: "acked"`.
- **Redelivery.** Submit a new message `a` → `c`, poll as `c` (generation `1`), wait until after its `lease_until` (≈31 s), poll as `c` again. Same `message_id`, `generation: 2`, new `lease_token`.
- **Proof.** Run `node $S/inspect.mjs "$RUN" after-ack`. Acked delivery has `state: "acked"`; audit events read `accepted, leased, acked`; the redelivered one has `state: "leased"`, `generation: 2` and events `accepted, leased, requeued, leased`.

## Gotchas

- `hab_poll` hands out the oldest deliverable message across senders; leftovers from an earlier recipe change what you get. Use a fresh run dir per recipe.
- The lease is 30 s. An ack built from a poll older than that may be refused; re-poll.
- A message is pollable as soon as `hab_submit` returns `pending`; admission and the body commit in one SQLite transaction.
- On Node 22, `inspect.mjs` may print an `ExperimentalWarning` for `node:sqlite` on stderr; it is not a failure. Node ≥ 26 (required by this skill) stays silent.
