# A2A native acceptance for the fixed connectivity route

This integration branch always runs the actual A2A SDK and private HAB Relay. The existing command runs both required A2A groups before the delivery-engine groups.

```sh
npm run test:delivery-lab
npm run test:delivery-lab -- --release
```

`--release` includes the full regression suite. It remains blocked by the eight NATS delivery-engine skips, immutable-ID rename coverage, workload budgets, and A2A scope beyond this fixed preview. No option omits native acceptance or supplies another source pin.

## Fixed component and integration identity

The A2A producer is `f19f1661bf1b2ce717ba6de485f19adb77f074a4`, tree `2c8375f10bca77695f2bd011accf9449ffde65ba`. The lab import baseline is `28fa2e8fd26c8fa957def85cf4e1005c2cc18b4f`. The report's `commit` identifies the combined integration checkout, which differs from the producer ref.

`test/delivery-lab/a2a-source-pin.json` contains expected hashes read from that exact producer Git commit. It covers 168 inputs, including all product source files, the nine top-level `drizzle/*.sql` migrations, producer A2A tests and fixtures, five shared transitive fixtures, the finite proof script, and the dependency lock. It also fixes dependency declarations and the unchanged shared-contract source. Runtime checks compare content and selected path inventories before and after execution. The SQL inventory matches the top-level files that `SQLiteDriver` reads. SQL additions, removals, byte changes, and symlinks fail the check. A shallow checkout needs no producer Git object or ancestry.

A source mismatch fails acceptance. Future NATS integration or product edits need a separately reviewed candidate manifest and new verification. Updating hashes from mutable files would discard the exact-f19 claim.

## Required native evidence

`a2a-producer` executes the six unchanged producer files and their 45 expected cases. `a2a-relay-acceptance` executes ten independent cases from `test/delivery-lab/a2a-native.test.js`. The declaration in `a2a-acceptance.js` owns their file lists, expected names, and coverage relationships.

| Case | Observed boundary                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01  | Official Send creates a Relay request; durable receive and ACK still create no execution Task.                                                                                |
| A02  | Lost submit response and store reopen preserve the original envelope, receipt, deadline, and native Task on replay. Changed input conflicts.                                  |
| A03  | An independent read-only inbox connection sees the committed body and original ACK request immediately before real HTTP ACK. Unrelated Request bodies pass through untouched. |
| A04  | Committed ACK response loss retains exactly the original retry payload after restart and confirms one inbox entry.                                                            |
| A05  | A precommit ACK drop leaves an unconfirmed inbox. Private lease expiry causes an actual stale-ACK refusal, then a new generation confirms that single entry.                  |
| A06  | Two authenticated real Relay pollers race after native Send. Only one receives the lease; the real receiver later saves and ACKs once.                                        |
| A07  | Get, List, and saved delivery do not submit work. Explicit authorized acceptance and retry across reopen retain one engine Task.                                              |
| A08  | Engine completion stays private until a matching durable result and authorized closed evidence. One Artifact survives stale evidence, late acceptance, and reopen.            |
| A09  | Actual private Card, Get, and List deny a foreign group and a revoked current group, with a completed Artifact as the positive control.                                       |
| A10  | Unknown work at the original deadline cannot execute. A recorded successful engine RPC survives deadline and bridge-lease expiry without another RPC.                         |

Missing groups, changed case names or counts, duplicate cases, nonzero exits, failures, cancellation, TODO, and skips fail native acceptance even in baseline mode. An occupied legacy full-suite port reports an environment block and leaves native evidence unverified. It never passes the release gate.

The fetch observer matches only the fixture Relay URL, `relay_ack` tool, and synthetic recipient credential. Other requests go directly to the original fetch. Tests run serially within the file. Lease SQL changes only the named fixture delivery. No production endpoint, real credential, OS clock, disk exhaustion, or LLM is used.

## Eight former placeholders remain visible

A2A is a request protocol over the SQLite delivery engine. It does not implement the engine's generic submit, poll, status, and ACK interface. The eight former A2A engine placeholders are reclassified in `report.a2a.reclassified`, never counted as eight passed tests. The original generic contract source remains unchanged.

The ledger records each D01–D08 relationship, native case IDs, limitation, and execution state. A relationship alone does not establish successful execution. Failed or missing required groups leave every mapped result unverified. Even successful native evidence keeps `generic_requirement_verified` false.

D01's arbitrary six-direction bodies and parts are outside the fixed `connectivity_check` route. D07's native Card and Task privacy does not establish foreign raw mailbox or ACK refusal. D06 concerns Relay consumer exclusion after native ingress, not an A2A polling API. D08 proves bounded fixture restart recovery, not arbitrary transport or power-loss durability.

## Writer verification

The first focused execution passed all ten native cases and all five provenance and gate tests. A second focused run passed all 15 after adding the unrelated Request-body assertion. The code commit is `137100629fd1c7e397d6ad9b873ba21652703f3c`. The working-tree baseline run at `.lab/run-PL1V6E/report.json` passed producer 45, native 10, SQLite contracts 8, storage and harness 26, and selected Relay regressions 281. Eight NATS cases remained skipped. Source snapshots matched before and after, and scratch cleanup completed.

These group counts overlap existing regressions and are not a unique-test total. The baseline run was provisional because new harness files were uncommitted. Lint and typecheck passed. Parent verification of the clean final combined commit and full suite is a separate step; no full-suite success is claimed here. Earlier lab result documents describe their own historical commits.

## Runtime migration input correction

Review found that `SQLiteDriver` executes `drizzle/*.sql`, which the original 159-file pin omitted. A controlled source fixture reproduced the gap at `cb038a1512c8ab5b7821a04e85b0265804a89d27`: changed and added SQL both passed the old source check. No altered SQL was executed. `.lab/a2a-migration-before.json` retains that observation.

The correction at `e5d3d24` adds nine expected SQL hashes read from exact f19 Git content and checks the same top-level SQL inventory as the runtime. All original 159 inputs and actual SQL files remain unchanged. `P06` rejects missing, changed, added, and symlinked migration files. Migration metadata is outside this check because `SQLiteDriver` does not read it.

The focused follow-up passed native 10 and provenance 6, with zero failures or skips. Native replay now requires the specific `message_id_conflict` error for changed input under the same ID. Lint passed. The provisional baseline at `.lab/run-0kvEKu/report.json` passed producer 45, native 10, shared contracts 8, storage and checks 27, and Relay regressions 281. Eight NATS cases remained skipped. Parent-owned full-suite and finite-proof execution of the corrected clean combined commit remain separate verification steps.

The parent completed independent clean-commit verification after the migration pin correction. See [independent results](a2a-independent-results.md) for the actual full run, finite proof, scoped cleanup and remaining release blockers.
