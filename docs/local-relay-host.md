# Local Relay host and supervised connection plan

`startLocalRelay` in `src/relay-host/local.ts` is the explicit, product-independent
programmatic startup entry point. Importing it performs no IO. Calling it opens
only its dedicated HAB registry, Relay store and process ownership database, then
listens on IPv4 `127.0.0.1`. All capacity/transport limits, stable integrity keys,
individual authority, bearer verifier and audit sink must be supplied by trusted
operator code. No credential source, fixture identity, public bind or no-auth
fallback is selected automatically. HTTP exposes only the existing five Relay
MCP tools; runtime registry management authority is withheld.

The directory must already exist at a canonical absolute path, owned by the
current user with no group/other permissions. New DB files are 0600. Existing
permissive, symlinked or hardlinked database files are refused, not repaired.
The process-lifetime SQLite owner is acquired before either data store is opened.
A competing host is refused, even on a different port. Changed keys refuse
reopening. Keep the original stable integrity keys for retained database state;
they are not client authentication credentials and must not be rotated blindly.

The returned `{ url, close }` lets an operator composition bind a supervisor's
normal stop signal to `close()`. Stop closes the listener, aborts network work,
awaits bounded gateway callbacks, closes the stores and releases ownership.
Late authentication results cannot dispatch tools. Reopening the same directory
preserves message IDs, original expiry, delivery state and deduplication. Startup
failure releases owned resources, but may leave initialized private DB files.
It never deletes accepted state or stops another process to free a port.

The opt-in [configured local CLI](local-relay-service.md) now supplies private
credential loading and a digest-based local verifier. No LaunchAgent is installed
by this module. Live credential provisioning,
operator enrollment, reviewed audit persistence, approved finite capacities and a
supervisor composition remain deployment work. No Adapter cycles, expiry/GC
scheduler, wake notifications or external connections are started by this host.
Existing stores enforce bounds; a maintenance schedule must be explicit before
unattended operation. Tests use only synthetic credentials and temporary DBs:

```sh
npm ci
node --test test/local-relay-host.test.js
npm run demo:hab-mvp -- --simulate
```

On macOS, older snapshot fixtures require a canonical temporary root. If the
ordinary `TMPDIR` contains a symlink such as `/var` → `/private/var`, supply its
resolved directory to the test process; do not weaken snapshot path checks:

```sh
TMPDIR="$(node -e 'console.log(require("node:fs").realpathSync(require("node:os").tmpdir()))')" npm test
```

## Proposed authorization boundaries (not provisioned)

| Purpose                          | Minimum permission and intended lifetime                                                                                                                                                                                                                                                                                                                                 | Storage and readers                                                                                                                                                                                                     | Stop, revoke and delete                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay store integrity            | Stable independent random keys for registry and delivery fingerprints; no network permission. Retain while their databases exist.                                                                                                                                                                                                                                        | Private service config outside Git, 0700 directory/0600 files; current OS user and its Relay process. Same-OS-user processes are not isolated by these modes. Never argv, logs or MCP results.                          | Stop the owned Relay. Retain keys with protected database backups; deleting a key makes retained state unusable. Disposal of both DB and keys is a separate destructive operator action.                                                                                                                                                                                                        |
| Relay probe and execution bridge | Distinct opaque high-entropy bearer per individual, verified against an exact principal/connection binding. Only submit/status/poll/ack/resolve needed for the fixed roundtrip; no registry management, Task operator or unrelated receiver rights. Initial test expiry: 15 minutes, no refresh. Persistent unattended access needs a separate expiry/rotation decision. | Raw bearer only in each approved local client runtime; Relay keeps a protected digest-to-principal configuration. No shared bearer between individuals. Durable storage of raw bearers is a separate explicit approval. | Stop finite clients, disable the credential mapping and revoke the registry binding; stop Relay for immediate local shutdown. Expiry must be enforced by the verifier and per-operation authority, not merely written in metadata. Remove test credential artifacts after reconciliation. The common verifier is implemented separately; live provisioning remains an explicit operator action. |
| Isolated Hermes API              | Separate temporary 32-byte bearer, only for one supervised isolated process. The bearer itself has no API route scope or inherent expiry. The approved wrapper must restrict routes/input/run count and end within 120 seconds; no refresh.                                                                                                                              | Private runtime injection to child and bridge only. Never copy Desktop `.env`, persist raw key, or put it in arguments/logs. Only fingerprint/purpose/expiry/state metadata may survive.                                | Stop/reconcile the single Run and owned API process, confirm its listener is closed, dispose key references. A stop failure is unresolved, not successful revocation. JavaScript strings cannot be reliably zeroized.                                                                                                                                                                           |
| Existing model authentication    | Request explicit reuse for one independent fixed-text Run through the existing `openai-codex / gpt-6.1-sol` route. No new OAuth grant, token refresh/adoption, API-key fallback, purchased credits or provider fallback.                                                                                                                                                 | Existing protected store stays in place; only the separately approved runtime resolves it. No token is copied into HAB or its public configuration.                                                                     | Stop the one-shot runtime and remove temporary runtime references; leave the user's original authentication intact. Do not revoke the user's account/session as part of this test.                                                                                                                                                                                                              |

The provider/model names alone do not establish entitlement, remaining allowance
or $0 additional billing. Treat price/credit exposure as **unknown** until current
account and route evidence confirms included use and no paid spillover. Do not
invoke a model to discover its billing path.

## First real roundtrip, after approvals and technical gates

Proposed ports are Relay **8792** and temporary isolated Hermes API **8793**, both
`127.0.0.1` only. Recheck immediately before starting. A collision means stop and
report, never terminate/reconfigure an existing service. Relay may later be
supervised continuously under the existing loopback-start request. The API and
receive/execute/send cycle initially remain finite, manually invoked and bounded
to **one new task, concurrency one, 120 seconds, no automatic continuation**.
No firewall, external publication, CORS opening or existing Desktop/profile change
is part of the plan.

Flow: separately bound probe → Relay → common Adapter's durable inbox save → ACK
→ explicit `connectivity_check` Task bridge → existing HermesRuns boundary →
TaskReplies → common durable outbox → probe. A normal question or ACK never
implicitly creates a task. The Adapter owns durable handoff and finite triggering;
MCP registration alone supplies neither polling nor save-before-ACK guarantees.
The identity proven by this path is the execution bridge, not a native per-chat
Hermes identity. Later native MCP participation requires its own verified binding.

The existing fixed-pilot contract sends exactly
`Reply with exactly HUB_HERMES_OK.` to Hermes, accepts exactly `HUB_HERMES_OK`,
and normalizes it to `Agent Hub connectivity check completed.` in HAB. The
standard zero-tool contract is a different contract; do not substitute them during
recovery. Keep the original scope, run ID, idempotency key and deadline. HTTP
retries may reconcile the same admitted Run; they must never create a second one.
No private files, memories or conversation are inputs.

A fresh independent Inspector must prove the dedicated profile/import closure,
fixed wrapper, actual process/listener, empty effective tools and disabled personal
context/session overrides. A prompt saying “read only” is insufficient. The
installed API has full tools by default. Current source provides the fixed-pilot
client/Inspector contract, not an automatically deployable fixed-text API launcher.
The inventory launcher reads files and must not be substituted for this test.
Locate/review the existing fixed wrapper and pins, or resolve this missing
implementation explicitly; stale prototype trial evidence is not live proof.
The current execution environment's denied process observation also prevents
claiming fresh Inspector evidence; resolve it through the ordinary permitted
execution path, without bypassing the denial.

Before approval, report which artifacts would be created, exact credential
readers/lifetimes, the fixed payload, the route/billing uncertainty and any remaining
isolation or process-observation blocker. Credential approval does not by itself
prove these technical gates or complete a production connection.

For the reviewed fixed wrapper, the pinned Hermes source supports an explicitly
empty `enabled_toolsets=[]` (distinct from `None`, which enables all),
`skip_memory=True`, `skip_context_files=True`, `load_soul_identity=False` and
`skip_background_review=True`. The proposed isolated profile has no auto-loaded
skills, configured MCP servers, memory provider, private prefill, existing session
or personal workspace; its working directory is empty. Its sanitized environment
must also omit inherited dispatcher/delegation variables, plugin configuration
and provider/key/endpoint overrides. Before admission, assert the actual tool
list is empty, both memory objects are absent, no private prompt/history was
loaded, and the effective provider/model match. Apply a proposed one-iteration
limit, 128 output-token ceiling, 90-second model/run budget and 120-second
process lifetime. These are **planned checks**, not a deployed wrapper or an
OS filesystem sandbox; review/test their behavior before a live call. Existing
model retry/refresh/fallback behavior must also be rejected or explicitly bounded,
not assumed absent from an API-level one-run limit.

Source references for the installed commit: [toolset selection](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/model_tools.py),
[agent initialization and memory](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/agent/agent_init.py),
and [API authentication/default capabilities](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/website/docs/user-guide/features/api-server.md).
