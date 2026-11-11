# Current composite tests and publication scope

The active CI workflow runs the mandatory P7 composite profile on Node 24.12.0 / npm 11.6.2. It also requires ten negative CLI tests for the bounded NATS stage wrapper; these nested cases are separate from the historical flat root inventory. It retains diagram validation, lint, both package type checks, the complete root JavaScript inventory, Python tests, and pinned Ruff checks. An independent non-author execution verdict is recorded in each task PR as a Conversation comment, not a GitHub Approve review. Check the current commit's Actions status for hosted success.

## Reproduce the required profile

```sh
npm ci
npm ci --prefix packages/relay-nats --ignore-scripts
node packages/relay-nats/scripts/install-server.mjs
npm run test:p7 -- --nats-server /absolute/path/from/installer/output --full
```

The installer downloads only the pinned official NATS2.15.2 archive and checks its archive digest. Pass its JSON `binary` value as an argument. P7 independently verifies extracted file size and SHA256 before copying it into private executable scratch. It accepts no broker endpoint, credential, external adapter, or forwarded command. All fixtures use synthetic identities and loopback addresses; no LLM is called.

The runner retains the original conservative `blockers` checklist, including the historical unknown hosted-CI state. Those fixed strings are not live observations of the current Actions run; use its current status separately. Adoption stays blocked for the remaining deployment gates.

Required groups are A2A53, native A2A10, NATS69, broker startup5, composite5, runner guards8, shared16, and the full root1468. These overlap and are not a unique total. Required failures, skips, cancellations, missing/duplicate cases, timeouts, source drift, cleanup failures, or retained owned processes fail acceptance. The historical `test:delivery-lab` source guard freezes f19 and intentionally rejects the newer composite. Do not refresh that guard from mutable working files to make it green.

Both shared backends run the eight contracts through JetStream; the SQLite delivery store was deleted. P7 separately witnesses all three execution messages in actual JetStream. Saved delivery ACK still leaves the native Task submitted and the engine idle. Explicit acceptance and a confirmed correlated result are required for one Task and one Artifact.

## Fixed content and safe publication

The 218-input manifest is unchanged from the verified local composite. It records original content provenance; runtime checks require the committed files, not those historical Git objects or ancestry. All product source, both dependency locks, the NATS package, and existing acceptance fixtures preserve the verified bytes. The configured host combines the authorized NATS extension and optional same-ID rename field. New publication changes are portable documentation and CI wiring, including a strict bounded NATS stage wrapper.

Public task history is reconstructed from the existing main. Private host paths were removed before their first public commit; original local histories, raw evidence bundles, databases, broker stores, credentials, archives and executables are excluded. CI uploads only reports, source hashes, TAP, build logs and synthetic per-case JSON, never whole scratch directories.

The early generic baseline's explicit unimplemented-backend skips remain historical observations. They are not backend passes. The mandatory current P7 profile requires zero skips. Earlier local reports that held publication describe that recorded execution; current PR/CI state is separate.

## Remaining deployment gates

Local P7 restore moves a closed image to another directory on the same SSD. It does not establish another physical failure domain, power-loss durability, physical erasure, or OS/volume crash recovery. The old Linux container's full suite was not green; its baseline comparison found no new candidate-only regression. Hosted Ubuntu checks cannot replace tests under the selected service account, native volume semantics and independent restore on a real target server, which remains unselected.

Representative workload and latency/recovery/load budgets remain undecided. The finite 25-task SQLite characterization is not a JetStream capacity result or production SLO. Generic A2A input/attachments, formal cancellation, GUI/wake and production identity flows remain outside this fixed route. No deployment, authentication, network/permission setting, or production migration is performed by these PRs.
