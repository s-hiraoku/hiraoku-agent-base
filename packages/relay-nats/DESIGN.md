# HAB delivery through JetStream

JetStream is HAB's only delivery backend. The host has one start path (`npm run relay:local`), one `delivery` config section, and no SQLite delivery store, router, or routing epoch. Messages held by the retired SQLite store are not migrated.

The package keeps the existing synchronous HAB operation boundary and moves broker I/O into a supervised pump. `HabJetStreamService` implements the same `submit`, `status`, `poll`, `ack`, address resolution, and optional discovery methods used by `HabMcpClient`. No Promise crosses `SQLiteHabRegistry.withRelay`, and the MCP executor's Promise rejection remains unchanged.

## Admission and authority

`admitWithAuthorization` commits a private SQLite admission record and the original body outbox inside the current Registry guard. That commit is the acceptance point. A pending receipt proves HAB has admitted the body for publication. It does not prove a PubAck or recipient save.

The pump publishes the original ID and remaining TTL. After PubAck or reconciliation of a lost PubAck, it clears the outbox. It can prefetch verified broker bodies into a bounded private cache. Prefetch never leases to a HAB recipient, creates a saved receipt, starts a Task, or carries an Authorization across await.

Public poll and ACK acquire a fresh `withRelay` scope and commit synchronously. The guard checks the current credential, selected immutable ID, group membership, operation rights, sender, kind, block policy, credential expiry, and Registry epoch. Stopped or revoked subjects cannot use an earlier scope. An admission that committed before revocation remains admitted, while later delivery requires current rights.

The considered alternative was a Promise-returning replacement inside the existing guard. The Registry rejects that return value. Awaiting a copied authorization after publication cannot undo a publication. A synchronous façade also preserves the HTTP cancellation boundary because background prefetch cannot create a late user lease.

## Replies, capacity, and the delivery audit

Each store-level rule from the retired SQLite store lives in the journal transaction that changes the state. A reply must reference a message its recipient sent to its sender in the same pair-scoped thread. A third agent cannot reuse another pair's thread name. Admission checks the global record, pending, recipient, and body limits and the required per-sender quotas and reservations before it inserts. An exact retry needs no new capacity. A recipient has at most one application lease, and fair poll alternates senders over the cached candidates.

The journal keeps a redacted delivery audit (`nats_delivery_audit`: sender, message ID, time, and one of `accepted`, `leased`, `requeued`, `quarantined`, `expired`, `acked`) with no body or token. Each event is inserted in the same transaction as the state change it records. An audit failure rolls back that admission, lease, or ACK, including its capacity use. `nats_maintenance_totals` counts expired and purged records. If its row is missing, expiry and collection fail closed with `maintenance_state_unavailable` instead of losing the counts. Purging a record also removes its audit events.

### Visibility latency

Admission commits synchronously, but a message becomes pollable only after the pump publishes and caches it. A poll right after a submit can therefore return no delivery for up to one pump cycle (`delivery.pump.interval_ms`, 100 ms in the example config) plus broker round trips. The retired SQLite store made an accepted message pollable immediately. Clients already poll repeatedly, so no contract changes. Tests that need the old immediacy run the production pump to completion before polling.

## Broker policy and recovery

The fixed server is [NATS Server 2.15.2](https://github.com/nats-io/nats-server/releases/tag/v2.15.2). The stream uses File storage, one replica, Limits retention, DiscardNew, one stored message per unique subject, and finite message, byte, size, and consumer limits. The backend creates no consumer; HAB disposes of a body by tracked explicit erasure.

Subjects contain hashes of immutable IDs and message keys. A journal HMAC detects changed content for the same ID. A unique subject and expected sequence zero reconcile publication beyond the broker's two-minute deduplication window. HAB's retained receipt remains the longer-lived deduplication record.

The synchronous HAB pump selects only uncached pending journal rows and reads their unique subjects through the official stream message API. It verifies the exact sequence, subject, size, original expiry, and content fingerprint before caching. Missing or replaced published bodies fail closed without republishing.

The HAB cache bound covers the entire admitted mailbox bound, so a stopped sender cannot hide all other candidates. Durable sender and within-sender message positions advance even over denied candidates while each poll scans at most `poll_scan_limit` rows. The Registry and journal still permit only one HAB lease. The earlier asynchronous submit, status, poll and ACK operations, which read through a durable explicit-ACK consumer, were deleted because no production caller used them; the host has only this synchronous path.

Application leases retain generation, token, expiry, retry visibility, and bounded attempt checks. Retry exhaustion persists as quarantine. The Limits stream retains quarantined bodies until TTL. A broker-capacity error does not prevent cached accepted work from reaching the recipient and freeing space through saved ACKs.

Runtime reconnection is explicit when `reconnect:true`. The client transport itself has reconnect disabled, so old timed-out PUB frames cannot flush from an offline buffer. The next pump replaces a failed connection, checks the pinned version and stream configuration, and reconciles the same journal. It never creates a missing replacement stream during reconnect.

Unknown journals are refused. A v1, v2, or v3 journal requires explicit `migrate_journal:true` for the v4 migration. The migration preserves receipts and the fair sender and within-sender message positions, drops the retired routing state and next-store turn, and adds the delivery audit and maintenance totals. Schema 4 records only events after the migration. A changed key, stream binding, or subject prefix is refused.

## Saved receipt and body disposal

The recipient's existing `DurableReceiver` saves the body, deduplication key, and original ACK request first. HAB then validates the current lease and commits its saved receipt. A response loss retrieves that exact receipt. Broker ACK and erasure can finish later without another user delivery.

The HAB pump uses tracked explicit erasure after the saved receipt rather than a consumer ACK. Recovery after a gateway restart uses the same explicit erase API for an already-saved message. No private client reply field or raw broker ACK subject is given to a product.

After saved ACK, the journal removes its body cache and leaves cleanup pending. Explicit `deleteMessage(..., true)` and a follow-up absent-body read finish broker cleanup. Failed cleanup remains durable. The private health file records fixed-code ready or degraded transitions, including publication and integrity failures. The file is a transition record, not a heartbeat.

HAB retains its original one-hour absolute deadline. Publication rounds remaining broker TTL up to seconds because the pinned server rejects subsecond TTL. Lease and ACK checks use the original deadline. Broker logical expiry can lag by rounding and transport delay. Repeated submission never extends the HAB deadline.

Expired records retain at least 30 days. ACK records retain the ACK retry horizon plus record retention. Legacy IDs are safety-held. Only replay-bound `rm1` IDs can be collected. Body disposal does not erase receiver copies, filesystem snapshots, backups, or every physical SSD block.

## A2A and the remaining proof

`HabA2aRoute` continues to use `HabMcpClient` and the same durable sender and receiver ports. Backend selection stays behind that endpoint. Saved ACK does not mark an A2A Task working or completed. The recipient's explicit TaskBridge and independently verified closed result remain the execution boundary.

The package does not guarantee application effects exactly once. The final combined A2A-to-JetStream-to-Task proof and an independent restore exercise remain with the integration owner. Hosted CI, real VPS deployment, OS power failure, partitions, and corrupt storage are not implied by a local functional test.

The fixture uses `sync_interval: always` and SQLite `synchronous=FULL`. The client cannot attest the server's fsync configuration through INFO. The [official configuration](https://docs.nats.io/reference/config/jetstream/sync_interval), [2.14.6 compaction fix](https://github.com/nats-io/nats-server/releases/tag/v2.14.6), and [2.15.0 WAL changes](https://github.com/nats-io/nats-server/releases/tag/v2.15.0) describe separate durability conditions. They do not prove this machine's power-loss safety.

Official issues [7549](https://github.com/nats-io/nats-server/issues/7549), [7556](https://github.com/nats-io/nats-server/issues/7556), [7564](https://github.com/nats-io/nats-server/issues/7564), and [7567](https://github.com/nats-io/nats-server/issues/7567) were still open when checked on 2026-11-01. Partial snapshot fail-to-start fixes and fsync documentation do not establish complete resolution of the reported faults in 2.15.2.
