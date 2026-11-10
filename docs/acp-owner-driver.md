# Optional ACP owner driver and fixed wake

`createAcpOwnerDriver` in `src/owner-integrations/acp-stdio.ts` implements the wire/process
portion of an `ExternalOwnerDriver`. It is optional user-managed owner integration, outside
`adapter-host`, the agent SDK and the configured Relay. No standard messaging path imports it.
There is no product-specific runner, automatic installation, live factory, credential loader,
queue consumer or grant/resume API. By default the driver sends no prompt. A separate explicit
trusted-local fixed-wake option can send one bounded prompt after successful verification. This is reusable code, not a native
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

Without the fixed-wake option, the only supported outbound requests are `initialize` and `session/new`. Client filesystem
read/write and terminal capabilities are explicitly false. A native permission request receives
the ACP cancelled outcome and then stops the channel. Other unsolicited requests or unknown
notifications fail closed. Default-mode bounded `session/update` notifications are discarded.
No native approval is granted or bypassed. The opt-in below adds only one fixed prompt and its
cancel notification, not resume, fork, session deletion, model change, gateway-wide stop or retry.

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

## Explicit fixed wake, outside standard messaging

A trusted local factory may configure `fixedWake: { text, timeoutMs, maxUpdateBytes? }` and
capture the returned driver's zero-argument `wake()`. Configuration is copied at construction.
The text must be nonempty, valid Unicode and at most 16 KiB of UTF-8. It is a local owner-approved
instruction to use the existing six HAB tools; **never build it from external inbox content**.
The recipient retrieves untrusted messages through those tools and applies its own policy and
existing approvals. ReceiveSupervisor, core dispatch and the Relay never call this method.
Runtime arguments to `wake`, including an external body, are refused. No production caller or
persistent per-source ledger is installed by this module.

Invoke it only from the trusted post-bind factory callback or after the external owner's
`ready` has confirmed the current discovery binding, with separately authorized current
permission/resume policy. The driver itself requires its exact created session, successful
(not pending) deployment verification and current launch/scope/lifetime. It cannot attest the
composition's bind from a session ID, inspect product-wide policy or independently activate
permissions. Omitting the option keeps existing create-and-verify behavior and no model turn.

`wake()` sends at most one standard `session/prompt` request with this same `sessionId` and
`prompt: [{ type: "text", text }]`. A second or concurrent invocation is refused permanently,
even after error, timeout or cancellation. The prompt timeout is 1–900000 ms and never extends
the already-running lifetime. The supported result is a frozen object containing only one of
`end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled` as `stopReason`. Additional
result metadata is discarded. This is a protocol turn result, not proof that a message was
read, accepted, executed, replied to or delivered; no output body or native reasoning is exposed.

With the option configured, every `session/update` must have a valid, matching session envelope.
The supported standard subset is text-only user/agent/thought chunks, tool_call/tool_call_update
(including bounded raw JSON, text content, diff or terminal reference), plan, available_commands_update
and current_mode_update. Metadata can precede session/new's response only while that request is
pending; its session ID must match the eventual response and confers no authority. Text/tool/plan
updates require the active prompt or its single canceled-response drain. The wire response ends
that update window immediately, even when more frames arrive in the same read. Media/resource
content and other update variants are explicitly unsupported and fail closed, not ignored as
successful standard compatibility. Commands, modes, tool descriptions and updates are discarded,
never interpreted as permission, instructions or client-side execution requests.

All update params, including metadata and raw tool JSON, are bounded to depth 16, 4096 visited
values, 256 entries per object/array, 256-byte keys and 64-KiB UTF-8 strings. Escaped lone
surrogates are rejected as well as invalid wire UTF-8. Cumulative update wire bytes default to
1 MiB; the constructor may choose 1 byte to 4 MiB, below the unchanged lifetime output bound.
Limits apply before any content can be retained or forwarded, and no update callback is exposed.

Persist the source's wake-started record **before** calling wake. ACP v1 supplies no universal
stable input-id, durable exact-key admission, or read-only prompt-outcome inspection. Never infer
those from response metadata, a stop reason or successful process exit. A failed/interrupted
attempt remains `unknown`, including response loss and a valid late completion. Shutdown first
fences admission, then sends at most one `session/cancel` notification for the same owned session
before ending stdin. Cancellation is best effort and does not prove non-execution. `close()`
rejects an unknown wake even after clean exit/drain so the external owner retains stores. There
is no automatic retry, reconnect, replacement generation, replay or unknown-clearing API. A real
source orchestrator must halt on its durable unknown record and use separately approved official
reconciliation before any further attempt. Known completion does not erase native side effects.

## Bounds, privacy and cleanup

The reader accepts one JSON-RPC object per UTF-8 newline-delimited frame. It bounds each frame
to 256 KiB, total stdout plus stderr to 8 MiB and frames to 2048 over the driver's lifetime.
It has at most one pending numeric request ID. Unknown/duplicate IDs, malformed JSON/UTF-8,
batches, error responses and incompatible version/capability replies stop. Partial EOF is a protocol failure, including valid JSON without a newline or unfinished UTF-8;
one well-formed response matching the single locally canceled pending ID may drain once during
shutdown, but never revives a stopped generation. Extra standard result metadata is discarded.
There is no raw protocol/result/error logger. Stderr is drained/discarded, and public failures
are fixed strings. The capability travels only through the owned stdin and dedicated HTTP
requests, never argv or a trace written by this driver. Trusted callbacks and native products
can still persist data themselves, and their behavior must be reviewed separately.

Child spawn passes `env: {}` and no inherited Node execArgv. macOS can add its own
`__CF_USER_TEXT_ENCODING`; the test checks the absence of inherited user/proxy/Node options.
An empty environment is not an OS sandbox. Executables can still read home, profile, credential
stores and network using the OS user's rights. Approved argv/cwd/executable paths must contain
no secrets. No real executable or profile is selected by this module.

Initialize/create and cleanup durations are 1–60000 ms; lifetime and the optional prompt timeout are 1–900000 ms. Lifetime starts before
spawn. Stdout EOF/error, child exit, request timeout, launch abort and scope loss synchronously
fence the driver and abort its owner signal. Close is idempotent, rejects pending work and ends
only the owned stdin. After one shutdown interval it may signal its exact ChildProcess handle
with SIGTERM, after another SIGKILL, then waits one further interval for observed exit. A known
signal denial prevents every retry/escalation. Forced termination or nonzero/signalled exit is
failure, never graceful success. Malformed/unmatched frames, output limits and active pipe/write
errors also latch a protocol failure. Even subsequent confirmed exit0 cannot make driver close
or owner completion succeed; stores are retained. EOF at a frame boundary, scope/launch abort and lifetime
shutdown remain normal ownership endings when cleanup succeeds and no wake is unresolved. Pipe errors induced by an
already-started shutdown do not turn that shutdown into a new protocol fault. Semantic frame
faults and buffered tails remain failures even during shutdown. Process exit alone does not prove
pipe drain: close waits one further bounded shutdown interval for closed pipes and requires
natural stdout EOF with no unfinished frame. Missing drain evidence rejects close. An unconfirmed exit rejects close, keeps `exited` pending and
requires retaining state. A later actual exit can settle `exited` but cannot change failed close
into success. No guessed PID, process-name search or process-group kill is used.

For composition, allow the external owner's driver cleanup budget to exceed four driver
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

The initial live trial must remain model-free and deny-only. Configuring fixedWake in source or
passing synthetic tests does not authorize its live invocation. Model/cost route, exact local
wake text, live queue consumption, recipient grants, production deployment and upstream product
changes require separate authority. The separate shared Python bridge still rejects session/prompt;
this standard driver does not silently make that bridge model-capable.

## Synthetic regression scope

`node --test test/acp-owner.test.js` exercises real owned Node stdio pipes, HTTP MCP and temporary
SQLite. Its named child is explicitly synthetic and receives only synthetic capability bytes.
It checks standard request shape, false client capabilities, bounds, denied permissions, response
loss/no retry, opaque correlation, missing discovery, closed eager discovery followed by commit,
pre/post-bind tool denial, EOF/scope loss, environment/output boundaries and exact owned cleanup.
No live product, profile, ticket, model or production queue is touched. These results do not
prove native commit semantics, effective participant scope, native auth or operational residency.

`test/acp-fixed-wake.test.js` adds 38 synthetic cases for fixed text and standard stop reasons,
disabled/preverification/pending-verifier/second invocation refusals, mutation-resistant constructor
configuration, matching bounded updates and malformed Unicode/tool/media/size/depth handling,
timeout/error/EOF/permission failures, scope/launch/lifetime/close cancellation, late completion,
post-response update rejection and actual external-owner store retention. The original 51 ACP
cases remain. These finite fixtures do not certify any native product or source orchestration.

Fixture observations use a private same-directory staged file and atomic rename, so concurrent
parent polling never observes an empty or partial JSON replacement. A deterministic regression
reads the old public snapshot while the next snapshot is empty, partial and fully staged, then
checks the complete replacement and private mode. This is test observation integrity, not native
admission, fsync/power-loss durability or a change to the driver's protocol and time limits.
