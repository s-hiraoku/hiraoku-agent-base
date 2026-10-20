# HAB verification map

This directory is the maintained source for verifying HAB's user-facing behavior. Read the index before driving, then use the matching feature file as the recipe. Commands assume the repo root as cwd, `S=.claude/skills/verify-hab/scripts`, and a run dir `RUN` launched by this run.

## Baseline preconditions

- `npm ci` has been run with Node ≥ 24.
- `$S/launch.sh "$RUN"` printed `DOCTOR_OK <url>` for a fresh `RUN=/tmp/hab-verify/<id>`.
- Baseline state: three active agents `a` = `verify-a@grok-bot.hab`, `b` = `verify-b@dot.hab`, `c` = `verify-c@hermes.hab`, each allowed `submit,status,poll,ack,resolve`, and no messages. Their ids and tokens are in `$RUN/instance/state.json`.
- Never drive a run dir or a port this verification run did not start.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise. A recipe that leaves a pending or leased message changes later `relay_poll` results; launch a new run dir instead of reusing it.
- All agent actions go through `$S/mcp.sh "$RUN" <agent> <tool> '<json>'`; build messages with `$S/new-message.sh`.
- Read results from `.result.structuredContent`. A tool refusal is HTTP 200 with `"isError":true` and `{"error":"<code>"}`; transport refusal is a non-200 HTTP code.
- The enrollment terminal is driven with tmux `send-keys`, waiting on the exact prompt text before each key.

## Proof and skip reporting

- Capture the action's request/response (`mcp.sh` does this) and a second view of the result: another agent's tool call and/or `node $S/inspect.mjs "$RUN" <label>`.
- Mutation proof includes the delivery state and `relay_delivery_audit` events from `inspect.mjs`.
- Terminal proof is a `tmux capture-pane -p` transcript saved in `$RUN/evidence/` plus the exit code.
- Record the sub-feature ID with each evidence file name.
- If a precondition is missing, report the attempted command and the unmet precondition. Do not report an entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-hab`, `Gotchas`.

## Features

- [Resolve an address](./resolve-address.md) covers `relay_resolve` success, unknown address and malformed address.
- [Send a message](./send-message.md) covers `relay_submit`, idempotent replay, conflicting replay, disallowed kind and sender-only `relay_status`.
- [Receive and acknowledge](./receive-ack.md) covers `relay_poll` leasing, empty poll, lease expiry redelivery and `relay_ack` including wrong-token and wrong-agent refusal.
- [Access control](./access-control.md) covers missing and unknown bearer tokens.
- [Restart durability](./restart-durability.md) covers a pending message surviving a stack stop and reopen.
- [Enrollment terminal](./enrollment-terminal.md) covers the human registration flow from product choice to an active address.
