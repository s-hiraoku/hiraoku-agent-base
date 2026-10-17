# Scope and boundaries

For the overall HAB roles, current evidence and hosting decisions, start at [README](../README.md) and [ADR](hab-decisions.md). This page owns the technical queue/adapter contract.

Dots retains personal context, consultation, important-mail decisions, mark-read after notification, and schedule summaries. Grok retains its existing connpass job and future Calendar/browser/long-task work. Hermes handles development experiments, MCP and Skills. These are design roles. Current limited task contracts are connectivity_check and the opt-in fixed shift_log_inventory; the diagnostic ping/pong service is separate. Verified server policy chooses the route and allowed task types. Results and notifications never submit tasks.

The adopted next-stage communication design is the [HAB Relay specification](hab-relay-spec.md). It separates durable message delivery from this existing Task Engine. Its proposed APIs and schemas are not implemented by the current runtime.

## Authentication and tool contracts

Both Node and Worker `POST /mcp` entry points use the pinned official MCP SDK. Strict schemas expose submit, claim, heartbeat, complete, get and cancel. No caller supplies a destination or trusted identity. Submit takes `{task_type:"connectivity_check",request_key}`; claim `{}`; get/cancel `{id}`; heartbeat `{id,fence,run_id?}`; complete `{id,fence,state,result}` with fixed success/failure results.

A trusted verifier supplies `{subject,operations,destination?,worker?}`. Default verification returns no identity and HTTP 401. Header names, including Sites identity headers, are never automatically trusted. A future Sites integration must verify the hosting boundary and map authenticated users/services to distinct policy. No service credential may manufacture user identity or connected-app consent. Cancellation requires both a verifier-granted `cancel` operation and task ownership. `destination` chooses the route for new submissions; it does not grant cancellation authority. A principal granted only cancellation may stop its own task without also being granted new-submission routing. Worker-only or foreign-owner principals cannot cancel.

## One state database, two storage drivers

The async `TaskService` constructs the same prepared SQL operations for SQLite or D1; select one authoritative storage driver per deployment. There is no replication or dual-write between them. SQLite executes an operation's statements in BEGIN IMMEDIATE. D1 uses a primary-constrained session and transactional ordered batch. Conditional UPDATE predicates and a unique partial index enforce one unresolved execution per destination. There is no JavaScript SELECT-then-write claim race.

`db/schema.ts` and generated Drizzle migrations own schema. Triggers persist state/run/lease audit and terminal outbox within the same transaction as the actual mutation. Terminal retries do not produce another mutation or event. Submission keys are scoped to owner. Heartbeats bind the run ID once and reject conflicts. Every completion requires the current lease/fence/worker; cancellation increments the fence. Lease expiry quarantines work in waiting_approval and retains its slot. Cancelled claimed work also retains the slot; queued cancellation does not reserve one.

The Mac's separate journal is a recovery receipt, not a second task-state database. It stores task ID, fence, stable admission key, run ID and admission time. It is committed before admission. Known runs are looked up by ID; unknown admissions replay the identical key only within the verified idempotency retention horizon. Existing prototype databases lacking migration metadata are refused with `legacy_schema_requires_reviewed_migration`, preserving their records for reviewed migration rather than silently replacing them.

## Outbound worker lifecycle

`Adapter.once()` handles one admission/status step; `run()` polls until terminal while the receipt exists. A watchdog renews leases during blocked create/get calls, with a finite renewal deadline. Initial, periodic and final heartbeat payloads contain only protocol fields. Renewal failure or explicit local stop aborts local waiting and retains the receipt and execution slot for reconciliation. This does not imply stopping a remote run. The adapter rejects unsafe timing budgets and unverified tool-isolation/durable-idempotency contracts.

Cancelled known work is read until the run driver confirms a terminal state. Unknown cancellation remains unresolved. Neither case silently clears the gate; general terminal reconciliation/release is not implemented. The internal operator reconciliation API can close a gate only after trusted proof of the exact fixed successful run on the original boundary; see [local integration](local-integration.md). No guessed stop endpoint is called. The real driver and authentication bootstrap remain gated: mock booleans are test seams, not proof of actual tool or memory isolation.

## Notification foundation

The transactional outbox is at least once; receivers must deduplicate stable event IDs. Offline-tested `EventSender` adds signed callback challenge verification, fixed terminal payloads, owner/access/expiry checks, bounded retry/backoff and 410/413/redirect policy rejection. `PinnedCallbackTransport` is a Node preparation adapter: exact approved URLs, HTTPS, fresh public-address validation at each connection, pinned DNS address and original TLS host, response bounds and no redirect following. The Worker egress adapter remains unimplemented.

Opt-in EventAPI, durable encrypted subscriptions, authenticated list/subscribe/unsubscribe and fenced delivery are implemented and tested with fixtures. Default entrypoints supply no EventAPI. Real callbacks, hosted egress and resident delivery are unconnected; cursor-based replay is unsupported. See [local integration](local-integration.md).

## Hermes prerequisites

The verified source commit was `f97608f178d1ffeca59860195ab7da295f7c8e5f`. Its document is `website/docs/user-guide/features/api-server.md`. It describes scoped Runs, capabilities/toolsets, API-key authentication and finite idempotency retention. Server agent creation uses platform toolsets; passing `tools: []` is not proof of real tool exclusion.

Desktop UI backend and standard gateway API are distinct interfaces. Do not assume an old desktop port exposes Runs. An approved isolated API profile must verify effective runtime tool definitions are empty, independent sessions/memory/history, durable idempotency, actual loopback binding and minimal authentication. Never extract desktop internal authentication for reuse.

## Remaining approval and verification gates

1. Isolated Hermes profile, key creation/storage and its exact endpoint/tool/memory policy; independent fixed-payload Runs. Keys must stay outside model context/chat/source/logs.
2. Mac/SQLite ingress, Auth0 production wiring and approved Hub-specific Tailscale routing. Sites/D1 are deferred portability options; local tests do not establish hosted auth interoperability.
3. Approved fixed outbound Mac-to-Hub traffic and any background worker. Current worker tests are manual and local.
4. Authorized cancellation terminal reconciliation/gate release and real endpoint/status normalization; cloud revocation/lease/stop failure checks.
5. Plugin registration and formally verified notification destinations after subscription/egress/replay security is complete.

No current production Hub deployment, Site/cloud D1 resource, live subscription/plugin registration or resident Hub worker is installed. An earlier fixed-connectivity local trial is recorded separately in [fixed pilot history](fixed-pilot.md); it does not validate the current inventory bridge or cloud clients.

## Execution planning beyond the fixed pilot

Keep the responsible agent, execution tool and execution environment separate. Dots, Grok Bot and Hermes retain their own judgement. A future task contract should identify its owner/responsible agent, requested execution environment, allowed tools, workspace and completion criterion; authorization must derive these permissions from verified identity and policy rather than task-supplied agent names. Claude Code, Codex and Cursor can be selected execution tools only after their real connection and scopes are verified. Mac and cloud are distinct environments.

Before supporting development work, add execution idempotency across tools, exclusive workspace reservations or isolated worktrees, bounded grants, result provenance and explicit reconciliation of unknown runs. Existing cron jobs must remain owned by their current system and must not be recreated by the Hub. Terminal events do not automatically submit another task. Cursor Cloud Agents and a Grok Bot external control interface are distinct capabilities; one does not establish access to the other. Current task contracts remain fixed connectivity and opt-in inventory; general development work is not admitted.
