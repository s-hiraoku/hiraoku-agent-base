# Dedicated inventory end-to-end entrypoint

The ordinary `server.ts` / `createRuntime` continues to reject inventory policy.
`startInventoryEntry` and the manual `inventory-server.ts` are separate, explicit
one-shot entrypoints. Importing either does not start anything. This implementation
has a synthetic local end-to-end test; it is not evidence of a live Hermes model
run or three-agent production connectivity.

## One audit, code gaps versus operator configuration

| Audited boundary            | Previous gap                                                                | Implemented code / remaining operator evidence                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated entry             | Normal runtime intentionally rejects inventory                              | Strict `inventory-one-shot`, `enabled: true`, explicit distinct requester/worker identities; invalid settings fail before binding                       |
| Hub HTTP client             | Connectivity-only response parser                                           | Separate `InventoryMCPClient`; canonical fixed inventory request/result; loopback only                                                                  |
| Fresh worker scope          | Scope created only inside factory, no server enrollment                     | Trusted factory callback enrolls actual Inspector/Runs boundary; request/token agent labels never select authority                                      |
| Submit-to-child             | No entrypoint invoked factory on authenticated submit                       | Fixed request key/type, durable idempotent task; one factory/key/child for concurrent duplicate submits                                                 |
| Async run                   | Adapter's single step could leave a nonterminal run                         | Follow same durable receipt until terminal or deadline, then stop; never claim a second task                                                            |
| Result-to-stop              | Immediate abort could race complete acknowledgement                         | Result retrieval closes gracefully after worker ACK/factory cleanup; deadline/manual/failure abort remaining work                                       |
| Process-start pins          | Artifact subsecond ctime could follow rounded `ps` start                    | Wait until next second before launch; Inspector retains its pre-start checks                                                                            |
| System interpreter          | File snapshot required current-user ownership even for reviewed system tree | Only interpreter covered by explicit systemRuntime tree may be root-owned; tree hash, effective write refusal and other files' ownership remain checked |
| Live auth/configuration     | Verified issuer/resource/client/subjects and token availability unknown     | Still operator configuration; no acquisition, discovery, refresh, copy or issuance in this change                                                       |
| Actual Mac model invocation | Live launch not authorized                                                  | Still unperformed; actual Inspector and approved existing OAuth/provider route must pass before a supervised run                                        |

## Fixed contract and lifecycle

Hub binds only `127.0.0.1:8789`; the dedicated child remains `127.0.0.1:8645`.
An occupied port fails rather than reusing or changing the existing listener.
The Hub port is separate from the ordinary Hub and other local applications.
Exact Host and optional approved Origin are checked, including duplicate headers.
JWKS is fetched only from the configured HTTPS Auth0 tenant; token signature,
audience, client, subject, expiry and operation scopes remain authoritative.

The requester can only submit/get its fixed inventory task. The worker can only
claim/get/heartbeat/complete inventory under the fresh verified runner scope.
Neither can issue grants, reconcile, consume events, submit ping, select shell,
choose another destination, provide personal data or expand tools. The fixed
request is `{ "task_type": "shift_log_inventory", "request_key":
"hab-inventory-one-shot-v1" }`; no free-form fields are accepted.

A fresh private `inventory-hub.sqlite` is created exclusively in the prepared
profile. Existing DB/sidecars refuse startup. Existing factory artifacts also
refuse reuse; failed/partial runs retain evidence for operator reconciliation.
The admission/work deadline is at most 120 seconds, including idle time. Bounded
child cleanup and HTTP drain may continue after that deadline. No
local API key is generated before an authenticated accepted submission. The
runtime-only local bearer is sent only to the owned child and its Runs connector.
A result read waits for acknowledgement and cleanup before closing HTTP. Deadline
or manual stop aborts work. `closed` rejects on uncertain factory shutdown; retained
stores/receipts are not automatically deleted, relaunching is not reconciliation.

## Local verification without a model

`node --test test/inventory-entry.test.js test/inventory-factory.test.js` exercises
signed synthetic JWTs through the actual HTTP entry, Hub SQLite task queue,
factory, real owned Node fixture child, real InventoryInspector and real Runs
HTTP client, final task result and child stop. The fixture produces only a fixed
synthetic metadata result and maintains SQLite run idempotency; no model or
installed OAuth is involved. Only the OS process observation is a trusted
synthetic probe; command/commit/listener observations are not live attestation.
Filesystem ownership, immutable hashes, marker/manifest identities and scope
checks are real. Linux tests exercise root-owned runtime-file checks; the managed
Mac fixture uses a private immutable dummy interpreter because system-file write
probes may return EPERM. Production still accepts only EACCES for write refusal:
EPERM is inconclusive and remains fail-closed.

Regressions cover concurrent duplicate requests, unsigned/wrong audience/client/
subject/scope tokens, requester worker-operation denial, extra agent/destination
fields, wrong worker authorization before claim/run, idle expiry, settings
refusal and missing CLI config. The successful path holds the worker complete
ACK after DB commit while the requester retrieves the result; clean shutdown
must wait for ACK. Existing factory tests retain PID/late-worker/late-claim/
sidecar/stop-failure cases. A synthetic callback success alone is not acceptance.

## Manual connection prerequisites (not performed)

1. Approve concrete Auth0 issuer and resource audience, requester subject/client
   with `hub:submit hub:get`, and a separate service worker subject/client with
   `hub:claim hub:get hub:heartbeat hub:complete`. Worker fresh runner scope is
   assigned by this entry, never embedded from untrusted JWT fields. Confirm how
   the already acquired service token will be supplied without copying secrets
   into source, argv, environment, logs or repo files.
2. Prepare a private mode-0600 `*.local.json` with version, explicit mode/enabled,
   oauth issuer/resource, requester/worker identities and reviewed pins from the
   existing offline launch procedure. No settings are auto-generated or enrolled.
3. Confirm actual immutable code/config/import closure and filesystem/process
   observations under the authorized runtime execution policy. A managed denial
   cannot be relabeled as nonwritability. Keep existing profile/auth/cron/UI intact.
4. Separately authorize the short local key and supervised dedicated child/model
   invocation, existing same-account ChatGPT OAuth access, fixed model/provider,
   one task and allowance/limit stop policy. Fixed route does not establish $0
   billing or entitlement. No paid fallback is enabled.
5. Only after those approvals, invoke `HAB_INVENTORY_CONFIG` with the selected
   private config and `node src/inventory-server.ts`; stdin accepts one bounded
   JSON object containing the already acquired Bearer authorization, then EOF.
   Do not paste tokens into a shell command/history. Prefer a reviewed in-memory
   operator integration calling `startInventoryEntry` with its token callback.
   A [manual hidden-input helper](inventory-token-input.md) supplies an already
   acquired worker token to this existing stdin contract without changing its
   authentication or execution gates. Its dummy tests do not establish live readiness.
   Submit/get via authenticated MCP, observe result/closed state, and preserve
   evidence if reconciliation is required.

Sites deployment, plugin registration, public endpoints, credential issuance,
privilege expansion, persistent workers, real agent external communication and
model calls remain outside this implementation. None were performed by tests.

## Metadata-only bootstrap

A separate explicit `inventory-metadata` mode serves protected-resource metadata
without constructing a task service, database, JWT verifier, worker, local key or
model connection. Copy `config/inventory-metadata.example.json` to an owner-only
mode-0600 `*.local.json`, set the reviewed issuer/resource, and manually invoke
`HAB_INVENTORY_CONFIG` with `node src/inventory-server.ts`. This mode requires
`enabled: false`, rejects authority/worker fields and never reads token stdin.
It closes after ten minutes or SIGINT/SIGTERM. Editing its config cannot promote
it: stop it and use a separate confirmed active configuration and invocation.

For a resource `https://hub.example/hab/mcp`, the two exact ingress paths are
`/hab/mcp` and `/.well-known/oauth-protected-resource/hab/mcp`; root metadata and
existing routes need no replacement. Shared HTTP admission permits only the
configured resource Host or `127.0.0.1:8789`. Unknown Host, duplicate Host/
Authorization/Origin and a nonmatching Origin receive 403. Forwarded headers
confer no authority. Metadata GET returns 200; its other methods return 405.
Every task request receives 401, including requests with a Bearer value.
Authenticated one-shot mode retains JWT/subject/client/scope authorization.

Raw HTTP tests send the configured public Host and prefixed path through the
complete synthetic authenticated round trip. A separate CLI bootstrap fixture
rejects every task operation and instruments SQLite construction, key random-byte
generation, process spawn and outbound fetch: all counters remain zero. Changing
its config during operation also leaves every task denied. These are loopback
fixtures; actual external ingress, OAuth callback registration, verified subjects
and real tokens/model calls remain untested and require separate authorization.
Metadata availability alone does not complete a ChatGPT OAuth/tool connection.
