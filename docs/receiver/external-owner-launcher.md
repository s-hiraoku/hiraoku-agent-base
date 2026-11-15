# External owner launcher: trusted local composition

This opt-in, product-independent launcher builds on [private recipient HTTP](private-recipient-http.md).
It is not installed in the normal host, does not create Tasks, and supplies no product runner,
native authentication, live credential issuer or permission policy. It is reusable orchestration
code tested against an explicitly synthetic driver, not a completed native connection.

## Two deployment boundaries

`startExternalOwner` in `src/adapter-host/external-owner.ts` owns a new port-zero listener
bound to numeric `127.0.0.1`. It supplies one immutable HTTP MCP configuration to a trusted
external driver: unique owner-selected server name, fixed `/mcp` URL and literal Authorization
Bearer header. The caller supplies an independently approved, generation-exclusive credential.
Names, loopback, object identities, MCP session IDs and successful HTTP are not native identity.
Name uniqueness and exclusive delivery are deployment obligations, not inferred here.

The listener reuses the existing private HTTP transport, fixed-source authority, acquired SQLite
owner/control, inbox/outbox, budget and answer journal. Discovery can expose the six schemas,
but every tool call is denied. After binding, it is initially paused and denied. By default it
stays deny-only. The returned launcher exposes only ready, completion, status and stop. An optional
trusted factory callback can retain the existing local controls described below; they are never
MCP tools or IPC commands.
No existing recipient queue, database, profile or gateway is discovered or opened automatically.

`superviseExternalOwner` in `src/adapter-host/owner-process.ts` starts the fixed Node bootstrap
in a separate process, using the current absolute Node executable and an owner-approved absolute
factory-module path and working directory. The factory exports `createOwnerOptions(signal)`.
It supplies contract-valid driver/options, stores and approved capability entirely within the owner child.
The factory must release allocations if it fails before returning options. Invalid returned options
are outside the supported ownership handoff and carry no resource-cleanup guarantee. Do not put
credentials in the module path, working directory, argv or factory source. This library does not
provide a live secret-loading mechanism or approve creating or transmitting a credential.

The child receives an empty environment, no inherited Node arguments, and ignored stdin/stdout/
stderr. Only the internal IPC channel carries fixed ready/stopped/failed messages and a loopback
URL without credentials plus validated `bound-deny`/`bound` readiness metadata. Neither phase
is an activation command or permission assertion. Raw native results/errors and product stderr are not forwarded. A trusted
factory can still write files or start processes; this is not a malicious-code sandbox. The owner
and driver retain the OS user's filesystem and network rights. A native CLI may read profiles,
home files or secret stores itself. An empty environment does not prevent those reads.

## Optional trusted local activation

`ExternalOwnerOptions.onBound(controls)` closes the composition gap between the external owner
and the existing private HTTP operator methods. It is invoked at most once, after the committed
native verification and unchanged discovery receipt have successfully bound. The callback is
trusted local factory code, not a native peer result, MCP argument, remote permission or new
authorization protocol. It receives a frozen object containing `status`, `updatePermission`,
`pause`, `resume` and the current owner's `signal`. It receives no context, store, bearer or raw
host. Omit it for the existing deny-only behavior.

Presence of a callback grants nothing and does not resume. An independently authorized owner
policy can explicitly use the same current-epoch sequence as private HTTP:

```ts
onBound(controls) {
  const paused = controls.updatePermission(controls.status().epoch, true);
  controls.resume(paused.epoch);
}
```

This example does not authorize running it with live stores or a native product. The policy
still permits exactly the fixed source and whole dedicated outbox chosen in the verified binding.
Receive still consumes the recipient queue, not a source-filtered queue. No new source can be
selected through these controls. There is no automatic model request, answer decision, send,
background receive or multi-question conversation policy. A standard ACP wake, fixed trusted
wake instruction and recipient-native judgment must be composed separately; do not elevate an
external message body into an owner instruction.

The hook can be asynchronous. Readiness waits for it and returns `phase: "bound"`, which means
local composition completed, not that permission is enabled, the host is running, or a message
was delivered. Without the hook, readiness retains `phase: "bound-deny"`. Read the local controls'
status for the actual pause/epoch state. A factory must await all its startup work and must not
await the owner's completion from inside the callback. Do not start detached store work there.

Stop, native scope loss and expiry synchronously fence captured controls before cleanup; none
can regrant after stop. Unsettled callback work retains stores and failed cleanup remains failure
even if it settles later. Callback exceptions are sanitized and stop the composition, including
when a grant happened before the exception. The supervised factory can use this same callback
without adding a remote grant channel or changing the independent process watchdog.

## Trusted driver contract

The driver is separately reviewed, user-managed deployment code outside the HAB product core.
Its methods and signals are local objects, never MCP inputs or serialized claims:

1. `create(launch)` is invoked exactly once. It uses an independently authorized, authenticated
   native management channel and delivers this launch's dedicated configuration exclusively to
   the approved scope. It may perform eager metadata discovery before native create commits.
2. `verifyCommitted(result, launch)` must independently verify the native commit and the causal
   relationship to that request, configuration and generation. It also verifies all effective
   participants, including profile-controlled viewers, rather than assuming a session UUID is
   private. A returned label or self-asserted boolean is not evidence. The synthetic test driver
   makes no real native claim.
3. The launcher captures its current discovery receipt after create returns and before verification.
   It binds only that same receipt after verification and while the launch remains alive. Receipt
   replacement, missing discovery, outstanding writes or owner loss fail closed. Closed eager
   discovery is supported under the underlying launch-exclusive credential contract.
4. The driver aborts its `ownerSignal` on native owner loss, connection/generation replacement or
   participant-scope changes. The launcher also observes the external supervisor's owner signal.
   MCP socket EOF is not proof that the native session or another viewer has ended.
5. `close()` cancels/settles driver work and closes only owned channels/processes. It must not kill
   an entire gateway or unrelated sessions. `closeStores()` closes the caller's private stores.
   Factory code must clean up partial allocations when it fails before returning its options.

Response loss, an error or a hung create never triggers another create. Any later reconciliation
must use an independently approved official product mechanism and prove the same operation.
This stage instead stops and leaves the ambiguous native outcome unresolved. No session deletion,
history erasure, broad bootstrap-ticket revocation or approval bypass is claimed.

## Finite shutdown and evidence

The composition lifetime is 1–900000 ms. Each bounded cleanup step is 1–60000 ms. Stop aborts
the launch, synchronously fences the private host, and closes listener admission and sockets even
if durable drain fails. Driver close and outstanding startup work (including the optional bound callback) must settle, and the host must
stop successfully, before stores close. Failure retains stores, rejects completion and does not
retry cleanup automatically. A late create/verification result cannot bind after stopping; captured controls cannot reactivate it.
Readiness still rejects when startup is cancelled, but successful settlement and cleanup resolve
completion; the supervised child reports stopped and exits zero. Only the launcher's own
post-settlement cancellation is exempt from startup failure. Driver creation/verification errors
(including errors named like cancellation) and real cleanup failures still reject completion.
Synchronous abort callbacks share one stop attempt, so reentrant owner loss does not close resources twice.

If stop or native owner loss occurs while the factory is pending, successfully returned valid
options are cleaned up before handoff: driver close must settle successfully before stores close,
with each step bounded by the returned shutdown timeout. No listener or driver create is started.
Successful cleanup reports stopped and exits zero; failures/timeouts report only fixed failed IPC
and exit nonzero. This does not retry cleanup after composition handoff. A factory that never
returns remains subject to the supervisor watchdog and its own allocation/descendant contract.
IPC disconnect still triggers local cleanup but cannot deliver stopped evidence to the supervisor.

The supervisor's independent timer starts at child spawn, including module load and factory startup.
On stop it asks the child to close. After its finite shutdown deadline it kills only that owned child
handle. Forced termination always reports failure, never graceful cleanup; success requires both
the child's successful cleanup message and observed exit code zero. Scratch should be removed only
after confirmed child exit, observable separately through `exited` and `status()`. If kill fails or
exit is not observed within a further shutdown deadline, completion rejects with exit unconfirmed;
it does not retry the signal or resolve `exited`. Retain state until exit is independently confirmed.
An observed signal failure immediately stops further signal attempts, including escalation; repeated
process error events are sanitized and cannot become an unhandled parent exception.
Driver-spawned children require their own owned cleanup contract; this
supervisor does not find or kill descendants by PID/name. Same-process use alone has no independent
watchdog. Event-loop timers, process suspension and host failure are not hard real-time guarantees.
If the supervisory process dies, the child observes IPC loss when its event loop can run; a blocked
or suspended child additionally needs an external OS/service watchdog. No such service is installed.

## Next native step and remaining authorization

The separate [product-neutral ACP stdio driver](acp-owner-driver.md) now implements standard
initialize and session/new over a dedicated owned channel, with bounded NDJSON parsing and an
explicit synthetic executable regression. It adds no SDK dependency or product-specific verifier.
Its correlated successful create response can support the native cause chain only with independently
verified product commit behavior, exclusive configuration delivery and effective participant scope.
Eager discovery alone is insufficient. The default host does not import or start this integration;
real product startup remains unapproved by source-code or synthetic-test acceptance.

Before live use, separately approve the actual executable/revision, profile and all effective viewers,
authentication/ticket scope, new capability creation and delivery, allowed resources, lifetime,
private storage and cleanup limitations. Native create without a model still changes product state.
No prior source-code or synthetic-test approval authorizes that action. The local callback is only an implementation seam. Live grants, model invocation,
live queue consumption and production deployment still require their own approval and acceptance.

## Regressions

`node --test test/external-owner.test.js` exercises owned HTTP/MCP, real fresh SQLite and synthetic
driver results. It checks pre/post-bind denial, no network dispatch, once-only ambiguous create,
missing/stale discovery, external/native owner loss, expiry, unresolved-work retention, sanitized
failure, environment/Node-option noninheritance, normal child cleanup and blocked-child watchdogs.
Eight additional local-composition cases cover explicit grant/resume with an empty synthetic
receive, unchanged deny-only default, no remote grant tool, stale epochs, revoke, failure/late
settlement fencing, safe store retention and the supervised factory path. This does not prove
an actual native answer or daily operation. These tests use no live product, ticket, profile secret,
model or production recipient queue.
