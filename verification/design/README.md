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

The existing [verify-hab feature map](../../.claude/skills/verify-hab/features/README.md) remains the one public feature map. It covers communication boundaries, resolve, send, receive/ACK, access, graceful restart, enrollment terminal and configured Relay/operator CLI. The new real helper exercises one bounded subset; other entries keep their existing recipes and are not automatically claimed as manually driven.

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
- The real roundtrip helper polled once right after submit. With JetStream the message is published on the next pump cycle, so the helper failed in 2 of 5 runs with an empty poll. It now repeats the poll every 25 ms for at most 5 seconds until the single delivery is saved. The pre-ACK observer, the one-observation assertion and the final empty poll are unchanged; 12 of 12 later runs passed, one of them after an empty first poll.

New and re-rendered source links pin to the reviewed commit above.
