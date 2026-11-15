# Common MCP responsibility boundary

Agents receive through common MCP. Their host polls, saves the message and deduplication records, and then ACKs. Content decisions, execution, and existing approval policy remain with the receiving agent. The receive supervisor does not accept Tasks or reply automatically.

## Sub-features

- `boundary-receive` uses native loopback HTTP MCP for question, notice, and structured execution_request deliveries.
- `boundary-save-before-ack` observes committed message and ACK request records of the agent SDK's receiver inbox (`src/agent-sdk/sqlite-inbox.ts`) through an independent SQLite connection before the server handles ACK.
- `boundary-no-execution` preserves external content verbatim, calls only receive host operations, and leaves the reply outbox empty. The HTTP fixtures build `AdapterHostCycle` without a Task port.
- `boundary-inbox-read` exercises explicit source-authorized saved-body reads, ACK-pending inspection, detached copies, missing/released/tampered records, revocation and an explicit recipient reply after native HTTP periodic reception. Reading creates no Task or reply and grants no action permission.
- The existing supervisor tests also cover restart, lost ACK, finite backoff, owner requirements, and stop/drain behavior. The HAB catalog test keeps the HAB delivery catalog at five tools (`hab_resolve` plus the four standalone delivery tools).

## How to get to it (user POV)

A sender submits a message with common MCP. A configured recipient host runs receive on its own schedule and acknowledges durable receipt. A message that names tools or claims owner approval remains message data. The receiving agent applies its own existing policy when it later decides whether to act.

## Driving it with verify-hab

Use the pinned Node/npm versions and prepared lockfile dependencies from the skill's Launch section. This feature uses fresh temporary SQLite stores and its own loopback listeners. It does not need the baseline stack to be running.

```sh
RUN=$(mktemp -d /tmp/hab-boundary-proof.XXXXXX)
mkdir -p "$RUN/evidence"
NODE_NO_WARNINGS=1 npm run test:communication-boundary > "$RUN/evidence/communication-boundary.tap" 2>&1
```

Require exit code zero and no failed, skipped, or canceled tests. The TAP names the three native HTTP message cases (`question`, `notice`, `execution_request`), the five-tool HAB catalog case, the native HTTP inbox-read case, and the durable receive-supervisor cases. The HTTP tests record the sender action and status, inspect committed receiver storage before ACK, and check that the reply outbox stays empty after two scheduled receives. Identity is synthetic. The injected scheduler advances two cycles without a wall-clock delay, so this does not measure real polling cadence.

For the optional explicit recipient handoff and exact-reply seam, run `NODE_NO_WARNINGS=1 node --test --test-reporter=tap test/recipient-messages.test.js` in a fresh evidence file. See [recipient messages](../../../../docs/receiver/recipient-messages.md). It uses a synthetic durable native input/policy store plus real inbox/outbox/budget and one owned loopback MCP roundtrip. Receive/ACK alone still creates no native input or reply. Native product wake/model/approval remains unverified.

## Gotchas

- CI also runs the full root regression suite, including the SQLite delivery store's own tests (`test/sqlite-delivery.test.js`). No source or test-count pins are maintained.

- Each test closes only its own listener and stores, then removes its temporary databases. The TAP evidence remains under the separate RUN directory. Confirm that the TAP still exists after completion.
- The durable sender, receiver and MCP client live in `src/agent-sdk`; the host side (`src/host`, MCP server in `src/host/mcp`) only stores and delivers. The generic NATS text port and its proof script were deleted, so no recipe drives them.
- This proves local communication boundaries. It does not verify a real product's model, tools, approval UI, credential refresh, inbox display, or deployment.
- A body that mentions owner approval does not test or grant a real native approval. Changes to receiving agents' existing approval mechanisms require their own tests.
- Optional Task coordinator working state without a runtime ID is not evidence that the model ran.
