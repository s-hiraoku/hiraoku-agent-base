# Optional deny-only ACP owner driver

`createAcpOwnerDriver` in `src/owner-integrations/acp-stdio.ts` implements the wire/process
portion of an `ExternalOwnerDriver`. It is optional user-managed owner integration, outside
`adapter-host`, the agent SDK and the configured Relay. No standard messaging path imports it.
There is no product-specific runner, automatic installation, live factory, credential loader,
prompt, model request, queue consumer or grant/resume API. This is reusable code, not a native
product binding established by the synthetic tests.

## Protocol and cause chain

The reviewed schema is ACP protocol version 1, generated schema ref `refs/tags/v0.11.2`:
[ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/v0.11.2/schema/schema.json),
[initialization](https://agentclientprotocol.com/protocol/initialization),
[session setup](https://agentclientprotocol.com/protocol/session-setup), and
[stdio transport](https://agentclientprotocol.com/protocol/transports).
Source review used the official Python SDK's generated `schema.py` and `meta.py` plus
its NDJSON `connection.py`, without importing or starting any native product. No SDK is
added to HAB; tests use a synthetic executable implementing this minimal wire surface.

The driver starts one independently approved absolute executable with literal approved argv
and working directory. It owns the child's stdin/stdout pipes exclusively, sends one
`initialize`, requires protocolVersion 1 and `agentCapabilities.mcpCapabilities.http === true`,
and sends at most one `session/new`. The session request contains an absolute approved cwd and
exactly one HTTP MCP server. ACP headers are an array of `{name,value}` pairs, containing only
the owner's literal Authorization Bearer. The URL is numeric loopback and `/mcp`. The owner's
launch/configuration objects must be frozen. No shell, environment interpolation, MCP stdio
child configuration, OAuth, client certificate, identity-header substitution or authentication
renegotiation is supplied. An authentication-required response stops; it never initiates login.

The only supported outbound requests are `initialize` and `session/new`. Client filesystem
read/write and terminal capabilities are explicitly false. A native permission request receives
the ACP cancelled outcome and then stops the channel. Other unsolicited requests or unknown
notifications fail closed. Bounded `session/update` notifications are discarded. No native
approval is granted or bypassed, and no prompt, cancel-prompt, resume, fork, session deletion,
model change, gateway-wide stop or retry operation is exposed.

One correlated successful `session/new` response produces a private opaque object. Only that
object and the identical launch may enter `verifyCommitted`, once. The trusted local
`verifyDeployment({sessionId, launch})` callback still must establish that the deployed product
actually commits before responding and that the configured capability belongs exclusively to
this generation and every authorized effective participant. ACP does not supply a universal
native attestation API. Session IDs, names and opaque objects are not identity or approval.
The callback is trusted deployment code, not a field supplied by the native peer or an MCP tool.
The caller's `scopeSignal` must abort on profile/viewer scope loss, owner replacement or changed
participants. The driver cannot independently discover those product-specific changes.

[The external owner](external-owner-launcher.md) separately captures the actual current discovery
receipt after create returns, before verification, and binds only that unchanged receipt. Eager
HTTP discovery may have already closed before native commit. Discovery alone, the native reply
alone, or a UUID alone cannot bind. The dedicated capability must not be disclosed elsewhere or
reused. Missing discovery and response loss stop without another `session/new`; the native
outcome remains unresolved even if the owned stdio process exits successfully. Any reconciliation
requires a separately approved official product operation, not an automatic retry here.

## Bounds, privacy and cleanup

The reader accepts one JSON-RPC object per UTF-8 newline-delimited frame. It bounds each frame
to 256 KiB, total stdout plus stderr to 8 MiB and frames to 2048 over the driver's lifetime.
It has at most one pending numeric request ID. Unknown/duplicate IDs, malformed JSON/UTF-8,
batches, error responses and incompatible version/capability replies stop. Partial EOF stops;
a late response never revives a stopped generation. Extra standard result metadata is discarded.
There is no raw protocol/result/error logger. Stderr is drained/discarded, and public failures
are fixed strings. The capability travels only through the owned stdin and dedicated HTTP
requests, never argv or a trace written by this driver. Trusted callbacks and native products
can still persist data themselves, and their behavior must be reviewed separately.

Child spawn passes `env: {}` and no inherited Node execArgv. macOS can add its own
`__CF_USER_TEXT_ENCODING`; the test checks the absence of inherited user/proxy/Node options.
An empty environment is not an OS sandbox. Executables can still read home, profile, credential
stores and network using the OS user's rights. Approved argv/cwd/executable paths must contain
no secrets. No real executable or profile is selected by this module.

Request/cleanup durations are 1–60000 ms and lifetime is 1–900000 ms. Lifetime starts before
spawn. Stdout EOF/error, child exit, request timeout, launch abort and scope loss synchronously
fence the driver and abort its owner signal. Close is idempotent, rejects pending work and ends
only the owned stdin. After one shutdown interval it may signal its exact ChildProcess handle
with SIGTERM, after another SIGKILL, then waits one further interval for observed exit. A known
signal denial prevents every retry/escalation. Forced termination or nonzero/signalled exit is
failure, never graceful success. Malformed/unmatched frames, output limits and active pipe/write
errors also latch a protocol failure. Even subsequent confirmed exit0 cannot make driver close
or owner completion succeed; stores are retained. Expected EOF, scope/launch abort and lifetime
shutdown remain normal ownership endings when cleanup succeeds. Pipe errors induced by an
already-started shutdown do not turn that shutdown into a new protocol fault. An unconfirmed exit rejects close, keeps `exited` pending and
requires retaining state. A later actual exit can settle `exited` but cannot change failed close
into success. No guessed PID, process-name search or process-group kill is used.

For composition, allow the external owner's driver cleanup budget to exceed three driver
shutdown intervals; otherwise its independent shorter deadline may conservatively retain stores.
Close does not wait for a product-specific verifier that ignores cancellation: the external
owner tracks that work and retains stores until it settles. Close does not erase native history
or revoke broader tickets. Child descendants, parent death with a blocked orphan, suspension,
OS crashes and hard real-time guarantees need independently approved operational containment.
The external supervisor owns its immediate child only, not this driver's descendants.

## Required approval and verification before a real model-free run

No live action is implied by source review or synthetic success. Before native `session/new`,
approve and independently verify:

1. The exact executable, revision, approved argv, owner factory and cwd; all startup code/profile
   reads and persistent side effects, even if no model is requested.
2. The selected profile and all viewers/participants, including any product-wide access; the
   monitor/verifier responsible for scope changes and commit semantics.
3. Authentication/ticket creation, delivery, lifetime and scope. A product's interactive bootstrap
   ticket may include create/read/submit/control/approve/respond beyond one session. Do not claim
   it is session-only, reuse existing credentials or create a new ticket without approval.
4. One newly approved exclusive HTTP capability, exact recipient/transport and unique server name
   with no conflicting profile declaration; literal URL/header, no profile-secret interpolation,
   OAuth, identity header or client certificate. Do not log/persist the capability in diagnostics.
5. Fresh private stores, allowed resources, finite deadlines, teardown ownership, and limitations
   on native session history, broader ticket revocation and unconfirmed outcomes.

The initial live trial must remain model-free and deny-only. Prompts, live queue consumption,
recipient grants, production deployment and upstream product changes require separate authority.

## Synthetic regression scope

`node --test test/acp-owner.test.js` exercises real owned Node stdio pipes, HTTP MCP and temporary
SQLite. Its named child is explicitly synthetic and receives only synthetic capability bytes.
It checks standard request shape, false client capabilities, bounds, denied permissions, response
loss/no retry, opaque correlation, missing discovery, closed eager discovery followed by commit,
pre/post-bind tool denial, EOF/scope loss, environment/output boundaries and exact owned cleanup.
No live product, profile, ticket, model or production queue is touched. These results do not
prove native commit semantics, effective participant scope, native auth or operational residency.
