# A2A through HAB Relay

The P2/P3 preview connects the official A2A client to the current HAB Registry, Relay, durable inbox/outbox, explicit TaskBridge and fixed Task engine. It starts only through explicit composition. The existing MCP tools and Relay host remain unchanged.

## Run the finite proof

Use Node 26.13 or a compatible Node 26 runtime. Install the locked dependencies, then run:

```sh
npm ci
npm run test:a2a-relay
npm run proof:a2a-relay -- --output /absolute/path/to/a-new-private-directory
```

The output directory must not exist. The proof creates private temporary databases and loopback listeners, then closes them. `report.json` records the commit, source SHA256 values, Task and delivery IDs, counts, and closed-port checks. `git_dirty` distinguishes an intermediate development run from a proof of a clean commit.

An optional `--contracts /path/to/delivery-lab/contracts.test.js` records the shared delivery-contract source SHA in the same report. This proof does not run that separate delivery suite and labels that fact. It does not change any pending backend or skip markers.

The fixed worker executes only `connectivity_check` with its canonical fixture result. No live credentials, model, product conversation, cloud account, daemon, or production service is used. No Mac-specific filesystem path or launchd dependency is in the implementation.

## Observable stages

1. The authenticated A2A request saves one exact Relay envelope and queues delivery. The engine Task count is zero.
2. The recipient saves the envelope durably and confirms the Relay ACK. The engine count remains zero. A2A remains `SUBMITTED`.
3. A separate explicit local operator accepts the saved request, then submits it through the independently authorized ConnectivityTaskPort. Retrying that submission creates one engine Task.
4. A durable `execution_accepted` reply permits observing execution progress. Confirmed execution can become `WORKING`, but its result remains private until the result reply arrives.
5. A durable `execution_result` reply and matching independently verified closed engine evidence allow the SDK Task and Artifact to be saved together. Only then can the client receive `COMPLETED`.

The proof then closes and reopens the Registry, Relay, inboxes, outboxes, TaskBridge journal, submission receipt journal, SDK Task store and engine database. A replay returns the same Task and original envelope. The expected successful counts are one engine Task, three Relay messages, one recipient inbox entry, two origin inbox entries, one Artifact, and zero measured unresolved outbox/bridge/receipt records.

## Host composition

`habRelayAgentCard(endpoint)` describes the fixed Relay skill. `createHabA2aGateway({endpoint,card,store,authorize})` returns a Fetch handler for native A2A1.0 JSON-RPC. Use the existing `createA2aNodeHandler` for an explicitly created Node server. The preview requires an explicit `http://127.0.0.1:<port>/a2a` endpoint and an authenticated private Card. Public network hosting and grants are separate work.

`authorize(request)` must verify the credential and create a current route. `createHabRelayRoute` accepts the Registry, verified context, configured immutable sender and recipient IDs/addresses, an existing outbox, DurableSender, origin inbox, and read-only evidence verifier. It snapshots configuration identities and dependencies. It checks current Registry group membership and peer policy. Enqueue runs under the synchronous Registry guard. Network delivery runs outside that transaction and is authenticated again by the Relay endpoint. Async Registry callbacks remain forbidden.

The SDK owner is the authorized immutable sender ID. An internal tenant scopes each recipient route. The request body cannot select an owner, tenant, execution principal, recipient or engine. The gateway rejects arbitrary metadata, continuations, deadlines, attachments and unknown protocol versions. The only skill is the fixed connectivity text. Reusing a message ID with different text returns `message_id_conflict`.

The SDK Task metadata stores the original rm1 message ID, thread, first timestamp, absolute one-hour expiry, payload hash and binding before enqueue. A replay reuses that record. It never assigns a new ID or extends the original deadline. Get/List observe existing delivery and result state; they never accept or submit execution. An original saved send intent can resume delivery only through a repeated SendMessage while its deadline is still valid.

`createHabA2aRecipient` composes the existing DurableReceiver, TaskBridge and TaskReplies. `receiveOnce` only saves and ACKs. `accept`, `submitOnce`, `observeOnce`, and `replyOnce` are separate explicit calls. The composition checks the original expiry at acceptance and initial submission, including repeated guard checks before the engine RPC. A validated success response is retained in a separate private submission receipt journal. It records an original RPC response, not Task lifecycle state. If that response crosses both the deadline and bridge lease, a fresh journal attempt can correlate the known receipt without another engine RPC. Current authorization and the new fence/lease are checked again. A call with no known receipt cannot start after expiry. The existing attempt limit still requires manual handling when exhausted; the known receipt stays available. Delivery expiry never proves an existing execution failed or stopped.

## Result evidence

The existing TaskReplies wire carries task ID, state and result. It does not carry the engine fence, request key, owner binding or execution-open flag. Therefore this preview requires a read-only `HabExecutionEvidence.verify(source,recipientId,engineTaskId)` host port. It returns independently authorized engine evidence for that original source. The proof checks the recipient BridgeLink and ConnectivityTaskPort.get. It never calls engine submission through this verifier.

The origin also requires a confirmed durable inbox reply from the configured recipient, exact original reply reference and thread, fixed schema, matching engine Task ID, and matching state/result. The full evidence must pass the existing Task evidence validator. Internal execution evidence and engine binding stay in private storage and are omitted from Send/Get/List responses, including before the result reply arrives. Ordinary legacy answers and notices in the same inbox are ignored by the execution observer. Lower fences and conflicting terminal evidence fail without replacing the saved result. A late acceptance reply cannot erase an Artifact. A store failure leaves the durable result reply available for recovery.

This read-only verifier is an explicit integration requirement. This preview does not claim a fence traveled on the old wire, implement a new signature format, or make a remote closed product expose its engine state.

## Cancellation, timeouts and limits

CancelTask returns the formal task-not-cancelable error. It never reports stopped execution. Default blocking SendMessage waits up to five seconds for a terminal or interrupted observation. A transport timeout preserves the queryable Task. It does not set execution failure or extend delivery expiry.

The preview supports one handler instance per Task database. It does not add multi-host writer coordination, production retention, capacity management, remote evidence authentication, product wake, or a GUI. Delivery runs through the JetStream backend behind the HAB Registry; the SQLite delivery route was deleted. The preview's A2A gateway is not wired into the host (`src/host`); whether to wire it awaits an owner decision (ADR-016). Production replacement acceptance remains a separate gate.
