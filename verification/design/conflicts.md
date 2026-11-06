# Conflicts and authority

Scope/history resolution does not approve deployment. A later date or implementation success does not automatically supersede an adopted requirement. The fixed source already resolves optional working to coordinator claim and standard MCP versus product execution; retain those meanings. The publication/access/resource overview has stale implementation wording; exact versioned boundary contracts and actual interoperability evidence remain separate.

## HAB-C-F01 — resolved

Do fixed no-tools/Hermes Runs/one-task constraints and the older Task topology apply to every standard connection?

Classification: scope/history/explicit-authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

No. Architecture/workflow explicitly own optional limited Task path, and ADR015/common-MCP explicitly retain Tasks optional and recipient existing authority; ADR-016 revises the standard composition and keeps that division. Diagram remains dated historical Task integration rather than standard communication target.

Sources: [docs/architecture.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/architecture.md#L1-L7), [docs/hab-workflow.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-workflow.md#L5-L7), [docs/hab-topology.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-topology.md#L5-L9), [docs/hab-decisions.md:24](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L24-L36), [docs/hab-decisions.md:37](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L37-L48).

## HAB-C-F02 — resolved

Relay specification allows outer Product adapter/API handoff, while common-MCP prohibits dedicated product adapters. Is every product API forbidden?

Classification: scope/authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

No. Reusable Relay permits outer capability integration without reverse dependency; standard messaging cannot require HAB product execution/approval runner. Verify native MCP/formal display/wake binding and leave absent capabilities unverified; independent explicitly configured execution integration remains scoped.

Sources: [docs/hab-relay-spec.md:81](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L81-L89), [docs/common-mcp-connection.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/common-mcp-connection.md#L3-L6), [docs/hab-decisions.md:31](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L31-L31), [docs/recipient-readiness.md:32](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/recipient-readiness.md#L32-L32).

## HAB-C-F03 — resolved

ADR014/group/Relay tables say persistent token updates unimplemented, while README and persistent-auth describe implementation. Which proves live refresh?

Classification: history/implementation-status. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

None proves live refresh. Older table is historical implementation snapshot; persistent-auth documents explicit v2 implemented contract and synthetic/loopback tests, with real Auth0/host refresh still unverified. Preserve version/mode and evidence scope rather than treating all common auth as 15-minute one-shot.

Sources: [docs/hab-decisions.md:22](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-decisions.md#L22-L22), [README.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/README.md#L19-L19), [docs/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L12), [docs/persistent-mcp-auth.md:133](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L133-L143).

## HAB-C-F04 — resolved

Product0.1 labels A2A/JetStream proposal/not current; README later exposes actual P7 lab and optional code. Is transport formally production adopted?

Classification: history/adoption-versus-implementation. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

Separate dated product baseline from optional proof implementation. Existing P7/optional modules do not by themselves resolve formal adoption/production replacement; preserve proposal/manual gate, existing MCP and single delivery authority. Superseded for delivery: the owner approved JetStream-only delivery, recorded as ADR-016 and in the product spec (HAB-C-D06, resolved). A2A formal adoption and production deployment remain undecided.

Sources: [docs/hab-product-spec.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L23-L30), [README.md:134](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/README.md#L134-L134), [docs/hab-product-spec.md:200](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L200-L206).

## HAB-C-F05 — resolved

Relay G0/G1/G2/G3 sequence says fixed Task before real agents. Must a normal native MCP conversation implement Task first?

Classification: scope/explicit-authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

Interpret G2 as optional execution-path gate, not ordinary communication prerequisite: Relay says ordinary question/answer Task unnecessary and ADR015 explicitly denies making optional Task mandatory. Native messaging capabilities and durable receipt still need G0/live evidence.

Sources: [docs/hab-relay-spec.md:31](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L31-L31), [docs/hab-relay-spec.md:517](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L517-L525), [docs/hab-decisions.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L28-L31).

## HAB-C-F06 — resolved

Old generic design interpreted working as recipient processing while implementation has pre-runtime claim. Is a current contradiction left?

Classification: history/state-meaning. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

Current fixed source explicitly resolves working to coordinator claim before runtime acceptance. Preserve this meaning in API/UI/evidence and do not treat working as model start/approval/completion.

Sources: [docs/implementation/design-boundary-alignment.md:15](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/design-boundary-alignment.md#L15-L15), [docs/generic-agent-async-design.md:142](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/generic-agent-async-design.md#L142-L142), [docs/implementation/generic-job-application.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/generic-job-application.md#L19-L23).

## HAB-C-F07 — resolved

Does reading saved body with receipt_confirmed=false bypass ACK-confirmed reply/task-accept preconditions?

Classification: scope/authority. Requirements: HAB-F01, HAB-F02, HAB-F03, HAB-F06, HAB-F08, HAB-F12, HAB-F18, HAB-F21.

No. Pure inbox_read preserves false receipt and does no action/ACK update; existing reply/task acceptance still independently require confirmed ACK and current authorization. Read authority is separate from metadata/receive and actions.

Sources: [docs/adapter-host.md:49](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L49-L53), [docs/recipient-readiness.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/recipient-readiness.md#L7-L9).

## HAB-C-A01 — resolved

Do individual-exclusive connection requirements prohibit adopted group sharing?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Exclusive-binding language describes legacy1:1 enrollment/fixed-pilot scope. The explicit optional shared-group section and adopted group design allow group credential holders to select sibling names/mailboxes; preserve both modes and enforce group boundaries, never promote legacy exclusivity into universal requirement.

Sources: [src/hab/README.md:50](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/src/hab/README.md#L50-L55), [src/hab/README.md:339](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/src/hab/README.md#L339-L373).

## HAB-C-A02 — resolved

Must every successful connection acceptance revoke grants and disable MCP?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

Finitev1 trial cleanup is separate from persistentv2 operation. Persistent mode retains intended settings/grants until explicit scoped stop/incident; record mode before invoking cleanup.

Sources: [docs/relay-oauth-ingress.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L19-L22), [docs/relay-oauth-ingress.md:143](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L143-L147), [docs/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L6), [docs/persistent-mcp-auth.md:79](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L79-L86).

## HAB-C-A03 — resolved

Does HAB security overview exact /mcp standard-port statement still constrain detailed resource-server supported prefix/port behavior?

Classification: history. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

Treat overview wording as stale implementation summary, not universal invariant. Detailed Auth0 boundary explicitly supports approved explicit HTTPSport/prefix and exact path-specific metadata, and Relay ingress has its own canonical resource. Preserve exact resource and route isolation; do not enforce standard-port/exact-/mcp-only globally. Actual ingress interoperability remains unverified.

Sources: [docs/hab-security.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-security.md#L19-L19), [docs/auth0-boundary.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L27-L35), [docs/auth0-boundary.md:62](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L62-L67), [docs/relay-oauth-ingress.md:40](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L40-L44).

## HAB-C-A04 — resolved

Does proposed address rename supersede default immutable-address policy for all deployments?

Classification: authority. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Rename is an explicit proposal requiring adoption and opt-in migration. Keep immutable default and permanent reservations; do not silently decide forwarding, production rollout or rollback policy.

Sources: [src/hab/README.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/src/hab/README.md#L27-L32), [docs/agent-address-rename.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/agent-address-rename.md#L3-L33).

## HAB-C-A05 — resolved

Must Relay OAuth ingress perform legacy Auth0 JWKS auto-refresh?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Legacy Auth0 verifier fetches bounded configured JWKS with cache. Relay OAuth ingress instead uses operator-pinned public keys with no runtime fetch; apply the correct subsystem contract.

Sources: [docs/auth0-boundary.md:131](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/auth0-boundary.md#L131-L147), [docs/relay-oauth-ingress.md:53](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-oauth-ingress.md#L53-L57).

## HAB-C-A06 — resolved

Do historical Hermes Runs/Inspector/trial gates become prerequisites of model-free native MCP?

Classification: scope. Requirements: HAB-A02, HAB-A07, HAB-A08, HAB-A10, HAB-A11, HAB-A18.

No. Those constraints apply when opting into the fixed execution trial, preserving useful execution safety boundaries. Native transport retains recipient execution/approval and does not add a HAB product runner.

Sources: [docs/local-relay-host.md:65](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/local-relay-host.md#L65-L102), [docs/local-relay-service.md:141](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/local-relay-service.md#L141-L155), [docs/hab-security.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/hab-security.md#L5-L5).

## HAB-C-D01 — resolved

Do early incremental pending statements mean attachment outbox/receiver/writer are unimplemented?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16, HAB-D17.

No: cumulative README explicitly appends the optional features later, and focused attachment-outbox/receiver/writer docs describe their adopted opt-in implementations. Keep old stage claims as historical evidence; do not make lack of these optional APIs a current invariant. Real product wiring remains unverified. Later the attachment outbox and receiver were deleted with managed attachments; only WriterAdmission remains as an adopted opt-in. The cumulative src/relay/README.md was itself deleted when the durable sender and receiver moved to src/agent-sdk; its successor README describes only the current agent SDK and has no stage claims, so the question is moot.

Sources: [src/agent-sdk/README.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/776dc8414a9c2bb2c7ec175f3f1cd23931877162/src/agent-sdk/README.md#L3-L3), [docs/writer-admission.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/776dc8414a9c2bb2c7ec175f3f1cd23931877162/docs/writer-admission.md#L5-L5).

## HAB-C-D02 — resolved

Does fair polling or writer admission promise global recipient execution fairness?

Classification: scope. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16, HAB-D17.

No. fair_poll guarantees bounded candidate rotation for a stable eligible set; WriterAdmission is shared single-process volatile rate/queue. The attachment receiver's single checkpoint slot was deleted with attachments. Bytes/time/processing/SLO/fleet fairness remain excluded.

Sources: [docs/relay-fair-poll.md:15](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-fair-poll.md#L15-L17), [docs/writer-admission.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/writer-admission.md#L23-L27).

## HAB-C-D03 — resolved

Does optional SQLite snapshot fulfill JetStream whole-deployment restore gate?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16, HAB-D17.

No, and the question is now moot: SQLiteSnapshotBundle was deleted. It never captured Registry/authority/Task/config/keys or broker data. JetStream operations require broker stream/consumer, admission journal, authority/config and recipient state quiesced and reconciled. P5/P6 remaining proof statements are package-scope/time-bounded; later P7 evidence must be reviewed separately by coordinator.

Sources: [packages/relay-nats/OPERATIONS.md:31](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/packages/relay-nats/OPERATIONS.md#L31-L37), [packages/relay-nats/README.md:60](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/packages/relay-nats/README.md#L60-L60).

## HAB-C-D04 — open

Which actual host policies, identity bindings, backup/IO quiescence and fault model are approved for production?

Classification: unresolved. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16, HAB-D17.

Open: actual production host/policy/fault assumptions require an explicit concrete decision; local verification cannot invent them.

Sources: [docs/hab-relay-integration.md:69](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/hab-relay-integration.md#L69-L71), [packages/relay-nats/OPERATIONS.md:17](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/packages/relay-nats/OPERATIONS.md#L17-L19).

## HAB-C-D05 — resolved

Are NATS issues listed as open on 2026-11-01 current proof of a fixed/unfixed 2.15.2 fault?

Classification: historical. Requirements: HAB-D07, HAB-D13, HAB-D14, HAB-D15, HAB-D16, HAB-D17.

They are dated risk references; this reading records external metadata access but does not revalidate issue status or fixes. No safety conclusion is derived. Platform-specific fault testing stays unverified.

Sources: [packages/relay-nats/DESIGN.md:59](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/packages/relay-nats/DESIGN.md#L59-L63).

## HAB-C-E01 — resolved

Does optional Runs driver mean standard Hermes connection must execute models through HAB?

Classification: resolved-subsystem-scope. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

No. hermes-connection1–5 and generic profile1–3 expressly choose native common MCP for standard messaging. Runs/inventory adapters remain optional explicit integrations; no default dependency can be inferred.

Sources: [docs/hermes-connection.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-connection.md#L1-L5), [docs/profiles/async-text-v1.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/profiles/async-text-v1.md#L1-L3).

## HAB-C-E02 — resolved

Earlier successful fixed pilot conflicts with newer inventory readiness still blocked?

Classification: resolved-historical-scope. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

Distinct request/runtime/import/key contracts. Earlier trial records finite connectivity only; current inventory/no-site and native acceptance gates remain separate. Do not erase earlier evidence or reuse it as current approval.

Sources: [docs/fixed-pilot.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/fixed-pilot.md#L3-L9), [docs/fixed-pilot.md:37](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/fixed-pilot.md#L37-L46), [docs/hermes-import-boundary.md:57](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-import-boundary.md#L57-L67).

## HAB-C-E03 — resolved

MVP table says OAuthResource only exact /mcp and wiring unfinished, while same page later reports selected HTTPS path configuration?

Classification: historical-implementation-status. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

Treat earlier table/diagnostic proposal as its earlier fixed baseline and later explicit fixed-text increment45–53 as source-backed implementation scope. Neither proves actual live OAuth/native compatibility. Avoid absolute current /mcp-only requirement.

Sources: [docs/mvp-acceptance.md:12](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/mvp-acceptance.md#L12-L16), [docs/mvp-acceptance.md:45](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/mvp-acceptance.md#L45-L53), [docs/inventory-end-to-end.md:118](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/inventory-end-to-end.md#L118-L134).

## HAB-C-E04 — resolved

Does working or waiting_approval prove remote model execution or recipient owner approval?

Classification: resolved-state-semantics. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

Current assigned generic application/profile/NATS docs consistently define coordinator claim and unknown reconciliation/cancellation; inspected GenericTextJobs projection agrees. Separate proposed recipient-owner approval is not implemented and must not overwrite this state meaning.

Sources: [docs/implementation/generic-job-application.md:21](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/implementation/generic-job-application.md#L21-L23), [docs/profiles/async-text-v1.md:40](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/profiles/async-text-v1.md#L40-L42), [docs/implementation/generic-text-preview.md:35](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/implementation/generic-text-preview.md#L35-L45).

## HAB-C-E05 — resolved

Does local-MVP1:1 auth establish Bot-exclusive identity in current shared groups?

Classification: resolved-version-scope. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

No. local-MVP99–108 explicitly keeps historical fixture while actual connection uses approved groups, distinct address selection and no same-group Bot exclusivity guarantee.

Sources: [docs/local-mvp.md:105](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/local-mvp.md#L105-L114).

## HAB-C-E06 — resolved

Can EPERM be reclassified as immutable code evidence or switch to another identity automatically?

Classification: proposed-architecture-not-authorized. Requirements: HAB-E01, HAB-E03, HAB-E04, HAB-E12, HAB-E17, HAB-E19.

No. Proposed OS read-only image/dedicated identity needs separately reviewed TS/Python identity, import/native closure and credential handoff contract. Current EPERM remains inconclusive and blocked.

Sources: [docs/inventory-preparation.md:43](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/inventory-preparation.md#L43-L78), [docs/hermes-import-boundary.md:53](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hermes-import-boundary.md#L53-L62).

## HAB-C-V01 — resolved

Early lab records unimplemented A2A/NATS skips, later P7 requires zero skips. Which is current?

Classification: historical-versus-current profile. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

Retain old baseline as historical evidence. Current composite P7 and successor catalogs are authoritative for mandatory groups; no old skip becomes a pass.

Sources: [docs/testing/delivery-lab.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/delivery-lab.md#L1-L9), [docs/testing/publication.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/publication.md#L28-L28).

## HAB-C-V02 — resolved

Older reports say workflow inactive/publication held, current publication guide says active CI.

Classification: historical publication and hosted-CI scope. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

The older statements describe fixed local runs. The active workflow and actual current Actions result establish current CI, not the inert example or historical report.

Sources: [docs/testing/p7-independent-results.md:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/testing/p7-independent-results.md#L1-L5), [docs/testing/publication.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/testing/publication.md#L3-L3).

## HAB-C-V03 — resolved

F05 documentation describes actual SIGKILL while restart recipe says no kill-9 verification.

Classification: different fault injection boundary. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

F05 actually spawns/kills an isolated receiver child after save at an injected service-port seam. test:hab-integration only closes/reopens in process; verify-hab marked stop is graceful. These prove different scopes; none proves power-loss/physical failure.

Sources: [docs/testing/delivery-lab.md:58](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/delivery-lab.md#L58-L58), [.claude/skills/verify-hab/features/restart-durability.md:29](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/restart-durability.md#L29-L30).

## HAB-C-V04 — resolved

Does raw relay_poll plus relay_ack establish durable receiving?

Classification: wire-versus-recipient-storage evidence. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

No. Corrected wire recipe explicitly does not save receiver state; only independent pre-network-ACK SQLite/body/request evidence supports durable receiver claims.

Sources: [.claude/skills/verify-hab/features/receive-ack.md:22](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/receive-ack.md#L22-L24), [.claude/skills/verify-hab/features/communication-boundary.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/communication-boundary.md#L7-L9).

## HAB-C-V05 — resolved

P7 guides still name the original 1498 full-root cases and old group set, but the current successor adds the broker-startup group and implementation adds tests. Which numeric counts apply to this exact candidate?

Classification: stale operational count within historical reference guide. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

The unchanged source-pin is explicitly historical; test/p7/README.md specifies the current successor catalogs and the separate broker-startup group. The generic-nats group was removed with its code, and the NATS producer catalog has 60 cases after the unused asynchronous relay operations were deleted. Old 1498/7 prose is stale implementation guidance, not a normative fixed count. Current scripts/p7-lab.mjs enforces its full-root count (1151 at this candidate) and every group in test/p7/manifest.js. Require their exact current report and hosted status; do not edit historical result documents or claim a unique overlapping total.

Sources: [docs/testing/p7-lab.md:10](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/p7-lab.md#L10-L10), [docs/testing/publication.md:18](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/publication.md#L18-L18), [test/p7/README.md:20](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/test/p7/README.md#L20-L20).

## HAB-C-V06 — resolved

Can native A2A acceptance or the shared JetStream D01 stand in for arbitrary six-direction backend behavior?

Classification: generic compatibility-versus-native protocol scope. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

No for native A2A: it has a fixed SDK route with no generic poll/ACK API, and native relationships do not verify generic requirements. The hybrid D01 is gone: both shared backends now run D01 to D08 through JetStream, so D01 covers six directed synthetic round trips on JetStream only. That is still a synthetic three-agent contract, not arbitrary product traffic. Keep both scopes visible.

Sources: [docs/testing/a2a-native-acceptance.md:43](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/a2a-native-acceptance.md#L43-L47), [docs/testing/publication.md:20](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/testing/publication.md#L20-L20).

## HAB-C-V07 — resolved

Do diagram manifests and their rendering implementation create additional product topology requirements?

Classification: documentation-integrity artifact versus product authority. Requirements: HAB-V06, HAB-V07, HAB-V09, HAB-V10, HAB-V11, HAB-V12, HAB-V14.

Manifest hashes verify correspondence of two rendered images to Markdown Mermaid source, not running topology. Derive principles from the authoritative Markdown current/target scope; keep binary image access separate.

Sources: [docs/diagrams/render-mermaid.mjs:1](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/diagrams/render-mermaid.mjs#L1-L1).

## HAB-C-D06 — resolved

The product spec still records JetStream formal adoption and production replacement as undecided and the NATS diagram as a proposal, not a current function. The implementation, package, Relay and README docs now make JetStream the only delivery backend and retire SQLite delivery. Is JetStream-only delivery the adopted product design?

Classification: explicit-authority. Requirements: HAB-F26, HAB-D15, HAB-D16.

Yes. The product owner approved JetStream-only delivery. ADR-016 records the decision, and the product spec now records JetStream as the adopted delivery (section 2 row, the section 8 diagram and note, section 8.2, the section 10 stage, A-12 and section 12), with no SQLite delivery store, no dual-send and no migration of retired messages. HAB-D15 and HAB-D16 are no longer blocked by the adoption question. HAB-F26 keeps only A2A transport adoption as a proposal. Production deployment, real storage failure behavior and whole-deployment restore remain separate gates (HAB-D16, HAB-C-D04).

Sources: [docs/hab-product-spec.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L28-L28), [docs/hab-product-spec.md:136](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L136-L136), [docs/hab-product-spec.md:153](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L153-L155), [docs/hab-decisions.md:37](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L37-L48), [packages/relay-nats/DESIGN.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/packages/relay-nats/DESIGN.md#L3-L3).

## HAB-C-E07 — resolved

docs/implementation/generic-nats-dispatch.md and the async-text-v1 profile still describe the opt-in generic NATS dispatch port (src/generic-nats, packages/relay-nats/src/text-port.ts, scripts/prove-generic-nats.mjs) as present, but that code was deleted. Is the port still part of the design?

Classification: historical. Requirements: HAB-E03, HAB-E11, HAB-E17.

No. The Relay removal deleted src/generic-nats, packages/relay-nats/src/text-port.ts, their tests, scripts/prove-generic-nats.mjs, the proof:generic-nats script and the P7 generic-nats group. The port had no production caller, its transport used the JetStream backend's own authorization callback instead of the Registry, and its production auth and startup were never enabled. The dispatch document now opens with a note that it is a historical record of removed code, and the async-text-v1 profile links it as that record. It stays context. HAB-E03, HAB-E11 and HAB-E17 no longer cite it and keep their TaskBridge, reply-journal and proof-label sources.

Sources: [docs/implementation/generic-nats-dispatch.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/generic-nats-dispatch.md#L3-L3), [docs/implementation/generic-nats-dispatch.md:43](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/implementation/generic-nats-dispatch.md#L43-L43), [docs/profiles/async-text-v1.md:50](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/profiles/async-text-v1.md#L50-L50).
