# Receive and acknowledge

A recipient polls for at most one message at a time; the Relay leases it for 30 seconds with a generation number and a lease token. The recipient saves it, then acknowledges it with that exact lease, which removes the server body. An unacknowledged lease expires and the message is redelivered with a higher generation.

## Sub-features

- `recv-poll` returns `{delivery: {message, generation, lease_token, lease_until}}` for the recipient.
- `recv-empty` returns `{delivery: null}` when nothing is deliverable (including while the only message is leased).
- `recv-ack` acknowledges with the journaled lease; the response and the sender's `relay_status` show `acked`.
- `recv-ack-replay` repeating the same ack request returns the same receipt; a new `request_id` for the same lease is `invalid_ack`.
- `recv-ack-refused` a wrong `lease_token` or another agent acking is `invalid_ack`.
- `recv-redeliver` after `lease_until` passes, the next poll returns the same message with `generation` + 1.

## How to get to it (user POV)

- MCP tools `relay_poll` (`{}`) and `relay_ack` (`{sender_id, message_id, generation, lease_token, request_id}`).

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK, and agent `a` has submitted one message to `b` (`send-ok` from [send-message.md](./send-message.md)) with `ID` set.

- **Poll.** Run `$S/mcp.sh "$RUN" b relay_poll | sed 1d > "$RUN/poll.json"`. `.result.structuredContent.delivery.message.message_id` equals `$ID`, `generation` is `1`, body text is what `a` sent.
- **Poll while leased.** Run `$S/mcp.sh "$RUN" b relay_poll`. `{"delivery":null}`.
- **Build the ack.** Run `ACK=$(jq -c '.result.structuredContent.delivery | {sender_id:.message.sender_id, message_id:.message.message_id, generation, lease_token, request_id:"verify-ack-1"}' "$RUN/poll.json")`.
- **Wrong token.** Run `$S/mcp.sh "$RUN" b relay_ack "$(jq -c '.lease_token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"' <<<"$ACK")"`. `{"error":"invalid_ack"}`.
- **Wrong agent.** Run `$S/mcp.sh "$RUN" c relay_ack "$ACK"`. `{"error":"invalid_ack"}`.
- **Ack.** Run `$S/mcp.sh "$RUN" b relay_ack "$ACK"`. `state: "acked"`, `request_id: "verify-ack-1"`.
- **Ack replay.** Run the same command again: identical `receipt_id`. Then `$S/mcp.sh "$RUN" b relay_ack "$(jq -c '.request_id="verify-ack-2"' <<<"$ACK")"`: `{"error":"invalid_ack"}`.
- **Sender view.** Run `$S/mcp.sh "$RUN" a relay_status "{\"message_id\":\"$ID\"}"`. `state: "acked"`.
- **Redelivery.** Submit a new message `a` → `c`, poll as `c` (generation `1`), wait until after its `lease_until` (≈31 s), poll as `c` again. Same `message_id`, `generation: 2`, new `lease_token`.
- **Proof.** Run `node $S/inspect.mjs "$RUN" after-ack`. Acked delivery has `state: "acked"`; audit events read `accepted, leased, acked`; the redelivered one has `state: "leased"`, `generation: 2` and events `accepted, leased, requeued, leased`.

## Gotchas

- `relay_poll` hands out the oldest deliverable message across senders; leftovers from an earlier recipe change what you get. Use a fresh run dir per recipe.
- The lease is 30 s. An ack built from a poll older than that may be refused; re-poll.
- `inspect.mjs` prints an `ExperimentalWarning` for `node:sqlite` on stderr; it is not a failure.
