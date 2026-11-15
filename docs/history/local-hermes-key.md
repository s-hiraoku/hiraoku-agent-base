# Local one-task Hermes API key lifecycle

The opt-in [one-shot factory](inventory-one-shot.md) now implements private
artifact writes, owned child lifecycle and the Inspector/Runs/Adapter connection.
It has no automatic entrypoint; implementation is separate from live authorization.

The Hub now includes an opt-in local provisioner and the reviewed candidate Hermes inventory Runs/inspector bridge. None is connected to a default entrypoint. Auth0 JWTs and model account credentials are separate from this local API bearer. Mock tests inject deterministic entropy and do not generate a real service key, start installed Hermes, open an API socket or call a model.

`LocalHermesKey` defaults to cryptographic 32-byte randomness, encoded as 64 hex characters. Only trusted local child/adapter factory callbacks receive the bearer. SHA256 of that hex string matches the candidate launcher's `credential.scope` check. The persistence callback receives only fingerprint, fixed purpose, expiry and issued/revoked/stop_failed state. No key is put in task/result, DB, logs, argv or files by this component. Production factories must use private runtime injection, never command arguments or inherited broad credentials; they are not implemented by the helper.

A provisioner is single-use, with a deadline at most 120 seconds. Close starts both stops concurrently and bounds their waits to one second; failed/hung stopping records stop_failed rather than claiming revocation. Factory registration and close are synchronized, including reentrant close and expiry/failure. A fresh instance creates a fresh key for a new approved task. Runtime Bearer has no cryptographic scope or TTL: expiry/revocation depends on stopping the isolated API process and disposing adapter references. Launcher/tool/session restrictions must independently enforce the single-task boundary; fingerprint metadata alone does not prove isolation.

JavaScript string copies cannot be reliably zeroized. The temporary random buffer is cleared and local references are dropped, but trusted factories must dispose their own copies. Process stop failure requires operator reconciliation; this is not an OS-enforced kill guarantee. A hung event loop, process crash or callbacks retaining the string are not solved by a JavaScript timer. The candidate Python launcher has its own lifetime limits, but actual process/API/profile/model behavior is not verified.

The integrated candidate accepts only the fixed inventory request, requires measured immutable import/profile/runtime/credential boundaries, checks unauthenticated API rejection and one effective tool, and retains uncertain Runs receipts for reconciliation. It is not a general shell or filesystem adapter. It must not fall back to the desktop agent. The direct collector candidate is not integrated as a substitute for Agent execution.

Before a live run: prepare a complete immutable policy/import closure and independent Inspector evidence, verify the dedicated loopback port without binding, confirm existing model allowance entails no additional charges, wire private key injection and metadata storage, then run only one fixed task and stop/reconcile. Existing processes/settings remain unchanged. A prior socket EPERM must not be bypassed or retried with elevated privileges. Actual service key generation and real startup are separate from mock code verification.

## Offline manifest / Inspector / runtime key binding

`InventoryLaunchPlan` accepts existing independently reviewed nonsecret pins and
a key **fingerprint**, never generates a key or refreshes a code hash. It emits
the exact fixed Python launch manifest and a 65-byte fingerprint marker, derives
their SHA256 values, and combines observed credential-marker/store/evidence-store
metadata into a structurally validated Inspector policy. Artifact bytes and
metadata must be kept private; they include local paths even though no Bearer is
present. Structural validation is not runtime evidence: fresh `inspect()` remains
mandatory after a permitted start.

Only the exact inventory endpoint `127.0.0.1:8645`, dedicated profile suffix,
`serve_inventory.py`, `runs_idempotency.db`, no-site Python closure and locked
model/tool/budgets are accepted. Python's launcher independently validates its
actual profile and full manifest. The launch envelope verifies the runtime key
against the fingerprint and puts it only in child environment, alongside the
manifest digest. It includes no ambient environment, argv key, default process
spawn or model call. Do not print or persist the sensitive `launch()` return value.
Model-account runtime access must be reviewed separately; this envelope does not
copy credentials from Desktop, the caller or another profile.

The existing `LocalHermesKey` callbacks provide the ordering: its asynchronous
`issued` metadata callback prepares private marker/manifest files and observed
metadata before its trusted child and adapter factories are called. Feed the
same plan/key binding to both factories; retain the original scope for receipts.
Tests use synthetic entropy and mock factories, and validate the generated
manifest with Python's real pure validator. No installed profile is modified.
Private writing, store initialization, process startup/readiness/stop and runtime
credential access remain unperformed trusted-factory responsibilities, not an
automatic production launcher hidden in this helper.

### Current concrete live gates

The prepared profile has its config and empty work directory. The manifest,
fingerprint marker, Runs DB, evidence DB and PID are absent. Existing six-root
measurement records must be reused as reviewed pins, not replaced with a fresh
self-approved scan. Runtime marker/store identities are obtained only after their
approved private creation; final Inspector evidence requires the actual process.

The prior operation was an ordinary `connect(127.0.0.1, port)` check, rejected with
`PermissionError / errno 1 (EPERM)` by the managed execution environment. It did
not establish listener presence or absence. Connected/attached Mac status does
not grant loopback operations. The required later operations are a dedicated
API `bind/listen` on 8645 and adapter capabilities/status/one-run traffic to that
loopback API. Do not repeat the blocked check with elevation, disable protections,
use another transport to evade the deny, or alter the existing Desktop API.

The owner can confirm the ordinary execution context with a single socket-only
probe in their normal Terminal, without changing any setting or running a model:

```sh
python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); s.close(); print("ordinary_loopback_bind_ok")'
```

This checks a short-lived ephemeral bind, not service availability or agent
isolation. If the permitted context is still rejected, stop and have its execution
policy resolved through the normal administrator/platform path. The agent must
also receive normal permission for the exact 8645 operations before executing
any real trial. Port allocation for the Hub must first account for ShiftLog's
8787 default; no port has been changed.

For model-test **additional cost $0**, OAuth success, model-list presence and
profile pins are insufficient. Missing nonsecret evidence is: the active account/
workspace uses included ChatGPT/Codex entitlement for this exact Hermes provider
route and `gpt-6.1-sol`; an included budget remains for the one supervised run;
and usage cannot spill into purchased credits, pay-as-you-go/API billing or a
paid fallback. Confirm the current plan/usage dashboard and applicable provider
route terms, without sharing account identifiers or tokens. No subscription
purchase, API-key fallback or extra-credit use is authorized. General official
[pricing](https://learn.chatgpt.com/docs/pricing) and
[authentication](https://learn.chatgpt.com/docs/auth) distinguish included usage
from API-key billing, but do not prove this account or third-party route's status.
Do not perform a model call to find out which billing path applies.

### Fixed provider route

The dedicated inventory bridge uses the pinned Hermes Codex resolver with
`read_only=True`, which performs no token refresh, Codex CLI adoption or auth-store
write. It requires `source=hermes-auth-store`, `auth_mode=chatgpt` and the exact
`https://chatgpt.com/backend-api/codex` endpoint, and constructs only the
`codex_responses` transport. Pool credentials, explicit/environment keys, endpoint
overrides, app-server transports and extra runtime fields are rejected before
agent construction. Effective endpoint, transport and absence of a credential pool
are checked again with the existing runtime guards. Automatic Codex credential
refresh is disabled for this one-run bridge; expiry requires operator reconciliation.

This follows the pinned Hermes
[OAuth result](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/auth_codex.py)
and [transport mapping](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/runtime_provider.py).
It does not establish subscription entitlement, account identity, remaining
allowance or prevention of server-side credit billing. Those live gates still
apply. No resolver is called by offline tests; synthetic fixtures cover the route.
Existing measured bridge pins predate this change and cannot be reused for live
launch without independent review of the changed bridge tree.
