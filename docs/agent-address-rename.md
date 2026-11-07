# Agent address rename — local prototype

This is a proposed, explicit extension to the original immutable-address contract.
Its presence does not imply a production rollout; migration needs separate operator approval. It changes a Bot's canonical name
inside the same product namespace while retaining its `agent_id`, authentication
assignment, operation grants, blocks, receipts, inbox and outbox identities. It
does not rename a host profile, move credentials, start an agent, or grant MCP
clients management rights. No product-specific dispatch is introduced.

## Proposed address policy — adoption decision required

- A previous address stays permanently reserved to the same ID and cannot be
  enrolled or claimed by any other ID. It is not a forwarding alias.
- `resolve`, `as_address`, `whoami` and directory filtering use the current name.
  A cached old `as_address` fails closed. `check_address` and enrollment consult
  every reservation, including historical names.
- An operator can explicitly rename back to a historical name owned by this ID.
  This is a new audited CAS operation, not deletion or reassignment of history.
- Host attestations containing a previous name owned by the same ID become
  `unknown/stale_address_attestation` until refreshed. They do not become valid
  ownership attestations or aliases. Foreign-name/ID attestations are rejected.

The no-forwarding policy and same-owner rename-back are prototype choices for
review, not a decision that an existing deployment has already adopted. If old
address forwarding is wanted, its authorization, expiry and discovery semantics
need a separate design; this implementation does not silently supply it.

## Schema and permissions

`registry.agent_rename: true` together with `authentication_groups: true` explicitly
upgrades registry v1/v2 to v3 during Relay initialization. The v2 group schema is
the base; existing individual bindings remain usable without group enrollment.
Without this flag existing v1/v2 schemas and immutable-address behavior are unchanged.
Admin commands refuse an upgrade-pending registry and never perform this migration.

V3 preserves the original `hab_agents` identity row and its immutable trigger.
It adds immutable address reservations, append-only rename events and a current-name
view. All changes occur in one Registry transaction through the separate `rename`
administrator permission, with a journaled request ID, expected address and epoch.
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

1. Quiesce the Relay, make an owner-only consistent registry backup, and record
   the deployed code/config and transport backup checkpoint. Do not copy raw keys
   into commands or logs.
2. Deploy v3-capable code with the explicit flag and perform initialization.
   Existing v1/v2 handles refuse the changed schema and must reopen.
3. Inspect `relay:admin status`; save the selected `agent_id`, address and `epoch`,
   chosen new `bot_name`, and a stable `request_id` in the management journal.
4. Invoke the operator CLI once (all values below are synthetic):

   ```sh
   npm run relay:admin -- --config /private/service.local.json rename \
     --agent-id example-agent --expected-address old@example.hab \
     --bot-name renamed --expected-epoch 4 --request-id journaled-rename-1
   ```

5. On an uncertain result, retry the exact saved request. Never invent a fresh
   request ID or epoch to force a concurrent change through.
6. Refresh the host's stored local address and recreate MCP clients that freeze
   `as_address` on construction, retaining the same ID and authentication. Update
   durable host attestations through their host-owned mechanism. Profile/path
   renaming is independent and is not performed by this command.
7. Verify `whoami`, scoped directory, new-address resolution, old-address refusal,
   pending delivery/ACK/status, and unchanged grants. Previously accepted envelopes
   and replies continue to use the same immutable sender/recipient IDs.

## Rollback boundaries

Disabling new rename operations in v3-capable code preserves current-name reads;
it never revives old names. An old binary refuses schema v3. Do not roll an active
Registry back to an older backup or drop its tables: this would erase later name
reservations and authority changes. Prefer an explicit same-ID rename-back after
checking clients and queued work, or keep v3-readable code with mutations disabled.
Only a quiesced, coordinated restore before any subsequent writes can safely use
the pre-migration checkpoint. No production migration or rollback has been run.
