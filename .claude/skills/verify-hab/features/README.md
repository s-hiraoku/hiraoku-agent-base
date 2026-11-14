# HAB verification map

This directory is the maintained source for verifying HAB's user-facing behavior. Read the index before driving, then use the matching feature file as the recipe. Commands assume the repo root as cwd, `S=.claude/skills/verify-hab/scripts`, and a run dir `RUN` launched by this run.

## Baseline preconditions

- `npm ci` has been run with Node ≥ 26.
- `$S/launch.sh "$RUN"` printed `DOCTOR_OK <url>` for a fresh `RUN=/tmp/hab-verify/<id>`.
- Baseline state: three active agents `a` = `verify-a@grok-bot.hab`, `b` = `verify-b@dot.hab`, `c` = `verify-c@hermes.hab`, each allowed `submit,status,poll,ack,resolve`, and no messages. Their ids and tokens are in `$RUN/instance/state.json`.
- Never drive a run dir or a port this verification run did not start.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise. A recipe that leaves a pending or leased message changes later `hab_poll` results; launch a new run dir instead of reusing it.
- All agent actions go through `$S/mcp.sh "$RUN" <agent> <tool> '<json>'`; build messages with `$S/new-message.sh`. `mcp.sh` sends the agent tools to `/mcp` and `hab_submit`/`hab_poll`/`hab_ack`/`hab_resolve`/`hab_peek` to `/mcp/delivery`; `HAB_CATALOG=delivery` sends `hab_status` and `tools/list` there too.
- Read results from `.result.structuredContent`. A tool refusal is HTTP 200 with `"isError":true` and `{"error":"<code>","message":"<what to change>",…details}`; transport refusal is a non-200 HTTP code.
- The enrollment terminal is driven with tmux `send-keys`, waiting on the exact prompt text before each key.

## Proof and skip reporting

- Capture the action's request/response (`mcp.sh` does this) and a second view of the result: another agent's tool call and/or `node $S/inspect.mjs "$RUN" <label>`.
- Mutation proof includes the delivery state and the delivery store's `delivery_audit` events from `inspect.mjs`.
- Terminal proof is a `tmux capture-pane -p` transcript saved in `$RUN/evidence/` plus the exit code.
- Record the sub-feature ID with each evidence file name.
- If a precondition is missing, report the attempted command and the unmet precondition. Do not report an entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-hab`, `Gotchas`.

## Features

- [Common MCP responsibility boundary](./communication-boundary.md) covers native HTTP receive scheduling, committed storage before ACK, external text and structured execution requests remaining data, and optional Task state semantics. It runs isolated fixtures with its own listeners and cleanup.

- [Agent tools: send, read, reply](./agent-tools.md) covers the `/mcp` agent catalog: `hab_send`, `hab_inbox` (read, mark read, re-read), `hab_reply`, the agent `hab_status`, specific error codes and audit reasons.
- [Arrival notice and the user's choice](./arrival-notifier.md) covers `hab_peek` (new mail without marking it read, the owner's `display` format and the framed `handoff_prompt`) and the `hab:notify` CLI showing a notice through the JSONL screen, then 対応する / あとで / 対応しない with the once-only handoff.
- [Resolve an address](./resolve-address.md) covers `hab_resolve` success, unknown address, malformed address and a renamed agent's previous name during the grace period.
- [Send a message](./send-message.md) covers `hab_submit`, idempotent replay, conflicting replay, disallowed kind, attachment-part refusal, sender-only `hab_status` and per-pair thread names.
- [Receive and acknowledge](./receive-ack.md) covers `hab_poll` leasing, empty poll, lease expiry redelivery and `hab_ack` including wrong-token and wrong-agent refusal.
- [Access control](./access-control.md) covers missing and unknown bearer tokens.
- [Restart durability](./restart-durability.md) covers a pending message surviving a stack stop and reopen.
- [Enrollment terminal](./enrollment-terminal.md) covers the human registration flow from product choice to an active address.
- [Configured host and operator CLI](./configured-host.md) covers the shipped `hab:host` start refusal reasons, `hab:admin` connect/status/disconnect (including group disconnect stopping every member), a roundtrip through the shipped host and the exact-Host rule. It has its own launcher (`configured.sh`), not `launch.sh`.
- [A2A entry on the configured host](./a2a-host.md) covers A2A off by default, host identity provisioning and its reservation, Card, A2A auth refusals, a Task sent from the host identity, restart durability, completion from the recipient's replies, and the `result_window_expired` failure of a Task whose reply window closed. It uses `HAB_VERIFY_A2A=1 configured.sh start`, `a2a.sh` and `new-reply.sh`.
