# HAB-owned design-verification helpers

These files are intended for `verification/design/checks/` in HAB. They import HAB source and installed TypeScript from the explicitly supplied target checkout. They do not import hirastack code, contain a generic runner, modify the target repository, read production configuration, or use native agents/models.

Generation baseline: HAB `c67711e2bb79670402e3b2cac10452344db7df00`. The target's existing `.claude/skills/verify-hab` feature map remains the public feature map; these are narrowly scoped additional checks. The coordinator owns contract mapping, execution and the Codex skill wrapper.

## Prerequisites and argv

Node >= 24, the HAB checkout's dependencies installed, and the checkout's existing `.claude/skills/verify-hab/scripts/stack.mjs` are required. TypeScript is resolved from `TARGET/package.json`, not the current working directory. No shell expansion occurs inside these helpers. Quote your absolute target/evidence paths in a shell.

```sh
node verification/design/checks/communication-boundary.mjs TARGET
node verification/design/checks/communication-boundary.mjs TARGET --self-test
node verification/design/checks/mcp-durable-roundtrip.mjs --self-test
node verification/design/checks/mcp-durable-roundtrip.mjs TARGET NEW_EVIDENCE_DIR
node verification/design/checks/assert-automated.mjs --self-test
node verification/design/checks/assert-automated.mjs REPORT.json CONTRACT.json
```

`TARGET` is the absolute HAB checkout root. `NEW_EVIDENCE_DIR` must not already exist and should be outside the checkout. All modes exit nonzero on failed assertions. The real roundtrip prints a JSON proof with `status: pass` only after observing a clean shutdown and removing disposable stores. Its stdout alone is insufficient evidence: inspect `trace.jsonl`, `stack.log`, `proof.json` and `cleanup.json`.

These are project-specific JavaScript checks for HAB's TypeScript/JavaScript implementation and MCP/storage boundary. They do not replace required native Node test suites, typechecking or existing Python bridge tests, and provide no cross-language guarantee.

## Static communication dependency boundary

`communication-boundary.mjs` recursively enumerates every `.ts` file beneath `src/relay` and `src/messaging`, classifies each as a reviewed inner/storage/host module or outer transport module, then checks **two separate transitive closures**. A new unclassified module or missing protected source fails and requires role review. This is an explicit dependency policy, not a claim that storage and host workers are literally part of the domain core package.

The communication closure retains the original product/Task boundary across **all** Relay source, including outer adapters. Only `src/relay/**`, `src/messaging/**`, `src/protocol.ts` and `src/security.ts` are allowed local modules; Node built-ins (`node:`), `zod` and `@modelcontextprotocol/*` are the approved package edges. An isolated product adapter outside this closure is not rejected just because it exists.

The additional protected core/storage closure starts from the explicit `coreModules` list in the helper, then checks every transitive local/type/module edge with the stricter policy. It rejects all MCP SDK packages, the MCP client/server wrappers, HTTP and OAuth-resource modules, and the outer-only `src/protocol.ts`/`src/security.ts`. It also rejects direct `node:http` and every package except `node:buffer`, `node:crypto`, `node:fs`, `node:path`, `node:sqlite` and `zod`. A core import of an outer wrapper fails even before that wrapper's SDK edge is reached; an intermediate permitted core module cannot hide the reverse dependency.

The reviewed roles follow `docs/hab-relay-spec.md:74–97` and the implementation's actual imports at the generation baseline:

| Role | Explicit modules | Reason |
| --- | --- | --- |
| Protected messaging contract | `src/messaging/index.ts`, `contract.ts`, `delivery-service.ts`, `tool-errors.ts` | Backend-neutral entry point, envelope, `DeliveryService` port and the fixed public tool error codes. |
| Protected public/domain | `src/relay/index.ts`, `sender.ts`, `receiver.ts` | Durable sender/receiver entry point with injected transport. |
| Protected storage | `sqlite-outbox.ts`, `sqlite-inbox.ts`, listed individually in `coreModules` | Dedicated outbox/inbox storage must not acquire transport SDK or credential dependencies. The retired SQLite Relay store (`sqlite-store.ts`) was removed when JetStream became the only delivery backend. A future filename is not implicitly accepted by this description. |
| Protected host contracts | `agent-capacity.ts`, `writer-admission.ts` | Pure domain or finite host orchestration with injected ports; no import of the transport implementation is required. |
| Outer transport | `src/relay/mcp.ts`, `mcp-client.ts`, `http.ts`, `http-node.ts`, `oauth-resource.ts` | Optional MCP/HTTP codecs/clients/listener and OAuth metadata. These can depend inward and use the MCP SDK. |
| Outer-only shared modules | `src/protocol.ts`, `src/security.ts` | HTTP admission and shared audit contracts needed by outer adapters. They are not exceptions to core's independent closure. |

The TypeScript AST identifies imports, exports, import-equals, import types, dynamic `import()` and direct `require()`. Computed paths, unresolvable project extensions, syntax errors, triple-slash path references and source symlinks require review rather than silently passing. Strings and comments are not dependencies. An isolated execution adapter outside the inspected closure is permitted.

The self-test asserts seventeen failures: the original ten controls (direct product import, Task re-export, model SDK, computed import, import-equals, direct require, import type, triple-slash reference, syntax error, indirect forbidden dependency), plus core→SDK directly, core→MCP wrapper→SDK, core→permitted sender→MCP wrapper, core→OAuth, core→HTTP, core→outer shared security type and core→HTTP builtin. Harmless comments, ordinary strings, an optional model adapter outside the closure and outer MCP→SDK must pass. It creates a temporary source tree and removes it in `finally`; it does not start a server.

Limits: this establishes source-module dependency edges in the stated closures. It does not inspect npm package internals, aliased loaders, reflection, global `fetch`/socket capabilities, import-time side effects, SQL contents, schema semantics, native approvals, model invocations, Task creation, configuration or all non-relay HAB code. Type edges are intentionally included. Conservative rejection of a new valid module path/package is a review request, not evidence that runtime execution occurred. The real protocol path remains a separate roundtrip check below.

## Durable common-MCP roundtrip

`mcp-durable-roundtrip.mjs TARGET NEW_EVIDENCE_DIR` performs a finite sequence:

1. Creates empty isolated state and spawns the target's existing verify scaffold with explicit loopback port `0`, so the OS chooses an available port. It records only its own child handle/PID. It waits at most 10 seconds for scaffold readiness. JetStream is the only delivery backend, so the scaffold starts its own private loopback `nats-server` (`HAB_NATS_SERVER` or `.runtime/nats-install.json`) inside that budget and stops it on SIGTERM.
2. Doctor compares the scaffold's state PID and pidfile with the actual owned child, checks the loopback HTTP `/mcp` URL/port and sends an unauthenticated POST that must return 401. Subsequent authenticated `relay_resolve` establishes actual usability. HTTP requests have bounded deadlines.
3. Sends one synthetic question over real MCP/HTTP and resubmits the identical envelope. The receipt IDs must match. Authority, enrollment UI and bearer values come solely from the existing synthetic scaffold.
4. Runs the actual `DurableReceiver` with the actual `SQLiteInbox` and `HabMcpClient`. At the exact outgoing `relay_ack` fetch boundary, before sending any ACK bytes, opens a separate `DatabaseSync(..., {readOnly:true})`. That connection must see the exact full message body, an unconfirmed inbox receipt, and the original pending ACK journal matching the outgoing request ID and complete request. It never migrates or writes the observed database.
5. After the real ACK response, checks confirmed local receipt, orderly closes/reopens the recipient store, and reads the unchanged body through `withEntry`, including its keyed integrity checks. Sender status must be `acked`; a final recipient poll must be empty.
6. In `finally`, closes the recipient store, requests SIGTERM on its own child only, waits at most 5 seconds, and uses a further bounded 2-second emergency SIGKILL fallback if needed. Forced termination or missing clean-stop evidence makes the proof fail. Emergency cleanup is never a crash-durability test.
7. Once child exit is observed and local store close succeeded, removes the scaffold's disposable `instance` tree and receiver SQLite/WAL/SHM files. It keeps scaffold audit evidence and the four named evidence files. If process exit or store close is uncertain, it retains synthetic state and records the uncertainty. A failed attempt writes `proof.json` with `status: fail` when the filesystem remains writable.

This proves one synthetic-authority loopback protocol/storage path with committed-before-ACK observation, stable same-ID submit receipt, confirmed recipient persistence after orderly reopen and sender-visible delivery completion. The independent observer does not call `SQLiteInbox.migrate()` or rely on an in-process receiver getter to establish the pre-ACK commit.

The `--self-test` mode exercises that same pre-ACK observation function against two SQLite connections. It must reject ACK before save, uncommitted save, missing original journal, uncommitted original journal, changed outgoing ACK and changed body; a committed matching body/journal must pass. This is a negative control of the **observation gate**, not a stand-in for running HAB. It creates/removes only its temporary DB; no server or model starts.

Limits: the authority/enrollment interaction is synthetic and the HTTP listener is existing verification scaffolding assembled from real HAB classes. There is no real-product/OAuth/native session attachment, native agent/tool execution, approval UI, periodic long-running supervisor, body handoff to an agent, deployment, server restart, lost-response injection, kill-9, power loss or physical-media recovery proof. A clean recipient DB reopen is described only as a clean recipient DB reopen. This path does not assert general absence of Task creation or that every public entry point works. The generated skill/contract must map broader requirements to their own existing tests or honest manual checks.

## Evidence and side effects

The real roundtrip creates a child listener on an ephemeral loopback port and writes only `NEW_EVIDENCE_DIR`. `trace.jsonl` contains synthetic request/response bodies, IDs and the pre-ACK observation. Authorization headers are omitted. `stack.log` contains scaffold startup/shutdown output; `scaffold/evidence/audit.jsonl` contains its synthetic audit events. `cleanup.json` records observed exit, fallback, storage removal and errors. `proof.json` ties scoped success/failure to cleanup. If cleanup is uncertain, retained `scaffold/instance/state.json` contains **synthetic** bearer values; inspect artifacts before publishing.

The helper is trusted code, not a security sandbox. It inherits the caller environment and imports the supplied target's code. The contract runner should additionally impose its overall command timeout and retain evidence after interruption. SIGINT/SIGTERM request cancellation and bounded owned-child cleanup; abrupt termination of the helper itself can prevent `finally`, so missing cleanup proof is incomplete. Never drive a production endpoint by editing the stored state file.

## Automated-subset CI evidence gate

`assert-automated.mjs REPORT.json CONTRACT.json` is a **post-run** HAB gate. Its exit 0 means only that the complete required automated subset has internally consistent passing evidence; every active manual check must still be `unverified`. It does not convert the generic runner's `incomplete`/exit 2 to overall product compliance. CI must first retain the runner report and then run this gate, rather than treating any exit 2 as successful. The gate itself must not be a command inside the report it inspects; its `--self-test` can be mapped independently.

The gate reads the supplied contract bytes and report, requiring matching spec SHA256/project/version, `executed: true`, empty drift, identical before/after target snapshots, a valid runner hash and identical verification-input snapshots. It computes the required check set from `accepted` and `unresolved` requirements, rejects missing/extra/duplicate checks, checks requirement/conflict projections, and validates each check's metadata and expanded argv against the contract. It derives a single consistent absolute target from explicit `{target}` argv and uses the contract/report files' actual canonical directories for `{bundle}`/`{evidence}`.

Every required command must appear exactly once with `status: pass`, exit 0, confirmed cleanup, no retained scratch and a matching actual log hash. Recorded helper maps must match the exact contract inputs, their current file hashes, and the before/after maps. Node TAP and Python unittest logs are parsed independently: nonempty passed-test totals must match `passed_tests`, with no failures, skips, cancelled/TODO cases or expected-failure summaries. A forged passing status alone is insufficient. Manual checks must have their exact unverified recipe and no fabricated command evidence. Overall may be only `incomplete` or `pass`, must agree with requirement projections, and must remain `incomplete` whenever manual checks exist.

This HAB-specific gate additionally requires `mcp-durable-roundtrip`, reads its actual `proof.json` and `cleanup.json`, and checks successful synthetic-authority/replay/clean-reopen flags, owned PID, observed normal exit, no forced cleanup, removed stores and preserved evidence. It inspects the retained stack start/stop log, audit file and trace, including the seven ordered MCP requests/responses and the independent read-only body/original-ACK observation between the outgoing ACK trace and its response. It checks IDs, the unchanged replay body, receipt/keyed-reopen flags and absence of residual disposable DBs. This checks retained observation evidence; it does not resurrect the removed DB to rerun the pre-ACK read.

`--self-test` creates a complete **synthetic report/artifact fixture**, never executes its listed argv and starts no server. Its one positive case is an internally consistent automated report with manual scope still unverified. Nineteen controls must reject: missing report, missing log, zero tests, skipped check status, forged manual pass, contract hash drift, unconfirmed cleanup, partial check set, duplicate check, extra check, log hash drift, helper hash drift, verification-input drift, target snapshot drift, failing roundtrip proof, failing roundtrip cleanup, missing trace, forged pass over skipped TAP, and forged overall pass with manual scope. These prove selected gate controls, not HAB behavior. It removes its temporary fixture in `finally`.

Limitations: this is consistency validation of a trusted report/contract and local artifacts, not a signature, trustworthy-runner attestation, independent target snapshot recomputation, semantic source audit or fresh product execution. The runner's file identity is compared across recorded snapshots; this gate is not given the runner executable path to attest its current binary/source. It cannot prove that an attacker who can rewrite the whole report, contract and all evidence actually ran the product, nor establish native/production/manual compliance. No generic runner/framework is copied into HAB.

## Reuse review and changes

The complete earlier examples `communication-boundary.mjs` and `mcp-durable-roundtrip.mjs` were reviewed in the immutable temporary hirastack tool checkout at `0ead9d3899e813916e0180cb4ffbff6c08d45ad6`. Only these HAB-specific observation patterns were reused. No generic CLI/framework is vendored and no runtime path points into hirastack.

Compared with those examples: recursive source enumeration and symlink/triple-slash guards were added; the original broad communication closure is complemented by a stricter classified core/storage closure that rejects reverse dependencies on SDK/transport wrappers; negative/harmless AST controls were expanded; CLI argv is validated; temporary names are HAB-specific. The roundtrip now uses a strictly read-only pre-ACK observer, tests that observer against uncommitted/missing/wrong evidence, records the detailed rejection before the receiver wraps an error, and uses keyed `withEntry` reads after ACK/reopen. It also explicitly requests port `0`, validates the pidfile and URL, bounds doctor/request/stop operations, handles spawn failures/interruption, retains failure proof, and distinguishes forced/uncertain cleanup from a clean pass. The earlier potentially unbounded post-SIGKILL await is removed.

Generation performed source review and file creation only. No helper, self-test, test suite, server, model or credentials were executed/read by the helper author. The coordinator must inspect and run these generated instructions before calling the harness proven.
