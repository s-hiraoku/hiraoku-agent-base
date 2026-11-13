# Fixed-connectivity A2A acceptance scope

P1–P3 expose one authenticated `connectivity_check` route through the official A2A SDK, current HAB authorization and existing Relay. Acceptance of this route and release of the whole migration are separate decisions.

## Required route behavior

| Requirement | Evidence entry point | Acceptance condition |
| --- | --- | --- |
| Official Agent Card, Send/Get/List and durable SDK Tasks | `test/a2a-adapter.test.js`, `test/a2a-sdk-store.test.js` | Authenticated calls retain their original Task and context after store reopen. |
| Current HAB authorization and immutable destination | `test/a2a-hab-unit-route.test.js`, `test/a2a-relay-e2e.test.js` | Stale mappings and revoked rights fail closed, including after asynchronous work. |
| Delivery differs from execution and completion | `test/a2a-relay-e2e.test.js` | Save/ACK creates no engine task. Explicit acceptance/submission creates one. A confirmed matching result and authorized closed evidence release the Artifact. |
| Replay, original deadline and uncertain delivery | `test/a2a-relay-e2e.test.js`, `test/a2a-submission-receipts.test.js` | Retries retain the original envelope and receipt. Known success survives lease/deadline expiry without another engine RPC. |
| Same-ID rename compatibility | `test/a2a-rename-acceptance.test.js` | Old names fail closed. Explicit host refresh resumes the same Task, IDs, lease, ACK request, receipt and expiry. Reserved old names, wrong IDs and revoked rights cannot redirect it. |
| Downstream foreign mailbox/status/ACK refusal | `test/a2a-rename-acceptance.test.js` | A separate authenticated Relay group cannot poll, inspect or ACK the request. Proper save/ACK leaves the A2A Task submitted. |
| Finite characterization | `scripts/measure-a2a-relay.mjs` | Five runs of five tasks at concurrency one include one lost-response recovery per run. Artifacts, engine/Relay counts and unresolved intents are checked. |

The independent lab observed producer 45 and independent native 10 cases passing at `b4bc2fcac7e031819a78840d2e4590d30f8f5689`, with exact A2A input `f19f1661bf1b2ce717ba6de485f19adb77f074a4`. Its full inventory passed 1,481 tests. Counts overlap and must not be summed. This follow-up has a separate identity and verification. It does not update the lab's pinned hashes.

## Rename dependency

The compatibility candidate imports the rename owner's exact `e7d77312361249e603d4a7d9461f492bc0ee092a` change, locally replayed as `76a7123992bcb6beba6089ed4c18f3010f14d34c`. It adds no A2A rename API, forwarding alias or replacement Registry. Rename remains an explicit `agent_rename` opt-in. Hosts explicitly refresh current names while preserving IDs according to `docs/agent-address-rename.md`.

This verifies integration with that dependency, not its adoption on main. The original f19 component and independent lab stay unchanged.

## Deferred product requirements

Generic six-direction A2A body/parts, arbitrary attachments, a raw A2A mailbox/poll/ACK API and formal cancellation are outside the fixed route. Card/Get/List authorization does not verify those absent APIs. The foreign-scope tests exercise downstream Relay only.

Remote evidence signing, product wake/GUI, Linux hosting, production identities and OS/power failure durability require separate work. Store reopen is not an OS crash test. NATS integration and release gates remain owned by the other lane.

Finite local measurement does not choose an operator's latency, load or recovery budget. It uses synthetic immediate execution, real loopback HTTP and local stores. Setup, warmup, cleanup and the instrumented SQL diagnostic are outside measured samples. Nominal and recovery samples are separate. A shared-host serial harness cannot establish production capacity, a hardware limiter or comparative speedup.

The whole migration remains blocked until its remaining product and backend gates are met. Public push, PR, merge and production changes remain held by the parent scope.
