# Operate one private Linux host

## Select the data volume

Choose a persistent volume and a dedicated service account before deployment. No provider, billable server, or OS service is created by this implementation.

Put the canonical private service state directory on that volume. Store `volume.local.json` directly inside it with the configured logical `volume_id`. Record the directory's `stat.dev` as `volume.expected_device` on that host. Do not copy a marker onto an underlying fallback directory.

The host validates the marker location, logical ID, file privacy, and device before creating state files. It repeats the storage check before commits and pump cycles. A missing or changed volume stops those operations. These checks do not constitute a physical unplug or power-failure test.

Use separate named files for Registry, NATS admission journal, Task Store, and recipient checkpoints. Keep the broker store on the selected persistent volume. A state directory from the retired SQLite delivery store may still contain `relay.sqlite`; the host ignores it and never migrates its messages.

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

There is no SQLite delivery fallback. To roll back a release, stop the host and restart the earlier build with the same journal and broker store. Preserve the original ID and expiry for uncertain requests. Do not delete the NATS journal, replay uncertain work under new IDs, or claim Task completion from a broker ACK.

## Interpret platform evidence

The code uses Node, SQLite, filesystem operations, and the official NATS client. The installer pins Linux amd64 and arm64 artifacts. A Linux container proof establishes execution in that container's kernel and filesystem environment. It does not establish a selected VPS provider's volume durability or availability.

One VPS and one volume form one failure domain. Three broker processes on that VPS do not provide independent host or storage failure domains. OS power faults, actual SSD disconnection, full disks, and corruption injection require a separate isolated fault model. None is performed against a live host by this package.
