# HAB design verification

HAB owns this contract, its source review, project skill and JavaScript checks. The generic hirastack coordinator is external; no HAB contract or runtime path is installed into hirastack. This bundle was created by actually running hirastack `init` and `inventory` against this HAB checkout, then reading/classifying the source and authoring requirement/check mappings. It is not the former example contract copied unchanged.

Source extraction baseline: [`c67711e2bb79670402e3b2cac10452344db7df00`](https://github.com/s-hiraoku/hiraoku-agent-base/tree/c67711e2bb79670402e3b2cac10452344db7df00). Generic tool baseline: [`0ead9d3899e813916e0180cb4ffbff6c08d45ad6`](https://github.com/s-hiraoku/hirastack/tree/0ead9d3899e813916e0180cb4ffbff6c08d45ad6). These are extraction/tool provenance, not a claim that newer code is verified. The runner records the actual current target tree, contract, runner and helper hashes before/after each run.

- [Design principles](design-principles.md): source-derived statements, reasons, scopes and exact citations.
- [Document review](document-review.md): one semantic review per discovered document; inventory alone is insufficient.
- [Review notes](review-notes.md): supplemental code/schema/config trace, discovery limits and evidence scope.
- [Conflicts](conflicts.md): history, version, subsystem and authority reconciliation; unresolved operational choices remain open.
- [External references](external-references.json): revision/access outcome; pending remote material is not verified.
- [Contract](contract.json): machine audit and requirement-to-check mapping.
- [Helpers](helpers.md): finite argv, side effects and proof limits.
- [Codex skill](../../.agents/skills/verify-hab-design/SKILL.md): Launch, Doctor, Drive, Evidence, Cleanup, Helpers.

The existing [verify-hab feature map](../../.claude/skills/verify-hab/features/README.md) remains the one public feature map. It covers communication boundaries, resolve, send, receive/ACK, access, graceful restart, enrollment terminal, configured Relay/operator CLI and the configured Relay's A2A entry. The new real helper exercises one bounded subset; other entries keep their existing recipes and are not automatically claimed as manually driven.

## Run

Use the pinned Node/npm in this checkout, `npm ci`, `npm ci --prefix packages/relay-nats --ignore-scripts`, and the pinned broker (`mkdir -m 700 -p .runtime && node packages/relay-nats/scripts/install-server.mjs > .runtime/nats-install.json`). JetStream is the only delivery backend, so delivery tests and the real helper start a private `nats-server` and fail when it is missing. Point `HIRASTACK_ROOT` at a separately reviewed hirastack checkout. Run these commands from HAB:

```sh
PYTHONPATH="$HIRASTACK_ROOT" python3 -B -m hirastack audit --target "$PWD" --spec verification/design/contract.json
PYTHONPATH="$HIRASTACK_ROOT" python3 -B -m hirastack run --target "$PWD" --spec verification/design/contract.json --out /tmp/NEW-UNUSED-HAB-DESIGN-RUN --execute
```

Review argv first: `--execute` runs trusted project code; it grants no access or permission to live systems. The output path must be new and outside HAB. Commands run sequentially with isolated canonical TMPDIR; no shared-app parallel driving. Python launches checks and validates evidence; actual HAB checks use TypeScript compilation, native JavaScript tests, real MCP/HTTP and SQLite, and the existing optional Python boundaries. This proves no universal language support.

`audit` failing means reread/reclassify changed documents/citations before executing. An all-green automatic subset is **not complete compliance**: native recipient judgment/approval/UI, actual OAuth/refresh, production choices, publication review and current hosted P7 are manual checks. Their status stays unverified; open conflicts block only their named requirements. Exit2/`overall=incomplete` is expected while those remain; inspect every command result and drift rather than accepting exit2 blindly.

Maintain with external `maintain-design-verification`; execute with `verify-design`. Preserve requirement IDs, historical evidence and explicit exclusions. Source or check changes require renewed semantic review, fresh hashes and a fresh evidence directory. Never regenerate pins or decide design authority just to make a check green.

## CI scope

The HAB Design verification workflow checks out only the generic hirastack package at the fixed tool commit, invokes the reviewed contract, then runs `assert-automated.mjs REPORT.json CONTRACT.json`. Exit2 alone never passes CI: all active automated checks must be present exactly once with successful nonempty evidence, confirmed cleanup and matching hashes; actual roundtrip proof/trace/cleanup files must exist and agree. Manual checks must still be unverified. The job explicitly reports automatic scope only, while the existing CI checks required real-broker P7 separately. The gate's self-test rejects missing evidence, zero/skipped tests, forged manual success and failed cleanup; it is not product behavior proof.

The complete native JS check explicitly sets `NODE_OPTIONS=--disable-warning=ExperimentalWarning`, matching existing P7 labEnvironment. CLI fixtures assert exact stderr. The first unsuppressed run failed nine such assertions and is retained separately; no product assertion or skip gate is weakened. This suppresses the entire ExperimentalWarning category and is recorded in the command evidence.

The root JavaScript check passes `test/*.test.js` as a literal argv to the pinned Node runner, whose native glob discovery includes newly added top-level tests. The generic coordinator performs no shell expansion. Two-file/three-file controls confirmed this Node24.12.0 behavior; nested real-broker suites remain separately mapped.

## Maintenance after JetStream-only delivery

Draft PR #137 (reviewed at `d307da1ea3fa049fa79b66748f5ed4f16f19dfc0`) moved the runtime to Node 26, deleted managed attachments, the snapshot bundle and the receive checkpoint, moved the backend-neutral contract to `src/messaging`, and made NATS JetStream the only delivery backend. The audit drift was handled by rereading, not rehashing:

- Retired as `historical` with their original statement kept: HAB-D08, HAB-D09, HAB-D10, HAB-D11 (attachments) and HAB-D14 (snapshot bundle). Their citations now point at the removal records.
- Reclassified for JetStream-only delivery: HAB-D04, HAB-D07, HAB-D12, HAB-D13, HAB-D15, HAB-D16, HAB-D17, HAB-V13, plus attachment wording dropped from HAB-A03 and HAB-A05 scopes.
- Added: HAB-D18 (attachment parts refused on every path) and HAB-D19 (atomic redacted journal delivery audit).
- Opened HAB-C-D06: the product spec still calls JetStream adoption undecided while the implementation docs make it the only backend. HAB-D15/D16 stay blocked and HAB-F26 stays a proposal until the product owner decides.
- Other citations whose text only moved were re-cited at the new lines after checking the excerpt bytes are unchanged. Ten deleted documents keep a disposition row in [document review](document-review.md).

New and re-rendered source links pin to the reviewed commit above instead of the extraction baseline.

## Maintenance after host consolidation and the Registry fixes

Phase 4 (reviewed at `1f5b492664707fe60c007442bda6f24d1756ee3d`) moved the configured host into `src/host` (`config`, `start`, `server`, `local-auth`, `oauth-auth`, `admin`, `delivery`, `hab-delivery-service`), the MCP server, HTTP gateway, Node handler, OAuth resource and writer admission into `src/host/mcp`, and sender capacity policy into `src/hab/agent-capacity.ts`. It also fixed five Registry and admin defects. The audit drift was handled by rereading, not rehashing:

- Added: HAB-A19 (a group stop or last binding revocation stops every member and clears its operations; reactivation re-grants no address) and HAB-A20 (an atomic group connect, refusal of an empty `--operations`, and group mode taken from `registry.authentication_groups`).
- Sharpened HAB-A12: an out-of-range limit, including a `registry` limit, is refused at start as `config_invalid` naming its field. It now also cites docs/local-relay-service.md:73.
- Re-cited after only a path or symbol rename (`startLocalRelay` to `startHostServer`): HAB-A12 (docs/local-relay-host.md:3) and HAB-A14 (docs/mcp-agent-discovery.md:136). Re-cited HAB-A02 and HAB-C-A01 at the longer src/hab/README.md group section, whose added text matches both statements.
- Re-cited at new lines after checking the excerpt bytes are unchanged: HAB-A01, HAB-A07 and HAB-C-A06 (docs/local-relay-service.md).
- In source-review.json the three moved supplemental sources keep their entries under the new paths (`src/host/mcp/server.ts`, `src/host/hab-delivery-service.ts`, `src/host/delivery.ts`), since their diffs only rewrite imports. The Registry fix sources (`src/hab/sqlite-registry.ts`, `src/host/admin.ts`, `src/host/config.ts`) joined the authority scope.
- The communication-boundary check and helpers.md were already updated by the move to cover `src/host/mcp` and `src/hab/agent-capacity.ts`. Its self-test fixtures still placed the outer MCP, OAuth and HTTP modules at their old `src/relay` names, so a core policy that wrongly admitted `src/host/mcp/oauth-resource.ts` still passed. The fixtures now use the `src/host/mcp` paths and that mutation fails the self-test. No check argv names a moved file.
- The real roundtrip helper polled once right after submit. With JetStream the message is published on the next pump cycle, so the helper failed in 2 of 5 runs with an empty poll. It now repeats the poll every 25 ms for at most 5 seconds until the single delivery is saved. The pre-ACK observer, the one-observation assertion and the final empty poll are unchanged; 12 of 12 later runs passed, one of them after an empty first poll. The report gate (`assert-automated.mjs`) still required exactly one poll before the ACK, so a run that needed the retry failed CI with "missing/extra/reordered MCP operations". The gate now accepts 1 to 201 polls before the ACK, requires every retried poll to have returned `delivery: null`, and its self-test covers both a retried run and a retried poll that returned a delivery.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the agent SDK move and the generic-nats removal

Phase 5 (reviewed at `776dc8414a9c2bb2c7ec175f3f1cd23931877162`) moved the durable sender, receiver, SQLite outbox and inbox, the MCP client and their public entry point from `src/relay` to `src/agent-sdk`, replacing `src/relay/README.md` with a short `src/agent-sdk/README.md`. It deleted the generic-nats text port (`src/generic-nats`, `packages/relay-nats/src/text-port.ts`, its tests, `scripts/prove-generic-nats.mjs`, the `proof:generic-nats` script and the P7 `generic-nats` group) because it had no production caller and its transport bypassed Registry authorization. The audit drift was handled by rereading, not rehashing:

- Re-cited after rereading the successor text: HAB-D01 to HAB-D07 now cite `src/agent-sdk/README.md`, the normative `docs/hab-relay-spec.md` sections (3.1 boundary, 5 envelope, 6 identity, 7 save points, 8 lease and ACK order, 9 resend, 13 retention, 15 MCP factory), `packages/relay-nats/DESIGN.md`, `docs/security-audit-limits.md:5` and the existing integration and writer-admission rows. The statements are unchanged. HAB-D04 and HAB-D07 scopes no longer point at the deleted historical SQLite step.
- The retired HAB-D08 to HAB-D11 and HAB-D14, and HAB-D18, dropped their deleted `src/relay/README.md` citation and keep their other removal records. HAB-C-D01 is moot, since the cumulative README it asked about no longer exists.
- No requirement was only about generic-nats, so none was retired. HAB-E03, HAB-E11 and HAB-E17 dropped their `docs/implementation/generic-nats-dispatch.md` citations and keep their TaskBridge, reply-journal and proof-label sources. HAB-E11's scope no longer names the generic NATS client and recipient. HAB-V06 and HAB-C-V05 no longer name the generic-nats group, and HAB-C-V05 records the current full-root count (1150).
- Opened and resolved HAB-C-E07: the dispatch document and the async-text-v1 profile still present the deleted port as present. The document is unchanged and is now `context`; updating it is product-documentation work.
- In source-review.json the five moved sources keep their entries at the `src/agent-sdk` paths after checking the bytes are identical, `src/generic-nats/recipient.ts` is retired, and `package.json`, `src/adapter-host/cycle.ts` and `test/p7/README.md` were rehashed after reading their diffs.
- The real roundtrip helper loaded `SQLiteInbox` and `DurableReceiver` from `src/relay`, which no longer exists. It now loads them from `src/agent-sdk`; nothing else in the helper changed. helpers.md names the current enumerated directories and module paths.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after Phase 6 (ADR-016 and the async-operation removal)

Phase 6 (reviewed at `135d9ca3a6fb93b9c2ce435f5674ede56bb0a338`) recorded the single-host, JetStream-only architecture as ADR-016 in `docs/hab-decisions.md`, rewrote the product and Relay specs to match, marked `docs/implementation/generic-nats-dispatch.md` historical, deleted the uncalled asynchronous `AsyncRelayOperations` surface (async submit/status/poll/ack, the P4 consumer and `reconnectBroker`) from `packages/relay-nats/src/backend.ts`, and made `demo:hab-mvp` print a fixed `nats_server_required` reason with the install hint. The audit drift was handled by rereading, not rehashing:

- Resolved HAB-C-D06 as `explicit-authority`: the product owner approved JetStream-only delivery, ADR-016 records it and the product spec now calls JetStream adopted. HAB-D15 and HAB-D16 are no longer blocked by the adoption question; their statements are unchanged and they keep the separate production and physical-fault gates.
- Rewrote HAB-F26's statement and scope: JetStream delivery is adopted with no dual-send and no migration of retired messages; A2A transport adoption stays `proposed`. Its decision is unchanged.
- Updated resolutions: HAB-C-F01 and HAB-C-F04 cite ADR-016; HAB-C-E07 cites the new historical banner of the dispatch document; HAB-C-V05 records the current counts (60 NATS producer cases, 1151 full-root tests); HAB-C-V06 no longer describes a hybrid store and its question was reworded to match.
- Re-cited at new lines after checking the excerpt bytes are unchanged: the HAB-F, HAB-D, HAB-E17 and HAB-V citations into `docs/hab-product-spec.md`, `docs/hab-relay-spec.md`, `docs/hab-decisions.md`, `README.md` and `packages/relay-nats/DESIGN.md`, plus the other conflict citations listed by the contract diff. No requirement was retired or added, and no check was weakened.
- In source-review.json `packages/relay-nats/src/backend.ts` was re-reviewed with a new summary (synchronous admission, poll and ACK plus `pumpOnce` only); the other changed sources were rehashed after reading their diffs. The deleted asynchronous operations had no production caller: `src/host` and `scripts/lib/local-mvp.mjs` use only the `*WithAuthorization` methods and `pumpOnce`.
- Document review rows for the rewritten documents were re-read and updated.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the restored delivery guarantees

The restored delivery guarantees (reviewed at `49afd74750dad01e6e9ca51b97fadb9d7afd5f2a`) fixed JetStream journal maintenance in `packages/relay-nats/src/journal.ts`, added eight behavior tests to `packages/relay-nats/test/delivery-semantics.test.js`, and raised the NATS producer catalog from 60 to 68 cases. Before the fix, `collect()` selected `LIMIT n` purge-due rows and only then skipped safety-held IDs, so `n` held rows could starve every purgeable record. It now filters held IDs in SQL through a `nats_gc_safe` function, orders the batch by `retain_until`, and counts held rows separately. The ping fixture fix in `test/ping-suite.js` touches no cited source. The audit drift was handled by rereading, not rehashing:

- HAB-D07 states the property the fix restores: safety-held records never take a maintenance batch slot, so a held backlog cannot starve collection of due replay-bound records. The requirement is stronger, not weaker. It now also maps to current-hosted-p7, because the new non-starvation, batch-limit and ACK-horizon tests run in the P7 NATS group and in no automated design check, as with HAB-D19.
- HAB-C-V05 records 68 NATS producer cases (60 plus the eight restored delivery-guarantee cases) and the unchanged full-root count of 1151.
- HAB-V07, HAB-V14 and the three HAB-C-V05 citations keep their ranges. Only the catalog count inside the excerpt changed, and each statement still holds against the reread text.
- In source-review.json `packages/relay-nats/src/journal.ts` was re-reviewed with a new `collect()` summary. The three count-only document diffs were rehashed after reading them. The document review rows for `docs/testing/p7-lab.md` and `test/p7/README.md` now name the 68-case catalog.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the A2A host wiring

The A2A host wiring (reviewed at `e772a7c6959a3bf9ef367870278f1aa363470a7e`) wires the HAB A2A gateway into the host, as the owner decided on 2026-11-06 (ADR-016, decision item 5). A2A stays off unless the host config has an `a2a` section. When enabled, the host provisions its own Registry identity idempotently, attests it in-process as `urn:hab:host` and drops impostor principals with that issuer. It checks each caller through the Registry with the caller's own credential and scopes Tasks per caller. It sends a saved intent only inside its owner's SendMessage, with no background submit retry, and runs a save-then-ACK receiver loop. Host-routed Tasks are reply-attested. The new code is `src/host/a2a.ts`, covered by `test/a2a-host.test.js`, and verify-hab gained the `a2a-host` feature. The audit drift was handled by rereading, not rehashing:

- Opened and resolved HAB-C-E08 as `explicit-authority`. The bundle said the gateway was not wired and that A2A `COMPLETED` needs independently verified closed engine evidence. Host-routed `COMPLETED` means only that the configured recipient replied with an `execution_result`, and the Task metadata says `attestation: "recipient_reply"`. The evidence rule is not weakened. HAB-E02 and HAB-V12 keep their statements, and their scopes now name the preview composition with `HabExecutionEvidence` that they govern.
- Added three accepted requirements, all mapped to js-root, where `test/a2a-host.test.js` runs. HAB-A21 covers the host identity, per-caller authorization and Task scoping that keep the host identity from acting as a confused deputy. HAB-D20 covers durability, owner-only send with no background retry, and the save-then-ACK receiver. HAB-E20 covers the reply-attested states and their label. HAB-E20 also maps to native-recipient, because no actual product recipient's reply is exercised.
- HAB-F26 stays `proposed`. The entry is opt-in, and the product spec still lists formal A2A adoption as undecided. Its ADR-016 citation keeps its range, as do HAB-C-F01 and HAB-C-D06. Only line 45 inside that excerpt changed, and each statement still holds against the reread text.
- HAB-A07 was re-cited at `docs/local-relay-service.md:200-212` after checking that the excerpt bytes are unchanged. The new A2A section moved it down.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change. HAB-C-V05 records the full-root count of 1159.
- The contract now lists `.claude/skills/verify-hab/features/a2a-host.md` as a normative document. The rows for the A2A preview, ADR, local Relay service, README, verify-hab skill and feature map, and P7 guide were rewritten from their new summaries.
- In source-review.json the changed sources were re-read and rehashed. `src/host/config.ts` and `src/agent-sdk/sender.ts` have new summaries. The ledger adds `src/host/a2a.ts` and `src/host/server.ts` under authority, `src/a2a/hab-contract.ts` and `src/a2a/hab-adapter.ts` under execution, and `test/a2a-host.test.js` under verification.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the review fixes

The review fixes (reviewed at `74c02b7e8e4b59d3c41eefe9c8949ddd554bd472`) count only unreleased bodies against the agent SDK inbox's record and byte quotas, make the A2A host ACK every delivery that is not a reply to a host message without an inbox or ACK record, require `group_bind` and `group_member` in `createBoundGroup`, let a nested `withRelay` join the enclosing transaction so the host submit runs inside the caller's check, and rewrite the rollback procedure. `test/a2a-host.test.js`, `test/hab-auth-groups.test.js` and `test/relay-inbox-maintenance.test.js` cover the fixes. The audit drift was handled by rereading, not rehashing:

- Opened and resolved HAB-C-D07. OPERATIONS.md and the product spec said a rollback restarts the earlier build on the same journal, while DESIGN.md makes the v4 journal migration one-way and earlier builds refuse schema 4. The procedure is now a whole pre-upgrade backup restore with original-ID reconciliation, and same-journal rollback is allowed only to builds that open schema 4. No requirement statement claimed the same-journal rollback. The OPERATIONS.md document summary did, and it is corrected.
- Sharpened, not weakened: HAB-F24 states the schema bound, the whole-generation restore and the reconciliation, and cites the roll-back section. HAB-A20 requires every right of the three separate operations in the one transaction. HAB-A21 states that the host submit shares the transaction that rechecks the caller, so a revocation lands before the check or after admission. HAB-D20 states that only replies to host messages are saved before ACK and other deliveries are ACKed without records, plus the `max_records` and three-times ACK history caps. HAB-D06 states that the inbox quotas count unreleased bodies and that a separate ACK-record bound limits dedup history.
- Re-cited after rereading the changed text: HAB-A05, HAB-A12, HAB-D07, HAB-D15, HAB-E20, HAB-F26, HAB-C-F01 and HAB-C-D06. Their statements still hold. Fourteen citations whose excerpt bytes only moved were relocated mechanically.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change. HAB-C-V05 records the full-root count of 1163.
- In source-review.json the changed sources were re-read and rehashed. `src/hab/sqlite-registry.ts`, `src/host/a2a.ts` and `src/agent-sdk/sqlite-inbox.ts` have new summaries. `test/hab-auth-groups.test.js` and `test/relay-inbox-maintenance.test.js` were added under verification.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the second review fixes

The second review fixes (reviewed at `2b764dda6a71984bb333cb8ecef2aa8e95b9c025`) give the host A2A inbox `2 × max_records` reply bodies, apply each saved reply to its Task in the receive loop and release the body once the Task is saved, save a reply only until one day after its request's expiry, and keep each host outbox record past the ACK history of its replies. The agent SDK inbox caps all rows at `max_records + max_ack_records` and legacy-ID rows at `max_ack_records`. The rollback procedure reconciles IDs still incomplete in the backup, treats `expired` and `quarantined` as outcome unknown, holds the earlier build until every restored ID has expired, and settles each ID with the new read-only `scripts/relay-rollback-reconcile.mjs`. `test/a2a-host.test.js`, `test/relay-inbox-maintenance.test.js` and the new `test/relay-rollback-reconcile.test.js` cover the fixes. The audit drift was handled by rereading, not rehashing:

- Strengthened, not weakened: HAB-D06 states the total-row and legacy-ID bounds and `inbox_legacy_id_capacity_exceeded`. HAB-D20 states the two reply slots per outbox record, the apply-on-receipt release (an unread or terminal Task holds no slot), the reply window and the outbox horizon that makes the outbox cap the binding limit, and its scope names the recipient's remaining ability to fill the ACK history. HAB-E20 states that a result past the reply window is ACKed without a record and leaves the Task WORKING; its scope says the test ACKs late replies but does not read that Task's state. HAB-F24 states the incomplete-at-backup IDs, the outcome-unknown journal states, the copies taken before the restore, the reconciliation script and its three actions, and the hold until restored IDs expire, and now also cites docs/local-relay-service.md:22-28 and ADR-016. HAB-C-D07's resolution records the extended procedure.
- Re-cited after rereading the changed text: HAB-F24, HAB-F26, HAB-A12, HAB-D06, HAB-D07, HAB-D20, HAB-C-F01, HAB-C-D06 and HAB-C-D07. Their statements still hold. Eight citations whose excerpt bytes only moved were relocated mechanically.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change. HAB-C-V05 records the full-root count of 1168.
- In source-review.json the changed sources were re-read and rehashed. `src/host/a2a.ts`, `src/agent-sdk/sqlite-inbox.ts`, `src/a2a/hab-adapter.ts` and `src/a2a/hab-contract.ts` have new summaries. `scripts/relay-rollback-reconcile.mjs` was added under delivery, `src/a2a/store.ts` and `src/a2a/hab-http.ts` under execution, and `test/relay-rollback-reconcile.test.js` under verification; all three tests run in js-root.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after the third review fixes

The third review fixes (reviewed at `4715b4ef2690b2d9ed4863d4fa023eeb4d06c553`) fail a host A2A Task whose reply window closes without a result, by the owner's 2026-11-07 decision: it moves to `TASK_STATE_FAILED` with reason `result_window_expired` and an outcome-unknown status, host maintenance makes the transition through the Task store's `overdue()`, and a late reply never revives it. The host releases saved replies that no ACK can confirm with the new `SQLiteInbox.releaseUnconfirmable`, and a blocking SendMessage no longer holds the Task serializer across its wait. The agent SDK inbox counts its ACK history per message and keeps at most `max_attempts` generations per message. The rollback listing takes the union of both journals' IDs, adds `--backup-inbox`, `--execution-record` and `restored_bodies`, and a new OPERATIONS.md step 6 settles restored inbox bodies; the documents no longer claim the expiry hold prevents re-execution. The audit drift was reread, not rehashed:

- Strengthened, not weakened: HAB-D06 states the per-message ACK history, the `max_attempts` generation cap and `releaseUnconfirmable`. HAB-D20 states the release of unconfirmable replies, the once-a-minute window maintenance, the per-message ACK history and the per-step blocking wait. HAB-F24 states the union of journal IDs, the restored inbox bodies, the execution-record export, the new step 6 and that the hold stops only redelivery through the relay. HAB-C-D07's resolution records the extended procedure.
- Changed by owner decision: HAB-E20 no longer says a late result leaves the Task WORKING. It states the `FAILED` / `result_window_expired` transition, its metadata, the outcome-unknown message and that a late reply changes nothing, and its scope names the test that now covers it instead of the earlier "state not read" gap. The new resolved conflict HAB-C-E09 records the superseded statement and the authority for the change.
- Re-cited after rereading the changed text: HAB-F24, HAB-F26, HAB-A12, HAB-A21, HAB-D06, HAB-D07, HAB-D20, HAB-E20, HAB-C-F01, HAB-C-D06, HAB-C-E08 and HAB-C-D07. Twelve citations whose excerpt bytes only moved were relocated mechanically.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change. HAB-C-V05 records the full-root count of 1175.
- In source-review.json the changed sources were re-read and rehashed. `src/host/a2a.ts`, `src/agent-sdk/receiver.ts`, `src/agent-sdk/sqlite-inbox.ts`, `scripts/relay-rollback-reconcile.mjs`, `src/a2a/hab-contract.ts`, `src/a2a/hab-adapter.ts` and `src/a2a/store.ts` have new summaries, and the three tests record their new cases.

New and re-rendered source links pin to the reviewed commit above.

## Maintenance after merging main into PR #137

Merge source `2cc396b59009883fdc2a0a185810b21ed6d5ab80` incorporates main `86e567b0681fdb9742a5a04ca0d2513004f94530` without changing ADR-016 or the JetStream-only delivery boundary. The imported `src/worker-loop.ts` change rejects non-finite and nonnumeric idle budgets before constructing an adapter. The imported `src/events.ts` change rechecks the subscription expiry after asynchronous authorization before issuing a callback. The three cases in `test/design-budget-boundaries.test.js` cover these guards and valid finite wait budgets. The existing `js-root` command discovers that new top-level file.

The full-root P7 catalog is 1178 (the PR's 1175 plus the three main cases). HAB-C-V05 records this current count; earlier counts and their source-document summaries remain historical. The successor manifest was regenerated from the committed merge, including the new regression file, and both added predecessor blobs were independently decompressed and hash-checked. Existing historical fixture bytes and the frozen source pin are preserved. This maintenance changes no requirement scope, execution authority, manual-check status or product design. Current hosted CI and the separate PR review remain separate evidence.

## Maintenance after the remaining review fixes

The remaining review fixes (reviewed at `c62d24da5f4cac0543286a8f54b8e7d89cd730f5`) save a host A2A reply under a new message ID only when a preview of its stored Task, with the inbox's held replies counted as confirmed, shows it would change the Task's state; any other such reply is ACKed without a record, so fresh-ID replies no longer fill the `3 × max_records` ACK history. The result-window transition now runs in the receive cycle after the earliest open window closes, from the Task store's new `nextExpiry()`, instead of waiting for the once-a-minute maintenance. New tests make the running host lose its own ACK at its delivery-service transport, cycle replay-bound IDs through retention in the agent SDK inbox and the relay journal, and drill the rollback through a broker store dir restore, the expiry hold and a recipient restart on the current build. The audit drift was reread, not rehashed:

- Strengthened, not weakened: HAB-D20 states the fresh-ID rule, that a held ID always reaches the inbox for dedup and that an unconfirmed reply is still never applied, and the timely window pass; its scope replaces the remaining fresh-ID limitation with the tests that cover the fix. HAB-E20 states that the transition comes in the first receive cycle after the window closes and names the test. HAB-D06 and HAB-D07 name the replay-bound retention cycle tests. HAB-F24's scope records the store-restore drill and narrows the remaining gap to starting the earlier build. HAB-C-D07's resolution records the drill.
- Re-cited after rereading the changed text: HAB-F24, HAB-F26, HAB-A21, HAB-D20, HAB-E20, HAB-C-F01, HAB-C-D06, HAB-C-E08 and HAB-C-E09; HAB-D20 also cites the new `a2a-fresh-id` bullet and gotcha, and the `a2a-window` bullet moved from line 14 to 15. Five citations whose excerpt bytes only moved were relocated mechanically.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change. HAB-C-V05 records the full-root count of 1183 and the NATS producer catalog of 69.
- In source-review.json the changed sources were re-read and rehashed. `src/host/a2a.ts`, `src/a2a/hab-adapter.ts`, `src/a2a/store.ts` and `src/a2a/hab-http.ts` have extended summaries, and the three root tests record their new cases.

New and re-rendered source links pin to the reviewed commit above.

## Local follow-up: retained rollback bodies and delayed ACK retention

This follow-up is based on `0fc76a6ebe48602524cf22df08888cff8bbff34a` and fixes two rollback omissions and the long-stop A2A capacity gate. Changed source citations use repository-relative links to remain valid on this branch.

- HAB-F24 now includes post-backup IDs retained only in recipient evidence after journal collection and unreleased bodies present only in upgraded inbox copies. Draining and the expiry hold do not transfer those bodies. The operator reviews original-key application-specific local handoff; missing/conflicting evidence and uncertain effects stay stopped, with no generic replay executor or expiry bypass.
- HAB-D06 documents the non-reserving read-only batch-capacity query. HAB-D20 replaces the incorrect claim that the outbox horizon always outlives ACK history with inbox-first maintenance and a whole-next-batch capacity gate before outbox collection. ACKs first made terminal after a long stop retain the full 30 days from their actual local terminal time. New admission waits instead of accepting Tasks whose replies cannot fit. This is prospective protection, not repair of source slots already collected by an earlier build or of lost/quarantined results; affected existing deployments need quiesced admissions and normal retention/capacity recovery. The whole-batch reserve is intentionally conservative.
- Re-read the rollback portions of ADR-016, the product spec, local Relay guide and OPERATIONS, the A2A host guide and agent SDK README. Updated their semantic summaries and the implementation/test source reviews. Re-cited affected excerpts; the platform-evidence passage moved unchanged. No authority, execution, retention or manual gate is weakened.
- Coverage adds four minimal SQLite projection cases, one inbox-capacity case and one host outage/ACK-loss case; the existing real rollback drill additionally recovers an upgraded-only saved body after its TTL. The host case uses a short lease, injected ACK transport failures and modeled timestamp/ID aging, not a real multi-week outage. Test outcome evidence is recorded separately from this source review.

## Task-store close lifecycle follow-up

The follow-up on `f1b6eb1` preserves the existing HAB-D20 shutdown obligation: the eagerly opened Task-store SQLite connection must close even when the lazy SDK database driver was never initialized by a load/save. Direct host maintenance reads do not initialize that driver. Repeated close remains safe and saved state can reopen. The new SDK-store regression covers both unused and initialized paths; it establishes this lifecycle defect, not that it causes every malformed database or repairs existing corruption.

The expected catalogs become A2A producer 49 and full root 1190 because that one new case belongs to both groups. These are expected inventories, not execution-result claims; earlier evidence counts and native/production gates remain historical and unchanged. Changed citations retain repository-relative links. The A2A shutdown paragraph and affected requirements were reread before updating their summaries and hashes.

The long-stop fixture also keeps original send time, expiry and replay-bound ID consistent, uses the host Task-store driver for offline edits, checks SQLite integrity before reopening, verifies the old Task reaches FAILED and retries only the expected admission-capacity refusal. Unexpected errors are surfaced immediately with no timeout increase. These fixture changes preserve, rather than weaken, the capacity and retention assertions.

## Nine-candidate review follow-up

Source review compares `ab66bd7` with the integrated `d6c67f7` changes and expected-catalog updates. Normal shutdown, reply-window failure and permanent identity disconnect remain intended behavior, with additional controls rather than speculative production fixes. The incorrect new-address recovery advice is removed. Partial collection budgets free sender slots, still-open sources and proposed collected rows together, while unexpected per-Task save failures retain their bodies. Deferred fresh replies are not falsely ACKed based on unconfirmed evidence, but finite relay leases and TTL still limit recovery. Overdue work uses bounded stable-key traversal; scoped reply reads retain final authorization and correlation checks. The 150,000-row read-only reconciliation control removes an argument-limit failure, not all memory limits.

The 17 new cases make the expected root inventory 1207; four enter the A2A producer inventory, now 53. Source inspection and inventory maintenance are not test-execution evidence. Synthetic cohort aging does not refresh fingerprints and proves maintenance/capacity behavior, not whole-state recovery. Per-Task injected faults do not prove API-reachable database corruption or repair globally failed databases. Source-index parse counts are bounded synthetic work measurements, not production MCP-starvation evidence. Existing independent-engine, live-recipient and production-operation limits remain unchanged.

A final arithmetic refinement budgets usable slots after collection as max(0, M - T + p), including when an operator lowers the cap M below the retained count T. Its extra assertion belongs to an existing test, so inventories stay 1207/53. The earlier integrated 113-case result predates this refinement; affected-test rerun and final-head checks must supply its execution evidence. A full-root run started before that edit is not an unchanged-final-snapshot claim.

## Maintenance after releasing contract-refused host replies

The follow-up (reviewed at `af7c769c0167230bf11809f326488ff0e1348186`) makes the host receiver release a saved, ACK-confirmed reply whose apply raises `ContractError`, as it already did for a conflict or a malformed body, so a body over the A2A contract limits is no longer retried every cycle and its Task does not change. `classifyReply` already discarded such a reply before save, so this covers only a saved body that reaches apply anyway, which the new test saves offline under the wider delivery limits. One new case in `test/a2a-host.test.js` covers it, so the expected root inventory is now 1208; the A2A producer inventory stays 53. The 1207 counts above describe the nine-candidate snapshot. The audit drift was reread, not rehashed:

- Strengthened, not weakened: HAB-D20 adds a reply over the A2A contract limits to the refusals the receiver releases, and its scope names the new test. HAB-C-V05 records the current expected root of 1208.
- HAB-V07, HAB-V14, HAB-C-V01 and HAB-C-V05 keep their ranges after the count-only change and were re-cited. No citation moved.
- In source-review.json the changed sources were re-read and rehashed. `src/host/a2a.ts` extends its summary with the refusal set, `test/a2a-host.test.js` records the new case, and the count summaries for the three testing documents, `scripts/p7-lab.mjs` and `test/p7/a2a-cases.json` state 1208.

Re-rendered source links are relative, as in the latest sections. This maintenance changes no execution authority, manual-check status or product design.

## RecipientMessages integration onto JetStream-only main

Reviewed explicit recipient-local handoff and exact-reply composition against ADR-015 after integration onto JetStream-only main. Uses src/messaging and src/agent-sdk, with explicitly supplied reply admission. Native input/dedup/policy/approval remain trusted recipient prerequisites. Synthetic native store and real JetStream/loopback MCP tests are not native model/approval/deployment evidence; deferred components remain unconnected to default runtime. The focused check remains separate from the overlapping full-root inventory (expected 1229). Manual evidence remains unverified. Existing requirement IDs, authority sources and historical failure records are unchanged.

## Proposed recipient-host MCP surface after latest-main integration

Reviewed merge `199202a178b35fc377197ace56522ec1d0c17715` onto main `322a940`, then source commit `6085738` and successor pin `8d3104c` for the scoped stdio verification follow-up. The actual external hirastack audit initially reported one new unreviewed document: `docs/implementation/recipient-host-mcp-proposal.md`. The document is now **context**, not normative adoption. Source review compared the wrapper, existing host/answer guards and both synthetic transports with ADR-015/016, common-MCP and adapter-host responsibilities. HAB-C-F08 records why this pull route neither replaces RecipientMessagePort nor expands native authority.

The new `js-recipient-host-mcp` check adds scoped regression evidence to HAB-F01/F02/F03/F06/F07/F08/F11/F16 and HAB-E07 without changing their statements, decisions or foundational citations. In-memory tests cover opt-in schemas, synthetic permission changes, error sanitization and unchanged incomplete results. Real-host tests exercise existing SQLite and private JetStream state; a separate owned child proves official SDK stdio discovery/calls and bounded clean shutdown. Its Relay-side gateway remains in-process. Existing pre-network ACK observation, crash tests and manual native-product checks remain separate and required. These seven tests overlap `js-root`; the expected root inventory is 1236, not a claim that a P7 or hosted run has passed.

No new feature map is created. Existing native-recipient, production, GUI, publication and exact-head hosted gates remain unverified. A clean source audit is not a full live maintenance pass, product adoption, a native binding, an approval or permission to install the test fixture. The focused command is re-driven independently; the parent owns final combined validation. Source commit `6085738` and successor pin `8d3104c` preserve the committed-source P7 inventory procedure; the three current testing guides change only 1229 to 1236, with historical results untouched.
