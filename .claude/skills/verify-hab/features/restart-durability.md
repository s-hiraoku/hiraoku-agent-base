# Restart durability

This recipe verifies that an accepted message remains deliverable after a graceful host process restart using the same data.

## Sub-features

- `restart-pending` a `pending` message submitted before stop is delivered by `hab_poll` after reopen.
- `restart-identity` agent ids, addresses and tokens are unchanged after reopen (no re-enrollment).

## How to get to it (user POV)

- Operator stops and restarts the host; agents keep calling the same `POST /mcp` URL.

## Driving it with verify-hab

Preconditions:

- Baseline run, doctor OK.

- **Submit before stop.** Run `MSG=$($S/new-message.sh "$RUN" c "survive restart")` and `$S/mcp.sh "$RUN" a hab_submit "$MSG"`. `state: "pending"`.
- **Stop, keep data.** Run `$S/cleanup.sh "$RUN" --stop-only`. Prints `stopped <pid>`; `$RUN/evidence/stack.log` ends with `HAB_VERIFY_STOPPED`; `$RUN/instance/*.sqlite` still exist.
- **Reopen.** Run `$S/launch.sh "$RUN"`. `stack.log` shows a new `--- launch` block with `reopened verify-a@grok-bot.hab=<same id> …` and `HAB_VERIFY_READY` on the same URL. The launch process then prints `DOCTOR_OK <url>` (from `doctor.sh`, not written into `stack.log`).
- **Receive after restart.** Run `$S/mcp.sh "$RUN" c hab_poll`. Delivery body text is `survive restart`, `generation: 1`.
- **Proof.** `stack.log` (both launch blocks), the pre-stop submit `.res`, the post-restart poll `.res`, and `node $S/inspect.mjs "$RUN" after-restart`.

## Gotchas

- Reopen reuses the recorded port; if another process grabbed it meanwhile, launch fails with `stack_exited` and a listen error in `stack.log`. Start a new run dir in that case.
- `new-message.sh` sets a one-hour `expires_at`. Poll after reopen before that deadline, or the row can expire and clear its body.
- This recipe verifies a graceful SIGTERM stop only when `HAB_VERIFY_STOPPED` is present before relaunch. A cleanup fallback to SIGKILL does not pass this graceful-stop proof.
- `npm run test:hab-integration` covers orderly in-process DB/listener close/reopen and injected lost-response recovery. It does not terminate a child with kill-9. Abrupt process death, power loss and physical storage failure remain unverified by these paths.
