# JetStream delivery experiment

This opt-in package is an isolated P4 boundary experiment for HAB. It does not register a production backend, change the existing Relay implementation, start an OS service, or expose a public listener. P5 adoption and P6 host integration remain separate gates.

It uses the official NATS JavaScript transport and JetStream client 3.4.0, pinned in this package's own lockfile. NATS Server is pinned to [2.15.2](https://github.com/nats-io/nats-server/releases/tag/v2.15.2). The installer verifies the SHA-256 published in the official GitHub release metadata for Darwin/Linux amd64/arm64 before extracting. The current functional evidence comes from Darwin arm64 on an external SSD, not Linux.

## Run the experiment

From the repository root, with Node 24 or later:

```sh
npm ci --prefix packages/relay-nats --ignore-scripts
node packages/relay-nats/scripts/install-server.mjs
```

The installer prints the absolute binary path and archive hash. Set `HAB_NATS_SERVER` to that binary. Nothing is installed globally.

```sh
HAB_NATS_SERVER=/absolute/path/to/verified/nats-server node packages/relay-nats/scripts/prove.mjs
```

To run the common delivery contract source owned by the test-lab task, pass its actual file path. The runner changes only the adapter import in a generated temporary test file and records the unchanged source digest.

```sh
HAB_NATS_SERVER=/absolute/path/to/verified/nats-server node packages/relay-nats/scripts/shared-contracts.mjs /absolute/path/to/test/delivery-lab/contracts.test.js
```

The fixture owns every broker process and uses a random loopback port, generated synthetic credentials, a private temporary store under `.runtime/`, and a private SQLite journal. There is no monitoring, cluster, leafnode, gateway, or external client listener. A test failure leaves its store and log available for diagnosis. `closed.json` records process exit and closed fixture handles. The proof runner writes TAP and JSON evidence under `.runtime/`.

## Boundary decision proposed for P4

The named data shape is a durable admission record with `staging`, `pending`, `leased`, `acked`, `expired`, and `quarantined` states. A staging record contains the outbox body until publication is confirmed. Other records keep only the receipt, HMAC, route, capacity accounting, generation fence, and cleanup progress. The organizing structure is one journal state machine, not an in-memory success flag.

| Candidate                                        | Acceptance proof                           | Revocation ordering                                                                                                                                                 | Decision                                        |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Synchronous admission plus async publisher       | Committed SQLite admission and body outbox | The current synchronous Registry guard must surround `admit`. Later publication does not reopen admission. Receiver policy is checked again at the lease/ACK commit | Proposed choice, proven with a synthetic policy |
| Promise-returning replacement inside `withRelay` | PubAck followed by receipt commit          | The existing guard rejects Promise values. Checking a copied policy after await cannot roll back a message already published                                        | Rejected as a drop-in replacement               |

`admit(context, submission)` is synchronous and returns a normal pending Relay receipt after SQLite FULL-synchronous commit. Acceptance means HAB has durably admitted the message, including its body, for publication. It does not mean JetStream has accepted it yet. `status` can return this pending receipt while publication is outstanding. This is a deliberate contract choice that the host owner must approve before production adoption.

`publishPending(limit)` is the explicit async publisher port. `submit` is an async convenience for the isolated transport test and calls admission before publishing. If publication fails after admission, a transport or capacity error can coexist with a pending admission. Retry/status must use the same original ID. There is no fallback to SQLite Relay and no new ID allocation. Recovery at `open` reconciles at most 100 records; the host must schedule bounded further publication/maintenance when adopting this package.

An admission that commits before revocation remains admitted. The held-PubAck test observes its receipt before revocation, releases the reply, and verifies that the stopped sender cannot be leased to the receiver. An admission attempted after revocation is refused. A second test revokes while a pull awaits the broker and verifies that no application lease commits.

The fixture's policy is synthetic. Real `SQLiteHabRegistry.withRelay`, group/identity epochs, endpoint configuration, and route ownership are not wired here. P4 is not an approval to bypass that integration. The host needs synchronous guarded commit ports for admission, lease, ACK, and status. It must not hold a Registry transaction across a broker await. This package proposes no edit to the shared synchronous Relay interface.

## Delivery and deletion mapping

| HAB contract                             | Experiment behavior                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable identity and `.hab` resolution | The gateway supplies a verified agent ID through `Authorization`. Subject tokens are hashes of immutable IDs and message keys. Address resolution remains outside this package                                                                                                                                                      |
| Group/operation rights                   | Trusted gateway policy runs before admission and again in the journal transaction. Poll/ACK recheck sender and kind. Products receive no NATS password, raw API, or ACK subject                                                                                                                                                     |
| Payload                                  | Existing `parseSubmission` and exact one-hour wire contract. Text and structured data work. Attachments fail explicitly and remain owned by the old backend                                                                                                                                                                         |
| Dedup                                    | Journal HMAC and `(sender_id,message_id)` uniqueness remain after the broker's two-minute dedup window. Unique per-message subject and expected sequence zero reconcile a lost PubAck                                                                                                                                               |
| Storage                                  | File stream, one replica, Limits retention, DiscardNew, one stored message per subject, bounded messages/bytes/message size/consumers. Limits is intentional so explicit erase can be tracked independently of consumer ACK                                                                                                         |
| Retry                                    | One durable explicit-ACK consumer per recipient, no overlapping filters, `max_ack_pending=1`. A bounded durable pull reservation prevents two gateways waiting out the same short lease. Journal generation/token fences and bounded exponential retry delays protect HAB ACKs                                                      |
| Retry exhaustion                         | Journal state becomes `quarantined`. The consumer terminates that delivery while Limits retention keeps the body until TTL. Quarantine is not a saved receipt or Task success                                                                                                                                                       |
| Save-before-ACK                          | Existing `DurableReceiver` commits inbox/body/dedup/original ACK request first. HAB validates the current lease and commits its saved receipt before contacting the broker                                                                                                                                                          |
| Broker ACK                               | The gateway uses the official `ackAck` API while it holds a delivery object. It does not depend on the client's private reply field or distribute broker ACK subjects                                                                                                                                                               |
| Crash after HAB ACK                      | The durable saved receipt suppresses user redelivery. If a delivery object was lost, recovery uses the official erase API to remove the already-saved message. This resolves broker pending state without replaying application work                                                                                                |
| Body release                             | Journal outbox clears after publication. After saved ACK, explicit `deleteMessage(..., true)` and a follow-up absent-body read complete cleanup. Failed cleanup remains durable and retries on open/maintenance                                                                                                                     |
| TTL                                      | Publication rounds remaining TTL up to whole seconds because the tested server rejects subsecond TTL. Poll, lease, and ACK use the original absolute expiry. Broker expiry can lag the original deadline by rounding and transport delay; maintenance performs explicit cleanup. Repeated submission never extends the HAB deadline |
| Minimum records                          | Expired records retain at least 30 days. ACK records retain the 30-day ACK retry horizon plus 30-day record retention. Legacy IDs are safety-held; only replay-bound `rm1` IDs can be collected                                                                                                                                     |

`acked` means the receiver asserted durable save and HAB committed that proof. A broker cleanup failure does not turn it back into pending or hide the committed receipt. ACK returns that receipt even when broker cleanup must retry. Cleanup progress is separate and is not exposed through the existing user receipt. The maintenance-authorized `diagnostics` port reports pending publication, pending cleanup and quarantine counts. Neither `acked` nor broker ACK means an A2A Task completed or an external application effect ran exactly once.

Explicit erase makes the normal broker read unavailable and requests broker-file overwrite. TTL expiry, OS caches, SSD wear leveling, filesystem snapshots, backups, and receiver copies do not gain a physical-erasure guarantee from this API.

## Durability and known limits

The fixture sets `sync_interval: always`, File storage and replica count one. The journal uses SQLite DELETE journaling, `synchronous=FULL`, private file permissions, and secure-delete. The client does not attest server fsync configuration through NATS INFO; deployment must audit the server configuration itself. No `persist_mode=async` override is used.

The [official fsync configuration](https://docs.nats.io/reference/config/jetstream/sync_interval) explains the setting. The [2.15.0 release notes](https://github.com/nats-io/nats-server/releases/tag/v2.15.0) distinguish replicated WAL syncing from single-replica storage. The [2.14.6 notes](https://github.com/nats-io/nats-server/releases/tag/v2.14.6) include the inline-compaction sync fix. These releases do not establish power-loss safety for this SSD.

The official issues [7549](https://github.com/nats-io/nats-server/issues/7549), [7556](https://github.com/nats-io/nats-server/issues/7556), [7564](https://github.com/nats-io/nats-server/issues/7564), and [7567](https://github.com/nats-io/nats-server/issues/7567) were still open when checked on 2026-11-01. Snapshot corruption has partial fail-to-start fixes, and deferred fsync is documented. This experiment does not establish that every reported failure is fixed in 2.15.2. It tests process termination, not Jepsen-style OS/power faults, partitions, block corruption, or snapshot corruption.

Not run here are real HAB group/epoch integration, A2A-to-JetStream-to-Task proof, production MCP host selection, application effect exactly-once, corruption recovery, snapshot restore to independent storage, representative performance, and Linux execution. These remain acceptance requirements for the parent integration task.

## Linux VPS operating proposal

No host, cloud account, billable service, or system service is created by this package. Its source uses Node, SQLite, standard filesystem operations, TCP loopback, and the official NATS client. No macOS-specific core API is introduced. The installer has pinned Linux amd64/arm64 artifacts; they are not claimed as executed tests.

For a future single-host Linux deployment, select a persistent filesystem/volume explicitly, for example a private service data directory chosen by the operator. Place the NATS store, admission journal, Registry, Task Store and receiver checkpoints in separate named directories on the chosen volume. Check the expected volume identity and mount before starting; a missing mount must fail startup instead of creating an empty replacement directory. This mount guard belongs to the host integration, not the standalone client.

Use one broker bound to loopback with dedicated credentials. Keep server/account file limits, stream byte/message/consumer limits, and journal record/outbox limits finite. Reserve disk headroom for journal transactions, compaction, snapshots, and logs. Monitor disk availability, storage errors, publish errors, pending/outbox age, quarantine, and unfinished erase work. Do not use a full-disk test against a live VPS volume. No resource sizing or performance budget has been measured here.

Use `sync_interval: always` and audit the volume/provider's durability contract. A single VPS plus one volume has one host/storage failure domain. Additional broker processes on that VPS do not create independent HA. Record the permitted recovery point and recovery time before deployment.

Back up a quiesced, consistent set of broker stream/consumer snapshots, admission/ACK journal, Registry, Task Store, binding configuration and receiver checkpoints to separate encrypted storage. Keep credentials under an independent secret-management policy. Restore into an isolated directory/host and compare accepted-ID/body digests, saved receipts and Task results before routing traffic. This package has not executed that restore exercise.

For rollback, stop new JetStream admissions, retain its journal and broker, reconcile and drain its existing owner route, and return only future unadmitted text requests to the old backend. Do not reissue uncertain IDs as new SQLite requests. Keep attachment ownership with the old backend. The actual route epoch/drain switch belongs to P6 and is not implemented here.
