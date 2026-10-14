# Manual ping-only runner

This opt-in runner tests Grok → HUB → Dots → HUB → Grok using fixed `ping`/`pong`.
It does not implement Grok job execution, automatic wake delivery, Hermes/model
execution or recurring polling. Source/test success is not live bot acceptance.

`startPingRunner` validates an explicit enabled `manual-ping-only` config before
DB, audit worker or listener creation. Two user subject/client pairs are pinned;
client IDs must differ (the same human subject may be shared). OAuth scopes and
static operations are exactly `hub:ping_submit`, `hub:ping_get`, `hub:ping_reply`,
`hub:ping_pending`. The MCP catalog contains only those four tools. Caller agent
names or unverified claims do not choose authority. Sharing a human account does
not establish an exclusive Bot identity. Examples contain rejected placeholders.

The operator supplies a fresh, empty, canonical owner-only `0700` directory. A
new exclusive `0600` `ping-hub.sqlite` and `0700` audit directory are created; old
data/sidecars are not reused. The existing acknowledged private AsyncAudit writer
starts before the listener, with its queue/retention/privacy protections. Invalid
config fails before writes; later startup failures close owned resources but
preserve allocated artifacts for reconciliation. No secret lookup or token
acquisition occurs at startup; Auth0 JWKS is fetched only when authenticating
requests through the existing verifier.

The only listener is `127.0.0.1:8789`. Request/header sizes, connection counts,
deadlines, duplicate Host/Authorization/Origin rejection and exact Host/Origin
checks use the existing primitives. Node requests must use the configured public
resource Host; no Host is rewritten or inferred from forwarded headers. In
particular, an ordinary loopback Host `127.0.0.1:8789` is denied by the inherited
runtime boundary. Local diagnostics must explicitly use the approved resource
Host. Resource path is fixed to `/hab/mcp` to avoid the existing model `/mcp`.

The listener closes after the configured lifetime (1 second to **15 minutes**),
or SIGINT/SIGTERM. Admission closes, connections are destroyed, active handlers
have a bounded drain, and DB/audit close. Shutdown confirmation failures are
reported as `ping_runner_stop_uncertain`, not successful cleanup. Repeated signals
after startup reuse the same cleanup promise. A process crash/OS kill can still
prevent graceful audit drain; retained DB/audit state requires reconciliation.
This is not an OS sandbox against hostile same-user changes to private paths.

## Operator invocation after separate approvals

Prepare a private `*.local.json` from `config/ping-runner.example.json` using
verified Dots/Grok user subjects and distinct user-delegated OAuth client IDs.
Keep it outside the source tree, owner-only `0600`. Confirm four-scope grants,
callbacks, included usage and the exact endpoint before connection.

```sh
HAB_PING_CONFIG=/approved/private/ping.local.json \
HAB_PING_DIRECTORY=/approved/fresh/private/directory \
node src/ping-runner-cli.ts
```

The placeholders are intentional: live client IDs/configuration/publication are
not yet confirmed or authorized by this patch. The CLI does not publish, remove
or change Tailscale routes, issue credentials, send bot instructions, or install a
service. Existing 8787, `/mcp` and Dashboard 9443 remain outside this runner.
Publishing `/hab/mcp` and its protected-resource metadata path for the finite
test window, and removing only those added routes afterward, are separate owner
operations. Listener expiry does not remove a public proxy route.

For one live trial: Grok `ping_submit` with a unique `request_key`, fixed `ping`,
and `ttl_ms:300000`; Dots `ping_pending`, then `ping_reply` with matching
`in_reply_to` and `correlation_id` and fixed `pong`; Grok `ping_get` must return
`replied` with the original correlation ID. An HTTP 200 or synthetic terminal
readback alone is not that acceptance. Do not automatically retry uncertain
operations or create another routine/job.

Tests use a dummy listener (no actual bind), private temporary SQLite and mocked
audit/JWKS. They verify authenticated in-process ping/pong, four-tool catalog,
ordinary-operation denial, exact client binding, Host/Origin and duplicate Host
rejection, deadline closure, startup cleanup and uncertain stop. No actual Grok,
Dots, Hermes, credentials, public route or model call is involved.
