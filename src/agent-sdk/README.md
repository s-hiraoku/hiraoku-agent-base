# Agent SDK: durable sender and save-then-ACK receiver

This directory is the agent-side client of HAB delivery. An agent embeds it to call the host's MCP entry (`relay_submit`, `relay_status`, `relay_poll`, `relay_ack`) without losing a message across crashes, lost responses or restarts. The server side is elsewhere. The message contract and the `DeliveryService` port live in [`../messaging`](../messaging/index.ts), the Registry in [`../hab`](../hab/README.md), and the one host in [`../host`](../host). JetStream is the only delivery backend ([packages/relay-nats/DESIGN.md](../../packages/relay-nats/DESIGN.md)).

Importing `./index.ts` performs no IO. It exports the pure `DurableSender` and `DurableReceiver` and their store and transport ports. The SQLite stores and the MCP transport are separate entry points, so a caller opts into each IO dependency by name.

| Module | Role |
| --- | --- |
| `receiver.ts` | `DurableReceiver`. `receiveOnce()` recovers a due ACK, polls at most one delivery, saves its body, dedup key and stable ACK request, then ACKs. |
| `sqlite-inbox.ts` | `SQLiteInbox`, the receiver store and the local inbox lifecycle (`releaseBody`, `maintain`). |
| `sender.ts` | `DurableSender`. `enqueue()` commits the immutable submission before any network call. `sendOnce()` claims at most one job. |
| `sqlite-outbox.ts` | `SQLiteOutbox`, the sender store with lease fencing, bounded backoff and `maintain`. |
| `mcp-client.ts` | `RelayMcpClient`, the fixed relay_* tool client over Streamable HTTP. It implements both transport ports. |

## Receiver: save, then ACK

A failed local save sends no ACK. A response lost after the server committed the ACK is retried with the same journaled request. The server returns its existing receipt even after the lease expired, and the inbox holds one record per `(sender_id, message_id)`. If the ACK never committed and its lease went stale, a new lease creates a new stable ACK request against the same inbox record. Conflicting body or lease contents are refused. Overlapping `receiveOnce()` calls in one process are rejected. Multiple processes rely on the server's single receiver lease and the inbox's atomic dedup.

The inbox records received messages. It is not an execution queue, and a saved ACK does not start or accept a Task. An application saves the message in its own store, then calls `releaseBody` once. Unreleased bodies are never deleted automatically. Finite quotas refuse new messages until the application handles them. `max_records` and `max_body_bytes` count unreleased bodies only, so `releaseBody` frees a slot at once. `max_ack_records` bounds the dedup history, which every saved message enters, released or not. ACK records and released tombstones are collected only after 30-day retention past the original expiry, ACK retry horizon and local terminal time, and only for replay-bound `rm1` IDs.

## Sender: commit, then submit

A lost acceptance response replays the exact original submission. Once the submit budget is spent or the deadline passes, the job uses status lookup only. No retry extends the one-hour TTL or generates a replacement message. Exhaustion ends in quarantine before expiry or `expired_unknown` after it, never a claim that the recipient saw nothing. The receipt must match the local agent, message, recipient and expiry before the outbox commits acceptance and clears the body.

## MCP transport

`RelayMcpClient` makes one network attempt per operation, with byte, deadline, concurrency, SSE and JSON budgets supplied by the host. It refuses redirects, compressed responses and nonlocal plain HTTP. An injected credential provider supplies the Bearer header. The expected `agent_id` is a local result check, not identity proof; a mismatch returns `forbidden`, so the sender quarantines instead of replaying under other credentials. HTTP and protocol failures normalize to `relay_transport_failed`. Only allowlisted tool errors keep their code. The durable journals own retry, backoff and restart recovery.

## Tests

```sh
node --test test/relay-receiver.test.js test/relay-inbox-maintenance.test.js \
  test/relay-sender.test.js test/relay-outbox-maintenance.test.js \
  test/relay-mcp-client.test.js test/relay-mcp-client-http.test.js
```

The fixtures use synthetic keys and new temporary databases only.
