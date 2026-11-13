# Conflicts and authority

Scope/history resolution does not approve deployment. A later date or implementation success does not automatically supersede an adopted requirement. The fixed source already resolves optional working to coordinator claim and standard MCP versus product execution; retain those meanings. The publication/access/resource overview has stale implementation wording; exact versioned boundary contracts and actual interoperability evidence remain separate.

## HAB-C-F01 — resolved

Do fixed no-tools/Hermes Runs/one-task constraints and the older Task topology apply to every standard connection?

Classification: scope/history/explicit-authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

No. Architecture/workflow explicitly own optional limited Task path, and ADR015/common-MCP explicitly retain Tasks optional and recipient existing authority; ADR-016 revises the standard composition and keeps that division. Diagram remains dated historical Task integration rather than standard communication target.

Sources: [docs/architecture.md:1](../../docs/architecture.md#L1-L7), [docs/history/hab-workflow.md:5](../../docs/history/hab-workflow.md#L5-L7), [docs/history/hab-topology.md:7](../../docs/history/hab-topology.md#L7-L11), [docs/hab-decisions.md:24](../../docs/hab-decisions.md#L24-L36), [docs/hab-decisions.md:37](../../docs/hab-decisions.md#L37-L48).

## HAB-C-F02 — resolved

Relay specification allows outer Product adapter/API handoff, while common-MCP prohibits dedicated product adapters. Is every product API forbidden?

Classification: scope/authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

No. Reusable Relay permits outer capability integration without reverse dependency; standard messaging cannot require HAB product execution/approval runner. Verify native MCP/formal display/wake binding and leave absent capabilities unverified; independent explicitly configured execution integration remains scoped.

Sources: [docs/hab-relay-spec.md:81](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L81-L89), [docs/common-mcp-connection.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/common-mcp-connection.md#L3-L6), [docs/hab-decisions.md:31](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L31-L31), [docs/receiver/recipient-readiness.md:32](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/recipient-readiness.md#L32-L32).

## HAB-C-F03 — resolved

ADR014/group/Relay tables say persistent token updates unimplemented, while README and persistent-auth describe implementation. Which proves live refresh?

Classification: history/implementation-status. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

None proves live refresh. Older table is historical implementation snapshot; persistent-auth documents explicit v2 implemented contract and synthetic/loopback tests, with real Auth0/host refresh still unverified. Preserve version/mode and evidence scope rather than treating all common auth as 15-minute one-shot.

Sources: [docs/hab-decisions.md:22](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-decisions.md#L22-L22), [README.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/README.md#L19-L19), [docs/operations/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L12), [docs/operations/persistent-mcp-auth.md:133](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L133-L143).

## HAB-C-F04 — resolved

Product0.1 labels A2A/JetStream proposal/not current; README later exposes actual P7 lab and optional code. Is transport formally production adopted?

Classification: history/adoption-versus-implementation. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

Separate dated product baseline from optional proof implementation. Existing P7/optional modules do not by themselves resolve formal adoption/production replacement; preserve proposal/manual gate, existing MCP and single delivery authority. Superseded for delivery: the owner approved JetStream-only delivery, recorded as ADR-016 and in the product spec (HAB-C-D06, resolved). Superseded for A2A: the owner confirmed on 2026-11-12 that the retired Relay is replaced by NATS JetStream delivery and A2A interoperability (HAB-C-F10). A2A production deployment remains undecided. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/hab-product-spec.md:23](../../docs/hab-product-spec.md#L23-L30), [README.md:165](../../README.md#L165-L165), [docs/hab-product-spec.md:198](../../docs/hab-product-spec.md#L198-L204).

## HAB-C-F05 — resolved

Relay G0/G1/G2/G3 sequence says fixed Task before real agents. Must a normal native MCP conversation implement Task first?

Classification: scope/explicit-authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

Interpret G2 as optional execution-path gate, not ordinary communication prerequisite: Relay says ordinary question/answer Task unnecessary and ADR015 explicitly denies making optional Task mandatory. Native messaging capabilities and durable receipt still need G0/live evidence.

Sources: [docs/hab-relay-spec.md:31](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L31-L31), [docs/hab-relay-spec.md:517](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L517-L525), [docs/hab-decisions.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L28-L31).

## HAB-C-F06 — resolved

Old generic design interpreted working as recipient processing while implementation has pre-runtime claim. Is a current contradiction left?

Classification: history/state-meaning. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

Current fixed source explicitly resolves working to coordinator claim before runtime acceptance. Preserve this meaning in API/UI/evidence and do not treat working as model start/approval/completion.

Sources: [docs/history/design-boundary-alignment.md:15](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/design-boundary-alignment.md#L15-L15), [docs/history/generic-agent-async-design.md:142](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/generic-agent-async-design.md#L142-L142), [docs/history/generic-job-application.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/generic-job-application.md#L19-L23).

## HAB-C-F07 — resolved

Does reading saved body with receipt_confirmed=false bypass ACK-confirmed reply/task-accept preconditions?

Classification: scope/authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F21.

No. Pure inbox_read preserves false receipt and does no action/ACK update; existing reply/task acceptance still independently require confirmed ACK and current authorization. Read authority is separate from metadata/receive and actions.

Sources: [docs/receiver/adapter-host.md:49](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L49-L53), [docs/receiver/recipient-readiness.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/recipient-readiness.md#L7-L9).

## HAB-C-A01 — resolved

Do individual-exclusive connection requirements prohibit adopted group sharing?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Exclusive-binding language describes the earlier 1:1 enrollment/fixed-pilot scope. The adopted group design allows group credential holders to select sibling names/mailboxes; since 2026-11-12 every connection is a group binding and an address bound on its own is its group's only member. Enforce group boundaries; never promote single-member exclusivity into a universal requirement.

Sources: [src/hab/README.md:50](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/src/hab/README.md#L50-L55), [src/hab/README.md:342](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/src/hab/README.md#L342-L376).

## HAB-C-A02 — resolved

Must every successful connection acceptance revoke grants and disable MCP?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

Finitev1 trial cleanup is separate from persistentv2 operation. Persistent mode retains intended settings/grants until explicit scoped stop/incident; record mode before invoking cleanup.

Sources: [docs/operations/relay-oauth-ingress.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L19-L22), [docs/operations/relay-oauth-ingress.md:143](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L143-L147), [docs/operations/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L6), [docs/operations/persistent-mcp-auth.md:79](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L79-L86).

## HAB-C-A03 — resolved

Does HAB security overview exact /mcp standard-port statement still constrain detailed resource-server supported prefix/port behavior?

Classification: history. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

Treat overview wording as stale implementation summary, not universal invariant. Detailed Auth0 boundary explicitly supports approved explicit HTTPSport/prefix and exact path-specific metadata, and Relay ingress has its own canonical resource. Preserve exact resource and route isolation; do not enforce standard-port/exact-/mcp-only globally. Actual ingress interoperability remains unverified.

Sources: [docs/hab-security.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-security.md#L19-L19), [docs/history/auth0-boundary.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L27-L35), [docs/history/auth0-boundary.md:62](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L62-L67), [docs/operations/relay-oauth-ingress.md:40](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L40-L44).

## HAB-C-A04 — resolved

Does proposed address rename supersede default immutable-address policy for all deployments?

Classification: authority. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No for existing deployments: rename stays an explicit opt-in migration and keeps permanent reservations. Superseded on adoption: the owner adopted rename on 2026-11-12 with a grace period in which an old name resolves to its own ID only (HAB-C-A07); production rollout and rollback remain separate decisions.

Sources: [src/hab/README.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/src/hab/README.md#L27-L32), [docs/agent-address-rename.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/agent-address-rename.md#L3-L33).

## HAB-C-A05 — resolved

Must Relay OAuth ingress perform legacy Auth0 JWKS auto-refresh?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Legacy Auth0 verifier fetches bounded configured JWKS with cache. Relay OAuth ingress instead uses operator-pinned public keys with no runtime fetch; apply the correct subsystem contract.

Sources: [docs/history/auth0-boundary.md:131](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L131-L147), [docs/operations/relay-oauth-ingress.md:53](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L53-L57).

## HAB-C-A06 — resolved

Do historical Hermes Runs/Inspector/trial gates become prerequisites of model-free native MCP?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Those constraints apply when opting into the fixed execution trial, preserving useful execution safety boundaries. Native transport retains recipient execution/approval and does not add a HAB product runner.

Sources: [docs/operations/local-relay-host.md:65](../../docs/operations/local-relay-host.md#L65-L108), [docs/local-relay-service.md:147](../../docs/local-relay-service.md#L147-L161), [docs/hab-security.md:5](../../docs/hab-security.md#L5-L5).

## HAB-C-D01 — resolved

Do early incremental pending statements mean attachment outbox/receiver/writer are unimplemented?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16.

No: cumulative README explicitly appends the optional features later, and focused attachment-outbox/receiver/writer docs describe their adopted opt-in implementations. Keep old stage claims as historical evidence; do not make lack of these optional APIs a current invariant. Real product wiring remains unverified. Later the attachment outbox and receiver were deleted with managed attachments; only WriterAdmission remains as an adopted opt-in. The cumulative src/relay/README.md was itself deleted when the durable sender and receiver moved to src/agent-sdk; its successor README describes only the current agent SDK and has no stage claims, so the question is moot.

Sources: [src/agent-sdk/README.md:3](../../src/agent-sdk/README.md#L3-L3), [docs/delivery/writer-admission.md:5](../../docs/delivery/writer-admission.md#L5-L5).

## HAB-C-D02 — resolved

Does fair polling or writer admission promise global recipient execution fairness?

Classification: scope. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16.

No. fair_poll guarantees bounded candidate rotation for a stable eligible set; WriterAdmission is shared single-process volatile rate/queue. The attachment receiver's single checkpoint slot was deleted with attachments. Bytes/time/processing/SLO/fleet fairness remain excluded.

Sources: [docs/delivery/relay-fair-poll.md:15](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-fair-poll.md#L15-L17), [docs/delivery/writer-admission.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/writer-admission.md#L23-L27).

## HAB-C-D03 — resolved

Does optional SQLite snapshot fulfill JetStream whole-deployment restore gate?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16.

No, and the question is now moot: SQLiteSnapshotBundle was deleted. It never captured Registry/authority/Task/config/keys or broker data. JetStream operations require broker stream/consumer, admission journal, authority/config and recipient state quiesced and reconciled. P5/P6 remaining proof statements are package-scope/time-bounded; later P7 evidence must be reviewed separately by coordinator. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

## HAB-C-D04 — open

Which actual host policies, identity bindings, backup/IO quiescence and fault model are approved for production?

Classification: unresolved. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16.

Open: actual production host/policy/fault assumptions require an explicit concrete decision; local verification cannot invent them.

Sources: [docs/history/hab-relay-integration.md:69](../../docs/history/hab-relay-integration.md#L69-L71), [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

## HAB-C-D05 — resolved

Are NATS issues listed as open on 2026-11-01 current proof of a fixed/unfixed 2.15.2 fault?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16.

They are dated risk references; this reading records external metadata access but does not revalidate issue status or fixes. No safety conclusion is derived. Platform-specific fault testing stays unverified. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

## HAB-C-E01 — resolved

Does optional Runs driver mean standard Hermes connection must execute models through HAB?

Classification: resolved-subsystem-scope. Requirements: HAB-E01, HAB-E17.

No. hermes-connection1–5 and generic profile1–3 expressly choose native common MCP for standard messaging. Runs/inventory adapters remain optional explicit integrations; no default dependency can be inferred.

Sources: [docs/history/hermes-connection.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-connection.md#L1-L5), [docs/history/async-text-v1.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/profiles/async-text-v1.md#L1-L3).

## HAB-C-E02 — resolved

Earlier successful fixed pilot conflicts with newer inventory readiness still blocked?

Classification: resolved-historical-scope. Requirements: HAB-E01, HAB-E17.

Distinct request/runtime/import/key contracts. Earlier trial records finite connectivity only; current inventory/no-site and native acceptance gates remain separate. Do not erase earlier evidence or reuse it as current approval.

Sources: [docs/history/fixed-pilot.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/fixed-pilot.md#L3-L9), [docs/history/fixed-pilot.md:37](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/fixed-pilot.md#L37-L46), [docs/history/hermes-import-boundary.md:57](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-import-boundary.md#L57-L67).

## HAB-C-E03 — resolved

MVP table says OAuthResource only exact /mcp and wiring unfinished, while same page later reports selected HTTPS path configuration?

Classification: historical-implementation-status. Requirements: HAB-E01, HAB-E17.

Treat earlier table/diagnostic proposal as its earlier fixed baseline and later explicit fixed-text increment45–53 as source-backed implementation scope. Neither proves actual live OAuth/native compatibility. Avoid absolute current /mcp-only requirement.

Sources: [docs/history/mvp-acceptance.md:12](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/mvp-acceptance.md#L12-L16), [docs/history/mvp-acceptance.md:45](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/mvp-acceptance.md#L45-L53), [docs/history/inventory-end-to-end.md:118](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/inventory-end-to-end.md#L118-L134).

## HAB-C-E04 — resolved

Does working or waiting_approval prove remote model execution or recipient owner approval?

Classification: resolved-state-semantics. Requirements: HAB-E01, HAB-E17.

Current assigned generic application/profile/NATS docs consistently define coordinator claim and unknown reconciliation/cancellation; inspected GenericTextJobs projection agrees. Separate proposed recipient-owner approval is not implemented and must not overwrite this state meaning.

Sources: [docs/history/generic-job-application.md:21](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/implementation/generic-job-application.md#L21-L23), [docs/history/async-text-v1.md:40](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/profiles/async-text-v1.md#L40-L42), [docs/history/generic-text-preview.md:35](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/implementation/generic-text-preview.md#L35-L45).

## HAB-C-E05 — resolved

Does local-MVP1:1 auth establish Bot-exclusive identity in current shared groups?

Classification: resolved-version-scope. Requirements: HAB-E01, HAB-E17.

No. local-MVP 99–108 says each MVP address connects as the only member of its own group, while actual connection uses approved groups, distinct address selection and no same-group Bot exclusivity guarantee.

Sources: [docs/local-mvp.md:95](../../docs/local-mvp.md#L95-L104).

## HAB-C-E06 — resolved

Can EPERM be reclassified as immutable code evidence or switch to another identity automatically?

Classification: proposed-architecture-not-authorized. Requirements: HAB-E01, HAB-E17.

No. Proposed OS read-only image/dedicated identity needs separately reviewed TS/Python identity, import/native closure and credential handoff contract. Current EPERM remains inconclusive and blocked.

Sources: [docs/history/inventory-preparation.md:43](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/inventory-preparation.md#L43-L78), [docs/history/hermes-import-boundary.md:53](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-import-boundary.md#L53-L62).

## HAB-C-V01 — resolved

Early lab records unimplemented A2A/NATS skips, later P7 requires zero skips. Which is current?

Classification: historical-versus-current profile. Requirements: HAB-V09, HAB-V10.

Retain old baseline as historical evidence. Current composite P7 and successor catalogs are authoritative for mandatory groups; no old skip becomes a pass. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/history/testing/delivery-lab.md:1](../../docs/history/testing/delivery-lab.md#L1-L9), [docs/history/testing/publication.md:30](../../docs/history/testing/publication.md#L30-L30).

## HAB-C-V02 — resolved

Older reports say workflow inactive/publication held, current publication guide says active CI.

Classification: historical publication and hosted-CI scope. Requirements: HAB-V09, HAB-V10.

The older statements describe fixed local runs. The active workflow and actual current Actions result establish current CI, not the inert example or historical report.

Sources: [docs/history/testing/p7-independent-results.md:1](../../docs/history/testing/p7-independent-results.md#L1-L7), [docs/history/testing/publication.md:5](../../docs/history/testing/publication.md#L5-L5).

## HAB-C-V03 — resolved

F05 documentation describes actual SIGKILL while restart recipe says no kill-9 verification.

Classification: different fault injection boundary. Requirements: HAB-V09, HAB-V10.

F05 actually spawns/kills an isolated receiver child after save at an injected service-port seam. test:hab-integration only closes/reopens in process; verify-hab marked stop is graceful. These prove different scopes; none proves power-loss/physical failure.

Sources: [docs/history/testing/delivery-lab.md:58](../../docs/history/testing/delivery-lab.md#L58-L58), [.claude/skills/verify-hab/features/restart-durability.md:29](../../.claude/skills/verify-hab/features/restart-durability.md#L29-L30).

## HAB-C-V04 — resolved

Does raw relay_poll plus relay_ack establish durable receiving?

Classification: wire-versus-recipient-storage evidence. Requirements: HAB-V09, HAB-V10.

No. Corrected wire recipe explicitly does not save receiver state; only independent pre-network-ACK SQLite/body/request evidence supports durable receiver claims.

Sources: [.claude/skills/verify-hab/features/receive-ack.md:22](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/receive-ack.md#L22-L24), [.claude/skills/verify-hab/features/communication-boundary.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/communication-boundary.md#L7-L9).

## HAB-C-V05 — resolved

P7 guides still name the original 1498 full-root cases and old group set, but the current successor adds the broker-startup group and implementation adds tests. Which numeric counts apply to this exact candidate?

Classification: stale operational count within historical reference guide. Requirements: HAB-V09, HAB-V10.

The unchanged source-pin is explicitly historical; test/p7/README.md specifies the current successor catalogs and the separate broker-startup group. The generic-nats group was removed with its code, and the NATS producer catalog has 69 cases: 60 after the unused asynchronous relay operations were deleted, eight restored delivery-guarantee cases, and the replay-bound retention cycle case added with the remaining review fixes. Old 1498/7 prose is stale implementation guidance, not a normative fixed count. Current scripts/p7-lab.mjs enforces its full-root count (1190 after the six rollback/capacity cases and the unused Task-store closure case (expected catalog, not an execution-result claim)) and every group in test/p7/manifest.js. Require their exact current report and hosted status; do not edit historical result documents or claim a unique overlapping total. The A2A producer catalog is 49 after the added Task-store closure case; the old 48-case records remain historical. The nine-candidate review follow-up added 17 root cases (root 1207) and four A2A producer cases (53); the contract-limit reply-release case makes the current expected root 1208. These are expected inventories, not evidence of an executed full suite; older totals above describe earlier snapshots. RecipientMessages adds 21 explicit-composition cases, making the integrated expected root inventory 1229; this is not execution evidence. The seven recipient-host MCP cases make the expected root inventory 1236 after main 322a940 integration. Source commit 6085738 and successor pin 8d3104c preserve the commit-before-pin procedure; fresh full P7 and exact-head hosted evidence remain separate. PR141 response-size and interrupted-stdio-cleanup corrections add three cases, so the current expected root is 1239 and focused recipient-host checks are 8+2=10. Their source must be committed before a separate successor-pin update; previous 1236 evidence remains historical and cannot validate the corrected source. The single-source owner composition adds five root cases; the current expected root is 1244. Earlier 1239 results remain historical; unpinned P7 refused before execution and must be rerun against the committed successor. The dedicated stdio composition adds five cases: expected current root 1251. This is an inventory update, not an execution-result claim. The stop-failure fencing and SDK-close ordering regressions raise the current expected root inventory to 1253 (seven dedicated-stdio cases). Earlier 1251 evidence remains historical. Private HTTP composition adds eleven root cases, making current expected inventory1264. Hosted run42699025780 observed1264 passes with owned cleanup; its stale1253 gate failed and is corrected without weakening acceptance. The generic deny-only external owner adds thirteen cases, raising the expected current inventory to 1277. Earlier 1264 execution evidence remains historical; source commit precedes a separate successor pin and new full/hosted checks. Startup-cancellation and reentry regressions add six top-level cases, making the expected current root inventory 1283. Earlier counts remain historical execution or inventory records; current-head execution is separate. Reintegrated ACP-only delta on main 3213cc7a5b97274f17f0a993f6a192c1616550f3 without changing owner startup-cancellation, shared-stop or late-factory behavior. Added actual ACP-driver/current-owner stop and scope-loss composition regressions: one shared stop, confirmed child exit before stores, closed HTTP and no dispatch. Focused ACP37 + owner23 + private HTTP11 = 71 passes. Expected root inventory1324; full/hosted and native/manual acceptance are separate. PR161 CI correction: eight owner activation regressions raise the current expected full-root inventory from 1338 to 1346. Both initial hosted trigger variants executed 1346 passes but failed the stale 1338 catalog gate; only the expected count changes, not the strict acceptance rule. Corrected-head hosted status remains a separate gate. PR163 stacked follow-up: the 25 unchanged source-launch cases bring this branch to 1371 expected full-root tests. Its original hosted PR report passed all 1371 but failed the inherited 1338 catalog. The corrected owner-activation source and bounded recipient fixture are inherited without changing journal semantics; exact-count and cleanup gates remain strict. The unchanged source-pin is explicitly historical; test/p7/README.md specifies the current successor catalogs and the separate broker-startup group. The generic-nats group was removed with its code, and the NATS producer catalog has 69 cases: 60 after the unused asynchronous relay operations were deleted, eight restored delivery-guarantee cases, and the replay-bound retention cycle case added with the remaining review fixes. Old 1498/7 prose is stale implementation guidance, not a normative fixed count. Current scripts/p7-lab.mjs enforces its full-root count (1190 after the six rollback/capacity cases and the unused Task-store closure case (expected catalog, not an execution-result claim)) and every group in test/p7/manifest.js. Require their exact current report and hosted status; do not edit historical result documents or claim a unique overlapping total. The A2A producer catalog is 49 after the added Task-store closure case; the old 48-case records remain historical. The nine-candidate review follow-up added 17 root cases (root 1207) and four A2A producer cases (53); the contract-limit reply-release case makes the current expected root 1208. These are expected inventories, not evidence of an executed full suite; older totals above describe earlier snapshots. RecipientMessages adds 21 explicit-composition cases, making the integrated expected root inventory 1229; this is not execution evidence. The seven recipient-host MCP cases make the expected root inventory 1236 after main 322a940 integration. Source commit 6085738 and successor pin 8d3104c preserve the commit-before-pin procedure; fresh full P7 and exact-head hosted evidence remain separate. PR141 response-size and interrupted-stdio-cleanup corrections add three cases, so the current expected root is 1239 and focused recipient-host checks are 8+2=10. Their source must be committed before a separate successor-pin update; previous 1236 evidence remains historical and cannot validate the corrected source. The single-source owner composition adds five root cases; the current expected root is 1244. Earlier 1239 results remain historical; unpinned P7 refused before execution and must be rerun against the committed successor. The dedicated stdio composition adds five cases: expected current root 1251. This is an inventory update, not an execution-result claim. The stop-failure fencing and SDK-close ordering regressions raise the current expected root inventory to 1253 (seven dedicated-stdio cases). Earlier 1251 evidence remains historical. Private HTTP composition adds eleven root cases, making current expected inventory1264. Hosted run42699025780 observed1264 passes with owned cleanup; its stale1253 gate failed and is corrected without weakening acceptance. The generic deny-only external owner adds thirteen cases, raising the expected current inventory to 1277. Earlier 1264 execution evidence remains historical; source commit precedes a separate successor pin and new full/hosted checks. Startup-cancellation and reentry regressions add six top-level cases, making the expected current root inventory 1283. Earlier counts remain historical execution or inventory records; current-head execution is separate. Reintegrated ACP-only delta on main 3213cc7a5b97274f17f0a993f6a192c1616550f3 without changing owner startup-cancellation, shared-stop or late-factory behavior. Added actual ACP-driver/current-owner stop and scope-loss composition regressions: one shared stop, confirmed child exit before stores, closed HTTP and no dispatch. Focused ACP37 + owner23 + private HTTP11 = 71 passes. Expected root inventory1324; full/hosted and native/manual acceptance are separate. Managed transport packaging (2026-11-10): reviewed the 15-case focused suite and strict full-regression gate; expected root inventory is 1353 (1338 + 15), not aggregate execution evidence. Committed feature source precedes successor-pin generation. Full aggregate outcome and descendant cleanup remain unverified; hosted and native/manual evidence are separate. Integration of #161/#162/#163 with managed transport (2026-11-11): expected root inventory 1424 (1338 + 33 + 38 + 15), an inventory update, not an execution-result claim. Optional recipient owner scheduling (2026-11-11): expected root inventory changes from 1424 to 1441 with 17 new synthetic owner cases; strict acceptance and historical evidence remain unchanged. Inventory is not execution or native-product evidence. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/history/testing/p7-lab.md:12](../../docs/history/testing/p7-lab.md#L12-L12), [docs/history/testing/publication.md:20](../../docs/history/testing/publication.md#L20-L20).

## HAB-C-V06 — resolved

Can native A2A acceptance or the shared JetStream D01 stand in for arbitrary six-direction backend behavior?

Classification: generic compatibility-versus-native protocol scope. Requirements: HAB-V09, HAB-V10.

No for native A2A: it has a fixed SDK route with no generic poll/ACK API, and native relationships do not verify generic requirements. The hybrid D01 is gone: both shared backends now run D01 to D08 through JetStream, so D01 covers six directed synthetic round trips on JetStream only. That is still a synthetic three-agent contract, not arbitrary product traffic. Keep both scopes visible. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/history/testing/a2a-native-acceptance.md:43](../../docs/history/testing/a2a-native-acceptance.md#L43-L47), [docs/history/testing/publication.md:22](../../docs/history/testing/publication.md#L22-L22).

## HAB-C-V07 — resolved

Do diagram manifests and their rendering implementation create additional product topology requirements?

Classification: documentation-integrity artifact versus product authority. Requirements: HAB-V09, HAB-V10.

Manifest hashes verify correspondence of two rendered images to Markdown Mermaid source, not running topology. Derive principles from the authoritative Markdown current/target scope; keep binary image access separate.

Sources: [docs/diagrams/render-mermaid.ts:1](../../docs/diagrams/render-mermaid.ts#L1-L1).

## HAB-C-D06 — resolved

The product spec still records JetStream formal adoption and production replacement as undecided and the NATS diagram as a proposal, not a current function. The implementation, package, Relay and README docs now make JetStream the only delivery backend and retire SQLite delivery. Is JetStream-only delivery the adopted product design?

Classification: explicit-authority. Requirements: HAB-F26, HAB-D15, HAB-D16.

Yes. The product owner approved JetStream-only delivery. ADR-016 records the decision, and the product spec now records JetStream as the adopted delivery (section 2 row, the section 8 diagram and note, section 8.2, the section 10 stage, A-12 and section 12), with no SQLite delivery store, no dual-send and no migration of retired messages. HAB-D15 and HAB-D16 are no longer blocked by the adoption question. HAB-F26 keeps only A2A transport adoption as a proposal. Production deployment, real storage failure behavior and whole-deployment restore remain separate gates (HAB-D16, HAB-C-D04). Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/hab-product-spec.md:28](../../docs/hab-product-spec.md#L28-L28), [docs/hab-product-spec.md:136](../../docs/hab-product-spec.md#L136-L136), [docs/hab-product-spec.md:153](../../docs/hab-product-spec.md#L153-L155), [docs/hab-decisions.md:37](../../docs/hab-decisions.md#L37-L48), [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

## HAB-C-E07 — resolved

docs/history/generic-nats-dispatch.md and the async-text-v1 profile still describe the opt-in generic NATS dispatch port (src/generic-nats, packages/relay-nats/src/text-port.ts, scripts/prove-generic-nats.mjs) as present, but that code was deleted. Is the port still part of the design?

Classification: historical. Requirements: HAB-E11, HAB-E17.

No. The Relay removal deleted src/generic-nats, packages/relay-nats/src/text-port.ts, their tests, scripts/prove-generic-nats.mjs, the proof:generic-nats script and the P7 generic-nats group. The port had no production caller, its transport used the JetStream backend's own authorization callback instead of the Registry, and its production auth and startup were never enabled. The dispatch document now opens with a note that it is a historical record of removed code, and the async-text-v1 profile links it as that record. It stays context. HAB-E03, HAB-E11 and HAB-E17 no longer cite it and keep their TaskBridge, reply-journal and proof-label sources.

Sources: [docs/history/generic-nats-dispatch.md:3](../../docs/history/generic-nats-dispatch.md#L3-L3), [docs/history/generic-nats-dispatch.md:43](../../docs/history/generic-nats-dispatch.md#L43-L43), [docs/history/async-text-v1.md:50](../../docs/history/async-text-v1.md#L50-L50).

## HAB-C-E08 — resolved

The bundle said the A2A gateway is not wired into the host, pending an owner decision, and that A2A COMPLETED needs a correlated durable result plus independently verified closed engine evidence. Since 4d34aa1 the host wires the gateway with a host-owned identity, and host-routed Tasks become COMPLETED from the configured recipient's durable execution_result reply with no engine evidence. Does the host route weaken the evidence rule?

Classification: explicit-authority. Requirements: HAB-E02, HAB-E20, HAB-A21, HAB-D20, HAB-F26.

No, the two routes carry different, labelled claims. The owner decided on 2026-11-06 (ADR-016, decision item 5) to wire the gateway into the host with a host-owned A2A identity, off by default, and recorded that its result is the recipient's durable reply report (`attestation: "recipient_reply"`), not an independent verification of the recipient's engine. The not-wired text is replaced. The preview composition with HabExecutionEvidence is unchanged and keeps its rule: HAB-E02 and HAB-V12 keep their statements and their scopes now name that composition. HAB-E20 states the reply-attested semantics and the label; HAB-A21 states the identity, per-caller authorization and Task scoping that keep the host identity from acting as a confused deputy; HAB-D20 states the durability, owner-only send and save-then-ACK receiver properties. test/a2a-host.test.js runs in js-root and covers them, including the attestation label, provisioning idempotence, the refused impostor and reserved address, the 401/403 refusals, the cross-owner GetTask, the quarantined forged reply, the named-intent claim and restart completion. HAB-F26 stays proposed: the entry is opt-in and the product spec still lists formal A2A adoption as undecided.

Sources: [docs/a2a/a2a-relay-preview.md:27](../../docs/a2a/a2a-relay-preview.md#L27-L27), [docs/a2a/a2a-relay-preview.md:59](../../docs/a2a/a2a-relay-preview.md#L59-L59), [docs/a2a/a2a-relay-preview.md:63](../../docs/a2a/a2a-relay-preview.md#L63-L63), [docs/a2a/a2a-relay-preview.md:116](../../docs/a2a/a2a-relay-preview.md#L116-L116), [docs/a2a/a2a-relay-preview.md:129](../../docs/a2a/a2a-relay-preview.md#L129-L129), [docs/hab-decisions.md:45](../../docs/hab-decisions.md#L45-L45), [docs/hab-decisions.md:76](../../docs/hab-decisions.md#L76-L76).

## HAB-C-D07 — resolved

The operations guide said a release rolls back by restarting the earlier build on the same journal and broker store, and the product spec said a code rollback reconciles uncertain requests in the same JetStream journal. The JetStream design says unknown journals are refused and the v1-v3 to v4 migration is one-way, so builds before the JetStream-only release cannot open the schema 4 journal. Which rollback procedure applies?

Classification: stale operational procedure versus schema version. Requirements: HAB-F24, HAB-A07, HAB-D15, HAB-D16.

The backup restore with reconciliation. Since 94e9a0f, OPERATIONS.md allows a same-journal code rollback only to a build that opens the schemas the release wrote (journal schema 4 and agent SDK inbox schema 4); builds up to 3e203d7 refuse a schema 4 journal with journal_key_or_version_mismatch and there is no downgrade migration. Rolling back past that change drains, exports the accepted messages from the schema 4 journal, restores every part of one stopped pre-upgrade backup generation together, and reconciles each exported message by original ID and state before routing traffic; the schema 4 journal copy is kept until then. The product spec section 9, the ADR-016 rollback line and docs/local-relay-service.md now say the same. No requirement statement claimed the same-journal rollback; the claim was in the OPERATIONS.md document summary, which is corrected. HAB-F24 now states the schema bound and the whole-generation restore with original-ID reconciliation. HAB-A07 already forbade lowering schema versions and is unchanged. HAB-D15 and HAB-D16 keep their statements. Since 2b764dd the procedure also reconciles IDs still incomplete in the backup, treats `expired` and `quarantined` as outcome unknown, keeps the earlier build stopped until every restored ID has expired, and settles each ID as delivered, not_saved or unknown from scripts/relay-rollback-reconcile.mjs; HAB-F24 states this. Since 4715b4e the list takes the union of both journals' IDs (a purged incomplete-at-backup ID stays listed), takes `--backup-inbox` and `--execution-record` and lists `restored_bodies` as do_not_process, process or unknown, which a new OPERATIONS.md step 6 settles before each restored recipient restarts; the documents now say the expiry hold stops only redelivery through the relay, not re-execution of a body a restored inbox already holds. HAB-F24 states this. Since the remaining review fixes the root test also drills the restore with the broker store dir, the expiry hold and a recipient restart on the current build; a rollback to the earlier build itself stays a production-operations gate (HAB-C-D04). The local follow-up on 0fc76a6 adds retained recipient evidence to the ID union and an upgraded-only unreleased-body list with application-specific original-key handoff review, since the full restore and wait do not transfer a body first saved after backup. Unknown effects remain stopped and no automatic replay is added. Superseded by ADR-018 (owner, 2026-11-13): JetStream, nats-server and packages/relay-nats were removed; the host delivers through one SQLite file (docs/delivery-store.md).

Sources: [docs/hab-product-spec.md:169](../../docs/hab-product-spec.md#L169-L169), [docs/hab-decisions.md:48](../../docs/hab-decisions.md#L48-L48), [docs/local-relay-service.md:16](../../docs/local-relay-service.md#L16-L27), [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

## HAB-C-E09 — resolved

Until 4715b4e HAB-E20 stated that a host Task whose execution_accepted was saved but whose execution_result arrives after the reply window stays WORKING, because the host stops saving replies one day after the request's deadline. The host now moves a Task still without a result when that window closes to FAILED with reason result_window_expired. Which state applies, and does FAILED here claim that the recipient did not execute the request?

Classification: explicit-authority. Requirements: HAB-E20, HAB-D20.

FAILED with result_window_expired. The owner decided on 2026-11-07 (ADR-016) that such a Task moves to the standard FAILED state rather than staying WORKING, with no custom A2A state, and that its status says the recipient may or may not have executed it. The superseded WORKING sentence in HAB-E20 is replaced by the transition, its reason metadata, the outcome-unknown message, the empty Artifacts and the rule that a late reply never changes the Task; HAB-D20 states the bounded host receiver work, scheduled at window closure and subsequent page/retry cycles, that makes the transition through the Task store's overdue() without a caller read. FAILED here does not claim non-execution: the features/a2a-host.md gotcha and the preview say the outcome is unknown. test/a2a-host.test.js covers the transition and the late result in js-root. HAB-E02 and HAB-V12 keep the preview composition's evidence-verified rule unchanged.

Sources: [docs/hab-decisions.md:45](../../docs/hab-decisions.md#L45-L45), [docs/a2a/a2a-relay-preview.md:124](../../docs/a2a/a2a-relay-preview.md#L124-L126), [.claude/skills/verify-hab/features/a2a-host.md:15](../../.claude/skills/verify-hab/features/a2a-host.md#L15-L15), [.claude/skills/verify-hab/features/a2a-host.md:44](../../.claude/skills/verify-hab/features/a2a-host.md#L44-L44).

## HAB-C-F08 — resolved

Does adding a separate recipient-host MCP pull surface adopt a native product connection, replace RecipientMessagePort, expand the normal Relay catalog or relax recipient approval?

Classification: proposal-versus-adopted-boundary. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F07, HAB-F11, HAB-F21, HAB-E07.

No. The wrapper is explicitly uninstalled opt-in preparation over existing AdapterHostCycle operations. It reuses trusted per-session context and current host commit guards, exposes no Task, arbitrary message enqueue, control or owner-release tool, and leaves the normal five-tool Relay unchanged. A pulled saved message is external data, not native owner input or permission. RecipientMessagePort admission and exact-reply native callbacks are not serialized or replaced. Existing accepted requirements keep their original authority; the proposal is reviewed context and synthetic MCP/SQLite/JetStream evidence adds regression coverage only. Native product binding, policy, approval and wake remain manual/unverified.

Sources: [docs/receiver/recipient-host-mcp-proposal.md:8](../../docs/receiver/recipient-host-mcp-proposal.md#L8-L23), [docs/receiver/recipient-host-mcp-proposal.md:116](../../docs/receiver/recipient-host-mcp-proposal.md#L116-L125).

## HAB-C-F09 — resolved

Does a trusted external-owner factory callback implicitly grant recipient authority or adopt a product execution path?

Classification: scope/implementation composition. Requirements: HAB-F02, HAB-F03, HAB-F07, HAB-F11, HAB-F16, HAB-E09.

Optional trusted owner-local onBound callback after unchanged discovery receipt and native verification. Omission preserves deny-only behavior; presence alone grants/resumes nothing. Frozen local status/updatePermission/pause/resume/signal controls use existing fixed-source policy and current epoch, never MCP or IPC. Readiness bound reports composition, not activation or delivery. Callback startup work is tracked through shutdown; late controls are fenced and unsettled work retains stores. Eight synthetic regressions cover activation with empty receive, no remote grant, epoch/pause/revoke, hook failure/cancellation/timeout, and supervised factory usage. No multi-source policy, native model, product-specific runner, credential issuance or live deployment is accepted. Existing HAB-F02/F03/F07/F11/F16/E09 statements and native/manual gates remain unchanged.

Sources: .

## HAB-C-F10 — resolved

The product spec, roadmap and ADR-003 called A2A a proposal or not adopted, while ADR-016 and the README describe a wired host A2A entry. Is A2A adopted?

Classification: explicit-authority. Requirements: HAB-F26.

Yes. The owner confirmed on 2026-11-12 that the retired Relay is replaced by NATS JetStream delivery and A2A interoperability. ADR-016 records it; the product spec, roadmap, ADR-003 and README now describe A2A as the adopted entry, off by default, next to the five MCP tools. Production deployment remains a separate gate.

Sources: [docs/hab-decisions.md:50](../../docs/hab-decisions.md#L50-L50), [docs/hab-product-spec.md:30](../../docs/hab-product-spec.md#L30-L30).

## HAB-C-A07 — resolved

The registry spec says addresses cannot change and the rename prototype refuses old names immediately, while the owner wants renaming without breaking callers that still hold the old address. What happens to the old name?

Classification: explicit-authority. Requirements: HAB-A18.

The owner adopted rename on 2026-11-12 and chose a grace period: an old name stays permanently reserved to the same ID and, for a default 30 days, resolves only to that ID (and is accepted as that ID's own as_address), then is refused. Delivery already uses immutable IDs, so accepted, leased and replied messages are unaffected. The grace period is implemented (rename_grace_days, default 30; 0 refuses at once).

Sources: [docs/agent-address-rename.md:3](../../docs/agent-address-rename.md#L3-L48), [docs/hab-relay-spec.md:135](../../docs/hab-relay-spec.md#L135-L135).

## HAB-C-D08 — resolved

ADR-016 made NATS JetStream HAB's only delivery backend. After the owner chose a single-VM cloud deployment, is JetStream still the adopted delivery?

Classification: explicit-authority. Requirements: HAB-F26, HAB-D15, HAB-D16, HAB-F24.

No. ADR-018 (owner, 2026-11-13) replaces the JetStream delivery part of ADR-016 with one SQLite file per host. The broker was loopback-only with one replica and no consumer, and the SQLite journal already held admission, leases, retries and ACK history, so the broker only stored bodies. packages/relay-nats, the pinned nats-server, its installers, the pump, the broker config and the CI broker stage were deleted. Messages of the JetStream build are not migrated; the host refuses to start while jetstream-journal.sqlite remains, and the upgrade waits one hour plus max_clock_skew_ms after the last acceptance so no old ID can be admitted again. Revisit if multi-host, HA or external consumers are needed.

Sources: [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68), [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/delivery-store.md:46](../../docs/delivery-store.md#L46-L58).
