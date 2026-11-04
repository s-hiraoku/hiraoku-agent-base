# Hermes external text adapter: isolated integration candidate

This implements the first text-only recipient slice of [the generic asynchronous design](../generic-agent-async-design.md). It is an out-of-tree Hermes integration under `hermes_bridge`, not a modification of Hermes core or an installed Desktop feature. Importing it starts no receiver, model, listener, credential acquisition or sender. Existing live receive-only deployments remain receive-only until a separately reviewed host binds this consumer.

## Native execution and authority

`ExternalTextConsumer` consumes a verified, durably saved request from the common layer. It never polls or ACKs the HAB inbox. `ExternalText` is a host-side object, not an unauthenticated wire decoder: the common service must authenticate each admission and query and construct `owner_scope`, sender, recipient, Task/context and deadline from its verified binding. `RecipientBinding` pins the receiving backend, profile, recipient, owner and an external authority epoch. Received text cannot supply native runtime options, a session, owner identity, callback, credential or approval choice.

`NativeTextRunner` uses the existing `AIAgent.run_conversation` API with a separate external-agent data wrapper, bot attribution and no human conversation history. `text_agent_class` refuses every `_execute_tool_calls` dispatch before the ordinary dispatcher. File, shell, plugin, sub-agent, browser, execute-code, MCP send and unknown tools are all unavailable in this initial phase, even after owner approval. Memory, context files, MCP refresh, history persistence and model fallback must be absent; model iterations, output tokens, run time and concurrency are bounded.

`load_native_text_runner` is an explicit native-host factory. It requires an already prepared venv, lazy installation disabled, the expected profile home, a reviewed clean Hermes commit (rechecked before and after each draft), and Hermes' existing managed-worker safe policy **already established by its own validated native bootstrap**. This adapter never calls the private safe-policy binder or invents an environment flag to grant it. Ordinary app processes are refused before client/model construction. The factory receives runtime credentials from its trusted native host; it neither discovers nor copies them. A host without a supported verified managed-worker attachment must keep processing disabled. This in-process guard is not an OS sandbox against arbitrary trusted Python/plugin code.

## Existing Desktop approval surface

A drafted answer is private: it is not returned in remote status or sent automatically. `request_reply_approval` commits the exact reply action, text hash, Task, recipient, deadline and stable prompt ID before presentation. `NativeOwnerApproval` attaches that prompt to the owning native session's existing `PendingControls`, which Desktop renders through its existing approval queue. Only `once` and `deny` are offered.

The host supplies actual native authority/principal/session objects, not booleans or fields decoded from HAB. Native approval authentication and execution-generation checks remain in force. The attachment additionally pins the recipient owner and profile, and refuses approval if a non-owner subscriber is present. The sender receives no approval credential, URL, prompt ID or approval method. A native generation change requires a fresh attachment; stale answers fail.

A native session showing these controls must be a host-verified recipient-owner session. A caller must not choose it by a remote session ID or by a chat title. The attachment does not create or commandeer a Desktop chat. Actual live Desktop acceptance and model execution are deployment-stage checks, not established by the isolated tests.

## Receipts, restart and common-layer contract

The common `TaskService` remains the Task state owner. `NativeJournal` contains only native execution/approval/handoff receipts; it creates no A2A Task and provides no scheduler. A process-lifetime SQLite owner lock prevents a second writer. Duplicate owner scope + sender + message identity returns the same receipt; changed content, destination, context, Task or deadline conflicts. Model admission is committed before invoking the provider. Lost responses and interrupted running work become `unknown` and are never automatically rerun.

Pending approvals reopen with the same prompt ID and unchanged draft. Answers record the decision time and authority epoch. At handoff the current native authority, exact action hash, expiry and consumption are checked again. Consumption commits before calling the common layer's synchronous, durable and idempotent outbox enqueue port. Its receipt must be exactly `{durable: true, id: approval_id}`. A lost handoff result stays unknown until an independently queried receipt confirms that exact enqueue. The adapter never directly submits the reply to HAB.

The common generic-text input maps as follows:

| Common host value | Recipient object |
| --- | --- |
| verified `textBinding.ownerScope` | `ExternalText.owner_scope` |
| verified `senderAgent`, `recipientAgent` | sender and recipient IDs |
| immutable engine Task ID | `task_id` |
| `messageId`, `contextId`, `text`, `workDeadline` | message, context, text and independent work deadline |
| native receiving profile/owner/epoch | `RecipientBinding`, outside received text |

The current common `Runs` contract has only running/succeeded/failed/cancelled. It does not yet carry recipient-owner approval metadata. A future host facade must therefore keep draft/approval stages running without result text; it must not report succeeded or expose the draft before the approved result handoff. Unknown must stop/reconcile, not be represented as failed or retried. Capability negotiation and A2A `INPUT_REQUIRED` projection remain common-layer work; this adapter does not claim those APIs are connected. No `Runs` descriptor advertising verified live Hermes capability is installed by this change.

`completed` in this native receipt means the approved draft reached a verified durable outbox, **not** HAB delivery, human reading, or a completed external file/service operation. The common layer must preserve its independent delivery/display/Task axes and revalidate outbound authority before transmission.

## Backup and lifetime requirements

A normal process restart can restore a pending prompt. Backup restore is different: the host must supply an authority epoch independently of the restored native journal, rotate it on restore, and revalidate current owner policy on every callback. An epoch change parks nonterminal native receipts as unknown and cannot revive a consumed approval. This adapter cannot detect a silent rollback of both the journal and the external authority anchor. If a host cannot prove that continuity, it must not enable processing or reply handoff. Never treat a restored missing record as permission to rerun an operation.

The host clock and work/approval deadlines use Unix epoch milliseconds. Work/approval deadlines are separate from the Relay delivery TTL. No cancellation API is provided or advertised. No arbitrary side-effect approval/execution, automatic model retry, reply transmission, daemon installation, new credential or production setting is included. Those remain later acceptance stages.

## Verification

Run the existing repository bridge suite, which uses temporary private stores and loopback fixtures only:

```sh
python3 -B -m unittest discover -s hermes_bridge -p 'test_*.py'
ruff check --no-cache hermes_bridge
ruff format --check --no-cache hermes_bridge
```

The optional native compatibility probe imports a reviewed Hermes checkout in an isolated temporary home, with lazy installation disabled. It exercises the actual `AIAgent` subclass dispatch block, `PendingControls` and `SessionAuthority.respond` APIs. The model and authenticated principal source are fixtures; no `AIAgent` instance, provider/client, live UI or production session is started:

```sh
HERMES_DISABLE_LAZY_INSTALLS=1 /approved/existing/venv/bin/python -B \
  -m hermes_bridge.prove_external_native \
  --hermes-source /approved/hermes-checkout \
  --expected-commit FULL_REVIEWED_COMMIT
```

Tests observe a real temporary target file and loopback HTTP arrival count for protected dispatch attempts. They cover owner/profile/generation mismatches, revocation, expiry, duplicate or changed requests, restart, owner-lock contention, lost model/outbox responses and backup restore with a rotated external epoch. These are isolated contract tests, not proof of deployment or a real model-to-HAB round trip.
