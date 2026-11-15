# Durable stop gate (local, undeployed)

This is an additional deny boundary for already verified principals. It does not
create an identity, approve a client, configure Auth0, enable authentication, add
an HTTP/MCP operator tool, or change hosting. Production authenticators still
reject every request by default. No tenant, credential, live notification or model
connection is configured by this change.

## Authoritative state and operation ordering

Migration `0005_durable_authorization` adds global, subject and client stop records,
a global monotonically increasing authorization epoch and bounded-field operator
audit records. The global row initially permits the existing verified-principal
code path; it supplies no authentication or authorization grant. A missing global
row or a database error denies operations. Existing task/grant/run records survive
migration. Existing subscriptions lack client attribution and remain legacy rows.

Both Node and portable HTTP MCP boundaries bind the verified principal to the
current DB epoch. The client ID comes from the verifier's approved static policy,
matched against signed claims, never from a request body or agent label. TaskService
also binds at operation entry, including trusted internal calls; an existing epoch
is validated rather than refreshed. Thus a stop followed by restore cannot make a
previously bound request usable again. Every stop-state edit invalidates all bound
requests conservatively, including unrelated subjects; their next freshly
validated HTTP request can obtain the current epoch.

Every principal-bound task read/write batch starts with a trigger-checked transient
authorization row and removes it before commit. SQLite uses `BEGIN IMMEDIATE`; D1
uses a primary-constrained transactional batch. Gate validation and task/grant/
audit/outbox effects therefore share one transaction. A stop committed first wins;
an operation committed first cannot be retroactively undone. Intermediate check
rows do not persist on successful or rejected transactions. Raw SQL driver access
is trusted maintenance infrastructure and can bypass this boundary; do not expose
it or accept SQL from requesters. An arbitrary driver must preserve this same
atomic-batch guarantee.

## Stop, restore and notifications

`DurableAuthorization.setStopped(target, stopped, expectedEpoch, actor)` is only a
local library maintenance capability. It has no network endpoint or new Principal
operation. No real operator has been enrolled. A future operator interface needs
separate reviewed authentication, scope and approval. Actor is an operator-owned
identifier, not raw token, provider error, or free-form incident text.

The compare-and-swap epoch rejects stale competing control decisions. The state
change, epoch advance, affected subscription invalidation and audit are one atomic
batch. Restore is explicit and cannot enroll a principal, restore subscriptions,
release an execution slot, retry an unknown model run, or clear an existing subject
or client stop. Authorization audit stores target kind/identifier, action flag,
epoch, actor and database time only; retention/export/access control still need an
operational policy. Runtime database identifiers remain private and gitignored.

Subscription creation stores the verified client ID and uses the same gate on
every write. Dispatch checks this gate alongside the existing identity callback,
task notification ACL, expiry, revision and delivery lease before sending. A stop
also increments affected subscription revisions and makes them inactive, fencing
challenge/acknowledgement attempts already underway. Restore requires an explicit
fresh subscription. For legacy principals/subscriptions with no client attribution,
any client stop conservatively denies admission/notification and invalidates those
subscriptions rather than guessing their client.

Notifications already sent cannot be recalled. A stop may happen after the last
DB check and before transport transmission; a database transaction cannot make
external HTTPS atomic. The last check, revision fencing and blocked retries narrow
this window without claiming instantaneous cancellation. Active model work may
also continue until its executor exits; the durable execution slot and receipt are
retained for reviewed reconciliation.

## Verification and remaining work

Mock tests cover global/subject/client stops, stale epoch after stop/restore, a stop
between operation entry and SQL application, atomic rejection with no task/grant/
audit/outbox writes, control CAS, missing-client conservative handling, missing
state/outage denial, SQLite reopen and a separate OS process retaining an old
principal. The same authorization contract runs against local D1. Notification
tests cover pending work, explicit re-subscription, challenge and acknowledgement
races and service recreation. Test callbacks and keys are fixtures only.

This unit does not implement token lifetime policy, rate limits, queue quotas,
authentication-failure audit, a user consent/revocation synchronization service,
sender-constrained tokens, operator UI or incident recovery automation. Short token
lifetimes, immediate Hub denial and issuance volume are separate decisions; do not
assume refresh-token/API-grant revocation invalidates a previously issued JWT.
Auth0/Tunnel interoperability, Dots PKCE/rotation, Grok compatibility and production
D1/egress remain unverified. No deploy, publish, push or merge is part of this unit.
