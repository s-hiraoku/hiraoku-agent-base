# Standalone Relay contract — implementation step 1

Import from `./index.ts`. This module owns no database, process, credentials,
network connection, environment configuration, HAB naming rules or Task Engine.
It validates a version-1 caller submission and supplies stable comparison material.
Service and SQLite delivery are described below. The optional MCP factory, HTTP adapters and client in steps 9–11 are unmounted from the existing runtime; no deployed endpoint is changed.
HAB-only enrollment/address policy and coordinated authorization are implemented
separately in [the HAB integration](../hab/README.md). The core imports none of it;
the optional HAB catalog adds address resolution while this catalog remains four
delivery tools. HAB also provides a separate human enrollment workflow and
synthetic terminal demo; production management/connection wiring and real
product binding remain pending.
HAB's [registration-to-delivery integration matrix](../../docs/hab-relay-integration.md)
also covers 17 native loopback journeys with offline receipt, uncertain submit/ACK,
stop/revocation and store/listener reopen. These tests compose this core without
adding HAB or Task dependencies to it.

The optional [managed upload contract and SQLite chunk backend](../../docs/managed-attachments.md)
implement resumable owner-scoped uploads and digest-checked finalize separately
from message storage. Optional durable per-message bindings and an acceptance-only
coordinator now protect finalized bytes before Relay commit and reconcile the original
receipt after failure/reopen. A host must explicitly supply prepared-reference admission;
default acceptance/outbox/inbox still reject attachments. Admission alone does not enable
poll or ACK: the host must additionally supply a fourth `AttachmentDeliveryPolicy`
constructor argument, connecting its finite limits and synchronous check to the fixed
blob store's `checkDeliverable`. Only then can confirmed attachments be leased and ACKed. The optional
`./attachment-read.ts` host service reads one bounded integrity-checked chunk for the
current receiver under a live Relay transaction; it rechecks message state/expiry,
confirmed refs and current poll authority. Grants expire at callback exit and reads
never advance delivery state. The optional [receiver attachment journal](../../docs/attachment-inbox.md) now
durably saves bounded chunks, resumes offsets and verifies the complete SHA-256
before a scoped readiness action. An explicit third constructor argument now gates ordinary inbox save and ACK
claim on verified retained bytes. Its schema-3 migration preserves v1/v2 journals
and released-text ACK replay; a keyed metadata tag retains attachment verification
after body handoff. The optional stager fetches at most one chunk per invocation.
Relay schema 4 now persists minimal attachment references and a fenced
[terminal deletion outbox](../../docs/attachment-deletion.md) in the same DB.
Unfinished deletion blocks receipt GC. A host-invoked `AttachmentDeletionWorker`
claims at most one job, checks separate maintenance authority and deletes the exact
terminal binding under the live fenced proof. Partial failures roll back all owned
bytes; retries reconcile a lost blob/queue completion without distributed transactions.
ACK immediately closes download access before physical deletion. Twenty in-process
HAB tests cover actual leases, durable local bytes, server ACK and cleanup, including
response loss and authority/lease changes. An explicit optional [attachment MCP/HTTP catalog](../../docs/attachment-transport.md)
adds six bounded version-1 upload/read tools; the default catalog is unchanged.
An optional fixed client and 19 native loopback tests now cover durable receiver
bytes, server ACK, physical cleanup, response loss and store/client restart.
A separate [sender source/progress journal](../../docs/upload-journal.md) now
persists original intents and bounded source chunks, seals their SHA, fences one
active claim and verifies progress receipts. A one-operation upload worker now
connects the fixed client with bounded waiting and fenced recovery; 20 additional
native loopback tests cover response/commit loss and restart. Message-outbox
handoff, receiver orchestration and production wiring remain pending; defaults
still withhold attachments. HAB provides separate scoped acceptance/read guards without
changing this core; the pure Relay entry and MCP catalogs are unchanged.

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
are refused with `attachment_store_unavailable` by default. The optional host-only
attachment coordinator described above enables acceptance after durable prepare; it does
not enable delivery. Poll/lease/ACK is implemented in step 3 below. Receiver inbox, registry enrollment, background
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
handoff/body release and metadata collection are implemented in step 8 below;
application processing itself remains the host's responsibility. Sender durable
outbox is in step 5; production MCP transport remains pending.

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
has only run on synthetic temporary databases. Client inbox collection and the
local handoff boundary are in step 8; backup expiry and managed attachments remain
later layers.

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
handoff/collection are in step 8. Scheduling, backup expiry, managed attachments and production
MCP/product integration remain separate work. In particular this API never
deletes a receiver's unconsumed inbox body.

## Implementation step 8: local inbox handoff and maintenance

`InboxLifecycleStore` is a separate pure port for local application/admin access.
`SQLiteInbox` implements it alongside the network-facing `ReceiverStore`.
Neither `releaseBody(senderId, messageId)` nor `maintain(limit)` is a network/MCP
tool. The host must restrict access to the private individual-bound database.
No model, Task, scheduler, credential or product integration is started.

An application first saves the message durably, deduplicated by the pair
`(sender_id,message_id)`, then explicitly calls `releaseBody`. The first call
atomically clears the local body and records release time; repetitions return
false without renewing retention. `inbox()` returns only unreleased bodies.
A crash between application save and release may cause another application
handoff attempt, so that application dedup is mandatory. This local API trusts
the caller's durable-save assertion; it does not verify another database's commit
or claim exactly-once execution. Application history has its own retention policy.

Release is independent of Relay ACK confirmation: the durable ACK journal survives
and can recover a lost committed-ACK response after release/restart. Exact or
new-generation redelivery checks the stored fingerprint and never restores a
released body. A new ACK generation requires a live delivery deadline and lease;
unseen expired deliveries are rejected, including after tombstone collection.
An existing exact journal request can still recover its committed receipt after
TTL. Wrong local ACK fingerprints cannot obsolete/quarantine another request.

Maintenance shares a 1–1000 unit budget between exhausted-ACK transitions, ACK
record purges and released-inbox purges. Exhaustion clears the temporary lease
token, records uncertainty and preserves the inbox. Unreleased bodies are never
automatically deleted, even after long absence; finite quotas refuse new messages
until the application handles them. A valid late receipt can still reconcile an
exhausted journal without restoring a body. Expiry, purge and fixed-size aggregate
counters commit or roll back together; missing counters fail closed.

ACK records are collected only after original expiry, retry horizon and local
terminal time are each at least 30 days old, and no pending request payload remains.
An inbox tombstone is eligible only after release, receive time, original expiry,
maximum ACK retry horizon and latest ACK terminal time are each 30 days old, with
no remaining ACK journal. The cached retention date is also checked; underlying
dates remain available after ACK records are gone. Exact saves, reads, ACK receipt
retries and release repetitions do not renew retention. Time-bound `rm1` IDs allow
safe tombstone collection; legacy/malformed IDs remain `safety_held` and consume
quota without starving other eligible messages. Logical deletion does not erase
SQLite sidecars, backups or the application's independent copy.

Schema v2 upgrade is explicit, transactional and owner/key checked. It verifies
saved body/identity/fingerprint before deriving expiry; malformed data fails
instead of being silently discarded. Old terminal ACKs conservatively begin a
new retention window at migration because v1 lacked local terminal timestamps.
Unreleased bodies, confirmed receipts and stable pending ACK requests are preserved.
Reopening/migrating v2 does not renew dates. Only synthetic temporary databases
have been migrated/maintained.

`node --test test/relay-inbox-maintenance.test.js` covers application handoff,
release failure, loss/restart, stale replay, live/exhausted ACKs, unconsumed bodies,
quota recovery, legacy holds, retention guards, atomic rollback and migration.
Production MCP/agent integration, actual application storage, scheduled upkeep,
backup expiry and managed attachment bytes remain separate work.


## Implementation step 9: isolated MCP tool catalog

Import `createRelayMcpServer` and `relayMcpSchemas` explicitly from `./mcp.ts`.
The pure `./index.ts` does not import the SDK. This optional adapter uses the
repository's pinned `@modelcontextprotocol/server` 2.3.1 and Zod 4; no dependency
or deployed Task/ping catalog is changed. See the [official SDK](https://github.com/modelcontextprotocol/typescript-sdk).
Construction starts no listener, process, network connection or model.

The catalog contains exactly `relay_submit`, `relay_status`, `relay_poll` and
`relay_ack`. Strict schemas reject caller-supplied sender/agent names and foreign
mailbox selectors. Poll has no arguments and returns `{delivery: valueOrNull}`;
other successful results are their service receipts. Results provide equivalent
JSON in text content and structuredContent. Delivery acceptance/ACK is distinct
from accepting or completing work. No maintenance, local body release, registry,
Task, shell, webhook or arbitrary-destination tool is exposed.

The host supplies a `RelayContextResolver` bound to the verified connection or
request. It must close over the host's trusted authentication result; tool
arguments, claimed product names, IDs and browser sessions are not credentials.
Every invocation resolves context again and the service rechecks current local
policy inside its transaction. Missing/throwing resolver, absent policy, unknown
binding, revoked identity and disallowed operation fail closed. Resolver failure
is normalized to `forbidden`; it cannot silently enable anonymous delivery.
Concurrent clients need separate bound resolvers, never a shared mutable global
current user. Async authentication must finish before synchronous DB authorization.

Tool hints are not permission enforcement. Even status may perform expiry cleanup,
so no tool advertises readOnlyHint. Poll is not idempotent; exact submit/status/ACK
operations are. Core contract validation still enforces JSON depth/node/UTF-8 byte
limits and immutable TTL, beyond the SDK's structural schema. Managed attachment
manifests continue to fail closed. Known core failures return isError with a fixed
allowlisted `{error: code}` in text/structured form; unexpected storage details
become `relay_operation_failed` with no raw exception/body. SDK structural schema
or unknown-tool rejection follows SDK protocol errors instead of entering storage.

`node --test test/relay-mcp.test.js` uses the SDK's Request/Response handler in
process, synthetic principal contexts and temporary SQLite stores. It tests
2026-07-28 request routing and legacy JSON-RPC/SSE, strict four-tool catalog,
scoped identities, revoked/missing auth, per-operation denial, concurrent poll,
stale leases, exact ACK retry, durable receive before ACK and redacted failures.
No actual HTTP socket, credential verifier or real agent is used by this fixture.
Its single-result SSE decoder is test-only, not a production client transport.

This factory is deliberately unmounted. A later HTTP host must authenticate
before protocol admission, bind a resolver per request/connection, constrain
Host/Origin/path/method, pre-parse body bytes/deadline, rate/concurrency/response
bounds, disable unsupported listeners and preserve the existing audit boundary.
Do not expose a raw SDK handler as a ready production endpoint. No OAuth scopes,
credentials, public/no-auth fallback or plugin registration are provisioned here.
A durable MCP client transport, real registry binding, managed attachments and
production agent connections remain later work.


## Implementation step 10: bounded HTTP host adapters

`./http.ts` exports `RelayHttpGateway`; `./http-node.ts` exports
`createRelayNodeHandler(gateway)`. They are explicit infrastructure imports;
the pure Relay entry does not import either. Constructing them never starts a
listener, installs a plugin, issues a credential or edits existing runtime config.
The existing `src/server.ts` remains the Task server. This adapter has only been
used with synthetic verification contexts and temporary loopback test listeners.

The host supplies a mandatory private audit sink and complete `RelayHttpPolicy`:
canonical resource URL, exact browser-Origin allowlist, request/response byte
caps, whole-exchange timeout, active-request cap and global request window/rate.
There are no copied Task policy defaults. Test fixture values are not approved
production settings. Policy is copied/frozen, with implementation ceilings on
bytes/time/counts. HTTP is permitted only for literal loopback/localhost resource
URLs; nonlocal resources require HTTPS. A present Origin must match the allowlist;
nonbrowser requests may omit it. No CORS cookie/session fallback is provided.

Only a bounded Bearer header is given to the injected `RelayHttpVerifier`, with
fixed resource and AbortSignal. That host verifier must actually verify issuer,
audience, subject/client and current individual binding; merely decoding a token
or returning a claimed agent name is insufficient. Default/missing verifier is
all-deny (401 with a Bearer challenge). Verification failures expose no exception.
No OAuth issuer, metadata route, scope/client registration or credential is set up
here. Current per-operation service authorization is still mandatory after HTTP
verification. Header/body agent names and forwarded IP/identity headers grant no
rights. Credentials/cookies are never forwarded to the internal SDK handler.

Admission bounds authentication, audit, input, protocol dispatch and response
buffering under one deadline. Resource URL/Host/Origin/path/method checks precede
verification; verification precedes JSON/protocol parsing. The host rejects
compressed/non-JSON bodies, mismatched/excess Content-Length, overflow and invalid
UTF-8/JSON. Only the existing finite MCP method allowlist is admitted: batches,
long-lived listeners and event subscriptions never enter the SDK. Routing mirrors
are checked, and SDK version validation remains active. Both modern 2026-07-28
and legacy JSON-RPC/SSE exchanges are tested against the installed official SDK.
See [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

The optional `RelayMcpGate` adds pre-dispatch checks and tool-start/outcome audit;
it grants no identity or operation rights. A timeout/abort marks the exchange
inactive, so late verifier/audit completion cannot start a service operation.
An ignored cancellation retains the admission slot until the provider settles,
rather than allowing new work to bypass the cap. A permanently hung provider can
therefore stop admission; the host must supply cancellable, bounded providers.
Synchronous JavaScript/SQLite work already started cannot be forcibly interrupted;
a late/failed response is uncertain, and recovery must use the original ID/ACK
receipt instead of manufacturing a new message. No automatic network retry runs
inside the gateway. Response overflow returns no partial success.

Audit contains fixed categories and server-generated correlation IDs only; no
credentials, body, caller labels or raw exceptions are passed to the sink.
Audit failure before dispatch denies the operation. Failure after a service commit
returns an error, preserving its durable receipt for exact retry. The global
request counter saturates and uses no attacker-controlled key map. Rate/deadline
notes use the sink's optional bounded synchronous counter. Per-individual quotas,
shared multi-process rates, monitoring and periodic upkeep remain later work.

The Node callback also checks raw origin-form path/Host before URL normalization,
rejects duplicate framing/auth headers, bounds active responses until finish/close,
and closes each exchange's connection. Cancelling an unread request waits until
the refusal response flushes, preserving actual 401/413 delivery. Native aborts
propagate to the gateway. The activating HTTP server/proxy must separately set
header-size, header/connection timeouts, socket caps, TLS, trusted proxy policy
and HTTP/2 admission; callback limits do not cover pre-header TCP connections.
No listening server or launch/cron entry is included in this implementation.

Reproduce from the repository root:

```sh
node --test test/relay-http.test.js test/relay-http-node.test.js
```

The latter opens new ephemeral 127.0.0.1 ports and closes them after each fixture.
The 24 tests cover durable receive-before-ACK over actual HTTP, strict default
rejection, raw path/Host/Origin, body/response limits, duplicate headers, protocol
refusal, audit/storage uncertainty, rate/concurrency, stalled body/verifier/audit,
late dispatch prevention and client disconnect. Existing MCP catalog tests remain
unchanged and pass with the optional gate. All data/keys are synthetic; no real
Auth0, service token, Hermes/model or existing route is used. Durable MCP client
transport, registry/real binding, managed attachments, runtime activation and
production connections remain separate milestones.

## Implementation step 11: durable MCP client transport

Import `RelayMcpClient` explicitly from `./mcp-client.ts`. It implements the pure
`SenderTransport` and `ReceiverTransport` ports and can be injected into the
existing `DurableSender` and `DurableReceiver`. The pure `./index.ts` still imports
no HTTP, SDK, Zod, SQLite or product modules. Construction makes no connection,
opens no database, provisions no credentials and starts no background loop.
The existing Task MCP clients and runtime are unchanged.

This is a narrow implementation of the fixed Relay tools over the official
[2026-07-28 Streamable HTTP contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
verified against the repository's pinned server SDK 2.3.1. It uses native fetch
and the existing Zod 4 dependency; no package/lockfile is changed. It is not a
general-purpose MCP client: no catalog discovery, version fallback, protocol
sessions, subscription, sampling, elicitation, MRTR, Task or arbitrary tool API
is provided. Every request supplies matching version/method/tool metadata,
advertises JSON and SSE, and accepts only a complete fixed-contract response.

The host supplies all policy: canonical fixed resource URL, expected immutable
individual, request/response byte caps, whole-exchange deadline, active-request
cap, SSE event/line budgets and JSON depth/node budgets, plus `ContractLimits`.
Policy is copied/frozen and all numeric limits are finite/positive with hard
implementation ceilings. Nonlocal endpoints require HTTPS; HTTP is limited to
literal loopback/localhost. No tool argument can choose another endpoint. Fetch
uses redirect-error, credentials-omit, no-store and identity encoding; redirected
or foreign final URLs, compressed responses and unsupported content types fail.
Host DNS, TLS, proxy and socket policy remain the host's responsibility.

An injected `RelayCredentialProvider` receives only the fixed resource and an
AbortSignal and returns the existing full Bearer authorization header. A missing
or malformed provider value denies before network dispatch. No environment-token
lookup, credential cache, OAuth discovery/issuance, refresh flow, cookie or
anonymous fallback is installed. A trusted custom fetch port must honor the
redirect and abort policy. Neither provider errors, response bodies, metadata,
headers nor credentials are logged or attached as error causes by this module.

The expected `agent_id` is a local result-binding check, never proof of identity
and never a sender/mailbox selector on the wire. The server still resolves the
principal and current permissions. Submit/status receipts must name the expected
sender, poll deliveries the expected recipient, and ACK receipts that recipient.
A discrepancy returns `forbidden`, so the durable sender quarantines rather
than automatically replaying under corrected credentials. Detection may occur
**after server commit under the credential's actual principal**. The host must
stop and reconcile the original ID under the relevant bindings before changing
credentials or manufacturing a replacement. A mismatch does not prove nondelivery.
Local HAB enrollment is now implemented in the separate integration linked above;
real credential-to-individual binding remains unverified.

Requests are privately validated/snapshotted before awaiting credentials. The
deadline covers provider wait, fetch, body reading and protocol parsing; a late
provider cannot initiate fetch. Byte limits are enforced before JSON parsing,
including streamed input with no Content-Length. UTF-8 is fatal, framing length
must match, and both outer and text-result JSON trees have explicit budgets.
The buffered SSE parser supports comments, folded data lines, CR/LF/CRLF and
fragmented UTF-8. It requires EOF and exactly one final response, rejects extra
responses and unsolicited notifications/requests, and never reconnects using
SSE id/retry fields. The profile requests no progress/logging notifications.
Unknown control fields, incomplete/input-required results, mismatched RPC IDs,
text/structured disagreement and invalid delivery/receipt contracts fail closed.
Bounded result metadata is ignored and grants no authority or execution rights.

Cancellation includes input cleanup. If a credential, fetch or cleanup provider
ignores cancellation, the caller receives its timeout but the admission slot
remains occupied until that work settles. A permanently hung provider can exhaust
capacity; supply bounded, cancellable providers. Limits are per client instance,
not a shared process/fleet quota. Synchronous JS parsing/validation cannot be
forcibly interrupted; explicit byte/tree limits bound its input. Timeout or an
invalid response can follow a commit and always leaves the outcome uncertain.

There is exactly one network attempt per operation. HTTP failures (including
401/403), protocol errors, malformed responses and unknown/raw errors normalize
to `relay_transport_failed`. Only a matching complete isError result with
equivalent text/structured `{error: allowlistedCode}` retains a semantic Relay
error; the server and client share a private allowlist. Missing local credentials
or an individual mismatch return `forbidden`. The durable journals own finite
retry/backoff, immutable IDs, receipt validation and restart recovery. No HTTP
failure triggers token issuance, identity switching or an automatic new message.

Reproduce the 29 new tests (including six temporary native HTTP cases):

```sh
node --test test/relay-mcp-client.test.js test/relay-mcp-client-http.test.js
```

Native HTTP tests inject submit loss before sending and after acceptance, and
ACK-response loss after commit. They reopen the private outbox/inbox and create
new clients, replay exactly the same message/ACK, recover original receipts and
confirm one server message/inbox record. Additional cases cover lost-poll lease
fencing, current revocation, wrong credential binding, opaque HTTP failures and
native redirect refusal. Synthetic keys, temporary databases and new loopback
ports are used exclusively. This is not a product integration or registered
three-agent end-to-end acceptance. The separate HAB tests now cover a registered
mock three-individual HTTP path; local registry/address policy is described in
the HAB integration above, including optional MCP lookup. Managed bytes,
application history, scheduling, runtime activation and production connections
remain separate work.

任意構成の[添付message outbox連携](../../docs/attachment-outbox.md)を追加しました。完了したsourceを同期gateで照合してenqueueし、既存DurableSenderで同じIDを再送します。sourceの自動解放・runtimeの有効化は行いません。

[受信checkpoint／worker](../../docs/attachment-receiver.md)を任意構成として追加しました。全文・leaseとchunkを永続化し、1呼出し最大1 RPCで途中再開・inbox保存・ACK照合を行います。元のTTL・既定runtimeは変更しません。

[サーバー添付の有限保守cycle](../../docs/attachment-maintenance.md)は保守専用認可で、Relay期限回収→削除1job→孤立upload回収を順に実行し、部分commitを明示します。scheduler・runtimeの起動や受信済みbytesの自動解放は追加しません。

[配送DBのsnapshot／停止復元](../../docs/sqlite-snapshot-bundle.md)はprofile全DBのwriter lockとHMAC付きmanifestを使い、既存DBを置換しない新規offline directoryへ復元します。registry・認証・設定・鍵を巻き戻さず、runtimeの接続を自動再開しません。
