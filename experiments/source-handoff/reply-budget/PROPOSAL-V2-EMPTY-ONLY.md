# V2: empty-budget-only capacity exception

Status: source-only proposal for independent review. Not an approved formal design, operative migration API, implementation permission or live authorization. Supersedes the scope of PROPOSAL.md for the first potential change; populated-store migration and source-store mapping are withdrawn from that first change. No live state or secrets were inspected.

## Decision and evidence

An EMPTY-only exception is materially smaller and safer than arbitrary populated-store policy migration, but it cannot yet be treated as a usable implementation or current deployment fix. Independent reviewer agrees it removes reservation-preservation complexity, not authorization, settlement, durable barriers or crash-safe recovery requirements.

Baseline: main 4c4663e42acc2fb27ffbe640531c0f5e5cfec1c9. Source:
- src/adapter-policy/sqlite-reply-budget.ts:131–149 binds max_records; :182–188 rejects mismatched schema/policy; :405–408 calls the outbox action AFTER committing the reservation.
- docs/adapter-reply-budget.md:50–54 excludes policy changes/reset and requires stop at capacity.
- docs/answer-intents.md:64 requires one producer journal, budget and outbox per identity.
- src/answer-intents/sqlite-journal.ts:135–145 also binds journal max_records. Raising the budget alone does not raise answer-journal capacity.
- src/agent-sdk/sqlite-outbox.ts:193–235 binds identity/key/schema, NOT max_records. Its capacity is a separate configuration decision, not this migration.
- ../single-owner-runtime/runtime.ts:178–183 automatically tries enqueue for a prepared intent. A pause on the budget alone does not eliminate silent retry.


## Narrow formal exception requested

Permit exactly one explicit local-owner administrative increase of max_records on an existing, fully authenticated, never-used budget, preserving its existing DB/key/identity lineage. Require 1 <= old cap < new cap <= 10000; all other policy fields and authenticated clock high-water mark remain byte-for-byte logically unchanged. No delete/reinitialize, replacement budget, key rotation, refund, lifetime extension or new identity.

Use a one-time schema1-to-new-version exception, not recurring policy generations or arbitrary reconfiguration. No follow-up expansion under this API. Capacity remains finite; 10000 is not indefinite daily operation. GC/compaction and populated migration are out of scope.

Alternative: preserve current configuration and stop at its cap. Creating a larger initial budget is legitimate only for a genuinely new identity, not replacing the existing identity's lineage, even if it appears empty.

E06/E07/E09/E11 remain invariant: shared finite budget and reply relationships; stable durable answer; same exclusive owner without timeout takeover; retain all dedup/unknown history. A separate accepted design amendment and maintained formal citations are required before an operative implementation.

## Eligibility: stricter than no pending work

The first exception should reject ANY record in the budget, source launch claims, answer journal or relevant reply action outbox, not merely nonterminal/pending records. This intentionally sacrifices eligibility to avoid inventing terminal-claim classification or historical disposition logic. The authoritative inventory must validate each store's original identity/key/policy/schema/integrity, authenticated counts, actual rows and original file lineage. Budget meta record_count=0 AND actual reservation rows=0 are mandatory. A zero UI count, empty query on a newly initialized store, missing file or a silently replaced path is not evidence.

No active/unknown native execution, transport operation, post-reservation callback, retained work reference, pending ACK-side effect affecting the snapshot or other business writer may remain. Positive known settlement is required; absent process/owner acquisition alone is insufficient. A schema version fence prevents future old reservations, but cannot cancel an old callback already past its reservation commit.

All affected producers and recovery paths must honor the durable maintenance barrier. If a legacy process does not, stop it through an authorized procedure, positively settle/drain its work and close its handles before proceeding. No universal process inspection or live control is authorized by this document.

The consistency inventory spans multiple DBs: it is not one atomic SQLite transaction. Its consistency depends on the same exclusive owner plus a verified no-writer barrier and closed legacy handles. If these cannot be established, refuse the operation. Check authoritative emptiness again immediately before mutation while the exclusion still holds.

## Durable barrier and inbox hold

A reviewed durable maintenance record is written BEFORE inspecting for eligibility or changing budget metadata. Its exact storage location, authentication and integration with control remain design prerequisites. It is not a second owner, budget or identity.

Required monotone states:
1. HOLD_REQUESTED: admission/recovery/send/native launch blocked. Existing work may only settle under an authorized drain procedure. A crash here stays blocked.
2. QUIESCENT_VERIFIED: positive settlement and authenticated empty-inventory evidence recorded against the exact request and owner lineage. A restart invalidates transient settlement evidence and revalidates; it never jumps directly to resume.
3. CAPACITY_APPLIED_HELD: committed budget receipt verified; all runtime paths remain blocked.
4. Separately authorized resume: only after exact schema/configuration consistency and current authority checks. Resume is not a migration side effect.

Cross-DB reconciliation is fail-closed: if the budget commit happened but the maintenance record update did not, the budget's original change ID/receipt proves APPLIED, while the barrier remains held. If only the barrier committed, nothing is assumed applied. Missing/corrupt/contradictory records stop startup. An abort can only remove a pre-mutation hold through separately authorized reconciliation; it cannot blindly set active.

Existing inbox records may include unprocessed or previously capacity-blocked input even when every other ledger is empty. Conservatively hold ALL preexisting and newly arriving sources until explicitly admitted by the reviewed post-cutover policy. No blanket resume scans old inbox and launches/answers it. Exact-source approval is a separate decision; timestamp cutoffs or an arbitrary fresh ID are not authority. The persistent gate must be checked before claim, prepare, enqueue, recovery and send, including on restart and at commit boundaries. It must not silently convert a held input into a new post-cutover source.

This blanket default-deny source hold avoids a complicated per-intent migration inventory while preserving previously blocked work. Its durable policy representation and every entry-point integration still require specification and tests. A callback returning true cannot stand in for this persisted gate.

## Authority, storage and receipt requirements

Live application requires authentic, current approval for exact identity, existing budget lineage, expected schema/binding, old/new cap, change ID and reviewed implementation digest. It must disclose that migration leaves the runtime paused and grants no processing/send authority. Trusted issuer/channel, approval authenticity/revocation and authoritative lineage attestation remain unresolved; synthetic fixtures must not unlock a live default. The user is not presumed a generic administrator, and root construction does not create authority.

The separate admin-only implementation, if approved, must open EXISTING stores only and preserve existing key custody. No create-if-missing, key export, key material in source/argv/environment or new credential. It is never exposed to Relay, general MCP, incoming messages, native tools or automatic startup.

Within one BEGIN IMMEDIATE on the budget, reverify original binding/integrity/empty rows, expected exact approval and unchanged cap request; atomically install the reviewed new schema/binding and a single authenticated immutable receipt, preserving record_count=0 and original last_at. Reservation table and immutable triggers remain intact. The receipt links original policy binding/key-check, new cap/binding, original clock, change ID, canonical approved request digest, authenticated approval reference and implementation digest. The new meta binds this receipt and maintenance/cutover identity. Old software must reject the new version; ordinary new startup cannot silently adopt the cap.

The actual new schema number/tables, canonical serialization, HMAC domains, trigger definitions, existing-lineage attestation and authenticated barrier reference are NOT yet specified sufficiently for an operative API. They must be reviewed, not filled with plausible placeholder authority. Empty state reduces receipt complexity: no row rewrite, reservation digest tree or per-record migration is needed.

Only one identical change request may commit. Same change ID/arguments returns the existing verified receipt; changed request fails. Read-only receipt inspection needs independent current inspection authority, not a still-valid mutation approval. A previously committed result can be reported after original mutation approval expires/revokes, but it cannot trigger any new mutation/resume. New attempt after expiry/revocation requires renewed exact authorization. Distinguish before-commit rollback, committed-after-lost-response and unknown outcomes by close/reopen/inspection, never a blind retry.

Never restore an old business snapshot or downgrade schema to undo the cap change. Code rollback must remain paused if incompatible. HMAC alone does not detect rollback of the entire DB; this proposal does not solve that threat. Disk-full/unknown commit fails closed.

## Shared stores; rotation is a separate dependency

Retain one shared owner/control/inbox/budget/claim journal and one shared answer journal/action outbox per identity. Remove the prior proposal's source-specific store mapping and extra outboxes. Existing journals already key by source, but this does not prove the entire native fixed-source composition is compatible with rotation.

The first change contains NO automatic rotation implementation. A later review must show sequential exact-source scopes with shared stores, same owner handoff, prior-claim recovery without model replay, no guessed latest row, immutable original reply IDs/dates, and no advance past unknown native/claim outcome. An empty-only migration cannot cure future unresolved claims or reset consumption between sources.

Before claiming multi-source readiness, independently verify capacity and retention of the unchanged shared answer journal, claims and outbox. If any HMAC-bound journal cap is insufficient, stop and propose its own reviewed change; do not expand this budget exception automatically. These are deployment prerequisites, not permission to read live keys or modify stores now.

## Evidence and remaining gates

After design approval, bounded fresh synthetic fixtures should prove: authoritative nonempty/unknown/missing/tampered stores reject; every guard remains paused; all interrupted barrier states survive restart; old callbacks are drained, not assumed fenced by schema; exact one-time receipt/idempotence/changed-request refusal; unchanged high-water and other policies; old binary refusal; lost response and disk-full stop; no model/producer/enqueue/send callbacks; old inbox remains held after migration and startup; revoked mutation approval does not prevent authorized read-only receipt inspection or authorize resume.

Independent reviewer confirms narrowing is worthwhile, with these unavoidable gates still blocking operative implementation:
1. Accepted exact formal exception and citations.
2. Real exact approval/lineage provenance, not a guard-shaped object.
3. Persistent barrier and complete legacy/native/transport settlement.
4. Concrete authenticated schema/genesis/receipt/inspection semantics.
5. Consistent authoritative empty inventory under same owner plus distinct crash-safe resume.
6. No automatic startup adoption; shared-store rotation separately reviewed.

No existing environment is declared empty, migrated or operational by this proposal. No API, live factory, live command, tests or deployment changes are included.
