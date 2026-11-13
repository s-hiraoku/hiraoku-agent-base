# Dedicated recipient stdio composition

`startSingleSourceRecipientStdio` in `src/adapter-host/stdio.ts` connects the
existing single-source host, SQLite owner and recipient MCP server to the current
process's private stdio. It is an explicit composition function for an owner
controlled launch. It does not load a product profile or create credentials,
stores, a scheduler, a listener, native approval or a session identity.

The prerequisites in [recipient readiness](recipient-readiness.md) still apply.
In particular, a private pipe is an identity input only when the launch owner has
verified its exclusive recipient binding. A shared MCP connection does not
become a private session because this function is used. Product configuration
and live model testing require their own concrete acceptance evidence.

## Owner integration

The trusted owner opens and migrates the existing inbox, dedicated outbox, reply
budget, answer journal, control and owner stores, acquires the owner, and supplies
the existing fixed Relay transport factory. These are the same options as
`createSingleSourceHost`; an answer journal is required so a retry preserves the
original answer envelope. The owner supplies two distinct already verified opaque
contexts and the exact permitted source key. Neither context is a tool argument.

```ts
import { startSingleSourceRecipientStdio } from "./src/adapter-host/stdio.ts";

const session = await startSingleSourceRecipientStdio({
  hostOptions: ownedHostOptions,
  actorId: verifiedActorId,
  verifiedRecipientContext,
  verifiedOperatorContext,
  source: reviewedSource,
  lifetimeMs: 60_000,
  shutdownTimeoutMs: 5_000,
});
// Explicit local owner actions, after the binding and applicable policy checks.
let state = session.status();
state = session.updatePermission(state.epoch, true);
session.resume(state.epoch);
await session.completion;
// Close owned stores only after successful stop/completion.
```

The identifiers in this example are trusted integration inputs, not values this
module discovers or authenticates. A production launcher must obtain and verify
them through its existing owner boundary. No runnable allow-all configuration or
test fixture is a substitute. Restart opens with no in-memory grant; the existing
single-source composition requires paused control and an acquired owner. An
active saved control is refused until the owner explicitly pauses it. Startup
never resets the epoch or automatically resumes a previous grant.

The returned `status`, `updatePermission`, `pause`, `resume` and `stop` methods are
local owner handles. Keep them outside tool results, product input and untrusted
callbacks. Permission updates reuse the committed pause/drain/held-owner fence;
resume is a separate explicit action. Source revocation also denies `send`, which
operates on the entire dedicated outbox. There must be one answer producer and
no unrelated queued/restored messages in that outbox. The function does not
validate an arbitrary shared outbox or grant exact-body human approval.

## MCP surface and shutdown

Only `recipient_receive`, `recipient_inbox_read`, `recipient_answer_prepare`,
`recipient_answer_inspect`, `recipient_answer_enqueue` and `recipient_send` are
exposed. Every call and commit retains the existing host authorization and epoch
checks. Initial state is deny and paused. A client cannot grant access, resume,
change the source, release the owner, enqueue arbitrary messages or create Tasks.
The recipient chooses whether to read and answer using its existing policy and
any required native approvals. Receive is one explicit save-before-ACK cycle;
stdio registration alone starts no receive loop or model.

`lifetimeMs` is an owner selected finite lifetime of 1–900,000 ms.
`shutdownTimeoutMs` bounds each stop attempt to 1–60,000 ms. These timers run on
the process event loop; they are not a hard real-time watchdog or remote RPC
cancellation. Expiry, stdin EOF/close/error, stdout error, or MCP transport close
starts the same stop path: permanently revoke recipient permission in memory,
commit pause, wait for running and draining work,
close the SDK server, and only then release the owner. Explicit EOF listeners
are necessary because the pinned SDK stdio transport does not close on EOF.

The irreversible recipient fence runs before any control-store read or pause
attempt. Every existing authorization guard, including guards of in-flight work,
then refuses recipient operations even if control storage temporarily fails and
later recovers in a resumed state. Operator status/pause/release remain usable
for a stop retry. This fence does not replace durable pause or establish its
success, and a new process still requires fresh verified launch binding.

Once stopping starts, local grant/resume operations are refused. Concurrent stop
calls share one attempt. A drain/close/control failure rejects that attempt and
`completion`; it retains ownership and stores. After the underlying work settles,
the local owner may retry `stop()` and close stores only if that retry succeeds.
`completion` records the first failed attempt and remains rejected after a later
successful retry. A failed startup whose cleanup also fails throws an
`AggregateError`; retain stores and the owner until confirmed process exit.
No process is killed by this function. The launch owner remains responsible for
signals and confirmed process exit. Pause or process exit does not undo a remote
commit: subsequent reconciliation must retain the original source, reply ID,
ACK request and outbox lease.

The existing `maxInboxReadResultBytes` owner budget is passed through unchanged.
Align it with the actual MCP client's framing, buffer and product content limits
as described in the [recipient MCP proposal](implementation/recipient-host-mcp-proposal.md).
Oversized reads are refused without truncation or a replacement source.

## Bounded verification

`test/single-source-stdio.test.js` uses the official SDK client, a separate owned
stdio process, and real SQLite stores, including the host's SQLite delivery store.
Its synthetic recipient/operator contexts and chosen answers do not prove a
Hermes/Dots session binding, model decision, actual approval, wake, residency or
production launch. The child fixture is test-only and must not be installed as a
production launcher. Pure EOF and the child's own cleanup marker are checked
separately from SDK client termination so killing a child cannot masquerade as
successful graceful shutdown. Additional fault cases recover a failed pause
read and verify continued recipient denial plus fencing of a delayed poll; an
SDK-close gate independently observes held ownership until close completes.
