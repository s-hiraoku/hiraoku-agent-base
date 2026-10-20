# Restart durability

A message accepted by the Relay is stored durably: if the Relay process stops and starts again on the same data, the recipient still receives it.

## Sub-features

- `restart-pending` a `pending` message submitted before stop is delivered by `relay_poll` after reopen.
- `restart-identity` agent ids, addresses and tokens are unchanged after reopen (no re-enrollment).

## How to get to it (user POV)

- Operator stops and restarts the host; agents keep calling the same `POST /mcp` URL.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Submit before stop.** Run `MSG=$($S/new-message.sh "$RUN" c "survive restart")` and `$S/mcp.sh "$RUN" a relay_submit "$MSG"`. `state: "pending"`.
- **Stop, keep data.** Run `$S/cleanup.sh "$RUN" --stop-only`. Prints `stopped <pid>`; `$RUN/evidence/stack.log` ends with `HAB_VERIFY_STOPPED`; `$RUN/instance/*.sqlite` still exist.
- **Reopen.** Run `$S/launch.sh "$RUN"`. `stack.log` shows a new `--- launch` block with `reopened verify-a@grok-bot.hab=<same id> …` and `DOCTOR_OK` on the same URL.
- **Receive after restart.** Run `$S/mcp.sh "$RUN" c relay_poll`. Delivery body text is `survive restart`, `generation: 1`.
- **Proof.** `stack.log` (both launch blocks), the pre-stop submit `.res`, the post-restart poll `.res`, and `node $S/inspect.mjs "$RUN" after-restart`.

## Gotchas

- Reopen reuses the recorded port; if another process grabbed it meanwhile, launch fails with `stack_exited` and a listen error in `stack.log`. Start a new run dir in that case.
- This is a clean SIGTERM stop. Crash/kill-9 recovery is covered by `npm run test:hab-integration`, not by this recipe.
