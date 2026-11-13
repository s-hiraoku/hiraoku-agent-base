# Independent A2A acceptance results

The fixed connectivity route passed independent real-SDK and real-Relay acceptance. Migration remains blocked. These are local macOS results on the SSD, not hosted CI or production adoption.

## Executed identities

The clean combined checkout tested was `b4bc2fcac7e031819a78840d2e4590d30f8f5689`. The A2A component remains exact `f19f1661bf1b2ce717ba6de485f19adb77f074a4`, producer tree `2c8375f10bca77695f2bd011accf9449ffde65ba`. The imported lab baseline is `28fa2e8fd26c8fa957def85cf4e1005c2cc18b4f`. This results document is a later documentation-only commit.

Independent `git show` derivation matched every one of the 168 pinned source, fixture, schema, proof and lock inputs. Dependency declarations and all 20 installed direct package versions matched the fixed lock. Node was 24.12.0 and npm was 11.6.2. The common delivery contract SHA256 remains `d9871b9bbcd7ecf3c92320dda53549e52ceff15c23b94f2042e230f3be1ad338`. Runtime provenance requires no producer Git object or ancestry.

## Actual execution

`node scripts/delivery-lab.mjs --release` includes the full suite. It exited 1 with the expected `BLOCKED` release verdict and no runner error. Every executed group passed. The baseline verdict computed from those same observed groups is `BASELINE_PASS`; that derived value is not a second full run. Source inventories matched before and after, and run scratch was removed.

| Group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Mandatory unchanged producer A2A | 45 | 0 | 0 |
| Mandatory independent native A2A | 10 | 0 | 0 |
| Shared delivery contracts | 8 | 0 | 8 NATS |
| Storage, environment and provenance | 27 | 0 | 0 |
| Selected Relay regressions | 281 | 0 | 0 |
| Full top-level JS inventory | 1481 | 0 | 0 |

There were zero cancellations and TODOs. Counts overlap and must not be summed as unique coverage. The eight former A2A engine skips are eight explicit reclassified ledger records with zero generic passes. Every generic requirement remains unverified as A2A; the successful counterparts have the fixed native or downstream Relay scope described in [the acceptance guide](a2a-native-acceptance.md).

The unchanged finite proof passed at the same clean combined commit. It measured one engine Task, three Relay messages, recipient/origin inbox counts of one/two, one Artifact and zero unresolved intents. Both owned HTTP ports and all fixture stores closed. Its common-contract hash records provenance only; the shared contracts were executed by the lab group above.

Lint, typecheck, diagram-manifest validation, Python Hermes 34 and input 13 tests, and Ruff 0.15.11 checks/format all passed locally. No dependency installation was needed. The local CI workflow remains prepared; a hosted CI run has not been requested.

## Review findings and negative checks

A fresh reviewer traced `src/sqlite.ts` to nine direct `drizzle/*.sql` migrations that the first 159-input guard omitted. A controlled private fixture reproduced acceptance of changed and added SQL under that old guard without executing the SQL. The follow-up pins all nine files from exact f19, checks the actual nonrecursive migration inventory, and rejects changed, added, missing and symlinked SQL. Product code, SQL bodies, producer fixtures, dependencies and lock stayed unchanged. Native changed-payload rejection now explicitly asserts `message_id_conflict`.

The final actual CLI was independently challenged in a disposable clone without node_modules. Changed SQL, added SQL and a missing producer fixture all returned FAIL with zero test groups executed, and the clone was removed. The first verification script assumed every failure would have a pinned-source error prefix. Missing tracked fixtures instead fail earlier during the initial repository snapshot with ENOENT. That overly narrow assertion failed, its evidence was retained, and the corrected verifier confirmed all three refusal paths. No failed product test is hidden by that correction.

After all runs, scoped inspection of Node, workerd, esbuild and nats-server processes found zero using either owned validation checkout. All 72 candidate process working directories were observable; this is a scoped inspection, not a claim that no other processes existed. Six owned temporary directories, including compilation caches, were removed. The original A2A checkouts and original delivery lab retained their recorded heads and clean status.

## Retained evidence and blockers

The final lab report is `.lab/run-xXhDQA/report.json` with sibling TAP and source inventories. Additional proof, comparison, CLI-negative and cleanup reports are retained in the sibling SSD directory `hab-a2a-independent-evidence`. `final-release-summary.json`, `final-independent-content-check.json`, `final-fixed-proof/report.json`, `final-cli-preflight-negatives.json` and `final-process-inspection.json` identify their exact observations. Initial clean-f19 proof and 45-case TAP, the earlier combined full run, review reports and corrected-check attempts remain separate evidence. The evidence export excludes private DBs, caches, credentials and executables.

NATS is not integrated in this phase and still has eight skips. Generic A2A six-direction/body/parts and raw foreign mailbox/ACK semantics, immutable-ID rename coverage, and workload recovery/performance budgets remain release blockers. Linux hosting, OS/power failures, production identities, product wake and GUI behavior were not exercised. Future product or NATS additions need a separately reviewed candidate source manifest and new verification; do not refresh expected hashes from mutable files.

Public push, PR, merge and production changes remain held by the parent scope. The local patch is reviewable without those actions. pstack Model the Domain separated protocol and delivery engine ownership. Prove It Works required real SDK ingress, independent storage observations and the clean combined run. One writer at a time owned the harness, with separate design, review and root validation artifacts.
