# Standalone Relay contract — implementation step 1

Import from `./index.ts`. This module owns no database, process, credentials,
network connection, environment configuration, HAB naming rules or Task Engine.
It validates a version-1 caller submission and supplies stable comparison material.
Service and SQLite delivery are described in the later implementation steps; nothing is exposed through HTTP or MCP.

The envelope has opaque recipient/message/thread IDs, kind, reply reference,
`first_sent_at`, `expires_at` and ordered body parts. UTC timestamps use the exact
`YYYY-MM-DDTHH:mm:ss.sssZ` form. The lifetime is exactly 3,600,000 ms. Parts are
text, managed attachment references (media type, bytes, SHA-256, optional display
filename), or schema-identified JSON data. Attachment bytes are not inline.
JSON keys, strings and part ordering are preserved; object key order alone does
not affect comparison. Unknown wire versions/control fields/part types fail
explicitly. New wire features require a versioned contract change.

Every call requires explicit, finite positive `ContractLimits`. Test fixture
numbers are not approved production capacity defaults. Raw request byte limits
must also be enforced by the future transport before parsing untrusted JSON.

`parseSubmission` rejects caller-supplied `sender_id`. This does not authenticate
anyone: the future service must resolve a verified principal, authorize every
operation, validate DB time/clock skew, and check finalized attachment ownership,
bytes and integrity before committing acceptance. Schema-valid data must never
be treated as accepted delivery. No product/model capability decisions belong here.

`comparisonMaterial` returns sensitive canonical comparison input, **not a hash**.
The future store must supply the verified sender and apply its private fingerprint
scheme; do not log or expose the returned string. The material includes the fixed
expiry, attachment manifests and structured content. It is never persisted as a
replacement copy of the body after deletion.

Next steps are tracked below: managed attachment storage, client outbox/inbox,
registry enrollment, maintenance and MCP wiring.
Nothing here changes existing Task or diagnostic-ping behavior.

## Implementation step 2: durable acceptance

`RelayService` now accepts an injected `Authorization` port and `AcceptanceStore`.
The trusted policy resolves the individual from opaque connection context on
every submit and status operation; neither product names nor supplied IDs are
identity proof. Missing, failed or revoked policy denies access. The callback is
synchronous and runs inside the storage transaction. A remote verifier must run
before this boundary and the host must maintain a current local authorization
snapshot/epoch; do not perform network IO in the callback.

The explicit infrastructure entry point `./sqlite-store.ts` provides
`SQLiteRelayStore`. Construction opens the selected database but does not apply
schema. Call `migrate()` explicitly against a dedicated new Relay database.
Unknown databases and schema versions are refused. No existing HAB database or
Task migration is opened by this module. A stable private fingerprint key must
be supplied by the host; this module issues no credentials and chooses no key
storage location. Changed keys refuse reopening rather than silently invalidating
dedup. Test keys are synthetic and must never become a runtime default.

Acceptance commits message, pending delivery and redacted audit together.
`(sender_id,message_id)` duplicates recover their original receipt; changed
content conflicts. Comparison is stored only as a keyed HMAC, not canonical body
text. Each transaction samples the SQLite clock once, refuses expired/future
submissions, and expires pending bodies before capacity calculation. Explicit
pending-count, per-recipient-count, live-byte and total-record bounds reject new
submissions without discarding accepted messages. Receipt/status contain no body.
Thread participants and reciprocal reply references are checked in the same
transaction. Pure contract parsing remains independent of SQLite/crypto modules.

This is an incremental internal API, not production delivery. Managed attachments
are refused with `attachment_store_unavailable` until finalize/integrity/ownership
checks exist. Poll/lease/ACK is implemented in step 3 below. Receiver inbox, registry enrollment, background
expiry maintenance, 30-day tombstone collection and standalone setup are next
steps. Current records are conservatively retained (with a hard record-count
limit); the complete retention acceptance gate has not passed. Expiry cleanup
runs on successful transactions, so idle databases still require the future
maintenance loop. Failed transactions roll back cleanup together with acceptance.
Nothing is wired to the existing MCP catalog or real agent connections yet.

## Implementation step 3: polling, leased delivery and ACK

`poll(context)` resolves the receiver from trusted policy and returns at most one
message with server-resolved sender, generation, opaque token and lease deadline.
One live lease per receiver is enforced transactionally and by a unique index.
Policy is checked for the receiver operation and for each candidate sender/kind;
blocked candidates are not delivered. The scan is explicitly bounded.
Lease deadline is capped by the immutable message expiry. Only token hashes are
persisted. A lost response waits for the persisted lease/backoff before redelivery;
no heartbeat or lease extension is exposed in this step.

`ack(context, request)` requires sender/message reference, generation, token and
stable request ID. The receiver is never caller-selected. A first ACK requires
the current unexpired lease and message, with current authorization. ACK ledger,
state, audit and body deletion commit atomically. Exact committed ACK retries
recover the same receipt after expiry/restart; different contents conflict, and
new ACK IDs cannot reconfirm an already ACKed delivery. Receipt is delivery only,
not execution acceptance. Client-side durable save before ACK remains a protocol
obligation until the receiver inbox adapter is implemented.

Lease expiry requeues with persisted bounded exponential backoff/jitter; attempts
are charged only when issuing a lease. Exhaustion quarantines until expiry, and
does not block another receiver. All delivery policy numbers are required config,
with test-only fixture values. Explicit schema migration now upgrades v1 to v2
transactionally and preserves previous messages/receipts. Unknown newer versions
are refused; rolling back to old code does not downgrade or destroy schema.
This migration has only run against new/dummy test databases.

Background maintenance, 30-day collection, attachment storage and real MCP wiring
remain separate milestones. No production readiness is implied by local polling.

## Implementation step 4: receiver inbox and ACK journal

The pure `DurableReceiver` uses injected `ReceiverStore` and `ReceiverTransport`
ports. Calling `receiveOnce()` explicitly first recovers a due ACK, then polls at
most one new delivery, commits its body/dedup record **and stable ACK request**,
then ACKs. It does not start a server, scheduler, agent or model. The caller must
provide an authenticated, bounded-time transport. The current local fixture binds
that port directly to `RelayService`; it is not evidence of a real MCP connection.

The separate infrastructure entry point `./sqlite-inbox.ts` provides `SQLiteInbox`.
Use a dedicated database per immutable individual and call `migrate()` explicitly.
The individual and private fingerprint-key check are persisted; reopening for
another individual/key is refused. New disk files are mode 0600, existing loose
files and symlinks are refused. The host must also provide a private parent
directory and protect SQLite sidecars/backups. ACK retry temporarily stores the
opaque lease token in this private journal; confirmed, obsolete or exhausted
requests clear that payload. Neither application logs nor API diagnostics receive
raw transport errors, message bodies, private keys or tokens.

A response lost after server ACK commit is retried with the same journal request.
The server returns its existing receipt even after lease expiry, and the inbox is
not duplicated. If the ACK never committed and its lease is stale, the old request
becomes obsolete. A new lease creates a new stable ACK request while preserving
one inbox record for `(sender_id,message_id)`. Conflicting body or lease contents
are refused. The server receipt is validated before local confirmation; local
receipt confirmation and journal cleanup are transactional. Failed local saves
send no ACK. A local process rejects overlapping `receiveOnce()` calls; multiple
processes rely on the server's receiver lease and atomic local dedup/journal.

Retry due time and attempt count are durable and bounded, with required policy
values and no background loop. Quarantine/expiry of the ACK retry horizon leaves
a durable received-but-unconfirmed inbox record; it does not claim non-delivery.
Record, byte and journal quotas reject new saves without discarding older content.
Attachments are refused until their durable-byte storage port is implemented.
The inbox is a received-message record, not an execution queue. Reading it again
is allowed and does not claim exactly-once application side effects. Application
handoff/processing, body lifecycle and 30-day metadata collection remain later
milestones. Sender durable outbox and production MCP transport are also pending.

Reproduce the model-free receive/restart/loss scenarios from the repository root:

```sh
node --test test/relay-receiver.test.js
```

Fixtures use new temporary databases and synthetic data/keys only. The reciprocal
three-individual case has no product-specific logic and executes no model/tools.

## Implementation step 5: sender durable outbox

The pure `DurableSender` takes `SenderStore` and authenticated, bounded-time
`SenderTransport` ports. `enqueue()` commits the detached immutable submission
before any network call. The caller must resolve the HAB address to recipient ID
and fix the message ID, first-send timestamp and one-hour expiry before enqueue;
this component does not resolve names or substitute destinations. `sendOnce()`
claims at most one job explicitly, with no daemon or scheduler.

The infrastructure entry point `./sqlite-outbox.ts` provides a dedicated
`SQLiteOutbox`. Like the inbox it requires explicit migration, a private file
(mode 0600, no symlink/loose existing file), a fixed individual and a supplied
private comparison key. Unknown schema/owner/key are refused. It persists the
original payload, HMAC, recipient and deadline. Same-key content conflicts are
rejected even after payload deletion. Record and byte caps are explicit;
metadata collection is explicit (step 7 below); a full store fails closed.

A transactional single-flight lease/fence coordinates concurrent sender processes.
A timed-out lease may retry the same operation, but its old holder cannot change
new state. Caller/transport mutation does not alter the durable payload. Temporary
failures schedule persisted bounded exponential backoff with jitter. Refusal,
conflict and unsupported storage quarantine instead of replacing credentials,
identity, recipient or message ID. Submit and status have separate finite budgets.

A lost acceptance response replays the exact original submission. Once the submit
budget is consumed, or the deadline is over, the job uses status lookup only. An
expired-before-acceptance response also forces status-only. No retry extends TTL.
Expired queued payloads are cleared while status lookup uses metadata only. A
status `not_found` is retried within the configured status budget/horizon because
it alone does not settle an earlier uncertain network request. Exhaustion is
quarantine before expiry or `expired_unknown` after expiry, never a claim that the
recipient definitely saw nothing. No replacement message/task is generated.

The receipt must match the local individual, message, recipient, expiry, valid
state, receipt ID and UTC acceptance time before the outbox commits acceptance
and clears its payload together. Its delivery state is a snapshot, not a live
view or work-completion signal. A receipt-save failure keeps the durable lease
and intent for recovery, including when the Relay has already accepted it.
Minimal receipt/dedup records are separate from body data. Cleanup currently runs
only on explicit operations; outbox record collection is in step 7, while
scheduled maintenance and application-side history lifecycle remain later work. Private SQLite sidecars and
backups require the same protection as the DB; deletion is logical, not a promise
of immediate physical erasure.

`node --test test/relay-sender.test.js` includes restart, concurrent claim,
fencing, capacity/refusal, expiry/status, local-save failure and a model-free
sender → Relay → receiver fixture that loses both acceptance and ACK responses.
Only synthetic data/new temporary databases are used. This proves the injected
local transport path, not production MCP or a real product's durable integration.
Attachments still fail closed pending managed-byte storage. No product SDK,
MCP listener, real-agent call, cron or new credentials are introduced.

## Implementation step 6: explicit server maintenance and replay-safe collection

`RelayService.maintain(context, limit)` is an internal maintenance operation with
its own mandatory `maintenance` authorization. It is not in the MCP catalog and
starts no cron/daemon. SQLite samples its clock once per transaction. Each call
has a 1–1000 unit budget shared across expired-message transitions, collected
messages and orphan threads; queries remain bounded by configured store capacity.
Expiry atomically clears body/lease token, updates delivery state and audits the
transition. Logical expiry time is the original deadline, even after a long outage.

Schema v3 adds terminal/retention timestamps and a fixed-size aggregate maintenance
counter. A pending/quarantined delivery retains its data until expiry. Terminal
metadata is retained for 30 days **after the later of original expiry, terminal
time and the supported committed-ACK retry horizon**. The maximum ACK retry
horizon is 30 days, matching the existing client's upper bound; an ACKed record
can consequently remain up to roughly 60 days after ACK. This is not a new body
retention period. Exact ACK retries and status reads never extend these dates.
The purge rechecks the underlying dates and ACK ledger, not just its cached
`retain_until`, and removes message, delivery, ACK and per-message audit together.
Orphan threads are removed only after all their messages are gone. Counters retain
no per-message identity/body. SQLite sidecars/backups still require private,
bounded lifecycle management; logical deletion is not physical secure erase.

Deleting a tombstone must not let an old ID become a new request. New producers
can use `makeReplayBoundMessageId(firstSentAt, entropyHex)` with 128 bits of fresh
host-generated random entropy. The format `rm1.<UTC milliseconds>.<32 hex>` binds
an immutable ID to its original `first_sent_at`. A modified timestamp/deadline
with the same ID is rejected; after collection the original submission is expired.
The pure contract helper generates no randomness, credentials or IO itself.
HAB addresses and immutable individual IDs are unrelated to this message-ID format.

Existing opaque message IDs remain compatible, but their tombstones cannot be
safely collected automatically. Maintenance returns `safety_held` for aged legacy
IDs and preserves them rather than reopening an unsafe dedup window. They still
consume the finite record quota. Such development databases need an explicit
migration/reconciliation decision; do not claim their 30-day collection gate has
passed. Malformed historical `rm1` IDs are also held. The new prefix is reserved
and strict validation applies to newly submitted prefixed IDs.

Schema upgrade is explicit, transactional and handles v1/v2 receipts. Known
newer schema is refused by older code rather than silently downgraded. Maintenance
has only run on synthetic temporary databases. Client inbox collection,
application handoff, backup expiry and managed attachments remain later layers.

## Implementation step 7: local sender maintenance

`SQLiteOutbox.maintain(limit)` is an explicit local administration API, not a
network/MCP tool. The private outbox's owner must control access to it. It sends
no requests and starts no timer, worker or model. The 1–1000 unit budget is shared
between expired-record transitions and metadata purges. Regular enqueue/claim
operations also perform expiry cleanup, bounded by the configured record cap.

Expired queued/in-flight payloads are cleared without creating a replacement
message. A live sender lease retains its fence and may still confirm an already
accepted request. Once its lease has elapsed and status attempts/horizon are
exhausted, maintenance fences the old claim and closes the record as
`expired_unknown`. A quarantined record keeps its body until expiry. Closed
unknown state never asserts that the recipient definitely received nothing.

Schema v2 records local terminal time and retains metadata for 30 days after the
latest of original expiry, local terminal time and the original configured
status-retry horizon. Exact enqueue replays, reads and maintenance do not extend
these dates. Purge rechecks the underlying dates, requires no body/active lease,
and only collects terminal `accepted`/`expired_unknown` records with a valid
time-bound `rm1` ID. Original expired submissions remain rejected after collection;
renewing their deadline with the same ID is invalid. Aged opaque/malformed IDs
are counted as `safety_held`, remain in the finite quota, and do not prevent other
eligible records being collected. They need an explicit reconciliation decision.

Upgrade is explicit and transactional, after owner/key verification. Since v1
did not record local terminal time, its terminal records conservatively begin
their retention window at migration. Reopening/migrating v2 does not restart it.
The fixed-size maintenance totals contain no per-message identity or body;
missing totals fail closed. Transition, purge and aggregate updates commit or
roll back together. Only synthetic temporary databases have been maintained.

`node --test test/relay-outbox-maintenance.test.js` covers expiry, active/stale
leases, uncertainty, bounded batches, safe replay after purge, quota recovery,
legacy holds, retention guards, rollback and schema upgrade. Receiver inbox
handoff/collection, scheduling, backup expiry, managed attachments and production
MCP/product integration remain separate work. In particular this API never
deletes a receiver's unconsumed inbox body.
