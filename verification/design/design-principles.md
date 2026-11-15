# Source-derived design principles

The contract preserves overlapping citations from coherent subsystem reviews; requirement counts are not unique test/coverage totals. Accepted requirements retain their stated subsystem scope; proposed/historical entries are not enforced as standard messaging requirements. Source authority comes from the cited adopted design and explicit decisions, not current test success.

## Foundations

### HAB-F01 — Recipient-owned judgment

HAB authenticates names, recipients, delivery and correlation; content understanding, refusal/questions/replies, task acceptance, execution and existing permissions/approval remain with the recipient agent. Do not centralize agent memories or judgment.

Reason: Preserves independent agents and prevents transport authorization becoming execution authority.

Scope: All standard communication; recipient integration Decision: **accepted**.

Checks: js-common-mcp, ast-boundary, native-recipient, js-recipient-messages, js-recipient-host-mcp.

Sources: [docs/hab-principles.md:9](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-principles.md#L9-L9), [docs/hab-decisions.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-decisions.md#L28-L31).

### HAB-F02 — Common product-independent messaging

Standard connection uses shared HTTP MCP and durable inbox/outbox; recipient host periodically receives without a model. Do not add product-name delivery branches or a HAB product execution/approval runner as a prerequisite.

Reason: Native product capability/configuration differs, but delivery contract must remain reusable.

Scope: Standard shared MCP and receive supervisor Decision: **accepted**.

Checks: ts-root, build, ast-boundary, js-common-mcp, native-recipient, js-recipient-messages, js-recipient-host-mcp.

Sources: [docs/common-mcp-connection.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/common-mcp-connection.md#L3-L6), [docs/hab-principles.md:13](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-principles.md#L13-L13).

### HAB-F03 — Tasks are optional

Ordinary question/answer communication works without creating Tasks. Existing fixed/generic Tasks, A2A and NATS execution ports are explicitly composed optional integrations; receive, ACK, listing or body reading must not automatically create task links, Tasks, model runs or replies.

Reason: Transport reception must not take or execute work on behalf of the recipient.

Scope: Standard communication, including untrusted execution_request data Decision: **accepted**.

Checks: js-common-mcp, ast-boundary, js-recipient-messages, js-recipient-host-mcp.

Sources: [docs/hab-decisions.md:30](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-decisions.md#L30-L30), [docs/receiver/adapter-host.md:32](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L32-L34), [docs/receiver/receive-supervisor.md:53](../../docs/receiver/receive-supervisor.md#L53-L54).

### HAB-F04 — Durable receiver checkpoint before ACK

Recipient deduplicates (sender_id,message_id), atomically stores message body and dedup plus durable original ACK request, and only then sends ACK; storage failure sends no ACK. Persist and reconcile the ACK receipt.

Reason: The Relay may delete body upon ACK; volatile conversation memory or direct poll-to-ACK is insufficient.

Scope: Durable receive and standard/native MCP handoff Decision: **accepted**.

Checks: js-common-mcp, mcp-durable-roundtrip, ack-observer-controls, js-process-crash.

Sources: [docs/common-mcp-connection.md:45](../../docs/common-mcp-connection.md#L45-L61), [docs/hab-messaging-spec.md:259](../../docs/hab-messaging-spec.md#L259-L263), [docs/hab-product-spec.md:163](../../docs/hab-product-spec.md#L163-L163).

### HAB-F05 — Durable sender identity and uncertainty

Resolve recipient and commit immutable original envelope and selected sender/recipient IDs in outbox before submit; uncertain responses reconcile same message/content/deadline rather than new ID, new recipient resolution or later expiry.

Reason: Avoids duplicate delivery, silently rerouted requests and false nonexecution inference after lost responses.

Scope: Sender outbox and resume/retry Decision: **accepted**.

Checks: js-root.

Sources: [docs/common-mcp-connection.md:45](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/common-mcp-connection.md#L45-L48), [docs/hab-messaging-spec.md:139](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L139-L139), [docs/receiver/adapter-host.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/adapter-host.md#L27-L29).

### HAB-F06 — ACK is receipt only

Keep delivery, display/human-read, acceptance/execution/approval/completion as separate states. ACK proves durable receipt only; active registration is not online; timeout/cancel-request does not prove remote stop.

Reason: Every UI and evidence statement must match its observed state boundary.

Scope: State APIs, UI, reports and recipient handoff Decision: **accepted**.

Checks: js-common-mcp, js-root, gui-parity, js-recipient-messages, js-recipient-host-mcp.

Sources: [docs/hab-product-spec.md:98](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L98-L110), [docs/hab-decisions.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-decisions.md#L28-L28).

### HAB-F07 — Pure source-authorized saved body read

inbox_read requires independent exact-source authorization and current actor, pause/epoch, configured owner and idle checks, rechecks before returning authenticated unreleased saved body as an independent copy. Missing/released/corrupt data gives no body.

Reason: Metadata/receive permission must not silently grant body access; caller mutation must not corrupt saved evidence.

Scope: Local AdapterHostCycle inbox_read Decision: **accepted**.

Checks: js-common-mcp, js-recipient-host-mcp.

Sources: [docs/receiver/adapter-host.md:47](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L47-L49).

### HAB-F08 — Read does not mutate receipt or act

inbox_read may return saved receipt_confirmed=false data but must not retry/confirm ACK, release body, modify inbox/ACK/outbox/Task or initiate model/Task/reply. Existing reply/task acceptance guards stay unchanged; body is untrusted data, never direct owner approval.

Reason: Decouples pure retrieval from uncertain transport state and independent action authority.

Scope: Local inbox_read and explicit recipient decisions Decision: **accepted**.

Checks: js-common-mcp, js-recipient-host-mcp.

Sources: [docs/receiver/adapter-host.md:47](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L47-L53), [docs/receiver/recipient-readiness.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/recipient-readiness.md#L7-L9).

### HAB-F09 — Receive-only supervisor authority

Supervisor repeats receive only with same-agent durable stores, current authorization, process owner and explicit resume. It stops on missing/lost owner, pause or local authorization failure and never clears pause, obtains/releases owner, logs in, updates grants, sends replies, accepts tasks or starts a model. An optional owner-local authentication gate begins blocked after process start and may unblock receive only after fresh verified evidence of the exact approved issuer/resource/subject/client/connection/agent identity; it is not authentication or a replacement for current authorization. Copied, foreign, reused or superseded verification tickets cannot unblock it. Credential refresh/login, independent identity verification and native notification delivery remain product responsibilities.

Reason: A scheduler must not become privileged agent control or invent operational authorization.

Scope: ReceiveSupervisor host port v1, optional trusted local recovery gate; synthetic recovery checks in test/authentication-recovery.test.js do not establish native OAuth or deployment acceptance. Decision: **accepted**.

Checks: js-common-mcp, js-root.

Sources: [docs/receiver/receive-supervisor.md:5](../../docs/receiver/receive-supervisor.md#L5-L15), [docs/receiver/receive-supervisor.md:90](../../docs/receiver/receive-supervisor.md#L90-L99), [docs/receiver/receive-supervisor.md:114](../../docs/receiver/receive-supervisor.md#L114-L127).

### HAB-F10 — Bounded receive and drain

Configure finite receive interval/backoff/drain; only poll/ACK transport failures back off. A trusted local provider recovery signal becomes an explicit stop reason without a gate, or a blocked gate with bounded local-only waits and fixed, secret-free synchronous state notifications. Generic HTTP status or wire strings do not confer that local signal. No poll/ACK starts while blocked; current pause/owner/draining authority is rechecked before readmission. Storage failure stops without deleting data for room. Outstanding work prevents a new receive; stop prevents the next cycle and waits boundedly; drained=false does not certify safe DB/owner closure. Recovery retains original body/ACK and deferred send intent without extending existing time/attempt/retention horizons.

Reason: Avoids overlap, lost durable evidence and false cleanup success.

Scope: ReceiveSupervisor timing, failures and cleanup Decision: **accepted**.

Checks: js-common-mcp, js-root.

Sources: [docs/receiver/receive-supervisor.md:32](../../docs/receiver/receive-supervisor.md#L32-L53), [docs/receiver/receive-supervisor.md:77](../../docs/receiver/receive-supervisor.md#L77-L83), [docs/receiver/receive-supervisor.md:131](../../docs/receiver/receive-supervisor.md#L131-L138).

### HAB-F11 — Current authorization and untrusted input

Derive identity/operations/recipient from verified subject, client, scope and policy. Reject absent or failed authorization and recheck current authority at operation/commit boundaries. Agent names, message role, readonly prose, arbitrary headers or approval text confer no rights.

Reason: Prevents outside content or stale authorization from crossing into management/execution authority.

Scope: All public entry points and recipient action integration Decision: **accepted**.

Checks: js-root, native-recipient, js-recipient-messages, js-recipient-host-mcp.

Sources: [docs/hab-principles.md:21](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-principles.md#L21-L21), [docs/hab-messaging-spec.md:93](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L93-L97).

### HAB-F12 — Group scope and address scope

Approved authentication group may select its member addresses; deny outside-group names/mailbox operations and ambiguous selection. Same-group shared credentials do not prove exclusive per-Bot identity; sender/receiver IDs stay fixed across recovery.

Reason: Preserves adopted shared trust boundary without claiming isolation that shared credentials cannot provide.

Scope: HAB authentication groups and five common MCP operations Decision: **accepted**.

Checks: js-root.

Sources: [docs/common-mcp-connection.md:10](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/common-mcp-connection.md#L10-L16), [docs/hab-messaging-spec.md:145](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L145-L151).

### HAB-F13 — Reusable inner Relay boundary

Relay core/contract and durable client stay independent of HAB naming, registry, product/model SDKs, Task state, MCP SDK, OAuth and UI; outer composition injects narrow public ports. No hidden reverse dependency or import-time DB/listener/network effects.

Reason: Enables reuse and prevents standard messaging being coupled to execution or a vendor.

Scope: Relay core/storage/client and composition boundaries Decision: **accepted**.

Checks: ast-boundary, ast-controls, architecture-review.

Sources: [docs/hab-messaging-spec.md:78](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L78-L99).

### HAB-F14 — Idempotency and fenced receipt replay

Same sender/message key and same content return original receipt/state without another message/delivery/task/notification; changed content conflicts. Atomic leases use generation/token; committed identical ACK receipt can replay after lease/TTL, while never-committed old ACK cannot steal current lease.

Reason: Lost responses and at-least-once delivery require durable identity rather than blind retry.

Scope: Relay submit/poll/ACK/status Decision: **accepted**.

Checks: js-root, mcp-durable-roundtrip.

Sources: [docs/hab-messaging-spec.md:227](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L227-L233), [docs/hab-messaging-spec.md:285](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L285-L300).

### HAB-F15 — TTL retention and handoff

Original message delivery TTL is one hour and never extends on retry/resume. Relay confirmed ACK atomically removes live message body and keeps minimum dedup/receipt for thirty days after max relevant horizon. Recipient body release requires explicit durable application handoff and does not follow delivery TTL automatically. Logical DB deletion is not all-copy physical erasure.

Reason: Limits retention without losing recovery/dedup proof or dropping recipient-owned content before handoff.

Scope: Relay and client retention/GC Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/hab-messaging-spec.md:372](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L372-L398).

### HAB-F16 — Pause and unresolved operations

New host control begins paused; each command retains actor/epoch and rechecks before/after RPC and commit. Pause/local abort is not remote cancellation. Timeout retains busy/draining until underlying work settles; original ACK IDs/envelopes/task keys survive uncertainty.

Reason: Prevents stale late responses and overlapping work after a superficial timeout or pause/resume.

Scope: Finite adapter host/control and optional task ports Decision: **accepted**.

Checks: js-root, js-recipient-host-mcp.

Sources: [docs/receiver/adapter-host.md:67](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-host.md#L67-L81).

Managed-transport scope: Managed transport is a trusted cooperative local-admission capability: unlike guarded fetch, its check releases the control transaction before physical SDK/IPC send. A request admitted before pause may still commit; every later request/retry needs a new current check. Product OAuth side clients must also be guarded. Abort/timeout never clears unsettled work or authorizes owner/store release. See the [reviewed local source](../../docs/receiver/adapter-host.md#product-owned-managed-transport-trusted-local-integration) and exact working-tree lines 63–109 in contract.json. This new source citation is not a claim of published or hosted acceptance.

### HAB-F19 — No loop or privilege fallback

Existing cron/jobs retain ownership; receiving or notifying does not automatically create another task/reply. Retries, quotas and reply/rate budgets are finite; reaching a limit stops/holds without new IDs, another model, credentials or weakened auth.

Reason: Controls duplicated work, reply loops and cost growth while preserving independent responsibilities.

Scope: Common communication and explicitly configured automation Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/hab-principles.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-principles.md#L27-L33), [docs/hab-messaging-spec.md:303](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L303-L309), [docs/hab-messaging-spec.md:328](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L328-L332).

### HAB-F20 — GUI and MCP shared authority

GUI and MCP operations use the same application services, validation, current authorization, idempotency and state meanings. Same verified actor/scope/target/input yields the same business result; no GUI direct-DB bypass.

Reason: Different entry points must not introduce parallel authority or inconsistent outcomes.

Scope: Confirmed product requirement; current UI mutation/live parity still to accept Decision: **accepted**.

Checks: js-root, gui-parity.

Sources: [docs/hab-product-spec.md:13](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L13-L13), [docs/hab-product-spec.md:68](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-product-spec.md#L68-L69).

### HAB-F21 — Honest product capability and evidence

Require verified formal caller/session binding, native transport, durable stores and actual display/input/wake capabilities; unsupported APIs remain unsupported. Synthetic/loopback/injected scheduler proofs must not become actual product model, approval UI, real timing, residency or production E2E claims.

Reason: Prevents a successful local harness from concealing missing product capabilities.

Scope: Readiness, public capability advertisement and verification reports Decision: **accepted**.

Checks: mcp-durable-roundtrip, native-recipient, js-recipient-messages.

Sources: [docs/receiver/recipient-readiness.md:17](../../docs/receiver/recipient-readiness.md#L17-L38), [docs/common-mcp-connection.md:106](../../docs/common-mcp-connection.md#L106-L124), [docs/hab-product-spec.md:198](../../docs/hab-product-spec.md#L198-L204).

### HAB-F22 — Private UI and product simplicity

Provide human-readable connect/register/select/send and separate connection/registration/receive ability. Private PC/mobile access still requires app authentication/authorization; browser lifetime and public Funnel are not private/resident receive guarantees. Kanban stays separate optional application.

Reason: The product should hide protocol mechanics while exposing honest capability and operational boundaries.

Scope: Confirmed product goals; manual/live acceptance remains required Decision: **accepted**.

Checks: gui-parity.

Sources: [docs/hab-product-spec.md:11](../../docs/hab-product-spec.md#L11-L17), [docs/hab-product-spec.md:35](../../docs/hab-product-spec.md#L35-L47), [docs/hab-product-spec.md:90](../../docs/hab-product-spec.md#L90-L94).

### HAB-F23 — Public source versus private runtime

Keep real credentials, personal messages/history, connection settings and operational raw logs outside the public repo. Source commit/push is not consent for new credentials/grants/public routes/resident processes/fees or real agent execution.

Reason: Protects personal context and prevents publishing source from expanding operational scope.

Scope: Publication and operational handoff Decision: **accepted**.

Checks: source-publication.

Sources: [README.md:9](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/README.md#L9-L9), [docs/hab-principles.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-principles.md#L23-L23), [docs/hab-messaging-spec.md:13](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/hab-relay-spec.md#L13-L13).

### HAB-F24 — Restore conservatively

Quiesce delivery and execution before restoring; reconcile original IDs, epochs, ACK/inbox, known Task/run and external outcomes before resuming. Back up and restore every state file of one generation together (Registry, delivery store, host owner, A2A files and each recipient's inbox and application state), never the delivery store alone, because an older delivery file rewinds receipts and ACKs. Keep a restored host stopped until the backup time plus one hour plus the largest max_clock_skew_ms has passed, so every message first sent before the backup has expired and cannot be delivered again. Compare copies of the replaced delivery store and recipient inboxes with the restored state by original sender and message ID: only acked proves a save, while expired and quarantined mean outcome unknown and the recipient's own inbox, Task results and execution records decide. Upgrading from the retired JetStream build migrates no messages: stop senders, wait one hour plus max_clock_skew_ms after the last acceptance so every old ID has expired, report unknown outcomes, then remove the old journal; the host refuses to start while jetstream-journal.sqlite remains. Rolling back drains the new store the same way before restoring the drained journal. Never resend a saved message under a new ID, replay uncertain work, extend expiry, dual-dispatch to old/new backends, or promise powerloss/all-copy durability from normal reopen/sync settings. No generic automatic replay or recovery executor is introduced.

Reason: Restoring old local proof can erase knowledge without undoing remote effects.

Scope: Backup/restore/migration and evidence claims. test/sqlite-delivery.test.js and test/host-service.test.js cover reopen, the legacy journal refusal and the retired config; the restore and upgrade procedures are operations gates. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/hab-messaging-spec.md:497](../../docs/hab-messaging-spec.md#L497-L503), [docs/hab-product-spec.md:167](../../docs/hab-product-spec.md#L167-L169), [docs/host-service.md:16](../../docs/host-service.md#L16-L27), [docs/hab-decisions.md:48](../../docs/hab-decisions.md#L48-L48), [docs/delivery-store.md:40](../../docs/delivery-store.md#L40-L58).

### HAB-F26 — Transport adoption is separate

The host's SQLite delivery store is the only delivery backend (ADR-018, superseding the JetStream choice of ADR-016), with no dual-send to a second store and no migration of messages held by a retired store. A2A is adopted (owner, 2026-11-12) as the agent-interoperability entry next to the five MCP tools: the host-owned identity entry, off by default. Its production deployment is a separate decision; do not dual-send the same request or infer closed-product wake/input capabilities from a standard.

Reason: Existing optional code and a successful lab do not decide production adoption.

Scope: Product0.1 transport adoption and rollout: the SQLite delivery store and the A2A entry are adopted; production deployment of either remains a separate gate. Decision: **proposed**.

Checks: proposal-review, production-operations.

Sources: [docs/hab-product-spec.md:136](../../docs/hab-product-spec.md#L136-L157), [docs/hab-product-spec.md:198](../../docs/hab-product-spec.md#L198-L204), [docs/hab-decisions.md:37](../../docs/hab-decisions.md#L37-L48), [docs/hab-decisions.md:60](../../docs/hab-decisions.md#L60-L68).

### HAB-F27 — Arrival notice before any work

When mail arrives, the recipient's agent screen shows the sender, the body and どうしますか？ with 対応する, あとで and 対応しない, found through hab_peek, which leaves the message unread. Arrival alone starts no model work. あとで keeps it unread and re-showable; 対応しない marks it read and starts nothing; only 対応する marks it read and hands the framed request to the same bound session, at most once across repeated or concurrent choices and restarts. A handoff that may or may not have reached the session is unknown and an absent entrance is unsupported; neither is retried or redirected to another session. The session itself replies with hab_reply.

Reason: The owner asked to be told on arrival and to decide before anything runs (ADR-021); a body or an arrival must not stand in for the user's choice.

Scope: src/agent-notify, hab_peek and the hab:notify CLI with the JSONL screen. Covered in js-root by test/agent-notify.test.js, test/hab-peek.test.js and test/hab-notify-cli.test.js. A product AgentScreen (Hermes Desktop) and acceptance in an existing product session are not covered. Decision: **accepted**.

Checks: js-root.

Sources: [docs/hab-decisions.md:95](../../docs/hab-decisions.md#L95-L105), [docs/receiver/arrival-notifier.md:60](../../docs/receiver/arrival-notifier.md#L60-L76).

### HAB-A01 — Common transport and recipient authority

Standard HAB transport authenticates and authorizes delivery; the receiving agent retains content judgment, execution and its existing approval rules. No product runner or product-specific approval layer is required by standard connection.

Reason: Transport consent and sender assertions cannot impersonate recipient-owner approval.

Scope: Standard common MCP Relay; legacy Task integration remains optional. Decision: **accepted**.

Checks: js-common-mcp, native-recipient, js-recipient-messages.

Sources: [docs/hab-security.md:5](../../docs/hab-security.md#L5-L5), [docs/host-service.md:147](../../docs/host-service.md#L147-L161), [docs/operations/persistent-mcp-auth.md:3](../../docs/operations/persistent-mcp-auth.md#L3-L6).

### HAB-A02 — Approved authentication groups

One approved authentication group may authenticate one or multiple registered addresses; addresses/inboxes remain distinct and credential sharing within that group is allowed. Product names do not determine authentication or delivery.

Reason: Provides practical shared host authentication without falsely claiming per-Bot credential isolation.

Scope: Every connection authenticates through a group; an address bound on its own is the only member of its group. Earlier direct 1:1 bindings move into such groups at migrate(). Decision: **accepted**.

Checks: js-root.

Sources: [docs/auth-groups.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/docs/relay-auth-groups.md#L5-L19), [docs/auth-groups.md:50](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/docs/relay-auth-groups.md#L50-L60), [src/hab/README.md:342](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/src/hab/README.md#L342-L367).

### HAB-A03 — Authorized own-side selection

Every basic operation validates selected own-side address membership, active state and intersected operation grants. Multiple ambiguous candidates, foreign-group names and expected ID mismatch fail closed. Submit destinations use separate cross-group delivery policy.

Reason: An address selector is a consistency/routing choice inside authenticated authority, not an authority grant.

Scope: Five HAB Relay operations in group mode. Decision: **accepted**.

Checks: js-root.

Sources: [docs/auth-groups.md:21](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-auth-groups.md#L21-L48).

### HAB-A04 — Stable send and receipt identities

Persist selected sender/receiver identity and resolved destination with original message intent; recovery reuses original outbox/inbox/ACK identity and never falls back by removing unsupported selectors or re-resolving to another recipient.

Reason: Prevents duplicate sends and cross-mailbox receipt substitution after restart or address/config change.

Scope: HAB common client and durable sender/receiver integration. Decision: **accepted**.

Checks: js-root.

Sources: [docs/auth-groups.md:27](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/docs/relay-auth-groups.md#L27-L46), [src/hab/README.md:109](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/src/hab/README.md#L109-L117), [src/hab/README.md:256](https://github.com/s-hiraoku/hiraoku-agent-base/blob/74c02b7e8e4b59d3c41eefe9c8949ddd554bd472/src/hab/README.md#L256-L263).

### HAB-A05 — Current authorization through commit

Recheck current credential, group membership, address/peer state and operation/block policy under registry write guard through Relay commit; bounded scoped authority cannot escape callback or revive stale contexts.

Reason: Closes revocation-versus-delivery races and prevents stale authorization reuse.

Scope: HAB Registry-composed SQLite delivery (HabDeliveryService); separate IO already sent cannot be retracted. Decision: **accepted**.

Checks: js-root, js-recipient-messages.

Sources: [src/hab/README.md:71](../../src/hab/README.md#L71-L107), [docs/auth-groups.md:54](../../docs/auth-groups.md#L54-L60), [docs/operations/oauth-ingress.md:102](../../docs/operations/oauth-ingress.md#L102-L104).

### HAB-A06 — Separate management authority

Delivery credentials/tools cannot create groups, enroll names, change membership, add operation grants or perform management rename. Management requires current separate host-verified authority and stable idempotent requests.

Reason: Receiving a message or selecting a known name must not expand trust or administrative rights.

Scope: HAB registry administration and all optional metadata tools. Decision: **accepted**.

Checks: js-root.

Sources: [docs/auth-groups.md:54](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-auth-groups.md#L54-L54), [docs/auth-groups.md:92](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-auth-groups.md#L92-L94), [src/hab/README.md:19](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/src/hab/README.md#L19-L40), [docs/agent-address-rename.md:46](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/agent-address-rename.md#L46-L51).

### HAB-A07 — Explicit schema and rollback boundary

Group schema migration runs at every migrate(), preserves existing identities and moves earlier direct bindings into single-member groups under the same binding IDs and fingerprints without changing effective rights, and refuses old runtimes. The operator CLI refuses an unmoved registry (registry_upgrade_pending). Never lower schema version or restore stale online state that resurrects revoked authority or loses accepted deliveries. Keep DB, keys, config and release in a consistent protected backup set.

Reason: Authority and delivery history must survive migration/recovery; version edits are not safe rollback.

Scope: Registry groupv1→v2 migration and deployment/recovery; proposed renamev3 remains separate. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/auth-groups.md:94](../../docs/auth-groups.md#L94-L94), [docs/host-service.md:206](../../docs/host-service.md#L206-L218), [docs/operations/persistent-mcp-auth.md:93](../../docs/operations/persistent-mcp-auth.md#L93-L108).

### HAB-A08 — Participation is separate from token lifetime

Persistent mode requires explicit OAuthv2 participation dates/state and a short-lived access-token maximum1–900seconds. Legacyv1 remains at most15minutes without auto-upgrade. Refresh cannot extend human participation, widen permissions or change group membership. Context expires no later than token or participation end.

Reason: Continuous use must not mean unbounded token authority or repeated manual recreation of stable identities.

Scope: Persistent Relay OAuthv2; actual production durations require separate concrete approval. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/operations/persistent-mcp-auth.md:8](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L8-L12), [docs/operations/persistent-mcp-auth.md:34](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L34-L46), [docs/operations/persistent-mcp-auth.md:61](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L61-L65), [docs/auth-groups.md:77](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-auth-groups.md#L77-L81).

### HAB-A09 — Host owns OAuth secrets and refresh

Relay stores approval/binding and validates tokens but does not issue, persist or refresh access/refresh-token bodies. Standard host OAuth client/issuer owns protected secret storage and refresh; failure/expiry/revocation stops use and reports required reauthentication.

Reason: Keeps credential lifecycle outside model and common message core, and prevents token refresh from granting new trust.

Scope: Relay ingress and common MCP host integration; real issuer/host compatibility remains acceptance work. Decision: **accepted**.

Checks: js-root, native-recipient.

Sources: [docs/auth-groups.md:77](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/relay-auth-groups.md#L77-L81), [docs/operations/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L6), [docs/operations/persistent-mcp-auth.md:124](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L124-L143).

### HAB-A10 — Persistent connections survive acceptance

Keep persistent connection configuration, grant, DB and store keys after a successful roundtrip. Revoke explicitly and narrowly for requested stop/incident, preserving revocation history; RT revocation alone does not prove immediate AT refusal.

Reason: Acceptance tests should not silently dismantle intended continuing service or erase recovery evidence.

Scope: Persistentv2; finitev1 trial cleanup remains a separate scoped runbook. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/operations/persistent-mcp-auth.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L3-L6), [docs/operations/persistent-mcp-auth.md:79](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/persistent-mcp-auth.md#L79-L91).

### HAB-A11 — Pinned Relay OAuth verification

Optional Relay OAuth ingress verifies operator-pinned RSA public keys, exact issuer and single canonical resource audience, verified subject/client, required five Relay scopes and bounded token times. Revalidate current configuration before issuing/using opaque contexts. Caller names, headers and unverified JWT claims cannot choose identity or keys.

Reason: Avoids unsigned authority, confused audiences, attacker-selected key fetching and stale async authentication.

Scope: Pinned Relay OAuth ingress; separate legacy Auth0 resource server has its own bounded JWKS cache contract. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/operations/oauth-ingress.md:53](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/oauth-ingress.md#L53-L76), [docs/operations/oauth-ingress.md:96](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/oauth-ingress.md#L96-L105).

### HAB-A12 — Explicit fail-closed local startup

Start only with explicit canonical owner-private bounded config/state/keys, required finite capacities and a verifier/audit. Missing/invalid configuration fails before usable operation; empty credential sets deny all. An out-of-range limit, including a `registry` limit, is refused at start as `config_invalid` naming its field, using the same schema the component itself enforces. No fixture fallback, automatic public bind, credential generation or product execution occurs.

Reason: Prevents accidental anonymous service, secret exposure and unbounded acceptance from example configuration.

Scope: Configured local Relay with its single `delivery` section, and optional ingress. Decision: **accepted**.

Checks: js-root.

Sources: [docs/operations/host-composition.md:3](../../docs/operations/host-composition.md#L3-L18), [docs/host-service.md:3](../../docs/host-service.md#L3-L7), [docs/host-service.md:16](../../docs/host-service.md#L16-L46), [docs/host-service.md:79](../../docs/host-service.md#L79-L84), [docs/operations/oauth-ingress.md:39](../../docs/operations/oauth-ingress.md#L39-L48).

### HAB-A13 — Owned release and service lifecycle

Use an explicitly reviewed pinned release/executable/config and stop only owned processes/listeners. Port/state collision fails without commandeering existing services; orderly stop closes resources and preserves accepted state and keys. LaunchAgent supervision does not imply recipient polling or execution.

Reason: Avoids interfering with unrelated services and overstating infrastructure readiness.

Scope: Local Relay host and optional user LaunchAgent runbook. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/operations/host-composition.md:15](../../docs/operations/host-composition.md#L15-L33), [docs/operations/host-launchagent.md:11](../../docs/operations/host-launchagent.md#L11-L24), [docs/operations/host-launchagent.md:63](../../docs/operations/host-launchagent.md#L63-L92).

### HAB-A14 — Discovery separates name and host identity

Opt-in read-only discovery distinguishes authenticated group, selected address, trusted host session attestation, registration and unobserved presence. Unknown/stale attestation stays unknown; no inferred offline/available/ownership. Directory remains own-group scoped and occupancy checks neither reserve nor grant.

Reason: Shared credentials and registration are not proof of which real Bot/session is running.

Scope: Optional hab_discover; basic five-tool behavior remains default. Decision: **accepted**.

Checks: js-root, native-recipient.

Sources: [docs/connections/mcp-agent-discovery.md:20](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/mcp-agent-discovery.md#L20-L36), [docs/connections/mcp-agent-discovery.md:44](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/mcp-agent-discovery.md#L44-L63), [docs/connections/mcp-agent-discovery.md:75](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/mcp-agent-discovery.md#L75-L99), [docs/connections/mcp-agent-discovery.md:107](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/mcp-agent-discovery.md#L107-L115), [docs/connections/mcp-agent-discovery.md:136](https://github.com/s-hiraoku/hiraoku-agent-base/blob/1f5b492664707fe60c007442bda6f24d1756ee3d/docs/mcp-agent-discovery.md#L136-L148).

### HAB-A15 — Limited trial durable ACK evidence

Before a trial ACK persist complete original envelope and exact generation/lease/ACK request in private per-address durable storage, independently reread and compare, then use that exact request for ACK/reconciliation. Poll/ACK or model conversation memory alone does not prove durable handoff.

Reason: Separates wire acknowledgements from receiver-owned durable evidence without claiming broad exactly-once or crash guarantees.

Scope: Finite single-consumer trial recipe; coordinator must map stronger common Adapter/supervisor requirements separately. Decision: **accepted**.

Checks: mcp-durable-roundtrip, ack-observer-controls.

Sources: [docs/operations/oauth-ingress.md:120](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/oauth-ingress.md#L120-L135).

### HAB-A16 — Redacted evidence and honest identity provenance

Do not publish secrets, live tenant/client/subject values, personal conversation, DB/config/logs or credentials. Record group and selected identity separately without claiming unique Bot execution; hashes and synthetic fixture roundtrips do not prove live process identity, real OAuth refresh or deployment.

Reason: Verification evidence must be safe to publish and accurately bounded.

Scope: Public repository and verification output; detailed audit formats remain subsystem-specific. Decision: **accepted**.

Checks: source-publication.

Sources: [docs/hab-security.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/hab-security.md#L23-L31), [docs/auth-groups.md:60](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-auth-groups.md#L60-L60), [docs/auth-groups.md:96](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/relay-auth-groups.md#L96-L100), [docs/operations/persistent-mcp-auth.md:136](https://github.com/s-hiraoku/hiraoku-agent-base/blob/d307da1ea3fa049fa79b66748f5ed4f16f19dfc0/docs/persistent-mcp-auth.md#L136-L143).

### HAB-A18 — Address rename keeps identity and reserves old names

Rename is adopted (owner, 2026-11-12) as an explicit administrator operation within the same agent_name namespace. It retains the immutable agent ID and authority/mailbox identities; every previous name stays permanently reserved to that ID. For a grace period (default 30 days) an old name resolves only to its own ID and is accepted as that ID's own as_address; afterwards it is refused. It is never an alias to another ID. Separate rename permission, CAS and migration approval are required. The grace period is the registry option rename_grace_days; each use of a previous name is counted per caller ID, and hab:admin status lists previous names and warns when the host config still names one.

Reason: Changing names must not reassign authority or silently resolve deployment policy.

Scope: Opt-in registry v3 rename with the grace-period resolution; deployment migration needs separate approval. Decision: **proposed**.

Checks: proposal-review.

Sources: [docs/agent-address-rename.md:3](../../docs/agent-address-rename.md#L3-L48), [docs/agent-address-rename.md:50](../../docs/agent-address-rename.md#L50-L66), [docs/agent-address-rename.md:104](../../docs/agent-address-rename.md#L104-L112).

### HAB-A19 — Group stop is total and re-grants nothing

Stopping a group, setting its access to stopped or retired, or revoking its last binding stops every active member address and clears its operations in the same transaction. Reactivating or rebinding the group re-grants no address: each member is granted again only by its own explicit access change, so a sibling an operator disconnected stays stopped when another member reconnects. Omitted own-side selection counts only active members.

Reason: A group stop revokes shared authority. Members that stay active, or that a later reconnect of one address silently revives, would undo an operator's disconnect.

Scope: Registry authentication-group mode and the hab:admin group disconnect and reconnect. Decision: **accepted**.

Checks: js-root.

Sources: [docs/auth-groups.md:56](../../docs/auth-groups.md#L56-L56), [src/hab/README.md:365](../../src/hab/README.md#L365-L372), [docs/host-service.md:124](../../docs/host-service.md#L124-L129), [.claude/skills/verify-hab/features/configured-host.md:12](../../.claude/skills/verify-hab/features/configured-host.md#L12-L12).

### HAB-A20 — Management connect is atomic and explicit

A group connect creates the group, binds the connection and adds the first address in one Registry transaction, so a refused step (such as binding capacity) leaves no group behind and a retry converges. That transaction requires every right the three separate operations need (group_create, group_bind and group_member), so a context missing any one of them is refused and creates no group, binding or member. An explicitly empty operation list is refused as `invalid_operations`, never read as the default grant of all operations. Every management connect goes through a group; `registry.authentication_groups` in an older config is accepted and ignored.

Reason: Management requests change authority. A partial or misread request must fail without orphan state and must never grant more than the operator named.

Scope: Operator management CLI (`hab:admin connect`) and the Registry `createBoundGroup` port. The per-operation rights are implementation evidence (src/hab/sqlite-registry.ts in source-review.json), covered in js-root by test/hab-auth-groups.test.js; no document states them separately. Decision: **accepted**.

Checks: js-root.

Sources: [src/hab/README.md:373](../../src/hab/README.md#L373-L374), [docs/host-service.md:129](../../docs/host-service.md#L129-L132), [.claude/skills/verify-hab/features/configured-host.md:13](../../.claude/skills/verify-hab/features/configured-host.md#L13-L13).

### HAB-A21 — Host A2A identity cannot act as a confused deputy

A2A is off unless the host config has an `a2a` section; without it there is no listener, mailbox file or host identity. When enabled, startup converges the configured identity address idempotently onto one active agent whose only live binding is the reserved in-process principal `urn:hab:host` with ack/poll/status/submit, and refuses to start with a2a_identity_conflict, a2a_identity_revoked, a2a_identity_stopped or a2a_identity_retired instead of repairing such an identity. The identity has no wire credential: an operator or OAuth principal with the `urn:hab:host` issuer authenticates as nobody, and hab:admin connect refuses the identity address with a2a_identity_reserved. Every A2A request is verified with the caller's own credential, whose audience must be the A2A endpoint. The caller must currently hold resolve and submit and be allowed to send execution_request to the configured recipient; that check repeats inside the Registry guard that commits the outbox record and around each send. The host identity's submit runs inside a Registry transaction that first repeats the caller check, because a withAuthorization called inside another's callback joins its transaction, so a revocation from another connection commits either before that check, which refuses the send, or after the message is admitted, never between them. The caller cannot choose sender, recipient, kind or body. Tasks are scoped to the caller's agent ID and the recipient tenant, so another caller cannot read them, and a revoked grant or disconnection makes them unreachable. The fixed host principal remains reserved to its original agent after revocation. Disconnect is a permanent A2A off switch for this Registry; changing the identity address cannot undo it. Removing the a2a section permits MCP-only startup without deleting stored history. No identity rotation or revocation reset is provided.

Reason: The host identity submits under its own rights. Without a current per-request check of the caller it could deliver to a recipient the caller cannot reach, or expose another caller's replies.

Scope: Opt-in host A2A entry (src/host/a2a.ts) with the local bearer verifier only; the OAuth ingress does not serve A2A, and a group-authenticated caller with several addresses is refused. Covered in js-root by test/a2a-host.test.js. Decision: **accepted**.

Checks: js-root.

Sources: [docs/a2a/a2a-host-preview.md:67](../../docs/a2a/a2a-host-preview.md#L67-L67), [docs/a2a/a2a-host-preview.md:84](../../docs/a2a/a2a-host-preview.md#L84-L94), [docs/a2a/a2a-host-preview.md:98](../../docs/a2a/a2a-host-preview.md#L98-L100), [docs/a2a/a2a-host-preview.md:104](../../docs/a2a/a2a-host-preview.md#L104-L106), [docs/hab-decisions.md:45](../../docs/hab-decisions.md#L45-L45), [docs/host-service.md:193](../../docs/host-service.md#L193-L203), [src/hab/README.md:81](../../src/hab/README.md#L81-L88).

## Delivery

### HAB-D01 — Shared model-free communication core

Relay wire/core and explicit receive/send cycles transport opaque ordered content without product SDK, model, shell or Task execution; recipient-local integration decides processing separately. Ordinary MCP delivery tools do not expose maintenance, release or execution.

Reason: A shared language-neutral message path must not inherit any product-specific execution/approval semantics.

Scope: Relay/HAB common delivery and recipient orchestration Decision: **accepted**.

Checks: ast-boundary, js-common-mcp.

Sources: [src/agent-sdk/README.md:3](../../src/agent-sdk/README.md#L3-L5), [src/agent-sdk/README.md:9](../../src/agent-sdk/README.md#L9-L9), [docs/hab-messaging-spec.md:82](../../docs/hab-messaging-spec.md#L82-L91), [docs/hab-messaging-spec.md:441](../../docs/hab-messaging-spec.md#L441-L441).

### HAB-D02 — Durable recipient save before ACK

The recipient commits the exact body, dedup identity and stable ACK request before issuing ACK. A failed save sends no ACK; repeated delivery and lost ACK response recover original body/receipt without duplicating inbox entries or claiming execution.

Reason: ACK authorizes server body disposal, so a committed local receive record must exist first.

Scope: DurableReceiver and recipient-owned SQLite inbox/ACK journal Decision: **accepted**.

Checks: js-common-mcp, mcp-durable-roundtrip, js-process-crash.

Sources: [src/agent-sdk/README.md:9](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/src/agent-sdk/README.md#L9-L9), [src/agent-sdk/README.md:17](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/src/agent-sdk/README.md#L17-L17), [docs/hab-messaging-spec.md:260](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L260-L261), [docs/hab-messaging-spec.md:291](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L291-L291).

### HAB-D03 — Immutable versioned message identity and lifetime

Preserve opaque IDs, JSON keys/strings and body part order under strict version/schema limits; sender is derived from verified policy, timestamps are canonical UTC and original lifetime is exactly one hour. Replays cannot change payload, destination, identity or extend deadline.

Reason: Cross-language transport and replay must have one consistent semantic message identity.

Scope: Version1 common Relay envelope Decision: **accepted**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:183](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L183-L194), [docs/hab-messaging-spec.md:219](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L219-L221), [docs/hab-messaging-spec.md:227](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L227-L231), [docs/hab-messaging-spec.md:372](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L372-L372).

### HAB-D04 — Current authority and one fenced recipient lease

Use current verified operation and sender/kind policy, at most one live recipient lease, bounded scan and original expiry. Initial ACK requires current generation/token/lease; exact committed retry recovers the same delivery receipt without granting execution, using current authority.

Reason: Stale credentials/leases and caller-selected identities must not cross an immutable individual boundary.

Scope: Server poll/ACK in the SQLite delivery store, HAB's only delivery backend. The spec's lease and ACK order states the rules; docs/delivery-store.md places them in the store transaction. Decision: **accepted**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:287](../../docs/hab-messaging-spec.md#L287-L289), [docs/hab-messaging-spec.md:293](../../docs/hab-messaging-spec.md#L293-L300), [docs/delivery-store.md:7](../../docs/delivery-store.md#L7-L7), [docs/delivery-store.md:17](../../docs/delivery-store.md#L17-L19).

### HAB-D05 — Bounded recovery keeps unknown outcomes

Persist original immutable intent before network. Recovery uses exact original IDs/body/expiry/ACK requests and finite persisted backoff/attempt/status horizons. Timeout, invalid/missing response, audit failure after commit or status not_found alone do not prove non-delivery; exhaustion may become quarantined/expired_unknown, never replacement message or automatic identity switch.

Reason: An uncertain side effect cannot be rolled back by pretending a failed response means no commit.

Scope: Sender/outbox and all HTTP/async boundaries Decision: **accepted**.

Checks: js-root.

Sources: [src/agent-sdk/README.md:11](../../src/agent-sdk/README.md#L11-L11), [src/agent-sdk/README.md:23](../../src/agent-sdk/README.md#L23-L23), [src/agent-sdk/README.md:27](../../src/agent-sdk/README.md#L27-L27), [docs/hab-messaging-spec.md:257](../../docs/hab-messaging-spec.md#L257-L258), [docs/hab-messaging-spec.md:304](../../docs/hab-messaging-spec.md#L304-L306), [docs/delivery/writer-admission.md:42](../../docs/delivery/writer-admission.md#L42-L44).

### HAB-D06 — Delivery, reading, application handoff and execution remain separate

Inbox is a received-message record, not execution queue. Local handoff requires separately durable application save deduplicated by sender/message before explicit release; ACK confirmation and release are independent. No read/release/receipt alone proves exactly-once application effects or Task acceptance. Unreleased body is retained under finite backpressure. The record and byte quotas count unreleased bodies only, so a release frees a slot at once, while a separate finite `max_ack_records` bound limits the dedup history, counted by message, that every saved message enters; a released tombstone still deduplicates. A lease redelivery of a message already in that history adds an ACK row for its new generation without taking another slot, and one message keeps at most `max_attempts` generations (a further one is refused with `inbox_capacity_exceeded`), so the ACK table holds at most `max_ack_records × max_attempts` rows. `releaseUnconfirmable` releases, without handing it to the application, only a body whose receipt can no longer be confirmed: its ACK is unconfirmed, the message has expired so no new generation can be saved, and no ACK request is pending; otherwise it changes nothing, and the released tombstone still deduplicates. Rows of any kind are capped at `max_records + max_ack_records`. A legacy (non-replay-bound) ID's tombstone is never collected, because a replay of it could not be told from a new message, so legacy-ID rows are capped at `max_ack_records`: a new legacy ID past that is refused with `inbox_legacy_id_capacity_exceeded`, replay-bound IDs keep the `max_records` body budget, and a held legacy ID stays deduplicated and is never handed off again. hasCapacityFor(records, bodyBytes) is a read-only check for new replay-bound messages against body/byte, per-message ACK-history and retained-row bounds; it neither reserves nor collects and never shortens retention from actual local terminal time. An optional original-source (sender_id, message_id) hint limits SQLite inbox reads through an additive partial expression index over unreleased bodies. It includes pending ACKs, preserves ordering, excludes released empty bodies, and changes neither record format/version nor retention. The hint never replaces receipt, identity, reference, thread, schema or current-authorization checks; unfiltered route implementations remain compatible.

Reason: Receiver storage and user processing have different lifetimes and authority boundaries.

Scope: Recipient-local body lifecycle. The quota and row bounds, the per-message ACK history, the `max_attempts` generation cap `releaseUnconfirmable` and the collection of replay-bound IDs over repeated retention cycles are covered in js-root by test/inbox-maintenance.test.js. The same suite covers the read-only capacity gate and unchanged terminal-time retention. Decision: **accepted**.

Checks: js-root, native-recipient.

Sources: [src/agent-sdk/README.md:19](../../src/agent-sdk/README.md#L19-L19), [docs/hab-messaging-spec.md:261](../../docs/hab-messaging-spec.md#L261-L261), [docs/hab-messaging-spec.md:392](../../docs/hab-messaging-spec.md#L392-L394), [docs/a2a/a2a-host-preview.md:55](../../docs/a2a/a2a-host-preview.md#L55-L55).

### HAB-D07 — Bounded metadata collection preserves replay safety

Explicit finite maintenance erases expired server body and only collects terminal metadata after required original expiry/terminal/ACK or status retry horizons plus retention. Reads/exact retry do not renew dates. Time-bound rm1 IDs bind original timestamp; legacy or malformed opaque identities remain safety-held instead of opening a replay window. Safety-held records never take a maintenance batch slot, so a held backlog cannot starve collection of due replay-bound records. Logical deletion does not imply physical erase or backup removal.

Reason: Finite storage cannot erase dedup evidence while stale requests remain admissible.

Scope: SQLite delivery store (server, docs/delivery-store.md), and the agent SDK's sender outbox and receiver inbox tombstone maintenance. Replay-bound retention cycles are covered for the inbox in js-root by "replay-bound IDs are collected every retention cycle, so new IDs keep saving within the row bound and a collected ID is never handed off again" (five cycles under a one-slot cap: nothing collected before retention ends, every row collected after it, a replay of a collected ID refused as expired_delivery), and for the journal by the P7 nats-producer case "replay-bound IDs cycle through the record cap every retention period, and a collected ID is never delivered again" (three cycles under a two-record cap with a mocked clock: capacity_exceeded until collection, a replay inside retention answered with the acked receipt and not delivered, a collected ID refused as expired_before_acceptance and not delivered). Decision: **accepted**.

Checks: js-root, current-hosted-ci, production-operations.

Sources: [src/agent-sdk/README.md:10](../../src/agent-sdk/README.md#L10-L12), [src/agent-sdk/README.md:23](../../src/agent-sdk/README.md#L23-L23), [docs/hab-messaging-spec.md:388](../../docs/hab-messaging-spec.md#L388-L390), [docs/hab-messaging-spec.md:398](../../docs/hab-messaging-spec.md#L398-L400), [docs/delivery-store.md:28](../../docs/delivery-store.md#L28-L28).

### HAB-D08 — Attachments are explicit bounded optional composition

Retired (historical): managed attachments were removed. The contract has no attachment part and the upload, binding, read and attachment MCP/HTTP modules were deleted. HAB-D18 replaces this requirement with refusal of attachment parts. Original accepted statement, kept for provenance: Defaults continue rejecting attachment storage/delivery until required host ports are explicitly connected. Original verified owner, immutable intent and manifest bind one-hour message identity; finalize, acceptance, receipt, execution are separate. Strict finite chunks/codecs prohibit arbitrary URL/path/free tool or body execution.

Reason: The removed design cannot be verified against code that no longer exists. Keeping the ID with its original text preserves provenance without enforcing it.

Scope: Removed attachment upload/read/admission/delivery/client; no current scope. Decision: **historical**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:225](../../docs/hab-messaging-spec.md#L225-L225), [README.md:122](../../README.md#L122-L122).

### HAB-D09 — Verified local attachment bytes gate body save and ACK

Retired (historical): the attachment inbox, receive checkpoint and AttachmentReceiver were deleted. DurableReceiver save-before-ACK (HAB-D02) is the only receive path. Original accepted statement, kept for provenance: Durably stage original-message chunks with original offset and integrity, verify all declared files/lengths/order/SHA including empty files, and recheck retained bytes under synchronous guard before body/ACK save and ACK claim. Missing, corrupt, unverified or prematurely released bytes cause no ACK. Checkpoint cannot issue ACK and does not replace body inbox.

Reason: Attachment bytes no longer exist on any path, so the gate has nothing to protect.

Scope: Removed AttachmentInbox and AttachmentReceiver; no current scope. Decision: **historical**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:223](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L223-L223).

### HAB-D10 — Cross-DB commits reconcile original records

Retired (historical): the upload acceptance, attachment outbox handoff, receive checkpoint and attachment deletion stores were deleted, so these cross-DB commit pairs no longer exist. HAB-D05 still covers original-ID recovery for messages. Original accepted statement, kept for provenance: Treat prepare→Relay commit→confirm, source→outbox handoff, body save→checkpoint clear and deletion→job done as independent commits, not distributed rollback. Preserve original reservations/intent/body/checkpoint where needed and reconcile original ID/job/receipt/fence after response or local commit uncertainty. No new IDs or deadline extension.

Reason: The independent stores this requirement coordinated were removed.

Scope: Removed attachment upload acceptance, outbox handoff, checkpoint and server deletion; no current scope. Decision: **historical**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:223](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L223-L223).

### HAB-D11 — Terminal disposal and local release are distinct

Retired (historical): attachment terminal deletion jobs and retained recipient bytes were removed. Relay schema 6 drops the deletion tables and inbox schema 4 drops the attachment columns. Original accepted statement, kept for provenance: ACK/expiry atomically stores exact minimal protected deletion job with server terminal state/body erasure/audit; unfinished jobs prevent ownership GC. A finite maintenance-authorized fenced worker deletes only exact terminal binding bytes and reconciles unknown completion. Server access closes at ACK; local verified bytes remain until explicit durable application handoff and ACK reconciliation permit release.

Reason: No attachment bytes are stored, so there is no deletion job or retained blob to track.

Scope: Removed server attachment deletion and recipient retained bytes; no current scope. Decision: **historical**.

Checks: js-root, production-operations.

Sources: [docs/hab-messaging-spec.md:223](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/docs/hab-relay-spec.md#L223-L223).

### HAB-D12 — Admission capacity is finite and atomic

Host-selected positive finite count/byte/record caps and minimum reservations are evaluated using verified immutable identity and persisted usage in the same admission transaction. Exact replay/conflict precedes new quota; retained metadata still counts, and capacity shrink does not discard accepted work.

Reason: Backpressure protects other individuals and bounded storage without corrupting recovery evidence.

Scope: Required delivery.queue.agent_capacity policy in the SQLite delivery store. The attachment owner_capacity policy was removed with attachments. Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/delivery/agent-capacity.md:3](../../docs/delivery/agent-capacity.md#L3-L25).

### HAB-D13 — Scope fair selection separately from rate and execution

Fair polling durably advances bounded sender/message cursors with lease/audit while denied candidates consume no delivery attempt; keep one live recipient lease and rollback corruption. Shared one-process writer uses finite identity map/queues, monotonic token bucket, fresh identity before callback and no DB locks while waiting. Retain active slot until actual callback/audit settles after timeout. Neither mechanism guarantees byte/time/model fairness, fleet rate or SLO.

Reason: Choice-count fairness and finite process admission must not be advertised as end-to-end execution scheduling guarantees.

Scope: Opt-in delivery.queue.fair_poll in the SQLite delivery store and WriterAdmission Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/delivery/fair-poll.md:3](../../docs/delivery/fair-poll.md#L3-L25), [docs/delivery/writer-admission.md:5](../../docs/delivery/writer-admission.md#L5-L27), [docs/delivery/writer-admission.md:40](../../docs/delivery/writer-admission.md#L40-L46).

### HAB-D14 — Snapshot restore requires offline original-ID reconciliation

Retired (historical): SQLiteSnapshotBundle was deleted with the attachment modules and its document was removed. Whole-state backup and restore of the SQLite delivery store stays an operations gate (docs/delivery-store.md) under HAB-F24 and the open HAB-C-D04. Original accepted statement, kept for provenance: Capture every DB in one fixed profile under all writer locks, validate private canonical owner/schema/bytes, preserve signed fixed-file manifests and never overwrite existing state. Exclude authority/config/secrets/Task and do not roll back current stop/revocation. Restore only new offline directory; marker is not an enforcement boundary. Host must quiesce IO and reconcile original receipts/IDs/leases/current authority and unknown remote effects before promotion.

Reason: The snapshot profiles named the retired SQLite Relay store and attachment DBs, none of which exist now.

Scope: Removed SQLiteSnapshotBundle profiles; no current scope. Decision: **historical**.

Checks: js-root, production-operations.

Sources: [docs/delivery-store.md:42](../../docs/delivery-store.md#L42-L44).

### HAB-D15 — SQLite delivery commits store rules, admission and recipient receipt distinctly

Keep a synchronous fresh Registry guard around each durable admission, status, poll and ACK; no Promise crosses it. The host's SQLite delivery store is the only delivery backend (ADR-018): each store rule (reciprocal pair-scoped replies, global/recipient/per-sender capacity and reservations, exact retry without new capacity, one application lease, fair poll, body fingerprint check) commits in the transaction that changes the state, and admission commits the body with the record. No broker, pump, outbox or second store exists, and a config naming broker or pump is refused. Recipient saves first; the saved HAB ACK then releases the body and never means Task completion.

Reason: Removing the broker must preserve the common message and receiver-owned execution contract without a second store to reconcile.

Scope: HAB SQLite delivery store, the only delivery backend. The broker, pump, outbox, router and routing epochs were retired. Decision: **accepted**.

Checks: js-root, current-hosted-ci.

Sources: [docs/delivery-store.md:3](../../docs/delivery-store.md#L3-L3), [docs/delivery-store.md:7](../../docs/delivery-store.md#L7-L9), [docs/delivery-store.md:13](../../docs/delivery-store.md#L13-L20), [docs/delivery-store.md:24](../../docs/delivery-store.md#L24-L24).

### HAB-D16 — Private persistent volume and bounded durability claims

Keep the delivery store in one private regular file (no symlink, owner-only mode, known schema and key) with synchronous=FULL on the configured persistent volume. Volume marker/device checks fail closed before each operation without fallback state. Whole deployment recovery and power/corruption/partition safety remain separate from local functional tests and single-host proof; one VM and one volume form one failure domain.

Reason: A passing reopen test or a pragma setting is not evidence that a chosen host survives physical faults.

Scope: SQLite delivery store host operations and verification evidence Decision: **accepted**.

Checks: js-root, production-operations.

Sources: [docs/delivery-store.md:36](../../docs/delivery-store.md#L36-L38), [docs/delivery-store.md:62](../../docs/delivery-store.md#L62-L62).

### HAB-D18 — Attachment parts are refused on every delivery path

The version-1 contract has no attachment part type or attachment limits. A submission that carries an attachment part, in any position, or a policy that carries a former attachment limit key fails validation before storage on the contract, MCP submit and delivery store paths. No attachment store, upload or download tool exists.

Reason: Removing managed attachments must not leave a partial path that accepts bytes the system can no longer store, deliver or delete.

Scope: Version-1 messaging contract, MCP submit and the SQLite delivery store Decision: **accepted**.

Checks: js-root.

Sources: [docs/hab-messaging-spec.md:225](../../docs/hab-messaging-spec.md#L225-L225), [docs/hab-messaging-spec.md:554](../../docs/hab-messaging-spec.md#L554-L554), [.claude/skills/verify-hab/features/send-message.md:12](../../.claude/skills/verify-hab/features/send-message.md#L12-L12).

### HAB-D19 — Delivery audit is atomic and redacted

The SQLite delivery store records accepted, leased, requeued, quarantined, expired and acked events with sender, message ID and time only, never body or token, in the same transaction as the state change. An audit failure rolls back that admission, lease or ACK including its capacity use. Missing maintenance totals fail closed instead of losing counts.

Reason: Audit evidence must not diverge from delivery state or leak content.

Scope: SQLite delivery store audit and maintenance totals Decision: **accepted**.

Checks: js-root, current-hosted-ci.

Sources: [docs/delivery-store.md:32](../../docs/delivery-store.md#L32-L32), [.claude/skills/verify-hab/features/README.md:22](../../.claude/skills/verify-hab/features/README.md#L22-L22).

### HAB-D20 — Host A2A sends only inside the owner's request

The host A2A outbox, inbox and SDK Task store are private 0600 files in the host state directory; a saved Task, its send intent and received replies survive a host restart, and a replay reuses the original message ID and one-hour expiry. A saved intent is sent only inside its owner's authorized SendMessage, which claims only that message ID from the shared outbox. There is no background submit retry; a retry is a repeated SendMessage with the same messageId. The only background work is the receiver loop, which polls the host mailbox and classifies each delivery before saving anything. A new reply ID is classified against the stored Task and only ACK-confirmed held replies. If it cannot change that state or is refused by validated contract/schema rules, it is discarded with ACK and no inbox record. If it would change that state but would be redundant or conflicting assuming an unconfirmed held reply became usable, it is deferred without save or ACK. Unexpected preview failures also defer rather than proving redundancy. A deferred delivery remains subject to finite relay leases, attempts and TTL, so it may quarantine or expire; recovery is not guaranteed. An ID already held still reaches the inbox for deduplication and ACK confirmation. Unconfirmed replies are never applied. Any other delivery is ACKed without an inbox record or ACK history entry, so unrelated senders spend none of the capacity replies need; dropping it again on a redelivery is harmless, so it needs no dedup record. At most once a minute the loop runs bounded inbox and outbox maintenance. Window closure uses at most 100 overdue Tasks per receive cycle, ordered and paged by the complete stable (tenant, owner, id) key. The cursor advances past individual failed applies; a full page schedules another cycle, and the end resets the cursor for the next scheduled pass. The earliest open window or at most one minute schedules that pass. Thus a failed full batch does not permanently hide later Tasks, but a backlog or persistent storage failure does not promise every transition within one cycle. `max_records` caps the outbox. The inbox holds `2 × max_records` unreleased reply bodies, one `execution_accepted` and one `execution_result` per host message, so an accepted reply never takes the slot its own result needs. The receiver loop applies each ACKed reply to its Task and releases the body once the Task store holds the new state; a reply the Task refuses (a conflict, a malformed body, such as a late reply to a terminal Task, or one over the A2A contract limits) is released the same way, and any other failure keeps the body for the next cycle. A successful durable apply releases the body even without a caller read; unexpected storage failures retain it for retry. A saved reply whose ACK never committed is never applied; once it has expired with no ACK request pending, so no redelivery can confirm it, the loop releases its body unread with `releaseUnconfirmable` and keeps its tombstone for dedup, and its Task waits for another reply or for its reply window to close. A reply is saved only while the current time is before its request's expiry plus one day (the reply window); a later reply is ACKed without a record and does not change its Task. Each outbox record is kept for at least the reply window plus the one-day ACK retry plus two hours past its expiry, then 30 days. That horizon alone cannot outlive an ACK first made terminal after a long stop: the required 30 days from its actual local terminal time are preserved. Maintenance collects the inbox first, then computes a bounded outbox collection allowance. Let M be max_records, T be retained outbox rows, W be retained sources whose reply windows are still open (expires_at > now minus one day), and p be proposed collected rows. It binary-searches p from 0 through 100 against room for 2 × (max(0, M - T + p) + W) new replies. For T <= M this equals 2 × (F + W + p), where F = M - T. If an operator lowers M below T, collecting excess rows creates no usable sender slots until the count falls below M. The check includes those replies and their maximum envelope bytes, checking unreleased body/byte, distinct-message ACK-history and all retained-row capacities. This preserves two future replies for each free slot and open source before freeing additional sender slots. The snapshots and numeric-cap collection have no intervening await in the single-owner host. Only eligible rows are collected, and expiry still runs even when the allowance is zero. This is conservative capacity accounting, not a multi-writer reservation or shortened retention. The inbox keeps an ACK history of three times `max_records` messages for the same 30 days, counted per message, so the lease redeliveries of one reply (up to `max_attempts` generations) take a single slot. A blocking SendMessage holds the handler's Task serializer only for each 25 ms check, which reloads the stored Task, so the receiver loop applies replies during the five-second wait and a result saved in a later receive cycle than its acceptance completes the Task. On close the host refuses new A2A requests with 503 and waits for in-flight requests and the current receiver cycle before closing its stores, leaving unsent intents, unACKed deliveries and saved Tasks on disk. Closing the Task store must close its eagerly opened SQLite connection even if the lazy SDK database driver was never initialized by a load/save, and repeated close is safe. An optional original-source (sender_id, message_id) hint limits SQLite inbox reads through an additive partial expression index over unreleased bodies. It includes pending ACKs, preserves ordering, excludes released empty bodies, and changes neither record format/version nor retention. The hint never replaces receipt, identity, reference, thread, schema or current-authorization checks; unfiltered route implementations remain compatible.

Reason: A background resend under the host identity would send without a current check of the caller who asked for it; save-before-ACK keeps replies recoverable across a crash.

Scope: Opt-in host A2A entry, one host process per state directory. Not multi-host writer coordination, production retention or capacity design. Covered in js-root by test/a2a-host.test.js, including results saved when accepted replies fill the cap, unread completed Tasks freeing their slots after the outbox purge, a Task admitted after a purge whose replies are saved after a late reply, unconfirmable saved replies that release their slots so a later reply still completes its Task, and a blocking SendMessage completing from a result in a later receive cycle than its acceptance. Its case "a saved confirmed reply that breaks the A2A contract limits is released as refused and leaves its Task unchanged" saves and ACK-confirms, offline, an execution_result whose data part is over HAB_A2A_LIMITS, then checks that the running host releases the body instead of retrying it every cycle and that the Task stays SUBMITTED. Its case "a flood of fresh-ID replies that would not change the Task takes no ACK history, so the valid result still completes it" sends more repeated acceptances, conflicting acceptances and refused results under fresh IDs than the `3 × max_records` ACK history holds, then a valid result, and checks that the result completes the Task with only two inbox rows. "when the running host loses its own ACK of a saved result, the reply expires unapplied and a new result still completes the Task" drops the running host's ACKs of one result at its delivery-service transport while the result is live, then checks the real relay's invalid_ack, the unapplied release and completion from a new result. "a Task whose reply window closes while the host runs fails within seconds, not at the next once-a-minute maintenance" covers the window timing (HAB-E20). The long-stop regression uses a 500 ms lease and injected host ACK transport failures to leave acceptance and result ACKs pending before one stop. It models 40 days offline by shifting timestamps and replay-bound IDs, verifies new Task refusal while local-terminal history is retained, then models another 31 days and verifies admission and both replies recover through normal maintenance. It is not a real 71-day outage or an unconditional downtime claim. This gate prevents future outbox collection; it does not restore source slots an earlier build already purged, repair already lost/quarantined results, or establish spare capacity in an existing deployment. Before resuming an affected deployment, quiesce new A2A admissions and let normal inbox maintenance and the full 30-day retention from actual local terminal time restore sufficient capacity. Do not delete history, shorten retention or re-execute Tasks with unknown outcomes. The bounded allowance remains conservative and does not repair previously lost admission reservations. No live deployment has been checked. test/a2a-sdk-store.test.js covers unused eager connection closure after direct host maintenance reads, closure after SDK initialization, safe repeated close and reopening. This demonstrates the lifecycle defect and its repair, not a universal cause or repair for malformed databases. The outage fixture now ages first_sent_at consistently with the replay-bound ID and expires_at, uses the host Task-store driver for offline Task metadata changes and checks integrity before reopening. It checks the old Task reaches FAILED after its result window and retries only outbox_capacity_exceeded, surfacing other errors immediately without increasing the timeout. A held confirmed body is retained on an unexpected per-Task save failure; no exception-based blanket release is allowed. The mixed-cohort regression injects that failure for one legitimate Task, verifies partial collection and another Task completing while the body remains, then removes the fault and verifies recovery. It does not repair malformed SQLite pages, a globally failed database or invalid JSON that prevents inbox enumeration. Cohort aging changes rm1 IDs and timestamps consistently but does not refresh fingerprints, so it is maintenance/capacity evidence, not a whole-state restore proof. The shutdown controls demonstrate a saved Task retrying under its original identity after close, and synchronous claim-to-admission before a queued close; no normal-shutdown race fix is claimed. The overdue control injects 100 per-Task save failures before a healthy later Task, then removes the fault and checks wrap/retry. It does not establish corrupt metadata reachability through the API. Decision: **accepted**.

Checks: js-root.

Sources: [docs/a2a/a2a-host-preview.md:109](../../docs/a2a/a2a-host-preview.md#L109-L111), [docs/a2a/a2a-host-preview.md:132](../../docs/a2a/a2a-host-preview.md#L132-L132), [.claude/skills/verify-hab/features/a2a-host.md:40](../../.claude/skills/verify-hab/features/a2a-host.md#L40-L40), [docs/a2a/a2a-host-preview.md:80](../../docs/a2a/a2a-host-preview.md#L80-L80), [docs/a2a/a2a-host-preview.md:105](../../docs/a2a/a2a-host-preview.md#L105-L105), [docs/a2a/a2a-host-preview.md:53](../../docs/a2a/a2a-host-preview.md#L53-L53), [.claude/skills/verify-hab/features/a2a-host.md:45](../../.claude/skills/verify-hab/features/a2a-host.md#L45-L45), [.claude/skills/verify-hab/features/a2a-host.md:14](../../.claude/skills/verify-hab/features/a2a-host.md#L14-L14), [.claude/skills/verify-hab/features/a2a-host.md:39](../../.claude/skills/verify-hab/features/a2a-host.md#L39-L39), [docs/a2a/a2a-host-preview.md:55](../../docs/a2a/a2a-host-preview.md#L55-L55), [docs/a2a/a2a-host-preview.md:138](../../docs/a2a/a2a-host-preview.md#L138-L138).

## Execution

### HAB-E01 — Optional execution must not become messaging prerequisite

Ordinary common-MCP messaging and receive-only supervisor work without Task, fixed Runs or a Hermes-specific model/approval adapter; receiving agents retain content, execution and existing approval decisions.

Reason: Communication authority and delivery must not take over recipient execution policy.

Scope: Standard messaging; optional subsystem entrypoints remain explicitly composed. Decision: **accepted**.

Checks: js-common-mcp, ast-boundary, native-recipient.

Sources: [docs/hab-principles.md:15](../../docs/hab-principles.md#L15-L15), [docs/hab-decisions.md:30](../../docs/hab-decisions.md#L30-L30).

### HAB-E02 — Storage receipt is not Task or completion

Receiving and ACK do not create a Task; separate current local accept and independently authenticated Task submit are required. Completion/result emission requires saved matching terminal evidence with execution_open=0.

Reason: Avoid interpreting transportation success as authorization or execution success.

Scope: Explicit fixed TaskBridge and the A2A Relay preview composed with HabExecutionEvidence only; the host-routed A2A entry is reply-attested under HAB-E20 and never satisfies this completion rule; ordinary message receive stays Task-free. Decision: **accepted**.

Checks: js-root.

Sources: [docs/a2a/a2a-host-preview.md:23](https://github.com/s-hiraoku/hiraoku-agent-base/blob/e772a7c6959a3bf9ef367870278f1aa363470a7e/docs/a2a-host-preview.md#L23-L27).

### HAB-E06 — Reply loops and budget are finite

Automated host replies only allow question→answer and execution_request→accepted/result with one stable reply per source/kind; replies/notices/failures cannot recursively generate answers or Tasks. Explicit finite shared budget is committed before outbox and never refunded to recover unknown delivery.

Reason: Bounds prevent self-amplifying communication, quota bypass and duplicate reply effects.

Scope: Recipient-local automated reply host and optional TaskReplies when budget explicitly connected; proposed8/thread60/min are not defaults. Decision: **accepted**.

Checks: js-root.

Sources: [docs/receiver/adapter-reply-budget.md:9](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-reply-budget.md#L9-L36), [docs/receiver/adapter-reply-budget.md:40](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-reply-budget.md#L40-L44).

### HAB-E07 — Durable answer before handoff

Persist one decided answer envelope before budget/outbox handoff; same source replay reuses original ID/body/deadline. Uncertain cross-DB result remains prepared and is reconciled with same envelope. Startup/listing/expiry does not send, invent new answer, Task or deadline.

Reason: Prepared replies survive restart without recreating content from conversation or duplicating unknown handoff.

Scope: Optional AnswerIntents producer and its host wiring. Decision: **accepted**.

Checks: js-root, js-recipient-host-mcp.

Sources: [docs/receiver/answer-intents.md:5](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/answer-intents.md#L5-L14), [docs/receiver/answer-intents.md:18](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/answer-intents.md#L18-L38).

### HAB-E09 — Owner lock cannot time out into duplicate work

All hosts for one local identity share dedicated exclusive owner DB; no heartbeat/TTL takeover. Owner loss rejects late save/ACK and release requires paused, not-running and zero draining. Reacquisition alone does not reset execution gate or justify new ID/Task.

Reason: A slow or timed-out call may still settle after another host begins.

Scope: Optional SQLiteHostOwner; local-MVP composition requires it, legacy unconfigured compatibility is not evidence of owner enforcement. Decision: **accepted**.

Checks: js-root.

Sources: [docs/receiver/adapter-owner.md:9](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-owner.md#L9-L15), [docs/receiver/adapter-owner.md:21](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/docs/adapter-owner.md#L21-L23).

Managed-transport scope: Managed transport is a trusted cooperative local-admission capability: unlike guarded fetch, its check releases the control transaction before physical SDK/IPC send. A request admitted before pause may still commit; every later request/retry needs a new current check. Product OAuth side clients must also be guarded. Abort/timeout never clears unsettled work or authorizes owner/store release. See the [reviewed local source](../../docs/receiver/adapter-host.md#product-owned-managed-transport-trusted-local-integration) and exact working-tree lines 63–109 in contract.json. This new source citation is not a claim of published or hosted acceptance.

### HAB-E11 — Capacity does not evict active dedup evidence

Private execution/reply journals reject binding/key/schema/corruption/capacity failures and preserve existing unknown/dedup records. Reopen does not extend original deadline or convert delivery expiry into failed/nonexistent execution. Independent restore needs quiescent reconciliation.

Reason: Freeing space or refreshing time cannot erase the only evidence preventing duplicate work.

Scope: TaskBridge and reply journals; exact numeric policies stay subsystem-specific. The optional generic NATS client/recipient was deleted, so its journals are no longer in scope. Decision: **accepted**.

Checks: js-root.

Sources: [docs/receiver/adapter-reply-budget.md:50](https://github.com/s-hiraoku/hiraoku-agent-base/blob/776dc8414a9c2bb2c7ec175f3f1cd23931877162/docs/adapter-reply-budget.md#L50-L54).

### HAB-E17 — Proof labels preserve actual exercised scope

Synthetic model-free loopback/SQLite tests and close/reopen prove their exercised contracts only, never native agent model/approval/wake, kill9/power failure, hosted identity or full operational restore. Finite native fixed-text exchange is separate evidence with pinned revisions and no generic-crash claim.

Reason: Prevent fixture success being promoted into untested native or operational guarantees.

Scope: All verification claims involving optional execution and local MVP. Decision: **accepted**.

Checks: source-publication, native-recipient.

Sources: [docs/local-mvp.md:68](../../docs/local-mvp.md#L68-L72).

### HAB-E20 — Host-routed A2A completion is reply-attested and labelled

The host-routed A2A entry has no engine evidence port. Recipient storage ACK leaves the Task SUBMITTED. A durable execution_accepted reply makes it WORKING, and a durable execution_result reply makes it COMPLETED (succeeded, with the result text as the only Artifact), FAILED or CANCELED; an expired or quarantined request with no reply becomes INPUT_REQUIRED until its reply window closes. A reply counts only when the configured recipient sent it, it references that Task's own host source message, its thread matches and its schema is exact. A reply counts only if it arrives before its request's expiry plus one day (the reply window); a later one is ACKed without a record and never changes the Task. By the owner's 2026-11-07 decision (ADR-016), a Task with no result applied when its reply window closes, whether SUBMITTED, WORKING or INPUT_REQUIRED, moves to the standard TASK_STATE_FAILED with no Artifact, `reason: "result_window_expired"` in its status message metadata and its public `hab_relay` metadata, and a status message that starts with `result_window_expired` and says the outcome is unknown, because the recipient may or may not have executed the request; no custom A2A state is added and the Task never stays WORKING. The host receiver loop makes this transition without a caller read through bounded stable-key pages from the Task store's `overdue()`, starting when the earliest window closes; later pages and failed applies can require later cycles. A read after the window attempts the transition at once. A reply arriving afterwards never revives or changes the Task. FAILED with result_window_expired never claims that the recipient did not execute the request. A later reply with another engine Task ID, or a second terminal result with another state, is refused without replacing the saved Task. Every such Task's public metadata carries `attestation: "recipient_reply"`, and the Card and Artifact describe the result as the recipient's report. COMPLETED here claims no verification of the recipient's engine and never satisfies the evidence-verified rule of HAB-E02 and HAB-V12.

Reason: The host cannot read a remote recipient's engine. The label keeps a recipient's self-report from passing as independently verified execution.

Scope: Opt-in host A2A entry only. The preview composition with HabExecutionEvidence keeps HAB-E02. Covered in js-root by test/a2a-host.test.js; an actual product recipient's reply is not exercised. Its case "a WORKING Task whose reply window closes without a result fails as result_window_expired, and a late result does not revive it" ages the request two days while the host is stopped, waits for the stored Task to fail without a caller read, checks the reason, the outcome-unknown message and the empty Artifacts, and checks that a late result is ACKed without a record and leaves the status unchanged. Its case "a Task whose reply window closes while the host runs fails within seconds, not at the next once-a-minute maintenance" ages the request so that its window closes five seconds after a restart, after the restart's first maintenance pass, and checks that the stored Task fails within 20 seconds of that time without a read. A live drive cannot wait out the day (features/a2a-host.md a2a-window). A new unit control holds a pre-window result unconfirmed, reaches FAILED at the window, then confirms it and checks that it cannot revive the failed Task. It preserves the existing deadline semantics, not a new grace period. One-cycle timing is an unobstructed fixture claim, not a backlog guarantee. Decision: **accepted**.

Checks: js-root, native-recipient.

Sources: [docs/a2a/a2a-host-preview.md:106](../../docs/a2a/a2a-host-preview.md#L106-L106), [docs/a2a/a2a-host-preview.md:116](../../docs/a2a/a2a-host-preview.md#L116-L129), [docs/hab-decisions.md:76](../../docs/hab-decisions.md#L76-L76), [.claude/skills/verify-hab/features/a2a-host.md:3](../../.claude/skills/verify-hab/features/a2a-host.md#L3-L3), [.claude/skills/verify-hab/features/a2a-host.md:43](../../.claude/skills/verify-hab/features/a2a-host.md#L43-L43), [docs/a2a/a2a-host-preview.md:80](../../docs/a2a/a2a-host-preview.md#L80-L80), [docs/hab-decisions.md:45](../../docs/hab-decisions.md#L45-L45), [.claude/skills/verify-hab/features/a2a-host.md:15](../../.claude/skills/verify-hab/features/a2a-host.md#L15-L15), [.claude/skills/verify-hab/features/a2a-host.md:44](../../.claude/skills/verify-hab/features/a2a-host.md#L44-L44).

## Verification

### HAB-V01 — Observe action and resulting state

A mapped feature claim must retain the actual protocol/terminal action, its result and an independent state or peer observation, labeled by sub-feature ID.

Reason: HTTP 200, a helper exit or a mutated screen alone does not prove the intended side effect.

Scope: HAB local verify-hab recipes; terminal requires transcript plus exit. Decision: **accepted**.

Checks: mcp-durable-roundtrip, source-publication.

Sources: [.claude/skills/verify-hab/SKILL.md:83](../../.claude/skills/verify-hab/SKILL.md#L83-L88), [.claude/skills/verify-hab/features/README.md:21](../../.claude/skills/verify-hab/features/README.md#L21-L25).

### HAB-V02 — Durable receiver evidence precedes network ACK

To claim durable receipt, independently observe committed recipient body and original ACK request before the actual network ACK; raw poll/ACK and Relay snapshots prove only wire behavior.

Reason: Relay ACK can delete its body; loss between ACK and durable recipient storage would otherwise be hidden.

Scope: DurableReceiver/SQLiteInbox through real MCP HTTP; independent connection, not native product execution. Decision: **accepted**.

Checks: ack-observer-controls, mcp-durable-roundtrip, js-common-mcp.

Sources: [.claude/skills/verify-hab/features/communication-boundary.md:7](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/communication-boundary.md#L7-L9), [.claude/skills/verify-hab/features/receive-ack.md:22](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/receive-ack.md#L22-L24).

### HAB-V03 — Receive preserves content without execution

The periodic receiver must preserve question/notice/structured request content, leave Task links/Tasks/reply outbox empty, and keep decisions, execution and existing approval with the receiving agent.

Reason: External content and claimed approval must not become execution authority merely through delivery.

Scope: Standard common-MCP receive path, optional Task port may be configured but is not automatically invoked. Decision: **accepted**.

Checks: js-common-mcp.

Sources: [.claude/skills/verify-hab/features/communication-boundary.md:3](https://github.com/s-hiraoku/hiraoku-agent-base/blob/135d9ca3a6fb93b9c2ce435f5674ede56bb0a338/.claude/skills/verify-hab/features/communication-boundary.md#L3-L16).

### HAB-V04 — Explicit saved-body read creates no authority

Saved-body reading must be explicit and source-authorized, preserve ACK-pending truth and return detached data without creating a Task or reply or granting permission to act.

Reason: An agent needs received data while inspection remains separate from execution and approval.

Scope: Adapter inbox_read operation; native host/UI integration remains separately unverified. Decision: **accepted**.

Checks: js-common-mcp.

Sources: [.claude/skills/verify-hab/features/communication-boundary.md:10](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/.claude/skills/verify-hab/features/communication-boundary.md#L10-L10).

### HAB-V05 — Coordinator working is not model evidence

Do not treat optional Task coordinator working state without runtime ID as evidence that the model ran.

Reason: Scheduling/coordination progress differs from runtime acceptance or execution.

Scope: Optional Task path only; ordinary messaging has no Task requirement. Decision: **accepted**.

Checks: js-common-mcp.

Sources: [.claude/skills/verify-hab/features/communication-boundary.md:11](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/.claude/skills/verify-hab/features/communication-boundary.md#L11-L12).

### HAB-V08 — Owned isolation and retained evidence

Use fresh isolated state, drive only an instance owned by this run, clean up owned processes after success and failure, and confirm retained evidence survives disposable-state removal.

Reason: Parallel tests must not drive/stop another service or erase the only proof.

Scope: Local verification lifecycle; process/readiness ownership must be established before network driving. Decision: **accepted**.

Checks: mcp-durable-roundtrip.

Sources: [.claude/skills/verify-hab/features/README.md:7](../../.claude/skills/verify-hab/features/README.md#L7-L10), [.claude/skills/verify-hab/SKILL.md:90](../../.claude/skills/verify-hab/SKILL.md#L90-L97), [.claude/skills/verify-hab/features/communication-boundary.md:36](../../.claude/skills/verify-hab/features/communication-boundary.md#L36-L36).

### HAB-V09 — Local substitutions remain explicit

Label synthetic identity/Task policy and injected scheduling; do not claim real product model/tools/approval/UI/credential/deployment or real polling cadence from finite fixture success.

Reason: Real protocol/storage verification is valuable but does not establish substituted external authority or runtime behavior.

Scope: Common-MCP boundary and synthetic local Relay recipes. Decision: **accepted**.

Checks: source-publication, native-recipient.

Sources: [.claude/skills/verify-hab/SKILL.md:87](../../.claude/skills/verify-hab/SKILL.md#L87-L88), [.claude/skills/verify-hab/features/communication-boundary.md:28](../../.claude/skills/verify-hab/features/communication-boundary.md#L28-L39).

### HAB-V10 — Restart evidence keeps fault scope

Label orderly DB/listener reopen and graceful marked SIGTERM restart as such; do not report kill-9, power-loss or physical failure proof from these recipes.

Reason: Lifecycle mechanisms have different failure windows and durability guarantees.

Scope: verify-hab restart recipe and test:hab-integration; dedicated owned F05 SIGKILL fixture has separate limited storage-seam evidence. Decision: **accepted**.

Checks: js-process-crash, mcp-durable-roundtrip, source-publication.

Sources: [.claude/skills/verify-hab/features/restart-durability.md:28](https://github.com/s-hiraoku/hiraoku-agent-base/blob/c67711e2bb79670402e3b2cac10452344db7df00/.claude/skills/verify-hab/features/restart-durability.md#L28-L30).

