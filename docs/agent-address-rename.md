# Agent address rename

Renaming is adopted (owner decision, 2026-11-12 JST). An administrator may change a
Bot's `bot_name` inside the same `agent_name` namespace while it keeps its `agent_id`,
authentication assignment, operation grants, blocks, receipts, inbox and outbox
identities. It does not rename a host profile, move credentials, start an agent, or
grant MCP clients management rights. No product-specific dispatch is introduced.
The registry v3 schema, the `rename` administrator operation, the permanent
reservations and the grace period below are implemented. Migration of an existing
deployment still needs separate operator approval.

## What a rename must not break

Delivery never depends on the address text. A sender resolves an address once and
saves the immutable `recipient_id` in its outbox before the first submit; retries,
status, poll, ACK, `in_reply_to` and `thread_id` carry IDs only. Messages already
accepted, leased, saved or being replied to are therefore unaffected by a rename.
The places that hold the address as text are handled as follows.

| Holder of the old address | Behaviour after a rename |
| --- | --- |
| Another agent's address book or saved contact | During the grace period `relay_resolve(old)` returns the same `recipient_id`. The v1 output still echoes the requested address, so existing clients keep working; the current name is read with `hab_discover`. After the grace period the old name is refused like any unknown name (`forbidden`). |
| The renamed agent's own `as_address` (frozen in its MCP client) | During the grace period the old name is accepted as the caller's own name only when the authenticated binding and `expected_agent_id`, if given, select the same `agent_id`. After the grace period it fails closed. Refresh the host's stored address before then. |
| Host config: `a2a.identity`, `a2a.recipient` | Resolved through the same rule, so the A2A entry keeps working during the grace period: the identity stays the same agent and the recipient resolves to the same ID. The rename procedure must update the config in the same maintenance window. A start after the grace period with an old identity is refused with `a2a_identity_renamed`; an old recipient is refused like any unknown name. |
| Host attestations | Become `unknown/stale_address_attestation` until refreshed. They never become ownership proof for the old name. |
| Directory, discovery and `check_address` | Show the current name only. A previous name is reported as reserved and can never be enrolled or claimed by another ID. |
| Credential mappings and OAuth connections | Keyed by connection, not address. Unchanged. |

Rules:

- Every previous name stays permanently reserved to the same `agent_id`. The grace
  period only decides whether the old name still resolves; it never releases the
  reservation.
- The grace period is a registry option, `rename_grace_days` (0–365, default 30),
  measured in the registry clock from the latest rename away from that name. Each
  previous name has its own period; 0 refuses a previous name at once. Each use of a
  previous name (a `relay_resolve`, or the agent's own frozen `as_address`) is counted
  per caller ID in `hab_previous_name_uses`, with no message content, so the operator
  can see which callers still use it. The table holds at most `max_audit_records`
  rows; when it is full, existing counts keep growing and new callers are not listed.
- An old name resolves only to its own `agent_id` and only with the caller's current
  resolve/submit rights to that ID. It is not a forwarding alias to another ID and
  grants nothing new.
- An administrator can rename back to a historical name owned by the same ID. This
  is a new audited CAS operation, not deletion or reassignment of history.
- The `agent_name` (product or execution environment) cannot change. A rename across
  namespaces is refused.
- `hab:admin status` lists `previous_names`: each previous name with its agent ID,
  current name, rename time, grace end, whether it still resolves, and the callers
  that used it. It reports `config_previous_address` (still resolving) or
  `config_previous_address_expired` when `a2a.identity` or `a2a.recipient` names a
  previous address.

## Schema and permissions

`registry.agent_rename: true` explicitly upgrades registry v2 to v3 during Relay
initialization. The v2 group schema is the base; every registry has it, because
every connection authenticates through a group. Without this flag the v2 schema and
immutable-address behavior are unchanged.
Admin commands refuse an upgrade-pending registry and never perform this migration.

V3 preserves the original `hab_agents` identity row and its immutable trigger.
It adds immutable address reservations, append-only rename events, a current-name
view and the previous-name use counts (name schema version 2). A v3 registry from the
first v3 build (name schema version 1) gains the use table at the next host start;
admin commands report `registry_upgrade_pending` until then. All changes occur in
one Registry transaction through the separate `rename` administrator permission,
with a journaled request ID, expected address and epoch.
Rename increments the agent epoch and its member-group epoch to invalidate scoped
discovery cursors, preserving grants and active credential bindings. Event storage
is capped by `max_requests`; reservations are capped by `max_agents + max_requests`.
Retired objects, quota exhaustion, concurrent/stale requests and namespace changes
fail closed. A successful exact request can be replayed without another change.

## Operator workflow after a separately approved deployment

The person chooses and confirms the desired Bot name through the host's dialogue
before management executes this operation. A chat message, received external
message, or model-proposed name is not itself administrator authorization. The
same management contract applies to all participating products.

1. Quiesce the host, make an owner-only consistent registry backup, and record
   the deployed code/config and transport backup checkpoint. Do not copy raw keys
   into commands or logs.
2. Deploy v3-capable code with the explicit flag and perform initialization.
   Existing v1/v2 handles refuse the changed schema and must reopen.
3. Inspect `hab:admin status`; save the selected `agent_id`, address and `epoch`,
   chosen new `bot_name`, and a stable `request_id` in the management journal.
4. Invoke the operator CLI once (all values below are synthetic):

   ```sh
   npm run hab:admin -- --config /private/service.local.json rename \
     --agent-id example-agent --expected-address old@example.hab \
     --bot-name renamed --expected-epoch 4 --request-id journaled-rename-1
   ```

5. On an uncertain result, retry the exact saved request. Never invent a fresh
   request ID or epoch to force a concurrent change through.
6. Refresh the host's stored local address and recreate MCP clients that freeze
   `as_address` on construction, retaining the same ID and authentication. Update
   durable host attestations through their host-owned mechanism. If the agent is
   named in the host config (`a2a.identity` or `a2a.recipient`), update the config
   and restart the host in the same window. Tell other agents the new name; their
   old address keeps resolving only until the grace period ends. Profile/path
   renaming is independent and is not performed by this command.
7. Verify `whoami`, scoped directory, new-address resolution, old-address resolution
   to the same ID during the grace period, pending delivery/ACK/status, and unchanged
   grants. Before the grace end, check `previous_names[].callers` in `hab:admin
   status` and tell any caller still listed. Previously accepted envelopes
   and replies continue to use the same immutable sender/recipient IDs.

## Rollback boundaries

Disabling new rename operations in v3-capable code preserves current-name reads and
the remaining grace periods; it never revives a previous name whose grace has ended.
An old binary refuses schema v3. Do not roll an active Registry back to an older backup or drop its tables: this would erase later name
reservations and authority changes. Prefer an explicit same-ID rename-back after
checking clients and queued work, or keep v3-readable code with mutations disabled.
Only a quiesced, coordinated restore before any subsequent writes can safely use
the pre-migration checkpoint. No production migration or rollback has been run.
