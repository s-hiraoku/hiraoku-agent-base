> Historical proposal, superseded by PROPOSAL-V2-EMPTY-ONLY.md. Neither version is accepted policy.

# Proposal: preserving finite reply-budget capacity and source rotation

Status: DRAFT FOR INDEPENDENT REVIEW. Not accepted design, an implemented API, live-change authorization, or production-readiness evidence. This separate artifact does not replace repository requirements. No credentials, live store contents or user payloads are included.

## Baseline and purpose

Repository: s-hiraoku/hiraoku-agent-base, main 4c4663e42acc2fb27ffbe640531c0f5e5cfec1c9. Reviewed source snapshot: [local source artifact omitted] Private composition: [local source artifact omitted]


Correction: SQLiteOutbox max_records is configured at construction, not HMAC policy-bound. Its migrate() verifies identity/key/schema; unlike the budget it does not bind all policy options. Existing live outbox settings still must not be widened silently or reset. Separate outbox capacity approval and retention analysis are required; changing the budget alone does not make the composition daily-use-ready.

This proposal adds only a reviewed local-owner administrative exception for increasing retained-record capacity in the same budget lineage. It does not change HAB wire messages, Relay responsibility, reply eligibility, identity, or authorization.

## Alternatives and scope

1. Keep the existing cap and stop when exhausted. This is the currently supported fail-closed behavior; exact existing reply replay remains possible.
2. Choose an adequately sized finite cap when creating a genuinely new identity's initial budget. This is not a migration of an existing identity. Creating a new empty budget for the existing identity, even when reported usage is zero, bypasses its established lineage and is not an alternative here.
3. Adopt this narrow capacity-change design only after independent review and exact operator authorization for any live application.

Only max_records may increase, with old < new <= 10000. Thread limit, global rate/window, skew, message limits, key, identity and existing reservation count remain unchanged. No default target cap is selected. Capacity 10000 is still finite and does not enable indefinite daily operation. GC, compaction, eviction, refunds, thread reset, key rotation and lowering caps are out of scope.

## Preserved accepted requirements

- HAB-E06: One shared finite budget per receiving identity; one stable reply per source/kind; reserve before outbox; no refund for an uncertain result. A source change never creates another budget.
- HAB-E07: Existing durable answer ID, body, first_sent_at and expires_at remain unchanged. Startup, migration, rotation and inspection do not prepare/send a new answer.
- HAB-E09: Same exclusive owner DB/path/inode for the identity; no lease timeout takeover or copied replacement. Unknown native activity cannot be treated as stopped by acquiring the OS lock.
- HAB-E11: Retain all existing dedup/unknown evidence. No independent state restore or deadline refresh. Capacity change cannot reclassify unknown execution as absent.

References: docs/adapter-reply-budget.md sections 枠の単位と消費点 and 保存・障害・運用; docs/answer-intents.md; docs/adapter-owner.md; verification/design/design-principles.md HAB-E06/E07/E09/E11. Implementation anchors: src/adapter-policy/sqlite-reply-budget.ts (#binding, #meta, #records, migrate, withReply), src/agent-sdk/sqlite-outbox.ts migrate, private composition runtime.ts runSingleOwner flow and openOwnedStores.

## Authority and exact approval

The administrative surface is local-only, unavailable to generic MCP, Relay, incoming messages, native tools and automatic recovery. Possession of the user conversation, a root constructor, a callback or a fingerprint key is not administrative approval. No generic claim that the user is an administrator suffices.

A live request must be approved for the exact identity, existing budget lineage/path, expected schema/policy generation, old and new cap, and reviewed migration implementation. Approval must disclose that future new reservations become possible, while existing blocked intents remain held and runtime stays paused. The official provenance/verification mechanism for such approval is UNRESOLVED. A fabricated approval object or a check() returning true cannot satisfy it.

A trusted synchronous guard must verify current, authenticated authority independently at entry and immediately before commit, including the unchanged approval request and live exclusive-owner/quiescent conditions. The audit stores an opaque verifiable approval reference/digest, never credentials. Reused authorization must not authorize a different cap, identity or generation. Tests may use synthetic authorization but must label it as such, not proof of live authority.

## Proposed local API responsibilities (not implemented)

- planCapacityIncrease(expectedGeneration, expectedPolicyDigest, newMaxRecords): read-only authenticated validation and redacted plan/digest. Must not create a missing file or initialize a DB. The plan grants no authority and is revalidated at commit.
- applyCapacityIncrease(changeId, expectedGeneration, expectedPolicyDigest, newMaxRecords, exactApproval, guard): explicit admin transaction on existing store, separate from ordinary migrate(). Reject unrecognized input, absent files, stale plans, decreases, other policy changes, partial/bad integrity or uncertain quiescence.
- inspectCapacityChange(changeId): authenticated read-only receipt lookup for uncertain completion. No implicit retry, resume or repair.

Exact types, authority implementation and schema encoding require review before implementation. Constructor or API existence cannot establish approval. No default live factory or shell command is supplied.

## Storage and transaction design

Require all model/source launch, receive, enqueue and send paths paused/drained, known transport/native settlement, and acquisition of the SAME existing owner. All holders must honor this boundary. Close other business-store handles before upgrade; no second migration process or unguarded old writer.

Use the existing key-loading/custody route in process. Do not read/export the live key during source development, pass it in argv/environment, generate a replacement or copy it elsewhere.

In one BEGIN IMMEDIATE transaction:

1. Validate exact old schema, expected policy/key binding, immutable protections, every reservation HMAC and indexed identity, unique source/kind and reply ID, authenticated row count and clock high-water mark, and reserved_at <= high-water mark.
2. Confirm all unchanged policy fields, generation and approved change digest. Verify all existing records fit the old policy and new cap. Never alter or reserialize reservation rows or fingerprints.
3. Upgrade to a reviewed versioned schema that binds policy generation and authenticated audit lineage. Keep reservation bytes, count and last_at unchanged. Do not update reply/envelope dates or consume/refund rate/thread usage.
4. Atomically append the capacity-change receipt and set the new active policy binding/generation. Receipt includes change ID, old/new policy digests and cap, expected/new generation, preserved-reservation digest/count/high-water mark, opaque authenticated approval reference and administrative timestamp. No body, bearer, key or secret is stored.
5. Recheck current guard and commit. Return the persisted receipt, leave the host paused and close migration handles.

The initial upgrade must preserve a verifiable link to the schema1 policy binding and original reservation integrity. Audit-chain head, active generation and policy must be mutually authenticated, not independent unchecked tables. Ordinary startup rejects mismatched policy/generation and never auto-adopts a capacity increase. Old software must reject the upgraded schema, including already-open stale handles before another reservation.

## Crash, idempotence and rollback

Same change ID plus identical canonical request returns the original receipt after full integrity and authority checks, without new audit event or capacity change. Reused ID with different arguments fails; stale generation and concurrent changes fail. No process-local-only idempotency.

Before commit, failure leaves the prior schema/policy/history intact. After commit, all new metadata and receipt exist together. Lost response or uncertain rollback closes/stops the store; reopen and inspect the original change ID before any retry. On disk-full or commit error retain evidence and remain paused. Atomic SQLite transaction evidence is not a power-loss/media guarantee.

Rollback is code/service selection only after quiescence. If old code cannot read the new schema it must remain stopped; use a compatible build or reviewed forward repair. Never downgrade metadata in place, restore an older business snapshot, restore/copy owner DB, delete audit events/reservations or replenish counters. Whole-DB snapshot rollback is not detected by HMAC alone; external anti-rollback authority is not provided by this proposal.

## Previously blocked intents and explicit resume

Current budget has no persistent rejected-admission ledger. Thus migration cannot infer which old intents were blocked by capacity. All outstanding prepared/enqueued/unknown work must be conservatively held or entered in an authenticated durable review set before resume. A previously blocked intent needs exact owner review/authorization for recovery; a changed cap alone cannot silently make it sendable.

Migration itself performs no outbox enqueue, transport call, model launch, Task creation, automatic retry or resume. A separate approved resume decision checks current authority, native settlement and held-intent dispositions. Recovery preserves original envelopes, and an expired envelope is not regenerated.

## Source rotation and lineage mapping

One identity retains the same owner, control, inbox, shared budget and shared launch-claim lineage across sources. Current private runtime is finite/exact-source and caller-provided store paths are not a durable rotation ledger.

Before multi-source operation, add or designate a reviewed authenticated durable mapping: exact source (sender_id, message_id) -> existing claim/launch identity, fixed answer-journal/outbox lineage, policy generation and recovery disposition. Paths alone are not proof; identity/key/policy/source binding and expected file lineage must be checked. How to encode durable file lineage without relying only on replaceable paths/inodes, and where this mapping is atomically recorded with claim creation, remain OPEN DESIGN QUESTIONS.

Commit mapping/claim before native create; recover the mapping before selecting any new source. Never choose a guessed latest row or create a fresh answer/outbox lineage to hide an existing claim. Fixed-source outboxes must not multiply identity-wide send capacity without an approved aggregate policy; reusing one outbox also needs explicit source-scope compatibility review.

Rotate only after positively observed native/transport settlement, paused/drained host release and closed handles; reacquire the same owner. An existing claim never calls create/prompt again. Prepared/enqueued work reconciles with the original envelope. Unknown native result/cleanup or claim-without-answer stays held for explicit reconciliation. The conservative first design stops source rotation on any unresolved claim, rather than silently skipping it. Neither expiration nor owner reacquisition clears the hold.

## Required implementation evidence after review

Use fresh synthetic state and synthetic keys only, with bounded focused tests, existing verified dependencies and no live/network/model/service work:

- Empty and populated schema1 upgrade preserving exact reservation bytes, fingerprints, count/high-water, original reply IDs/dates and consumption.
- All non-cap fields changed, wrong key/identity, decrease, cap >10000, stale generation, changed approval request, revoked authority and missing existing file rejected.
- Exact replay at full capacity; old thread exhaustion and current-window consumption survive expansion.
- Concurrent reservation/migration and two migrations serialized/rejected; stale old software/handles fail closed.
- Injected failure before/at commit, process interruption after commit but before response, lost response and repeated identical change ID. No second receipt or broadened request.
- Audit/head/policy mismatch, missing rows/triggers and rollback uncertainty fail closed.
- Migration leaves blocked intents held and host paused; no producer/send callback fires.
- Rotation/restart retains shared budget and exact source mapping; unknown claims never replay model; restart recovers original reply envelope; wrong source/outbox mappings rejected.

Each report must distinguish synthetic authority/process-crash evidence from actual approval, real native behavior, physical-fault durability and production readiness. No whole/P7/R08 suite is authorized by this artifact.

## Review gate and unresolved decisions

Before coding an operative migration: approve the narrow formal-design exception; settle exact approval provenance, schema/audit authentication, legacy open-handle rejection, owner quiescence across every entry, durable hold/review lifecycle and exact-source mapping atomicity/aggregate outbox capacity. Maintain formal citations through semantic review, not mechanical repinning. Then a minimal isolated implementation and focused synthetic tests can be considered. Until these are resolved, the API is a proposal and daily rotation remains incomplete.
