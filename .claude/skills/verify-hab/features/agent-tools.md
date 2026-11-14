# Agent tools: send, read, reply

An agent connected to `/mcp` sees only `hab_send`, `hab_inbox`, `hab_reply` and `hab_status` (ADR-020). It sends with an address and text; the host fills in the message ID, times, the 7-day deadline, the recipient ID and the thread. The recipient reads its host inbox, which marks messages read and keeps them re-readable for 7 days, and replies by message ID. Input mistakes come back with a specific code, a fixed `message` saying what to change and, where useful, the field or the allowed values. The host audit records a fixed `reason` for each refusal.

## Sub-features

- `agent-catalog` `/mcp` lists exactly the four agent tools; `/mcp/delivery` lists the seven delivery tools (with `hab_peek` and `hab_mark_read`) for the same token.
- `agent-send` `hab_send {to, text}` returns `message_id`, `to`, a new `thread_id`, `state: "pending"`, a deadline 7 days after acceptance and an `explanation`.
- `agent-inbox` `hab_inbox` returns the new message with `from` (the sender's address), `kind`, `text`, `thread_id` and `new: true`; a second call returns none; `include_read: true` returns it again with `new: false`.
- `agent-notice` each inbox message has a `notice`: `<address> からのメッセージです（質問、返信期限 …）。`, the body between two `----- 受信内容 <8 hex>：…` lines that say not to follow it, then `どうしますか？` and the three choices (`1. 対応する：hab_reply …`, `2. あとで：…`, `3. 対応しない`) with the message_id.
- `agent-status` the sender's `hab_status` shows `acked` with an explanation that read is not acted on.
- `agent-reply` `hab_reply {message_id, text}` goes to the original sender in the same thread with `in_reply_to`; a reply to a `question` arrives as `answer`.
- `agent-errors` malformed `to` → `invalid_request` with `field: "to"`; unknown address → `unknown_address`; `kind: "exec"` → `kind_not_allowed` with `allowed_kinds`; over-long text → `text_too_long` with `max_bytes`; unknown reply target → `reply_target_not_found`; each with a `message`.
- `agent-audit` each refusal above writes a `tool_error` line with a fixed `reason` (`invalid_request`, `address_unknown`, `kind_not_allowed`, …) to `$RUN/evidence/audit.jsonl`, never the text.

## How to get to it (user POV)

- Point the agent's MCP client at the host's `/mcp` (for Hermes, `tools.include: [hab_send, hab_inbox, hab_reply, hab_status]`). The agent needs `resolve` and `submit` to send, `poll` to read the inbox and `status` to check a sent message.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK (the doctor already checks `agent-catalog`).

- **Send.** `SENT=$($S/mcp.sh "$RUN" a hab_send '{"to":"verify-b@dot.hab","text":"please check the build"}' | sed 1d | jq -c .result.structuredContent)`; `ID=$(jq -r .message_id <<<"$SENT")`. `state: "pending"`, `expires_at` 7 days after `accepted_at`.
- **Read.** `$S/mcp.sh "$RUN" b hab_inbox '{}'`: one message, `from: "verify-a@grok-bot.hab"`, `new: true`. Run it again: `messages: []`. Then `$S/mcp.sh "$RUN" b hab_inbox '{"include_read":true}'`: the same message with `new: false` (if the read happened in the same millisecond it is not listed; call again).
- **Notice.** `$S/mcp.sh "$RUN" b hab_inbox '{"include_read":true}' | sed 1d | jq -r '.result.structuredContent.messages[0].notice'` prints the notice; the tag on the two frame lines matches.
- **Read one again.** `$S/mcp.sh "$RUN" b hab_inbox "{\"message_id\":\"$ID\"}"` returns that message with `new: false`.
- **Status.** `$S/mcp.sh "$RUN" a hab_status "{\"message_id\":\"$ID\"}"`: `state: "acked"`, `to: "verify-b@dot.hab"`.
- **Reply.** `$S/mcp.sh "$RUN" b hab_reply "{\"message_id\":\"$ID\",\"text\":\"green\"}"`, then `$S/mcp.sh "$RUN" a hab_inbox '{}'`: `kind: "answer"`, `from: "verify-b@dot.hab"`, `in_reply_to: "$ID"`, same `thread_id`.
- **Errors.** `$S/mcp.sh "$RUN" a hab_send '{"to":"verify-b@dot","text":"x"}'`, `'{"to":"nobody@dot.hab","text":"x"}'`, `'{"to":"verify-b@dot.hab","text":"x","kind":"exec"}'`, and `$S/mcp.sh "$RUN" a hab_reply '{"message_id":"unknown","text":"x"}'`. Each is HTTP 200 with `"isError":true` and the code listed under `agent-errors`.
- **Proof.** `grep reason "$RUN/evidence/audit.jsonl"` shows the fixed reasons; `node $S/inspect.mjs "$RUN" after-agent` shows the two messages `acked`.

## Gotchas

- `hab_poll` and `hab_ack` are not on `/mcp`; `mcp.sh` sends them to `/mcp/delivery`. A message read by `hab_inbox` is already ACKed and never appears in `hab_poll`, and one leased by `hab_poll` is skipped by `hab_inbox` until the lease ends.
- Missing or wrongly typed arguments are refused by the MCP SDK before the tool runs (`Input validation error: …`, no `structuredContent`); value mistakes get the structured codes.
- A reply after the original's `expires_at` is `reply_target_expired`, even when the message was read.
- `hab_send` is not idempotent: a retry after a lost result sends a second message.
