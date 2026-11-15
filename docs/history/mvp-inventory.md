# Narrow inventory MVP (local mock complete; production not connected)

The target is one authenticated Dots request, one fixed Hermes-side read, then
Dots retrieving the result from the Hub. Grok and other integrations are later
work. This unit implements the portable task contract and mock roundtrip only.
It does not enable a real Hermes tool, run a model, inventory the user's machine,
register an OAuth application, create a tunnel, or deploy a server.

## Fixed request and cautious evidence

Submit accepts only `task_type: "shift_log_inventory"` and a bounded request key.
There is no command, free text, product name, path, callback or agent argument.
The trusted static subject policy must explicitly include this task type for both
requester and worker. Existing subjects default to connectivity checks only.
Workers claim only their approved task types. An adapter with an unsupported Runs
contract refuses before claiming; existing HermesRuns remains connectivity-only.

The Node-only collector inspects metadata of these exact candidates:

- `/Applications/Shift Log.app`
- `/Applications/ShiftLog.app`
- `/Applications/shift-log.app`
- `/opt/homebrew/bin/shift-log`
- `/usr/local/bin/shift-log`

It uses `lstat` on fixed ancestors and leaves only: no listing, recursion, package
manifest, personal directory, file contents, binary execution, shell, PATH search
or network operation. Errors never enter results. Result fields are fixed product,
`unknown` status, a fixed explanation and five location IDs with enumerated
observations. Candidate names cannot establish exact product identity. Even all
missing candidates produce unknown rather than a whole-machine absence claim.
Exact vendor/product identity and an approved additional detection rule would be
needed to report installed; no such rule is silently inferred here.

Leaf symlinks are reported as candidates and not explicitly dereferenced. Static
ancestor checks reject observed symlinks but have a TOCTOU limitation: a parent
could be replaced between checks. This is not a proven race-resistant filesystem
sandbox. No real runner is connected. Before production admission, review exact
product identity and either prove a fixed metadata capability in a locked-down
executor or retain unknown/unavailable without expanding to shell or broad reads.
The collector is not a general MCP filesystem tool and is not automatically
registered in Hermes. A `readonly` instruction alone is insufficient.

Results are schema-validated and canonicalized against the task type. Claim,
lease, runner subject/scope, fence, durable stops, idempotency and execution slots
remain enforced. Reusing a request key for another task type is rejected. The
migration preserves historical tasks, audits, outbox, ACLs, subscriptions and stop
state, reconstructs indexes and audit/outbox triggers, and rolls back on error.
Tests exercise this upgrade on SQLite and local D1.

## Minimum real connection values (not provisioned)

Use a dedicated Hub API audience matching the verified canonical MCP resource
URL. The URL/issuer must be confirmed, not synthesized from a dashboard URL.
Human Dots connections use authorization code with PKCE S256. A predefined public
OAuth client with token authentication `none` is the initial candidate; verify it
against the actual client registration UI and Auth0 discovery. Do not depend on
trial-only CIMD, private-key authentication, custom domains or paid MFA features.

Copy the exact redirect URI shown on the ChatGPT MCP management page into the
Auth0 allowlist. Do not invent a callback, use wildcards, or reuse a displayed
Default App simply because it already exists. The same UI must confirm which
registration method is available. Verify issuer identification and resource/audience
handling before attempting user authorization. See the [official authentication
contract](https://developers.openai.com/plugins/build/auth).

Initial human scopes and `OAuthResource.userScopes`: `hub:submit hub:get`.
ChatGPT may also request OIDC scopes advertised by the authorization server;
review the actual consent screen before connecting. Hub policy does not copy
email/profile claims into task input or grant authority from them.
A separate worker M2M client requires only `hub:claim hub:get hub:heartbeat
hub:complete`; grant no Management API, operator, notification or submission scope.
Its client credentials remain in an approved local secret store and are not shared
with Dots. Request an access token on demand and reuse it within its validity; no
five-minute always-on issuance or daemon is part of this MVP. Token lifetime and
Free-plan issuance quota must be considered separately.

The server enrollment is an explicitly verified subject/client pair with the fixed
inventory task allowlist. A user connection alone does not prove Stallone-exclusive
identity. A trusted runner scope must identify the reviewed inventory executor,
not the existing broad Desktop profile.

## Result delivery and approval sequence

For this first supervised MVP, choose explicit `get(task_id)` in Dots after a
bounded worker run. No webhook, signing secret, subscriber, notification loop or
new autonomous job is required. Automatic later delivery is a separate decision
and requires an actual Dots event receiver and verified callback/egress boundary.

Before real connection, obtain and review:

1. Non-secret exact Auth0 issuer/discovery and the confirmed Free-plan feature set.
2. The chosen authenticated Hub endpoint/resource/audience and hosting/tunnel
   behavior; any new network exposure requires specific approval.
3. Actual Dots redirect URI, registration method, client ID and verified subject.
4. Approval for API/client registration with the above scope lists, distinct worker
   credentials and an agreed local secret storage/revocation procedure.
5. A proven inventory-only Hermes execution capability with unrelated tools,
   memory and existing-session history disabled. Current HermesRuns cannot do it.
6. Approval for one supervised inventory invocation and result retrieval, stating
   candidate metadata sent to the Hub/Dots and any model-provider exposure.

No value in this list is supplied by guesswork or by fixtures. Auth0 administrator
MFA enrollment remains a separate personal security step. Trial availability does
not establish a Free-plan dependency. Real OAuth, tunnel behavior and final Dots
operation are unverified until this sequence completes.

Reproduce the safe mock locally with `npm test`. The signed-JWT MCP test exercises
Dots submit, isolated mock worker collection, completion and Dots get; all file
metadata and credentials in that test are synthetic, and no external request is made.
