# A2A entry on the configured Relay

With an `a2a` config section, the shipped Relay opens a separate loopback A2A listener. An A2A client sends the fixed `connectivity_check` Task. The host sends it from its own Registry address (`a2a@hab-host.hab`), not the caller's. The configured recipient receives it through its normal MCP poll/ACK and replies to the host with `execution_accepted` and `execution_result`. The A2A client then sees `WORKING` and `COMPLETED`, with the result text as the Artifact and `attestation: "recipient_reply"` in the metadata. Without the section there is no listener, mailbox file or host identity.

## Sub-features

- `a2a-off` a config without `a2a` prints no `a2a_url` in the ready line and creates no `a2a-*.sqlite` file and no `a2a@hab-host.hab` address.
- `a2a-identity` start provisions `a2a@hab-host.hab` with one binding and `ack, poll, status, submit`. A restart leaves its agent ID and epoch unchanged. `relay:admin connect --address a2a@hab-host.hab …` is refused with `a2a_identity_reserved`.
- `a2a-card` `GET /.well-known/agent-card.json` with an A2A credential returns `HAB host connectivity check`.
- `a2a-auth` no bearer, an unknown bearer, or an MCP-audience bearer each get HTTP 401. An `Origin` header or `Host: localhost:<port>` gets 403.
- `a2a-send` SendMessage returns `TASK_STATE_SUBMITTED`. The recipient's poll shows `kind: execution_request` with `sender_id` equal to the host identity. A storage ACK alone leaves the Task `SUBMITTED`.
- `a2a-restart` after a Relay restart the same Task is still `SUBMITTED`, and the replies sent after the restart still complete it.
- `a2a-complete` the `execution_accepted` reply moves the Task to `WORKING`. The `execution_result` reply with `succeeded` moves it to `COMPLETED`, with Artifact text `connectivity_ok` and `result_message_id` equal to the reply's message ID.
- `a2a-fresh-id` a reply under a new message ID that would not change the Task, such as a second `execution_accepted` after `WORKING`, is ACKed (`relay_status` shows `acked`) without a host inbox record and leaves the Task unchanged. A valid `execution_result` sent after any number of them still completes the Task.
- `a2a-window` a Task with no result one day after its request's one-hour deadline is `TASK_STATE_FAILED`, with `metadata.hab_relay.reason == "result_window_expired"` and a status message saying the outcome is unknown. The host starts bounded processing at that time without a read, at most 100 Tasks per cycle; failed applies do not starve later Tasks. A later reply is ACKed without changing it. A live drive cannot wait out that day: `test/a2a-host.test.js` ages the request, once so that the window closes seconds after a restart.

## How to get to it (user POV)

- Operator: merge `config/relay-a2a.example.json` into the service config, then run `npm run relay:local -- --config …`. The ready line includes `a2a_url`. Bind each A2A caller's credential (audience `http://127.0.0.1:<a2a port>/a2a`) with `relay:admin connect`.
- A2A client: the official A2A client at `http://127.0.0.1:<a2a port>` with its bearer.
- Recipient agent: its usual MCP client at `/mcp`. It replies to the host address.

## Driving it with verify-hab

Preconditions are the same as [configured-relay.md](configured-relay.md), with a fresh `RUN`.

- **Start.** `HAB_VERIFY_A2A=1 $S/configured.sh "$RUN" start`. `state.json` gains `a2a_url` and caller `x`, a second connection of `codex@codex.hab` whose audience is the A2A endpoint. The recipient is `b` = `hermes@hermes.hab`. `admin status` lists `a2a@hab-host.hab` with `active_bindings: 1`.
- **Card and refusals.** Run `$S/a2a.sh "$RUN" x card` and check for HTTP 200. Then `$S/a2a.sh "$RUN" none SendMessage`, `… BAD SendMessage` and `… a SendMessage` (MCP audience) each return HTTP 401.
- **Send.** `$S/a2a.sh "$RUN" x SendMessage '{"message":{"messageId":"live_1","role":"ROLE_USER","parts":[{"text":"connectivity_check"}]},"configuration":{"returnImmediately":true}}' | sed 1d > "$RUN/send.json"`. Then `sleep 0.3; $S/mcp.sh "$RUN" b relay_poll '{}' | sed 1d > "$RUN/poll.json"`, and ACK it as in `SKILL.md`. `GetTask` (`$S/a2a.sh "$RUN" x GetTask '{"id":"<task id>"}'`) still returns `TASK_STATE_SUBMITTED`.
- **Restart.** Run `$S/configured.sh "$RUN" restart`. `GetTask` again returns `TASK_STATE_SUBMITTED`, and the identity's `agent_id`/`epoch` in `admin status` are unchanged.
- **Reply.** `$S/mcp.sh "$RUN" b relay_submit "$($S/new-reply.sh "$RUN/poll.json" execution_accepted engine-1)"` moves `GetTask` to `TASK_STATE_WORKING` within a few poll intervals. Then `… "$($S/new-reply.sh "$RUN/poll.json" execution_result engine-1 succeeded connectivity_ok)"` moves it to `TASK_STATE_COMPLETED`, with `.result.artifacts[0].parts[0].text == "connectivity_ok"`.
- **Fresh ID.** Between the two replies above, send `execution_accepted engine-1` again with `new-reply.sh`, which mints a new message ID. `relay_status` for it shows `acked` within a few poll intervals, `GetTask` stays `TASK_STATE_WORKING`, and `node -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(process.argv[1], { readOnly: true }).prepare("SELECT count(*) n FROM relay_inbox").get().n)' "$RUN/instance/state/a2a-inbox.sqlite"` stays at the count before it. The result reply then completes the Task as above.
- **Host.** `curl` the A2A URL with `Host: localhost:<a2a port>` or an `Origin` header and check for 403.
- **Stop.** Run `$S/configured.sh "$RUN" stop`.

## Gotchas

- Replies must be `relay_submit` from the configured recipient with `in_reply_to` pointing at the host's request. The Relay quarantines a forged reference from another agent. The host releases any other mail it receives without reading it into a Task.
- An `acked` status for a reply does not mean the host applied it. A reply under a new ID that repeats what the Task or ACK-confirmed held replies carry, or that the Task would refuse, is ACKed without a record. If its usefulness instead depends on an unconfirmed held reply failing, it is deferred without saving or ACKing it. Finite relay retries or TTL can quarantine or expire that deferred reply; inspect its status rather than assuming it was accepted.
- There is no background resend. If SendMessage failed, repeat it with the same `messageId`.
- The host polls every `a2a.poll_interval_ms` (100 ms here). Poll `GetTask` a few times after each reply.
- A Relay restarted from inside a short-lived shell can be reaped with that shell. Run `restart` and the later drives from the same long-lived shell, or check `kill -0 $(jq .pid "$RUN/instance/state.json")` before driving.
- `COMPLETED` means the recipient reported a result. The host does not verify the recipient's engine.
- `FAILED` with `result_window_expired` does not mean the recipient did not execute the request. The outcome is unknown.
- A blocking SendMessage (no `returnImmediately`) completes from a result that arrives in a later host poll cycle than the acceptance. It no longer stalls the host's receive loop until the five-second wait runs out.

- Capacity maintenance may collect only some eligible outbox rows. It leaves room for two replies per still-open source window and usable sender slot after collection (max(0, configured cap minus retained rows plus proposed collection)), including bytes and ACK/row history. An unexpected per-Task save failure keeps its body; it is not permission to discard mail. The synthetic mixed-cohort regression proves another Task can complete while one such body remains, not repair of corrupt storage.
- A deferred fresh reply has no local acceptance guarantee: finite relay attempts or TTL may quarantine or expire it. The tests include that terminal outcome rather than promising eventual redelivery.
- Disconnecting the host identity permanently disables A2A for this Registry. Configuring a new address cannot reset the reserved principal; remove `a2a` to start MCP alone. No identity rotation procedure is provided.
- The legal close-boundary controls preserve original Task/message IDs and show synchronous sender claim-to-admission precedes a queued close. They establish no normal-shutdown defect.
- Source-scoped inbox reads use an additive index but keep current authorization and final correlation checks. The 200-body/64-read test measures parsed bodies, not real MCP starvation.
