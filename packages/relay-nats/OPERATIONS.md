# Operate one private Linux host

## Select the data volume

Choose a persistent volume and a dedicated service account before deployment. No provider, billable server, or OS service is created by this implementation.

Put the canonical private service state directory on that volume. Store `volume.local.json` directly inside it with the configured logical `volume_id`. Record the directory's `stat.dev` as `volume.expected_device` on that host. Do not copy a marker onto an underlying fallback directory.

The host validates the marker location, logical ID, file privacy, and device before creating state files. It repeats the storage check before commits and pump cycles. A missing or changed volume stops those operations. These checks do not constitute a physical unplug or power-failure test.

Use separate named files for Registry, NATS admission journal, Task Store, and recipient checkpoints. Keep the broker store on the selected persistent volume. A state directory from the retired SQLite delivery store may still contain `relay.sqlite`. The host starts without a warning, ignores the file and never migrates or delivers its messages. Before upgrading, check each state directory for `relay.sqlite`: any message still pending in it is lost to recipients unless its sender resends it. Reconcile those senders first, then archive or delete the file.

## Configure the private broker

Use the pinned server and a private configuration such as [nats-server.example.conf](config/nats-server.example.conf). Bind the broker only to loopback. Give only the internal HAB service its dedicated broker credentials. Products continue to use the authenticated HAB endpoint.

Set File storage, replicas one, and `sync_interval: always`. Audit the actual broker configuration before deployment. Do not infer fsync policy from the client version or stream INFO. Avoid `persist_mode=async`.

Keep server, account, stream, outbox, sender, recipient, and retained-record budgets finite. Reserve disk space for transactions, compaction, logs, and snapshots. Choose numbers from the actual workload and recovery requirements. This work does not measure a production sizing target.

Keep cache bounds finite and large enough to cover the admitted mailbox. Synchronous HAB prefetch reads verified stream messages directly.

## Observe failures

Read the owner-private `jetstream-health.local.json` for the last ready or degraded transition and a fixed reason code. The file is not a heartbeat. Monitor process liveness, disk availability, oldest pending admission, pending cleanup, quarantine, and broker storage errors separately.

When the broker is unavailable, already admitted bodies remain in the bounded outbox. The running host can return their pending receipt. Reconnection uses the same IDs. No request falls back to SQLite under another ID.

If the volume is unavailable, the host does not write health data into a fallback path. Inspect the mount and marker before restarting. Do not create empty replacement stores to clear an error.

## Back up and restore

Stop new admissions and quiesce the relevant services before taking a consistent backup. Include the broker stream snapshot, admission and ACK journal, Registry, Task Store, binding configuration, and recipient checkpoints. Keep credentials under a separate secret-management policy.

Store encrypted backups outside the source volume. Restore into an isolated directory or host. Update the expected device only after verifying the restored volume. Compare accepted IDs, body digests, saved receipts, engine request keys, and Task results before routing traffic.

The independent restore exercise is not implemented by this P5/P6 package. A broker snapshot alone is insufficient to restore the whole HAB state.

## Roll back

There is no SQLite delivery fallback. A code-only rollback keeps the same journal and broker store, so it works only to a build that opens the schemas this release wrote. This release writes delivery journal schema 4 and agent SDK inbox schema 4. Builds before the JetStream-only release (`3e203d7` and earlier) open journal schemas 1 to 3 only. They refuse a schema 4 journal with `journal_key_or_version_mismatch`, with or without `migrate_journal`, and there is no downgrade migration. Never rewrite a schema version to make an older build start.

Rolling back past a schema change means restoring the consistent backup taken while stopped, immediately before the upgrade started with `migrate_journal: true`. Prefer a forward fix. If a rollback is still required, reconcile by original ID every message whose outcome the restore erases. That is each message the new release accepted, and each message still `staging`, `pending`, `leased` or `quarantined` in the backup, because the new release may have delivered it after the backup was taken.

A journal state never proves that a recipient did not save or execute a message. A recipient can save a body durably while its ACK never commits at the relay, and the row then ends `expired` or `quarantined`. Only `acked` is conclusive, and it proves only the save. The recipient's own records decide the rest.

1. Stop new admissions and drain. Keep recipients polling until no row is `staging`, `pending` or `leased`. Every row ends `acked`, `expired` or `quarantined` within one hour of its acceptance.
2. Stop the host and every recipient whose state is in the backup. Copy aside the schema 4 journal and all post-upgrade state the restore will replace: each recipient inbox, the Task Store, execution records and the host's `a2a-*.sqlite` files. These copies are the only record of what happened after the backup.
3. Build the reconciliation list from the copies. From the repository root, run `node scripts/relay-rollback-reconcile.mjs --upgraded-journal <schema 4 copy> --backup-journal <journal from the backup> --inbox <inbox copy>`, repeating `--inbox` for every agent SDK inbox copy, the host's `a2a-inbox.sqlite` included. For each listed sender and message ID it prints the state in the backup, the final state, whether the recipient's inbox copy holds a record, and one action: `delivered`, `not_saved` or `unknown`. It also prints `restored_incomplete_expire_by`, the latest expiry among the IDs still incomplete in the backup. It only reads.
4. Restore every part of that one backup generation together. That is the broker stream snapshot, the journal, the Registry, the Task Store, the binding configuration and the recipient checkpoints. Never restore the journal alone or the broker store alone. A journal older than its stream rewinds receipts and ACKs, so the old build would deliver ACKed messages again and recipients could execute them twice.
5. Keep the earlier build stopped, with no listener open, until the backup time plus one hour plus the largest configured `max_clock_skew_ms` has passed, and at least until `restored_incomplete_expire_by`. Every ID in the restored state was first sent before the backup, so by then each one has expired. The earlier build then marks its journal rows `expired` instead of delivering them, a restored sender outbox marks its expired intents `expired_unknown` and the journal refuses them, and a restored inbox refuses an unseen expired delivery. An ID that a recipient saved or executed after the backup therefore cannot reach the restored recipient again, although that recipient lost its record of it. A rollback that starts more than an hour after the backup has already waited long enough.
6. Start the earlier build with admissions still stopped. Settle every listed ID before routing traffic.
   - `delivered`: the recipient saved it, whether or not its ACK committed. Do not resend it. The restored sender's status lookup reports `expired` or `not_found`, so tell the sender from the list. Whether the recipient executed it, and with what result, is in that recipient's Task results and execution records in the copies, not in the restored Task Store.
   - `not_saved`: the recipient's inbox copy has no record of it, so its agent SDK never handed it off. Tell its sender it was not delivered. A new attempt is a new request under a new ID that the sender decides on. It is not an automatic replay.
   - `unknown`: there is no inbox copy for that recipient, or the record could already have been collected. Ask that recipient's operator to check its inbox, Task results and execution records by the original sender and message ID. Until then, tell the sender the outcome is unknown and do not retry.
7. A2A Tasks created after the backup are not in the restored state, and builds without host wiring ignore the `a2a-*.sqlite` files. Tell those Tasks' callers, using the Task results in the copied `a2a-tasks.sqlite`.

Do not delete the copies until reconciliation is complete. Do not replay uncertain work under new IDs, or claim Task completion from a broker ACK.

The root test `test/relay-rollback-reconcile.test.js` runs the listing on a real JetStream journal and agent SDK inboxes. It covers an ID staged before the backup and saved after it with its ACK lost, an ACK lost after a save, an acked ID, an unsaved ID and a recipient without an inbox copy. It marks unfinished rows `expired` in place of waiting out the one-hour drain. It does not start an earlier build, restore a broker snapshot or wait out the hold in step 5.

## Interpret platform evidence

The code uses Node, SQLite, filesystem operations, and the official NATS client. The installer pins Linux amd64 and arm64 artifacts. A Linux container proof establishes execution in that container's kernel and filesystem environment. It does not establish a selected VPS provider's volume durability or availability.

One VPS and one volume form one failure domain. Three broker processes on that VPS do not provide independent host or storage failure domains. OS power faults, actual SSD disconnection, full disks, and corruption injection require a separate isolated fault model. None is performed against a live host by this package.
