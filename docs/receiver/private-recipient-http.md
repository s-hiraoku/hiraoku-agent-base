# Private recipient HTTP composition

`createPrivateRecipientHttp` in `src/adapter-host/private-http.ts` is an opt-in,
agent-independent owner composition. It reuses the single-source host, durable
owner/control/stores and `createRecipientHostMcpServer`. It neither launches a
listener nor issues credentials, authenticates a native product session, starts a
model, or changes an agent's settings. It is not the stdio composition over HTTP.

## Two separate acceptance stages

Some products eagerly discover MCP tools before committing their native session.
The owner can supply an independently authorized, exclusive launch bearer to this
finite HTTP endpoint. Before `bindVerified`, only protocol metadata is useful:
all six tool calls fail, including reads. No host or fabricated verified context
exists. Metadata and post-binding tool names, schemas and annotations are identical.
An initialize receipt is local freshness evidence, NOT proof of native identity,
commit, exclusive credential possession, or approval.

The owner must independently verify the committed native session/bot, current
launch generation, exclusive credential delivery/connection scope, and all
participants able to use it. Only then may it pass the current local discovery
receipt and already verified distinct recipient/operator contexts to
`bindVerified`. Delayed POST/DELETE handling blocks promotion. A replacement
transport invalidates the previous receipt before reading initialization. A
response-lost/ambiguous create is not permission to activate: reconcile through
the product's authorized API or stop. This module provides no native verifier.

Discovery may DELETE its transport before native create commits. The current
closed discovery receipt can still be bound by the trusted owner; the next
bearer-authenticated transport then belongs to that owner-verified **launch**.
This is not continuity of an MCP session ID. It is safe only when the owner has
verified that the bearer is exclusive to the intended launch and its approved
participant scope. One live MCP transport is supported. A new MCP initialize
cannot adopt an already initialized transport. Credentials must never be reused
for a different instance/generation. Old session IDs do not create transports.

After binding, the host is still paused and permission is deny. The local owner
must separately call `updatePermission(epoch, true)` and `resume(epoch)` after
applicable policy checks. These methods are never tools. All operations retain
current host authorization checks; MCP authentication alone grants none of them.
The caller must provide an acquired owner, migrated private stores, answer journal,
fixed question source, and dedicated single-producer outbox. Receive can consume
other senders from that recipient queue; send grants the entire dedicated outbox.
Neither is a source-filtered queue permission. Never add a second consumer to an
existing production address or open a legacy database with these schemas.

## HTTP and owner boundary

The caller owns a loopback-only listener and passes requests to `handleRequest`.
The exact `127.0.0.1:port` Host and `/mcp` path are required; Origin is rejected.
Every method/request is bearer-authenticated before SDK handling, including
initialize, GET and DELETE. Only POST/GET/DELETE proceed. No redirect or Location
header is emitted. Tokens are never accepted in URLs or echoed in errors/tools.
An MCP session ID, localhost address, profile name or random identifier is not
identity. Use an independently approved literal Authorization Bearer credential,
not a profile secret or an arbitrary X-* identity header. The module does not
mint, save, deliver or rotate credentials. Host checks do not constrain where a
caller binds its listener: a remote listener is outside this supported contract.

Keep local owner handles private. `ownerSignal` must abort when that authenticated
owner is lost. HTTP socket/SSE EOF and SDK client.close() do not mean session
termination; HTTP is not stdio. After binding, DELETE/transport closure is terminal.
A replacement then requires a new composition, new authorization and new verified
binding. Metadata-phase closure alone cannot grant anything or cancel the launch.

## Finite shutdown and recovery

Lifetime is 1–900000 ms; each stop attempt is 1–60000 ms. Stop synchronously fences
recipient authority before durable pause IO, drains operations, closes transport,
then releases the owner. Bind/grant/resume remain unavailable once stopping begins.
Owner status remains available to inspect retained ownership after a failure.
A failed drain/control/close retains owner/stores; completion preserves its first
failure even if explicit stop retry later succeeds. Close stores only after a
successful stop or separately confirmed process exit. Stop does not undo a remote
commit: reconcile answer intents with their original IDs, bodies and deadlines.

Timers run on the event loop and do not provide a hard real-time guarantee. The
external owner remains responsible for a finite watchdog, owned-process shutdown,
listener/socket cleanup and confirmed termination. This module cannot revoke a
product's broader bootstrap ticket or remove its persisted session history. A
second viewer sharing a native session expands the effective participant scope;
the owner must authorize that scope or refuse/revoke the binding.

An external HTTP owner can be launched with a clean environment without the
product spawning an MCP child. That is an owner deployment responsibility, not
an OS sandbox or environment-isolation guarantee supplied by this module.

## Verification scope

`test/private-recipient-http.test.js` uses explicitly synthetic bearer/context
fixtures, owned loopback HTTP, real MCP SDK and SQLite stores, including the SQLite delivery store.
It checks metadata denial, stable manifests, current receipts, delayed requests,
explicit grant/resume, authorization/Host/Origin/path rejection, owner loss,
terminal DELETE, expiry and failed-drain retention/retry. It does not prove native
product identity, credential delivery, exact-body approval, model behavior, live
queue compatibility, or production readiness. No live launcher/config is shipped.
