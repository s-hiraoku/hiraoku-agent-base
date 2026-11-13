# Fixed readback, then one Hermes inventory task

This procedure separates a successful authenticated result read from an actual
Hermes execution. It does not deploy anything, issue OAuth credentials, expand
an API grant, register a caller automatically or start a daemon. Use only after
approval of the exact live step. Never put real settings or receipts in this repo.

## Positive get fixture

Prepare an owner-only directory and a mode-0600 `*.local.json` with exactly this
shape (all identity values below are dummy):

```json
{
  "version": 1,
  "mode": "auth0",
  "enabled": true,
  "oauth": {
    "issuer": "https://example-tenant.jp.auth0.com/",
    "resource": "https://hub.example/hab/mcp",
    "scopes": ["hub:get"]
  },
  "subjects": [
    {
      "subject": "operator-confirmed-user",
      "clientId": "operator-confirmed-requester-client",
      "kind": "user",
      "operations": ["get"]
    }
  ]
}
```

The manual `src/readback-fixture-cli.ts` reads `HAB_READBACK_CONFIG` and
`HAB_READBACK_DIRECTORY`. It creates only an exclusive new `readback-hub.sqlite`,
refuses an existing DB/sidecar, and seeds exactly one terminal fixture:

- UUID: `11111111-1111-4111-8111-111111111111`
- state: `succeeded`
- result: `Agent Hub connectivity check completed.`
- actor: `synthetic-readback-fixture-v1`
- no Run ID, execution gate, worker, model invocation or terminal notification.

Run the ordinary `createRuntime` with this reviewed get-only config and the new
DB in the supervised, manually started local harness. Port 8787 may already be in
use: never stop its owner. A reviewed wrapper can bind a separately confirmed
free 8789 and forward requests to the unchanged runtime with the exact configured
public Host. Keep existing routes; expose only `/hab/mcp` and its dedicated
protected-resource metadata path for the separately approved finite window.
Remove both added routes and stop only the owned process at the deadline.

The positive test is `get` of the UUID above, checking the exact result and
synthetic actor. This proves a successful read of synthetic data through the
configured authenticated Hub; it does NOT prove that Hermes executed a task.
The prior nonexistent-task `Operation rejected` result is consistent with
successful authentication and lookup denial when it is the actual Hub tool
response. A platform `INVALID_ARGUMENT` wrapper alone is not an independent
identity audit. No token/request logs are required or collected for this fixture.

## Verify an already acquired worker token

Use the existing, explicitly approved M2M client through Auth0's normal client
credentials procedure only after approval. The helper below does not acquire a
token, locate a client secret, refresh OAuth or alter Auth0 grants. The owner must
use a trusted issuance path and keep its token/secret out of agent views, shell
history, argv, environment, repo and saved logs. If no safe issuance path is ready,
stop before acquisition and settle that path with the owner.

Create a private config from `config/worker-identity.example.json`, selecting the
exact reviewed issuer, resource audience and worker client ID. Scopes are fixed
in code to `hub:get hub:claim hub:heartbeat hub:complete`; the original token
lifetime must be at most 600 seconds. Pin a reviewed, canonical executable Node
path; the input helper rejects a symlink, writable-by-group/other executable or
an executable owned by another user. Verify its installation/version/hash before
live use. No executable is selected from PATH by this helper.

```sh
python3 -m hermes_bridge.owner_input --verify-worker /private/identity.local.json /absolute/reviewed/node
```

The owner supplies the ALREADY acquired short worker token at a hidden terminal
prompt. Non-TTY input and terminal echo fallback are refused. Node receives a
bounded JSON object on stdin; the token is absent from argv, environment, files,
stdout and generic failure messages. Config validation occurs before the prompt.
Python strings/temporary process memory are not guaranteed to be erased.

`inspectWorkerIdentity` pins the configured Auth0 JWKS URL, rejects redirects,
bounds fetch time/body/key count, checks RS256 and signature, issuer, audience,
client binding, expiry/not-before/issued-at, `gty: client-credentials`, exact four
scopes and original TTL. It refuses token-provided key URLs and unsupported actor,
proof-binding or authorization-detail claims. Only after all checks does it return
subject/client/time/scopes and `enrolled: false`. It creates no Principal,
listener, registry, database, worker or model connection. A rejected candidate
prints no identity or token. Do not guess `sub` from the client ID: Auth0 can use
other service/agent subject formats. See [Auth0 token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles) for `sub`, `gty` and client-binding semantics.

The owning operator must explicitly approve the verified candidate, then put its
exact subject/client in the private inventory settings. This is a separate manual
enrollment; it is never derived from an arriving Hub caller. The ordinary server
Auth0 verifier and static subject gate are unchanged.

## One Hermes inventory task

After positive get, the separate live gate covers all of the following:

1. Existing Requester `hub:submit hub:get`, separate worker four-scope token
   issuance/input, exact verified worker subject/client and explicit enrollment.
   No `openid`, `offline_access`, worker submit, cancellation, events or broader
   grant is required for this fixed execution.
2. Recheck the reviewed immutable source/config/import closure and actual Mac
   Inspector observations. The existing write-refusal check accepts EACCES;
   EPERM is inconclusive and stays fail-closed. Synthetic OS observations in tests
   are not real Mac launch attestation. Resolve this before claiming readiness.
3. Supervised `inventory-one-shot` entry on free 8789 with new/reconciled artifacts,
   a temporary local Hermes API key, owned dedicated child on fixed 8645,
   `openai-codex/gpt-6.1-sol` through the existing approved same-account OAuth,
   only `hub_shift_log_inventory`, one task, concurrency one, three iterations,
   256 output tokens and a 60-second run budget. No memory/history/paid fallback.
   The entry/key admission deadline is at most 120 seconds plus bounded cleanup;
   agree a concrete quota/cost stop policy. The fixed route does not prove $0
   entitlement, remaining allowance or service availability.
4. Approve the two public paths for that finite execution window and remove them
   on completion/expiry. Preserve existing `/mcp` and other listeners.

Only after those approvals and finalized private settings:

```sh
python3 -m hermes_bridge.owner_input --run-inventory /private/inventory.local.json /absolute/reviewed/node
```

The owner manually enters the already verified, still-valid worker token; no
refresh or token file lookup occurs. Submit exactly `shift_log_inventory` with
request key `hab-inventory-one-shot-v1`. Follow the SAME task via `get` until
terminal, require the canonical inventory result/evidence, settled complete ACK,
owned-child stop and key revocation, then read back listeners/routes. Unknown
admission/receipt/ACK/stop status requires reconciliation, never a second submit
or a new Run to recover an uncertain first one.

## Evidence limits and validation

Tests use generated synthetic RSA JWTs, dummy identities, an exclusive synthetic
DB and an owned harmless child. Positive raw HTTP get exercises the configured
Host/path, real runtime verifier, client/subject/scope failures, and all mutation
rejections while DB remains one synthetic row. Worker tests verify a candidate
cannot authenticate before explicit separate enrollment, and the existing real
HTTP factory/child/Runs/result/stop test now begins with worker identity inspection
and a manual enrollment decision. Only OS process observation in that child test
is synthetic. No live Auth0 token, user communication, real Hermes model execution,
credential discovery, publication or privilege changes occur in these tests.
