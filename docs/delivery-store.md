# HAB delivery store

The host delivers through one private SQLite file, `delivery.sqlite`, in its state directory (ADR-018). `src/delivery/sqlite-delivery.ts` holds admission, the message body, leases, retries, saved ACKs and the redacted delivery audit. There is no broker process, pump, outbox or second store. The host config has one `delivery` section with `volume`, `queue` and optional `maintenance`; a config that still names `broker` or `pump` is refused with `config_invalid`.

## Operations and authority

`HabDeliveryService` (`src/host/hab-delivery-service.ts`) implements `submit`, `status`, `poll` and `ack` for `HabMcpClient` and the MCP tools. Each call takes a fresh `SQLiteHabRegistry.withRelay` scope and commits one synchronous SQLite transaction inside it, so no Promise crosses the Registry guard. The guard checks the current credential, selected immutable ID, group membership, operation rights, sender, kind, block policy, credential expiry and Registry epoch. A stopped or revoked subject cannot use an earlier scope. An admission that committed before revocation stays admitted, while later delivery needs current rights.

Admission commits the record and the body in the same transaction. That commit is the acceptance point: a `pending` receipt means the body is stored and is pollable at once. It does not prove a recipient save.

## Store rules

Each rule commits in the transaction that changes the state:

- A reply must reference a message its recipient sent to its sender in the same pair-scoped thread. A third agent cannot reuse another pair's thread name.
- Admission checks the global record, pending, recipient and body limits and the per-sender quotas and reservations (`queue.agent_capacity`) before it inserts. An exact retry returns the original receipt and needs no new capacity. Changed content under the same ID fails with `idempotency_conflict`.
- A recipient holds at most one lease (a unique index on leased rows). Two handles on one file cannot lease the same recipient twice.
- A lease carries a generation and a token whose HMAC is stored. A lapsed lease returns to `pending` after the retry backoff (`retry_base_ms` doubling up to `retry_cap_ms`), or to `quarantined` once `max_attempts` generations were used. A stale generation or token cannot ACK.
- With `fair_poll`, candidates rotate over senders. A candidate the Registry denies (for example a stopped sender) is skipped without spending its attempt, while one poll scans at most `poll_scan_limit` rows.
- The stored body is checked against its HMAC fingerprint before a lease. A changed body fails with `journal_integrity_failed` and stays unleased.

## ACK, expiry and retention

The recipient's `DurableReceiver` saves the body, deduplication key and original ACK request first. The ACK then validates the current lease, records the request and releases the body in one transaction. A retried identical ACK returns the same receipt; a different request under the same request ID fails with `ack_idempotency_conflict`. ACK request IDs are recipient-wide.

HAB keeps the original one-hour absolute deadline. Admission, status, poll and maintenance first expire overdue live rows: the body is released and the row becomes `expired`. An ACK checks the deadline itself and fails with `invalid_ack` after it. A duplicate submission of an expired message returns the expired receipt and never resurrects the body. Repeated submission never extends the deadline.

Expired records are retained for 30 days after their deadline. ACK records are retained for the ACK retry horizon plus 30 days. The host's maintenance timer (`delivery.maintenance`, default every 60 s, at most 100 records) collects records past retention. Only replay-bound `rm1` IDs are collected, because their encoded deadline makes a collected ID permanently unadmittable. Other IDs are safety-held and never take a batch slot. Body release does not erase receiver copies, filesystem snapshots, backups or every physical SSD block.

## Delivery audit

`delivery_audit` records `accepted`, `leased`, `requeued`, `quarantined`, `expired` and `acked` with sender, message ID and time only, never a body or token. Each event is inserted in the same transaction as its state change, so an audit failure rolls back that admission, lease or ACK, including its capacity use. `delivery_maintenance_totals` counts expired and purged records; if its row is missing, maintenance fails closed with `maintenance_state_unavailable`. Purging a record also removes its audit events.

## File and volume checks

The file is opened with `O_NOFOLLOW` and must be a private regular file (`insecure_journal_file` otherwise). An unknown table set fails with `unknown_journal_schema`, and another fingerprint key or schema version with `journal_key_or_version_mismatch`. SQLite runs with `journal_mode=DELETE`, `synchronous=FULL` and `secure_delete=ON`.

Put the state directory on a persistent volume with `volume.local.json` inside it, as before. The host checks the marker, logical ID and device before opening state and before each operation; a missing or changed volume stops delivery instead of writing to a fallback path. These checks are not a power-failure or unplug test.

## Back up and restore

Stop the host before taking a backup. Copy the whole state directory (Registry, `delivery.sqlite`, host owner, A2A files) together with each recipient's inbox and application state, and keep the key files under a separate secret policy. Restore every part of one backup generation together, never `delivery.sqlite` alone: an older delivery file rewinds receipts and ACKs.

A restore can erase knowledge of messages accepted after the backup. Keep the restored host stopped until the backup time plus one hour plus the largest `max_clock_skew_ms` has passed, so every message first sent before the backup has expired and cannot be delivered again. Before resuming recipients, compare a copy of the replaced `delivery.sqlite` and the replaced recipient inboxes with the restored state by original sender and message ID. Only `acked` proves a save; `expired` and `quarantined` mean the outcome is unknown, and the recipient's own inbox, Task results and execution records decide. Never resend a saved message under a new ID automatically.

## Upgrade from the JetStream build

Builds before ADR-018 delivered through JetStream and kept `jetstream-journal.sqlite` plus a broker store. Their messages are not migrated. The new build refuses to start while `jetstream-journal.sqlite` is in the state directory (`legacy_jetstream_journal_present`), so an undrained journal cannot be silently abandoned.

1. Let recipients send the replies they owe for messages already received. After the upgrade a reply that references a pre-upgrade message fails with `invalid_reference`, and the sender's outbox quarantines it.
2. Stop the senders so no new message is submitted, and keep recipients polling.
3. Wait until one hour plus `max_clock_skew_ms` has passed since the last accepted message. Every journal row is then `acked`, `expired` or `quarantined`, and no pre-upgrade message ID can be admitted again, because its deadline has passed.
4. List the `expired` and `quarantined` rows for their senders: their outcome is unknown, and only the recipient's records decide.
5. Stop the host and the broker. Back up the state directory and the broker store.
6. Move `jetstream-journal.sqlite` and `jetstream-health.local.json` out of the state directory, and delete `delivery.broker` and `delivery.pump` from the config.
7. Start the new build, check `relay:admin status`, then start the senders again.

To roll back, repeat steps 2 to 4 on the new build, stop it, move `delivery.sqlite` aside, put back the drained journal and broker store from step 5 with the old config, and start the earlier build. The drained journal holds no live message, so nothing is delivered twice. Agent SDK inbox and outbox files are unchanged by this release.

## Remaining proof

A local functional test does not establish power-loss safety, a chosen host's volume durability, partitions or corrupt storage. One VM and one volume form one failure domain. Multi-host or high-availability delivery is out of scope for this store; ADR-018 records when to revisit it.
