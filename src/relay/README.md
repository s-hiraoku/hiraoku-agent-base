# Standalone Relay contract — implementation step 1

Import from `./index.ts`. This module owns no database, process, credentials,
network connection, environment configuration, HAB naming rules or Task Engine.
It validates a version-1 caller submission and supplies stable comparison material.
It is not yet a message service and is not exposed through HTTP or MCP.

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

Next steps: authorized registry/service boundaries, durable SQLite delivery and
receipt storage, managed attachment storage, client outbox/inbox and MCP wiring.
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
checks exist. Poll/lease/ACK, receiver inbox, registry enrollment, background
expiry maintenance, 30-day tombstone collection and standalone setup are next
steps. Current records are conservatively retained (with a hard record-count
limit); the complete retention acceptance gate has not passed. Expiry cleanup
runs on successful transactions, so idle databases still require the future
maintenance loop. Failed transactions roll back cleanup together with acceptance.
Nothing is wired to the existing MCP catalog or real agent connections yet.
