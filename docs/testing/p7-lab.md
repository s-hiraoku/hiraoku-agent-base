# Run the isolated A2A and JetStream acceptance

Use Node 26.13.0, the pinned root and relay-nats dependencies, and an official nats-server 2.15.2 file. The P7 command verifies the binary's size and SHA256 before making an exclusive executable copy. It starts private loopback brokers with synthetic credentials and removes its private state afterward.

```sh
npm run test:p7 -- --nats-server /absolute/path/to/official/nats-server
npm run test:p7 -- --nats-server /absolute/path/to/official/nats-server --full
```

The first command always runs producer A2A 48, independent native A2A 10, NATS 60, broker startup five, P7 five, runner guards eight, and the unchanged shared contracts against two real backends. The shared group requires 16 passes with no skips. `--full` adds the build and the complete top-level 1150-case inventory. Counts overlap and are not a unique-test total. Both shared backends deliver through JetStream: `hab-host-jetstream` is the host's own delivery behind the Registry, and `nats-jetstream-real-hab` is the guarded JetStream backend over a real HAB Registry. Neither uses a SQLite delivery store, which was deleted. The P7 cases separately witness all three execution messages in JetStream. A missing, failed, skipped, cancelled, duplicated, empty, or contradictory required result fails acceptance. Timeout fails even if the child handles termination and exits0.

Read the printed `.lab/p7-run-*/report.json`. `local_verdict=P7_LOGICAL_PASS` means the required local cases passed, source contents matched before and after, worker groups closed, and no staged broker remained. `adoption_verdict=BLOCKED` is separate. An occupied legacy port 8789 blocks full execution without probing or stopping its owner. The report retains source inventory, TAP, per-case JSON, actual runtime, and binary identity. Private DBs, copied keys, staged executables, and compilation caches stay in removed scratch.

## Fixed component reference

The composite pin has 218 committed inputs. Expected hashes come from Git blobs at A2A follow-up `e9e19f6e49cff4a468175380055e9b83ca368ac7`, NATS `ee101e3514546fba9df99564ac9c8a3a2612494b`, and historical lab `6c92deea85855450549f886d30e2bdf02e44912e`. Every `src/a2a` file remains the f19 implementation. The reviewed import `5461ff3869f18b06daa8333ac81a9a79eb4dbcdb` supplies the synthesized `src/relay-host/configured.ts` blob, combining the NATS extension with the optional rename field. The two other NATS core overrides are `src/relay-host/local.ts` and `src/relay/sqlite-store.ts`.

Those paths are the historical 218-input record. The current profile applies the reviewed successor delta in `test/p7/successor-source-pin.json`, described in [P7 source profiles](../../test/p7/README.md). Since that record, the host moved to `src/host`, the message contract to `src/messaging`, and the durable sender and receiver to `src/agent-sdk`; the SQLite delivery store and the generic-nats port were deleted.

The verifier checks exact inventories, origin labels, source bytes, nine root SQL migrations, both locks, and root dependency declarations. Runtime checks need no producer Git object or ancestry. The report's current commit identifies the P7 code separately. Future product changes require a reviewed replacement component manifest, not hashes refreshed from mutable files.

The historical f19 delivery runner and its 168-input guard remain unchanged. Their old source-positive and public-CLI tests intentionally reject the approved composite inputs. P7 records that old 27-case group as not applicable and independently tests the frozen guard's rejection. P7 does not claim that historical group passed on this composite candidate.

## Real protocol and restore boundaries

P7-01 uses the official SDK, private native Card, real HAB HTTP, current Registry guards, and the host's actual JetStream delivery factory. A transparent fixture wrapper captures the real Registry and preserves the factory's preflight, volume checks, owner checks, and automatic pump. The Registry permits the three execution kinds explicitly. The test reads each actual broker body before request, accepted, and result ACK cleanup, and finds no retired SQLite delivery store.

The independent pre-ACK connection sees the committed recipient body and original core ACK request. HTTP address-selection fields are checked separately. Saved delivery leaves the native Task submitted and engine count 0. Explicit acceptance creates one engine Task. Engine completion stays private until matching confirmed durable result delivery and authorized closed evidence release one Artifact.

P7-02 leaves one queued engine Task and a published but unreceived execution_accepted reply. It records a positive broker sequence, cleared journal outbox, origin inbox 0, and the actual broker body. An exclusive read-only oracle outside source, backup, and restore records original IDs, receipt, deadline, Task/request-key relation, and key digests.

The fixture closes native admissions and awaits in-flight handlers, then closes the real host/pump, all application stores, broker observer, and owned broker. The cold image includes the full FileStore and application state with file and directory modes. No code opens or hashes owner.sqlite while its host is active. The original configured path becomes unavailable. A fresh restore first starts only the broker and reads the original sequence, subject, and body before opening the application host. It then recovers the same engine Task with an observer that rejects another submit RPC, receives the accepted reply once, and produces one Artifact. The case records old and new URLs, FileStore and volume-marker paths, device values, and unchanged binding/key digests.

P7-03 refuses a missing broker block or application store before traffic. Guard tests also reject unsafe paths, duplicate entries, symlinks, byte/mode drift, an image inside its source, and restore into the image itself. These are restore-validator results. The separate producer broker_store_missing case remains actual product evidence.

P7-04 renames the pending recipient through the existing same-ID Registry API. Stale configuration fails closed. Explicit address refresh preserves the ID. After a cold host restart the original request ID, receipt, deadline, and both reply chains remain on NATS, and a new unrelated native Task is admitted to the same journal and stays unexecuted. Routing epochs and the SQLite fallback were retired with the SQLite delivery store.

P7-05 stops only the owned broker while HAB stays active. A native request retains its original pending admission; there is no SQLite fallback. The same broker store restarts, the original identity and receipt recover, and explicit execution produces one Task and Artifact. The JetStream entry still needs its broker during restart and drain.

Completed cases separately inspect outbox, bridge, submission-receipt, admission, quarantine, and body-cleanup counts. They also read actual stream info and require logical messages 0. Storage, retention, and actual consumer count are recorded. The P5 synchronous path uses stream reads and tracked body deletion after HAB ACK; the tests do not claim a pull-consumer ACK that did not occur. Logical deletion does not establish physical byte erasure or power durability. P7-04's new SDK Task intentionally stays submitted and is distinct from unknown RPC or delivery intents.

## Historical local results and deployment limits

The original writer's required groups passed on Node24.12 using private copies of already installed dependencies. Its handoff and raw reports were local evidence, not published repository artifacts. The independent full1498 result is recorded in [independent P7 results](p7-independent-results.md). The original setup failures and corrected oracles remain in focused TAP logs. They exposed an invalid synthetic name, an overlong authentication context, HTTP address fields absent from persisted ACK data, and copy-created directory modes. Product code and permission guards were not relaxed.

The upstream Linux investigation reproduced all original 71 failed IDs on main. Paired main and ee runs each reported 1331 passes and 69 failures, with no remaining candidate-only failure ID. That historical container full suite was not green; it does not describe the current hosted Ubuntu CI result. A real service account, selected native volume semantics, and independent restore remain pre-move gates. No target server has been selected. This P7 exercise proves logical restore into a different directory on the same SSD, not another physical failure domain or a power/OS crash.

Finite SQLite characterization is not P7 JetStream performance or a production SLO. Workload budgets, broad A2A bodies/parts, formal cancellation, GUI/wake, production identities, and physical failure behavior remain outside local acceptance. Hosted CI is separate evidence from that historical local run. Production deployment, authentication, and OS settings remain outside this publication scope.

The [active CI workflow](../../.github/workflows/ci.yml) now invokes the mandatory P7 composite runner with `--full` and verified official binary provisioning. The [workflow example](p7-ci.yml.example) mirrors it. Check the current commit's GitHub Actions result for hosted status; the historical local reports do not establish hosted success. See [publication scope](publication.md).

Model the Domain separates the running system, closed image, immutable semantic oracle, delivery ownership, and engine Task. Prove It Works requires real stream observations and restore with the original path unavailable.

The parent completed independent full verification at clean code2750a7e. See [independent P7 results](p7-independent-results.md) for the actual1498 run, semantic restore observations, finite SQLite compatibility rerun and remaining adoption gates.
