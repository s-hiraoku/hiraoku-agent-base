# Send a message

A sender submits a message with a fixed replay-bound id to a recipient id; the Relay stores it as `pending` and returns a receipt. The sender, and only the sender, can read that receipt later. Acceptance is delivery only and never executes work.

## Sub-features

- `send-ok` stores the message and returns `state: "pending"` with a `receipt_id`.
- `send-replay` re-submitting the identical message returns the identical receipt (same `receipt_id`, `accepted_at`).
- `send-conflict` re-using a `message_id` with a different body is refused with `idempotency_conflict`.
- `send-kind` a kind outside the allowed set (`question`, `answer`, `notice`) is refused with `forbidden`.
- `send-status` the sender's `relay_status` returns the receipt; another agent gets `not_found`.
- `send-thread-scope` a `thread_id` belongs to the agent pair that uses it: another agent reusing the same name with a different peer gets its own thread and the same answer as for an unused name, never `invalid_reference`.

## How to get to it (user POV)

- MCP tool `relay_submit` with the message object; MCP tool `relay_status` with `{"message_id": "<id>"}`.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Submit.** Run `MSG=$($S/new-message.sh "$RUN" b "hello from a")` then `$S/mcp.sh "$RUN" a relay_submit "$MSG"`. `structuredContent.state` is `pending`, `sender_id` is agent `a`'s id, `recipient_id` is `b`'s.
- **Identical replay.** Run `$S/mcp.sh "$RUN" a relay_submit "$MSG"` again. Same `receipt_id` and `accepted_at` as the first response.
- **Conflicting replay.** Run `$S/mcp.sh "$RUN" a relay_submit "$(jq -c '.body.parts[0].text="changed"' <<<"$MSG")"`. `{"error":"idempotency_conflict"}`.
- **Disallowed kind.** Run `$S/mcp.sh "$RUN" a relay_submit "$($S/new-message.sh "$RUN" b x task)"`. `{"error":"forbidden"}`.
- **Sender status.** Run `ID=$(jq -r .message_id <<<"$MSG")` then `$S/mcp.sh "$RUN" a relay_status "{\"message_id\":\"$ID\"}"`. Same receipt, `state: "pending"`.
- **Non-sender status.** Run `$S/mcp.sh "$RUN" c relay_status "{\"message_id\":\"$ID\"}"`. `{"error":"not_found"}`.
- **Thread scope.** Run `T=$(jq -r .thread_id <<<"$MSG")`, then `$S/mcp.sh "$RUN" c relay_submit "$($S/new-message.sh "$RUN" b "same name" | jq -c --arg t "$T" '.thread_id=$t')"` and `$S/mcp.sh "$RUN" c relay_submit "$($S/new-message.sh "$RUN" a "same name" | jq -c --arg t "$T" '.thread_id=$t')"`. Both return `state: "pending"`, and `a` can still submit to `b` on `$T`.
- **Proof.** Run `node $S/inspect.mjs "$RUN" after-send`. Exactly one `messages` row for `$ID`, one `deliveries` row with `state: "pending"`, `generation: 0`, and one `accepted` audit event (the replay added none). `inspect.mjs` shows the plain `thread_id` name even though the store keys threads by agent pair.

## Gotchas

- `new-message.sh` sets `first_sent_at` 100 ms in the past and `expires_at` exactly one hour later; hand-built messages with another lifetime or a `message_id` whose `rm1.<ms>` part does not equal `first_sent_at` are refused as `invalid_contract`.
- Sending to yourself (`a` → `a`) is currently accepted; do not use it as a negative case.
- `relay_status` reports delivery state (`pending`/`leased`/`acked`), never work completion.
