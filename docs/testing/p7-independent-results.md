# Independent P7 results

**Historical record (removed path)**: `packages/relay-nats`, the nats-server installer, the `--nats-server` input and the P7 runner were deleted by [ADR-018](../hab-decisions.md) on 2026-11-13; delivery now runs only through the host's SQLite [delivery store](../delivery-store.md). The current CI is `.github/workflows/ci.yml`. What follows records that time and does not describe current code or procedure.

Historical local-run record. Public task history was reconstructed with portable documentation and an active composite CI pipeline; see [publication scope](publication.md). Statements about the earlier publication hold describe that recorded run. Raw local evidence bundles are not published.

The isolated A2A and JetStream integration passed on the local SSD. The local verdict is `P7_LOGICAL_PASS`. Production adoption remains `BLOCKED`; no public or production operation was attempted.

## Fixed and executed identities

The clean root execution target was `2750a7ea151277e6d04ffd8d2389140763d8ab0e`. Writer documentation followed at `fe1ff0554e8a2427e52846ed8c5b72346c075390`. This result is another documentation-only follow-up.

The composite inputs are A2A follow-up `e9e19f6e49cff4a468175380055e9b83ca368ac7`, NATS `ee101e3514546fba9df99564ac9c8a3a2612494b`, and historical lab `6c92deea85855450549f886d30e2bdf02e44912e`. All src/a2a bytes remain f19. The reviewed import `5461ff3869f18b06daa8333ac81a9a79eb4dbcdb` supplies the explicitly synthesized configured.ts blob. It combines the NATS host extension with the optional rename flag. The other two NATS core overrides retain their exact ee bytes.

Root independently derived and matched all 218 declared inputs from those committed Git blobs. Both dependency locks and all 24 installed direct package versions matched. Node was24.12.0, npm11.6.2, and the native darwin-arm64 NATS2.15.2 binary matched SHA256 `2531878f98a383b0a83cbc2288d2095713f2eca8c9d49fec44ca77bf4bc57567` before its private copy executed. No dependency installation was required.

## Actual root execution

`node scripts/p7-lab.mjs --nats-server /absolute/official/binary --full` exited0 at that clean code commit.

| Required group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| A2A producer and rename acceptance | 48 | 0 | 0 |
| Existing independent native A2A | 10 | 0 | 0 |
| NATS producer | 55 | 0 | 0 |
| P7 integration | 5 | 0 | 0 |
| Composite, image, CLI and process guards | 7 | 0 | 0 |
| Shared contracts over two real engines | 16 | 0 | 0 |
| Full top-level JS inventory | 1498 | 0 | 0 |

There were zero cancellations or TODOs. Groups overlap and must not be summed as unique tests. The common source stayed SHA256 `d9871b9bbcd7ecf3c92320dda53549e52ceff15c23b94f2042e230f3be1ad338`. Its private generated copy ran eight real SQLite and eight real Registry/JetStream scenarios. It did not declare an A2A delivery-engine adapter or turn old placeholders into passes. The historical frozen f19 guards remain unchanged and correctly reject this different candidate.

The shared JetStream adapter is the existing real HAB opt-in router with recipient b selected. D01 intentionally also sends independent traffic to a and c through SQLite. Its eight successes establish hybrid-host delivery compatibility, not six-direction JetStream-only transport coverage. The P7 cases separately witness all three execution messages in JetStream and require no SQLite shadow for those IDs.

Component checks matched before and after, the complete source snapshot was unchanged, all owned worker process groups closed, and scratch was removed. Root and NATS typechecks, related lint including the measurement script, diagram validation, Python34+13 and Ruff0.15.11 checks and formatting passed. The inactive CI proposal parsed and its explicit artifact scope excluded private stores; hosted CI was not run.

## Observed Task, restore and rollback behavior

P7-01 used the official SDK, real P6 host/factory, actual HAB HTTP and Registry, and three actual broker bodies. A separate inbox connection observed committed body and original ACK data before the real HTTP ACK. Save/ACK left engine0 and native submitted state. Explicit acceptance created engine1; only confirmed durable result plus closed authorized evidence released Artifact1. All three messages had NATS ownership and no SQLite shadows. Replay and reopen preserved identity, expiry and Artifact.

P7-02 preserved a linked queued engine Task and a published but unreceived accepted reply with positive stream sequence and cleared outbox. Its semantic oracle was sealed outside source, image and restore roots before quiescence. The complete stopped broker and application state was copied with file and directory metadata. The original configured path became unavailable. A fresh broker read the restored sequence, subject and body hash before the application host or pump started. Recovery reused the original engine ID and request key with zero repeated submit RPCs, then produced one Artifact. The original native Task/context, envelope, receipt, absolute deadline, agent IDs, keys and binding matched. Old/new endpoint, FileStore, marker and directory substitutions are recorded. Both paths have the same observed device, so this is logical restore from a separate SSD directory, not a separate physical failure domain.

P7-03 refused missing broker blocks and an application database before traffic. Its helper guards reject unsafe or duplicate paths, links, mode and byte drift, inside-source images and inside-image restore targets. These are restore-validator results; product diagnosis of every partial backup is not claimed.

P7-04 renamed the pending recipient under the same immutable ID. Stale configuration failed, and explicit refresh retained the original Task and delivery identity. Epoch2 with new NATS routes disabled retained the original request and reply chain on NATS. A new unrelated request used SQLite and stayed deliberately unexecuted. No dual ownership appeared. Ordinary SQLite startup refused the extension marker with the host already closed; same-epoch policy changes and lower epochs were rejected by the real extension.

P7-05 stopped only the owned broker. Admission retained its original pending NATS identity and receipt, with no SQLite fallback or engine work. The same broker store recovered, and explicit acceptance completed one engine Task and Artifact. The NATS entry still needs the broker for restart and drain.

Each completed case01/02/04/05 ended with zero pending admission, quarantine, body-cleanup, outbox, bridge and unknown-RPC counts. An independent official stream query also found zero logical messages and bytes. Actual storage was File, retention Limits, and consumer count0 on this P5 path. This verifies stream reads and tracked deletion after HAB ACK, not a pull-consumer ACK or physical byte erasure. P7-04's extra submitted native Task is intentional and separate from unknown intents.

## Independent refusal, characterization and cleanup

Root challenged the actual CLI with a same-size synthetic executable whose SHA256 was wrong. It failed before groups ran and never created its execution marker. An unapproved adapter argument failed before a run directory was created. An extra migration in a disposable clone failed before input staging or product execution. The guard suite also exercised a real owned worker and descendant timeout, and refused a timeout that exits0.

The unchanged finite SQLite characterization ran independently at the same clean code commit. Five runs validated five Tasks each, with five expected response-loss recoveries, 25 distinct engine Tasks, 25 Artifacts and zero unexpected failures. All source hashes matched the full-run inventory. Seven fixtures confirmed 14 owned listener closures. This is SQLite compatibility and shared-host characterization, not JetStream performance, capacity, a comparison winner or production SLO. Those conclusions remain inconclusive.

A broader final process inspection examined all44 Node/workerd/esbuild/nats-server candidates' working directories and found zero belonging to either owned checkout. No unrelated process was stopped. Ten root-owned private runtime/cache directories were removed after evidence capture; the writer separately removed its focused scratch. The recorded tracked heads and clean status of five source checkouts remained unchanged.

## Corrections and retained evidence

Early fixture failures exposed invalid synthetic naming, an excessive context lifetime, HTTP address-selection fields absent from stored core ACK data, and copy-created directory modes. The fixes changed the verifier fixture, not product source or permission guards. Independent review then corrected component-boundary path checks, generation-local broker readiness and closed/duplicate lifecycle starts. A later helper fix rejects empty or duplicate expected evidence declarations. Explicit rebind metadata was verified by reading actual emitted JSON before final acceptance.

Root's first focused setup lacked its private parent directory and stopped before a broker ran. A later summary assertion assumed the wrong rebind JSON shape; it was corrected against the unchanged master report. Both attempts remain recorded and do not represent hidden product-test failures.

The final root report is `.lab/p7-run-8wAodU/report.json`, with sibling TAP, source inventory and cases/*.json. The sibling SSD directory `hab-p7-evidence` retains the fixed input derivation, design/judge/review reports, actual CLI negatives, root and writer results, finite SQLite samples, process/cleanup records, and local patch exports. Exported evidence omits private DBs, broker stores, configuration keys, caches and executables. See [the execution guide](p7-lab.md) for the one-command entry and [the inactive CI proposal](p7-ci.yml.example).

## Remaining adoption gates

Upstream Linux investigation reproduced all original71 failed IDs on unchanged main. Paired main and ee runs each reported1331pass69fail, with no unreproduced candidate-only failure. Linux full is not a pass, and this e9+ee P7 combination was not executed on Linux. A selected service account, real volume permissions/ownership and native Linux restore remain pre-move checks. No server was selected or provisioned.

The active CI still selects the historical frozen runner; its replacement is an inactive proposal, not green hosted CI. Representative workload and operator budgets, broad A2A bodies/parts, supported execution cancellation, production identities, wake/GUI and physical OS/power/storage faults remain outside this local acceptance. Formal cancellation refusal is covered by existing producer tests. Public push, PR, merge, production, authentication and OS/service configuration remain held and unattempted.

Pstack Model the Domain separated protocol, route ownership, engine execution, cold image and semantic oracle. Prove It Works required actual broker reads before restored application activity and independent clean-commit execution. One writer owned the shared lifecycle; separate native design, review and root verification lanes supplied independent evidence without model/provider diversity.
