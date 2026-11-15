# Agent SDK: durable sender and save-then-ACK receiver

This directory is the agent-side client of HAB delivery. An agent embeds it to call the host's MCP entry (`hab_submit`, `hab_status`, `hab_poll`, `hab_ack`) without losing a message across crashes, lost responses or restarts. The server side is elsewhere. The message contract and the `DeliveryService` port live in [`../messaging`](../messaging/index.ts), the Registry in [`../hab`](../hab/README.md), and the one host in [`../host`](../host). The host delivers through one SQLite file ([delivery store](../../docs/delivery-store.md), ADR-018).

Importing `./index.ts` performs no IO. It exports the pure `DurableSender` and `DurableReceiver` and their store and transport ports. The SQLite stores and the MCP transport are separate entry points, so a caller opts into each IO dependency by name.

| Module | Role |
| --- | --- |
| `receiver.ts` | `DurableReceiver`. `receiveOnce()` recovers a due ACK, polls at most one delivery, saves its body, dedup key and stable ACK request, then ACKs. |
| `sqlite-inbox.ts` | `SQLiteInbox`, the receiver store and the local inbox lifecycle (`releaseBody`, `maintain`). |
| `sender.ts` | `DurableSender`. `enqueue()` commits the immutable submission before any network call. `sendOnce()` claims at most one job. |
| `sqlite-outbox.ts` | `SQLiteOutbox`, the sender store with lease fencing, bounded backoff and `maintain`. |
| `mcp-client.ts` | `DeliveryMcpClient`, the fixed hab_* tool client over Streamable HTTP. It implements both transport ports. |
| `receive-host.ts` | `HostCore`, the serialized, epoch-fenced command runner, and `ReceiveHost`, which accepts only `receive`. It needs a control, an inbox and a transport, plus an optional process owner. |
| `sqlite-host-control.ts` | `SQLiteHostControl`, the durable pause/resume switch and epoch that stops a running command. A new control starts paused. |
| `sqlite-host-owner.ts` | `SQLiteHostOwner`, the process-lifetime lock that keeps two hosts off the same stores. |
| `receive-supervisor.ts` | `ReceiveSupervisor`, the model-free loop that repeats one `receive` step with backoff ([docs](../../docs/receiver/receive-supervisor.md)). |

## Receiver: save, then ACK

A failed local save sends no ACK. A response lost after the server committed the ACK is retried with the same journaled request. The server returns its existing receipt even after the lease expired, and the inbox holds one record per `(sender_id, message_id)`. If the ACK never committed and its lease went stale, a new lease creates a new stable ACK request against the same inbox record. Conflicting body or lease contents are refused. Overlapping `receiveOnce()` calls in one process are rejected. Multiple processes rely on the server's single receiver lease and the inbox's atomic dedup.

The inbox records received messages. It is not an execution queue, and a saved ACK does not start or accept a Task. An application saves the message in its own store, then calls `releaseBody` once. Unreleased bodies are never deleted automatically. `releaseUnconfirmable` releases a body whose receipt can no longer be confirmed: its ACK is unconfirmed, the message has expired so no new generation can be saved, and no ACK request is pending. An application that acts only on confirmed receipts calls it instead of `releaseBody` for such a body, and the tombstone still deduplicates. Finite quotas refuse new messages until the application handles them. `max_records` and `max_body_bytes` count unreleased bodies only, so `releaseBody` frees a slot at once. `max_ack_records` bounds the dedup history by message. Every saved message enters it, released or not. A lease redelivery of a message already in it adds an ACK row for the new generation without taking another slot, and one message keeps at most `max_attempts` generations, so the ACK table holds at most `max_ack_records × max_attempts` rows. ACK records and released tombstones are collected only after 30-day retention past the original expiry, ACK retry horizon and local terminal time, and only for replay-bound `rm1` IDs. A legacy ID's tombstone is never collected, because a replay of it could not be told from a new message. The inbox therefore holds at most `max_records + max_ack_records` message rows of any kind and at most `max_ack_records` legacy-ID rows. A new legacy ID beyond that is refused with `inbox_legacy_id_capacity_exceeded`, while replay-bound IDs keep the `max_records` body budget. A held legacy ID stays deduplicated and is never handed off again. `hasCapacityFor(records, bodyBytes)` reads current unreleased body/byte, distinct-message ACK-history and retained-row usage for a batch of new replay-bound messages. It neither collects records nor reserves capacity, and does not shorten the 30-day retention from the actual local terminal time after a long stop. The single-owner A2A host uses it after inbox maintenance before freeing outbox admission slots; it is not a multi-writer reservation.

## Sender: commit, then submit

A lost acceptance response replays the exact original submission. Once the submit budget is spent or the deadline passes, the job uses status lookup only. No retry extends the one-hour TTL or generates a replacement message. Exhaustion ends in quarantine before expiry or `expired_unknown` after it, never a claim that the recipient saw nothing. `maintain(limit, false)` or `maintain(limit, 0)` still expires payloads but defers collecting retained rows, keeping admission slots occupied. A numeric second argument caps collection separately within the total maintenance budget; `true` (the default) keeps normal collection. `retainedCounts(expiresAfter)` reads all retained rows and those with expiry strictly after the supplied horizon without reserving slots. The receipt must match the local agent, message, recipient and expiry before the outbox commits acceptance and clears the body.

## MCP transport

`DeliveryMcpClient` makes one network attempt per operation, with byte, deadline, concurrency, SSE and JSON budgets supplied by the host. It refuses redirects, compressed responses and nonlocal plain HTTP. An injected credential provider supplies the Bearer header. The expected `agent_id` is a local result check, not identity proof; a mismatch returns `forbidden`, so the sender quarantines instead of replaying under other credentials. HTTP and protocol failures normalize to `transport_failed`. Only allowlisted tool errors keep their code. The durable journals own retry, backoff and restart recovery.

## Receive host

A new agent receives with `ReceiveHost` and `ReceiveSupervisor` alone: no outbox, reply budget, Task bridge or answer journal is needed. The operator resumes the control and acquires the owner before the supervisor starts. `src/adapter-host`'s `AdapterHostCycle` extends the same `HostCore` and adds send, answers and the optional Task bridge.

## Tests

```sh
node --test test/receiver.test.js test/inbox-maintenance.test.js \
  test/sender.test.js test/outbox-maintenance.test.js \
  test/mcp-client.test.js test/mcp-client-http.test.js \
  test/receive-host.test.js test/receive-supervisor.test.js
```

The fixtures use synthetic keys and new temporary databases only.

An optional original-source (sender_id, message_id) hint limits SQLite inbox reads through an additive partial expression index over unreleased bodies. It includes pending ACKs, preserves ordering, excludes released empty bodies, and changes neither record format/version nor retention. The hint never replaces receipt, identity, reference, thread, schema or current-authorization checks; unfiltered route implementations remain compatible.

`authentication-recovery.ts` provides local-only branded recovery reasons and an optional
owner-local identity verification gate. It performs no IO, stores no tokens and does not
refresh or log in. See [receive recovery](../../docs/receiver/receive-supervisor.md#認証失効時の待機と検証後の再開)
for trusted native-provider wiring, fixed status metadata and the explicit operational limits.
