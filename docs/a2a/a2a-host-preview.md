# A2A through the HAB host

The P2/P3 preview connects the official A2A client to the current HAB Registry, host, durable inbox/outbox, explicit TaskBridge and fixed Task engine. It starts only through explicit composition. The existing MCP tools and the host remain unchanged.

## Run the finite proof

Use Node 26.13 or a compatible Node 26 runtime. Install the locked dependencies, then run:

```sh
npm ci
npm run test:a2a

```

The output directory must not exist. The proof creates private temporary databases and loopback listeners, then closes them. `report.json` records the commit, source SHA256 values, Task and delivery IDs, counts, and closed-port checks. `git_dirty` distinguishes an intermediate development run from a proof of a clean commit.

An optional `--contracts /path/to/delivery-lab/contracts.test.js` records the shared delivery-contract source SHA in the same report. This proof does not run that separate delivery suite and labels that fact. It does not change any pending backend or skip markers.

The fixed worker executes only `connectivity_check` with its canonical fixture result. No live credentials, model, product conversation, cloud account, daemon, or production service is used. No Mac-specific filesystem path or launchd dependency is in the implementation.

## Observable stages

1. The authenticated A2A request saves one exact HAB envelope and queues delivery. The engine Task count is zero.
2. The recipient saves the envelope durably and confirms the delivery ACK. The engine count remains zero. A2A remains `SUBMITTED`.
3. A separate explicit local operator accepts the saved request, then submits it through the independently authorized ConnectivityTaskPort. Retrying that submission creates one engine Task.
4. A durable `execution_accepted` reply permits observing execution progress. Confirmed execution can become `WORKING`, but its result remains private until the result reply arrives.
5. A durable `execution_result` reply and matching independently verified closed engine evidence allow the SDK Task and Artifact to be saved together. Only then can the client receive `COMPLETED`.

The proof then closes and reopens the Registry, host, inboxes, outboxes, TaskBridge journal, submission receipt journal, SDK Task store and engine database. A replay returns the same Task and original envelope. The expected successful counts are one engine Task, three HAB messages, one recipient inbox entry, two origin inbox entries, one Artifact, and zero measured unresolved outbox/bridge/receipt records.

## Host composition

`habAgentCard(endpoint)` describes the fixed HAB skill. `createHabA2aGateway({endpoint,card,store,authorize})` returns a Fetch handler for native A2A1.0 JSON-RPC. Use the existing `createA2aNodeHandler` for an explicitly created Node server. The preview requires an explicit `http://127.0.0.1:<port>/a2a` endpoint and an authenticated private Card. Public network hosting and grants are separate work.

`authorize(request)` must verify the credential and create a current route. `createHabRoute` accepts the Registry, verified context, configured immutable sender and recipient IDs/addresses, an existing outbox, DurableSender, origin inbox, and read-only evidence verifier. It snapshots configuration identities and dependencies. It checks current Registry group membership and peer policy. Enqueue runs under the synchronous Registry guard. Network delivery runs outside that transaction and is authenticated again by the HAB endpoint. Async Registry callbacks remain forbidden.

The SDK owner is the authorized immutable sender ID. An internal tenant scopes each recipient route. The request body cannot select an owner, tenant, execution principal, recipient or engine. The gateway rejects arbitrary metadata, continuations, deadlines, attachments and unknown protocol versions. The only skill is the fixed connectivity text. Reusing a message ID with different text returns `message_id_conflict`.

The SDK Task metadata stores the original rm1 message ID, thread, first timestamp, absolute one-hour expiry, payload hash and binding before enqueue. A replay reuses that record. It never assigns a new ID or extends the original deadline. Get/List observe existing delivery and result state; they never accept or submit execution. An original saved send intent can resume delivery only through a repeated SendMessage while its deadline is still valid.

`createHabA2aRecipient` composes the existing DurableReceiver, TaskBridge and TaskReplies. `receiveOnce` only saves and ACKs. `accept`, `submitOnce`, `observeOnce`, and `replyOnce` are separate explicit calls. The composition checks the original expiry at acceptance and initial submission, including repeated guard checks before the engine RPC. A validated success response is retained in a separate private submission receipt journal. It records an original RPC response, not Task lifecycle state. If that response crosses both the deadline and bridge lease, a fresh journal attempt can correlate the known receipt without another engine RPC. Current authorization and the new fence/lease are checked again. A call with no known receipt cannot start after expiry. The existing attempt limit still requires manual handling when exhausted; the known receipt stays available. Delivery expiry never proves an existing execution failed or stopped.

## Result evidence

The existing TaskReplies wire carries task ID, state and result. It does not carry the engine fence, request key, owner binding or execution-open flag. Therefore this preview requires a read-only `HabExecutionEvidence.verify(source,recipientId,engineTaskId)` host port. It returns independently authorized engine evidence for that original source. The proof checks the recipient BridgeLink and ConnectivityTaskPort.get. It never calls engine submission through this verifier.

The origin also requires a confirmed durable inbox reply from the configured recipient, exact original reply reference and thread, fixed schema, matching engine Task ID, and matching state/result. The full evidence must pass the existing Task evidence validator. Internal execution evidence and engine binding stay in private storage and are omitted from Send/Get/List responses, including before the result reply arrives. Ordinary legacy answers and notices in the same inbox are ignored by the execution observer. Lower fences and conflicting terminal evidence fail without replacing the saved result. A late acceptance reply cannot erase an Artifact. A store failure leaves the durable result reply available for recovery.

This read-only verifier is an explicit integration requirement. This preview does not claim a fence traveled on the old wire, implement a new signature format, or make a remote closed product expose its engine state.

## Cancellation, timeouts and limits

CancelTask returns the formal task-not-cancelable error. It never reports stopped execution. Default blocking SendMessage waits up to five seconds for a terminal or interrupted observation. The wait takes the handler's Task serializer only for each 25 ms check, which reloads the stored Task, so the host receive loop can apply replies in between. A transport timeout preserves the queryable Task. It does not set execution failure or extend delivery expiry.

Reply observation supplies the original `(sender_id, message_id)` source key as an optional hint. The SQLite route selects only unreleased replies to that exact pair through an additive partial index, instead of parsing every active reply body on each observation or incoming-reply comparison. Pending ACKs remain visible to the host's admission logic. Unfiltered route implementations remain compatible, and the observer still checks receipt confirmation, both agent identities, reference, thread and schema. Every current-authorization check, including checks after asynchronous storage, delivery and evidence reads, remains in place. The index does not change the record format or retention rules, and excludes released tombstones whose bodies are empty.

The bounded `test/inbox-source.test.js` regression uses 200 synthetic unreleased replies with 256-character results and 64 source observations. It asserts 64 body parses rather than the previous 12,800 and verifies an indexed source search without a full scan or temporary ordering tree. Timing is diagnostic only. This proves less synchronous reply-read work under a backlog, not a production MCP latency bound or starvation measurement.

The preview supports one handler instance per Task database. It does not add multi-host writer coordination, production retention, capacity management, remote evidence authentication, product wake, or a GUI. Delivery runs through the host's SQLite delivery store behind the HAB Registry ([ADR-018](../hab-decisions.md)). Production replacement acceptance remains a separate gate.

## Host wiring with a host-owned identity

The owner decided on 2026-11-06 (ADR-016, decision item 5) to wire the gateway into the single host with its own A2A identity. The host cannot read the calling agent's mailbox for the replies. That agent's own save-then-ACK receiver already holds the single lease on it. The host therefore has its own Registry address and durable mailbox. A2A Tasks are sent from that address, and recipients reply to it. The `DeliveryService` contract, the lease rules and the `hab_*` MCP tools are unchanged. The code is `src/host/a2a.ts`, and `test/a2a-host.test.js` covers it through the real host and its SQLite delivery store.

### Configuration

A2A is off unless the host config has an `a2a` section. With no section there is no listener, mailbox file or host identity.

```json
"a2a": {
  "port": 8793,
  "identity": "a2a@hab-host.hab",
  "recipient": "worker@worker.hab",
  "poll_interval_ms": 1000,
  "max_active_requests": 4,
  "max_records": 100
}
```

`port` is a separate `127.0.0.1` listener serving `http://127.0.0.1:<port>/a2a` and its Card at `/.well-known/agent-card.json`. It must differ from `port` and the ingress port. A separate listener keeps a five-second blocking SendMessage from taking the MCP listener's `max_active_requests` slots. The gateway's existing checks still apply. These are the exact Host header, refusal of an `Origin` header, the A2A-Version header, JSON-only bodies of at most 16 KiB, and the fixed connectivity skill. `recipient` is the one address every Task goes to. `max_records` caps the host outbox. A reply is saved only until one day after its request's one-hour deadline, the reply window. A later reply is ACKed without a record, so its Task does not change. A Task with no result when the window closes moves to `FAILED` with reason `result_window_expired`. Each outbox record is kept for at least 30 days past that deadline plus two days and two hours. This horizon alone does not bound reply ACK retention: after a long stop, an ACK first made terminal on restart retains its history for another 30 days from that actual local terminal time. Maintenance collects the inbox first, then computes a bounded outbox collection allowance. Let M be max_records, T be retained outbox rows, W be retained sources whose reply windows are still open (expires_at > now minus one day), and p be proposed collected rows. It binary-searches p from 0 through 100 against room for 2 × (max(0, M - T + p) + W) new replies. For T <= M this equals 2 × (F + W + p), where F = M - T. If an operator lowers M below T, collecting excess rows creates no usable sender slots until the count falls below M. The check includes those replies and their maximum envelope bytes, checking unreleased body/byte, distinct-message ACK-history and all retained-row capacities. This preserves two future replies for each free slot and open source before freeing additional sender slots. The snapshots and numeric-cap collection have no intervening await in the single-owner host. Only eligible rows are collected, and expiry still runs even when the allowance is zero. This is conservative capacity accounting, not a multi-writer reservation or shortened retention. The inbox holds twice as many unreleased reply bodies, one `execution_accepted` and one `execution_result` per Task, so an accepted reply never takes the slot its own result needs. The receiver loop applies each ACKed reply to its Task and releases the body once the Task store holds the new state, so a Task nobody reads can release its slot after a successful durable apply. Unexpected storage failures keep the body for retry. A late or conflicting reply to a terminal Task is rejected and released the same way. A reply whose ACK never committed is never applied. Once it has expired with no ACK request pending, no redelivery can confirm it, so the loop releases its body unread and keeps its tombstone for dedup. The Task then waits for another reply, or fails when its reply window closes. Only the configured recipient's replies to a host message are saved, and a reply under a new message ID only if it would change its Task. Before saving, the receiver loop applies the reply to a copy of the stored Task, using only ACK-confirmed held replies. A reply that leaves that copy's state unchanged, or that the Task would refuse, is ACKed without a record, the same way as a late reply. An unconfirmed held reply is not evidence that another reply is redundant. If the new reply would change the actual Task but would be redundant or conflicting if those unconfirmed replies became usable, it is deferred without saving or ACKing it. This preserves the finite reply-body and ACK-history bounds. The host may redeliver it after the held reply is confirmed or safely released unread, but finite lease retries may instead quarantine it, or its TTL may expire. The sender must inspect its delivery status; this is not a guarantee that every recovery reply completes the Task. Safely discarded redundant replies spend no ACK-history slots; the flood regression verifies completion from a valid result behind that redundant traffic. Deferred replies have the finite-delivery limits above. A message ID the inbox still holds always reaches it, so a redelivery of a saved reply is deduplicated and can still confirm its ACK. The inbox keeps an ACK history of three times `max_records` messages for the same 30 days, which leaves room for each Task's `execution_accepted` and `execution_result` replies and one more reply. The history is counted per message, so the lease redeliveries of one reply, up to five generations, take a single slot. This gate prevents future outbox collection; it does not restore source slots an earlier build already purged, repair already lost/quarantined results, or establish spare capacity in an existing deployment. Before resuming an affected deployment, quiesce new A2A admissions and let normal inbox maintenance and the full 30-day retention from actual local terminal time restore sufficient capacity. Do not delete history, shorten retention or re-execute Tasks with unknown outcomes. The allowance may conservatively defer collection and admission; it does not assume all held bodies can be released. No live deployment has been checked.

### Identity provisioning

At start the host converges `identity` to an active agent, using an administrator port that answers only during this step and only for inspect, product, enroll, bind and access. Each step reads the current Registry state and applies only the difference. It registers the product if it is missing, enrolls the address if it is missing, binds the host principal, and grants `submit/status/poll/ack`. A restart or a crash partway through therefore ends at the same agent ID, with no change on a repeat run. The host refuses to start rather than repair the identity in these cases:

| Reason | State found |
| --- | --- |
| `a2a_identity_conflict` | The address has another live binding, is in an authentication group, or the host principal is bound elsewhere. |
| `a2a_identity_revoked` | The host principal's binding was revoked. Descriptors stay reserved forever. |
| `a2a_identity_stopped` | The agent was stopped. The host never re-enables it silently. |
| `a2a_identity_retired` | The address was retired. |
| `a2a_identity_renamed` | The configured identity is a previous name of a renamed agent whose grace period has ended. Set `identity` to the current name. During the grace period the previous name still starts the host under the same agent ID. |

Changing `identity` is not a general recovery path. Once the fixed host principal has been bound, it stays reserved to that agent in this Registry, even after revocation; configuring another address then fails with `a2a_identity_conflict`. A new address can avoid an address conflict only before the host principal has been bound. `hab:admin connect` refuses the configured identity address with `a2a_identity_reserved`. `hab:admin disconnect` on it is the permanent A2A off switch for this Registry, not a temporary pause. To start the remaining MCP host after that revocation, remove the `a2a` config section. This keeps the Registry and mailbox history intact; the preview provides no host-identity rotation or revocation-reset procedure.

### Credentials

The host identity has no bearer token, OAuth client or file credential. It is an in-process context object that only the host holds. The host's Registry authority attests it as the reserved principal `{issuer: "urn:hab:host", audience: "urn:hab:host:a2a", subject: "a2a-identity", client_id: "hab-host", connection_id: "host-a2a"}`, with a context lifetime of at most one second. It calls `HabDeliveryService` directly. Every operation still runs the Registry's `withAuthorization` check, and nothing reaches it over HTTP. The host drops any operator or OAuth principal whose issuer is `urn:hab:host`, so a credentials file entry cannot impersonate the identity even if someone binds it.

A2A callers authenticate with the existing local bearer file. Their credential's audience must be the A2A endpoint `http://127.0.0.1:<a2a port>/a2a`, so an MCP credential is refused there with 401. `hab:admin connect` lists the A2A endpoint among its resources and binds such a credential to the caller's address as usual.

### Authorization and the confused deputy

Each request is verified with the caller's own credential. The route then checks the caller through the Registry. The caller must currently hold `resolve` and `submit`, resolve the configured recipient, and be allowed to send `execution_request` to it. Directional blocks, stopped peers, group state, kind allowlists and the emergency stop apply as if the caller sent the message directly. The enqueue repeats that check inside the Registry guard that commits the outbox record. The host identity then submits under its own rights, so the recipient and its policies see the host address as the sender. That submit runs inside a Registry transaction that first repeats the caller check, because a `withAuthorization` call inside another's action joins its transaction. A revocation from another connection, such as `hab:admin disconnect`, therefore commits either before that check, which refuses the send, or after the message is admitted. It cannot land between them. The caller never chooses the sender, recipient, kind or body. The body is the fixed `connectivity_check` request.

Tasks are stored per caller (the SDK store's owner is the caller's agent ID) and per recipient (tenant). Another caller's GetTask finds nothing. The host mailbox is readable only through a Task. A reply counts only when the configured recipient sent it, it references that Task's own source message from the host, its thread matches, and its schema is exact. The host itself refuses a reply reference to a message the sender never received. The receiver loop classifies each delivery before it saves anything. Anything else is ACKed without an inbox record or ACK history entry, so unrelated senders spend none of the capacity that replies need. Dropping such a message again on a redelivery has no effect, so it needs no dedup record.

### Durability, retry and the receiver loop

The outbox (`a2a-outbox.sqlite`), inbox (`a2a-inbox.sqlite`) and SDK Task store (`a2a-tasks.sqlite`) are private 0600 files in the host state directory. Their HMAC keys are derived from the Registry fingerprint key. A saved Task, its send intent and received replies survive a host restart. The original message ID and one-hour expiry are reused on replay.

Delivery of a saved intent happens only inside its owner's authorized request. SendMessage sends that one record (`DurableSender.sendOnce(messageId)`), never another caller's. To retry after a failure or a restart, the A2A client repeats SendMessage with the same `messageId`. There is deliberately no background submit retry. A background retry would send under the host identity without a current check of the caller who asked for it. The only background work is the receiver loop. Every `poll_interval_ms` it polls the host mailbox and classifies up to 16 deliveries per cycle. Useful replies are saved before ACK, safely discardable deliveries are ACKed without a record, and replies whose redundancy depends on unconfirmed evidence are deferred without ACK. At most once a minute it runs inbox maintenance followed by capacity-gated outbox maintenance. It starts failing Tasks whose reply window closed in the first receive cycle after the earliest open window closes, independently of that maintenance cadence. Each receive cycle handles at most 100 Tasks and advances a stable Task-key cursor even when individual applies fail, so a full failing batch cannot starve later Tasks. After reaching the end, the next scheduled pass retries from the beginning. The host identity is the only consumer of its mailbox, so it holds the single receiver lease.

### Task state

The host route has no engine evidence port, because the host cannot read a remote recipient's engine. Its Tasks are reply-attested, and their public metadata says `attestation: "recipient_reply"`.

| Observation | A2A state |
| --- | --- |
| Request saved and queued, or recipient storage ACK | `SUBMITTED` |
| Durable `execution_accepted` reply | `WORKING` |
| Durable `execution_result` reply with `succeeded` | `COMPLETED`, with the result text as the Artifact |
| `failed` / `cancelled` result reply | `FAILED` / `CANCELED` |
| Original deadline passed or delivery quarantined with no reply | `INPUT_REQUIRED` with a fixed message |
| Reply window (request deadline plus one day) closed with no result | `FAILED`, reason `result_window_expired`, outcome unknown |

When the reply window closes before a result is applied, the Task moves to the standard `FAILED` state. Its status message starts with `result_window_expired` and says the outcome is unknown, because the recipient may or may not have executed the request. The message metadata and the Task's `hab` metadata carry `reason: "result_window_expired"`, and the Task has no Artifact. The receiver loop makes this transition without a caller read when the earliest open reply window closes. It keeps that time from the Task store's next non-terminal request expiry and refreshes it at least once a minute with maintenance, so due Tasks enter bounded receive-cycle processing at the deadline. More than 100 due Tasks require successive cycles; per-Task storage failures remain retryable without holding back later Tasks. A read after the window attempts the same transition immediately; a storage failure can prevent that save. A reply that arrives later is ACKed without a record and never changes the Task. A result applied inside the window still completes it. Saving a reply before the deadline does not extend the window while its ACK is unconfirmed. If the Task fails at the boundary, later confirmation of that saved reply cannot revive it.

A different engine Task ID in a later reply, or a second terminal result with another state, is refused without replacing the saved Task. `COMPLETED` here means the recipient reported a result. HAB does not verify the recipient's execution. The preview composition with `HabExecutionEvidence` keeps its stronger verified semantics.

### Shutdown

On close the host stops accepting A2A requests with 503 and closes the listener. It waits for in-flight A2A requests and the current receiver cycle, then closes the Task store, outbox and inbox before closing delivery and the Registry. Unsent intents, unACKed deliveries and saved Tasks stay on disk for the next start. Closing the Task store also closes its eagerly opened SQLite connection when no SDK load/save initialized the lazy database driver. Calling close again is safe; a stopped host must not leave an unused connection behind across restart.

### Not covered

Only the local bearer verifier is accepted. The OAuth ingress does not serve A2A. A caller authenticated through a group with several addresses has no address selector and is refused. Reply bodies are released when the receiver loop applies them, and a reply that arrives after the Task is terminal is released the same way. A2A requests are not written to the redacted HTTP audit.

A held confirmed body is retained on an unexpected per-Task save failure; no exception-based blanket release is allowed. The mixed-cohort regression injects that failure for one legitimate Task, verifies partial collection and another Task completing while the body remains, then removes the fault and verifies recovery. It does not repair malformed SQLite pages, a globally failed database or invalid JSON that prevents inbox enumeration. Cohort aging changes rm1 IDs and timestamps consistently but does not refresh fingerprints, so it is maintenance/capacity evidence, not a whole-state restore proof.
