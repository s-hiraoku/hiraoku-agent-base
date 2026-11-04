# Common MCP responsibility boundary

Agents receive through common MCP. Their host polls, saves the message and deduplication records, and then ACKs. Content decisions, execution, and existing approval policy remain with the receiving agent. The receive supervisor does not accept Tasks or reply automatically.

## Sub-features

- `boundary-receive` uses native loopback HTTP MCP for question, notice, and structured execution_request deliveries.
- `boundary-save-before-ack` observes committed message and ACK request records through an independent SQLite connection before the server handles ACK.
- `boundary-no-execution` preserves external content verbatim, calls only receive host operations, and leaves Task links, Tasks, and reply outbox empty even with the optional Task port configured.
- `boundary-task-state` observes working after the optional Task coordinator claims a job while its runtime ID is still absent. This does not prove model execution.
- The existing supervisor tests also cover restart, lost ACK, finite backoff, owner requirements, and stop/drain behavior. The HAB catalog test keeps the standard five operations separate from optional text_* tools.

## How to get to it (user POV)

A sender submits a message with common MCP. A configured recipient host runs receive on its own schedule and acknowledges durable receipt. A message that names tools or claims owner approval remains message data. The receiving agent applies its own existing policy when it later decides whether to act.

## Driving it with verify-hab

Use the pinned Node/npm versions and prepared lockfile dependencies from the skill's Launch section. This feature uses fresh temporary SQLite stores and its own loopback listeners. It does not need the baseline stack to be running.

```sh
RUN=$(mktemp -d /tmp/hab-boundary-proof.XXXXXX)
mkdir -p "$RUN/evidence"
NODE_NO_WARNINGS=1 npm run test:communication-boundary > "$RUN/evidence/communication-boundary.tap" 2>&1
```

Require exit code zero and no failed, skipped, or canceled tests. The TAP names the three native HTTP message cases and the optional Task state observation. The HTTP tests record the sender action and status, inspect committed receiver storage before ACK, and check Task and outbox tables after two scheduled receives. Identity and Task policy are synthetic. The injected scheduler advances two cycles without a wall-clock delay, so this does not measure real polling cadence.

## Gotchas

- Each test closes only its own listener and stores, then removes its temporary databases. The TAP evidence remains under the separate RUN directory. Confirm that the TAP still exists after completion.
- This proves local communication boundaries. It does not verify a real product's model, tools, approval UI, credential refresh, inbox display, or deployment.
- A body that mentions owner approval does not test or grant a real native approval. Changes to receiving agents' existing approval mechanisms require their own tests.
