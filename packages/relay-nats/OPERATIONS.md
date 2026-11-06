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

Rolling back past a schema change means restoring the consistent backup taken while stopped, immediately before the upgrade started with `migrate_journal: true`. Prefer a forward fix. If a rollback is still required, reconcile the work the new release accepted, because the backup does not contain it.

1. Stop new admissions and drain. Keep recipients polling until no message is `pending` or `leased`, or until the one-hour expiry of the last accepted message has passed.
2. Stop the host. Copy the schema 4 journal aside and export each `nats_messages` row accepted after the backup time, with its sender ID, message ID, expiry and `state`. The export is the reconciliation list.
3. Restore every part of that one backup generation together. That is the broker stream snapshot, the journal, the Registry, the Task Store, the binding configuration and the recipient checkpoints. Never restore the journal alone or the broker store alone. A journal older than its stream rewinds receipts and ACKs, so the old build would deliver ACKed messages again and recipients could execute them twice.
4. Start the earlier build on the restored state with admissions still stopped. Reconcile every exported message before routing traffic.
   - `acked`: the recipient saved it. Do not resend it. The restored relay no longer knows the ID, so its sender's status lookup returns `not_found`, and the export is the record of delivery.
   - `expired` or `quarantined`: it was not delivered. Tell its sender. A new attempt is a new request that the sender decides on. It is not an automatic replay.
   - `pending` or `leased` (the journal was not drained): the outcome is unknown. Check the recipient's inbox and Task results by the original sender and message ID first. Resubmit only the original message with its original ID and expiry, and only before that expiry. The recipient's inbox deduplicates by sender and message ID only while it keeps its own records.
5. A2A Tasks created after the backup are not in the restored state, and builds without host wiring ignore the `a2a-*.sqlite` files. Tell those Tasks' callers.

Do not delete the schema 4 journal copy until reconciliation is complete. Do not replay uncertain work under new IDs, or claim Task completion from a broker ACK.

## Interpret platform evidence

The code uses Node, SQLite, filesystem operations, and the official NATS client. The installer pins Linux amd64 and arm64 artifacts. A Linux container proof establishes execution in that container's kernel and filesystem environment. It does not establish a selected VPS provider's volume durability or availability.

One VPS and one volume form one failure domain. Three broker processes on that VPS do not provide independent host or storage failure domains. OS power faults, actual SSD disconnection, full disks, and corruption injection require a separate isolated fault model. None is performed against a live host by this package.
