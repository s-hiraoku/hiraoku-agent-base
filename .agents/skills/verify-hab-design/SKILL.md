---
name: verify-hab-design
description: Verify HAB source-cited design principles with native TS/JS checks, actual owned MCP/SQLite evidence and explicit unverified native/operational scope.
---

# Verify HAB design

Read [the HAB bundle](../../../verification/design/README.md), [contract](../../../verification/design/contract.json), [review/conflicts](../../../verification/design/conflicts.md) and the existing [eight-feature map](../../../.claude/skills/verify-hab/features/README.md). Reuse that map; do not create competing feature definitions. The generic external workflows are `verify-design` and `maintain-design-verification` from a reviewed hirastack checkout.

## Launch

Identify HAB through Git origin, read repository instructions and the pinned `.node-version`/package manager. Install the committed locks with `npm ci` and `npm ci --prefix packages/relay-nats --ignore-scripts` in an isolated worktree. Locate an external reviewed hirastack checkout; its pinned generation version is in the bundle. Do not copy a HAB contract into hirastack or vendor the generic engine here.

Start from no previous run state. Choose a NEW absolute evidence directory outside HAB. Review every contract argv and side effect before `--execute`. The real helper starts only its own scaffold on OS-selected loopback port0 and uses new synthetic state. Never probe/stop/drive an unowned service, use live credentials or change real agent/config/grant settings merely to satisfy verification.

## Doctor

From HAB, run `PYTHONPATH="$HIRASTACK_ROOT" python3 -B -m hirastack audit --target "$PWD" --spec verification/design/contract.json`. Require no source/citation/new-document drift. On drift reread/reclassify affected meaning and citations through maintain; do not mechanically rehash. Check required Node/Python/dependencies. The real helper verifies its actual child PID against both state and pidfile, exact loopback URL, unauthenticated401 and an authenticated resolve before mutation.

## Drive

Run `PYTHONPATH="$HIRASTACK_ROOT" python3 -B -m hirastack run --target "$PWD" --spec verification/design/contract.json --out "$NEW_RUN" --execute` sequentially. Python only coordinates; checks exercise native TypeScript compilation, JavaScript behavior and real protocol/storage, plus existing Python-specific optional helpers. Manual checks stay unverified. Exit2 may mean incomplete: inspect drift and every command, never equate it to success.

For an individual bounded real feature subset, run `node verification/design/checks/mcp-durable-roundtrip.mjs "$PWD" "$NEW_ROUNDTRIP"`. It drives resolve→submit/replay→poll→durable save→ACK→status and clean recipient reopen. Link evidence to resolve-address, send-message and receive-ack subfeatures without claiming all subfeatures or other public entries. Run the existing communication-boundary recipe for receive-only scheduling and explicit inbox_read, and existing F05 for actual isolated child crash. Other feature recipes stay at the inherited map. Real agent/native/OAuth/UI/production recipes require their own concrete prerequisites and authorization; synthetic success cannot satisfy them.

## Evidence

Inspect `report.json`/`report.md`, each command log and assertion totals. Require nonempty consistent zero-fail/skip/cancel/TODO evidence; absent/blocked/manual results are not passes. Compare target/spec/runner/helper hashes before and after. For the real path inspect `mcp-roundtrip/{trace.jsonl,stack.log,proof.json,cleanup.json}` plus synthetic scaffold audit. The exact pre-network ACK trace must be independently observed read-only committed full body and original request journal, followed by confirmed receipt and sender acked state. A script exit or HTTP200 alone is insufficient.

Report exact product/transport/store/substitutions, individual requirement status, unresolved conflicts and manual scope. Never report fixture success as native model/approval, real timing/residency, crash/power/media or universal language proof. Check actual current-head GitHub CI/P7 separately. Review all publication candidates and evidence for live secrets/private content before sharing.

## Cleanup

The helper closes its recipient store and sends SIGTERM only to its spawned child, waits boundedly, and requires exit0 plus HAB_VERIFY_STOPPED. Emergency owned SIGKILL is cleanup failure, not crash proof. Disposable state is removed only after observed child exit and store close; uncertainty retains synthetic state and makes proof fail. Confirm cleanup.json and retained proof/trace/log files exist after removal. After interruption or failed attempts inspect ownership/cleanup before retrying; use a new evidence directory and retain failed logs. The generic runner also bounds owned process groups; missing cleanup evidence remains incomplete.

## Helpers

`communication-boundary.mjs TARGET [--self-test]` checks reviewed AST dependency closures and negative/harmless controls. `mcp-durable-roundtrip.mjs --self-test` controls the independent commit observer; `mcp-durable-roundtrip.mjs TARGET NEW_EVIDENCE_DIR` performs the actual bounded protocol path. Both are HAB-owned under verification/design/checks; see helpers.md for argv, prerequisites, effects and limits. Existing verify-hab scripts remain owned by the existing skill; no path calls into hirastack HAB examples.

After a run, invoke `node verification/design/checks/assert-automated.mjs "$NEW_RUN/report.json" verification/design/contract.json`. This validates complete automatic evidence and preserves manual-unverified status; it does not declare full compliance. Its `--self-test` mode exercises report-gate negative controls only.
