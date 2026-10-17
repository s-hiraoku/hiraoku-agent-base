# HAB registration and policy boundary

This optional integration owns HAB names, product enrollment and individual
authorization. The reusable Relay core never imports `src/hab`, parses `.hab`
addresses or queries registry tables. The four-method `RelayOperations` port lets
the existing HTTP/MCP adapters accept the composed `HabRelayService`. No existing
runtime, route, credential, Hermes setting or process is changed by this module.

## Names and enrollment

Address normalization version **1** accepts only canonical lowercase ASCII
letters, digits and internal hyphens, 1–48 characters per component. Both ends
must be a letter/digit. Uppercase, Unicode, whitespace, dots and underscores are
rejected rather than silently normalized. An address is exactly
`<bot_name>@<agent_name>.hab` (maximum 101 characters). It is a local logical name;
no DNS, SMTP, URL fetch, alias or forwarding operation is involved.

Only a separately authorized administrator can register a product slug. There
are no automatically enrolled products or individuals. The human chooses a
product ID from that approved catalog and a `bot_name`; the API derives
`agent_name` from the product. `preview` returns availability and a proposed
address without reserving anything. `enroll` represents the host's explicit
human confirmation: it atomically allocates an opaque UUID and reserves the
address, with state `waiting_connection` and no operation grants.

Names, product association, normalization version and individual ID are immutable.
SQL guards also reject accidental rename/delete operations. Retirement is terminal;
IDs and addresses remain reserved permanently, including after retirement. A
changed address means a new individual and a new explicit message intent, after
reconciling any prior uncertain delivery. No alias or automatic numbered suffix
is generated on collision. A preview is a proposal, not a reservation guarantee.

All normal mutations require a stable `request_id`. The request fingerprint,
result receipt, state, policy epoch and redacted audit commit together. Exact
retries recover the original response after restart; changed content conflicts.
The ledger is scoped by the host-verified management actor and rechecks its current
authority before every retry. A replayed response is the original snapshot,
**not current state**; use `inspect` for current epoch/state. Agent mutations use
`expected_epoch`, so stale management commands cannot overwrite later decisions.

## Individual binding and explicit activation

`RegistryAuthority` has separate synchronous ports for management authority and
an already verified individual context. Both default to deny. Returning an actor
or principal from these ports is an assertion by the trusted host, never a parsing
recipe for tool arguments, names, headers or unverified JWT claims. Neither port
performs OAuth verification or proves a product's real capabilities by itself.

An individual descriptor requires **issuer, audience, subject, client_id and
connection_id**. All are exact, nonempty bounded strings. The host must actually
verify issuer/audience/subject/client and attest that the connection identity is
exclusive to this individual. Shared owner subjects or client labels alone are
insufficient; G0 remains mandatory for every real product/individual. Bridges
must enroll as bridges unless they can prove the originating bot's identity.

The registry stores only a keyed HMAC of the complete versioned descriptor,
not its claims, raw credentials or tokens. A descriptor is permanently reserved
to its original individual. Revocation is irreversible; it cannot be reused for
another individual or silently reactivated. Explicit credential rotation requires
a newly verified descriptor and a new authorized binding request for the same
individual. The private HMAC key is supplied by the host; none is issued here.

Binding a waiting individual grants no communication rights. The administrator
must explicitly activate it with operation grants from
`submit/status/poll/ack/resolve`. Active state requires at least one live binding.
Revoking the last binding stops the individual and clears its operation grants.
Ordinary stop/resume retains its ID/address; resume requires a live binding and
explicit fresh grants. Retirement revokes all live bindings and cannot be undone.

## Current authorization and transaction order

`HabRelayService` composes the existing `RelayService` with the registry. Each
operation obtains the registry's `BEGIN IMMEDIATE` write guard **before** the
Relay transaction, and holds it until the synchronous Relay call/commit finishes.
Every admin mutation uses that same registry write lock. A stop/block/revoke
therefore serializes before or after the delivery operation; another process
cannot commit revocation between its authorization check and Relay commit.
No registry/Relay SQL JOIN or shared schema is needed.

All hosts must use this composition and the lock order **registry → Relay**.
Do not take a Relay write lock and then try to acquire the registry lock. Only
synchronous callbacks are supported; promises/reentrancy are refused. The scoped
`Authorization` expires on callback exit, checks the current registry epoch and
verified context expiry, and cannot be retained as a reusable permission object.
Uncoordinated SQL writers, stale external caches, other code paths or different
registry files are outside this guarantee. Single-writer serialization also limits
throughput; fairness and per-individual scheduling remain later work.

The host's verified context must have a canonical UTC expiry no more than the
explicit `max_context_ms` (at most five minutes) ahead of the registry clock.
The HTTP verifier must revalidate credentials and supply such a bounded context
per request; the registry does not renew claims or infer validity from a name.
Missing/throwing resolver, expired context, unknown/revoked binding, stopped or
retired individual, missing operation and unknown configured kind fail closed.

Active individuals communicate without pair allowlists. The host supplies the
explicit finite kind allowlist; it has no production defaults. Directional blocks
apply sender → recipient on submit, candidate delivery and ACK (including exact
committed ACK retry). Stopped/retired peers also deny those operations. This first
policy uses immediate refusal, with no drain-only ACK exception. Bodies already
accepted remain tracked until normal ACK/expiry; registry changes never delete
Relay data. A sender with current status rights can inspect its own receipt even
when the peer is stopped; it cannot inspect another sender's receipt.

`resolve(context,address)` is currently a **local host API**, requiring both
resolve and submit grants. It returns only the immutable recipient ID, exact
address and normalization version. Unknown, inactive and blocked targets share
`forbidden`. Malformed syntax has a fixed validation error. Save the resolved ID
in the durable outbox before sending; retries use that stored ID and never
re-resolve or redirect it. Acceptance still checks current state, so a cached
resolution cannot bypass a later stop. The four-tool MCP catalog is unchanged:
`relay_resolve` and a user-facing enrollment CLI/UI are separate next work.

## Storage, capacity and stopping

`SQLiteHabRegistry` explicitly opens a dedicated private database; `migrate()`
must be called explicitly. Unknown databases/schema versions, changed keys,
symlinks and loose file modes are refused. New files are 0600. The host must own
a private parent directory and protect sidecars/backups. No existing Task/Relay
database is migrated. Tests use only new temporary directories and synthetic keys.

Finite explicit caps bound product/individual/binding reservations, management
requests, blocks and audit rows. There is no automatic reservation or management
ledger collection: deletion could reopen an identity/idempotency window. Revoked
bindings still consume reservation capacity; explicit unblock can free a block
slot. On quota/audit failure, new management mutations roll back without partial
rights or reservations. Exact successful requests can still recover receipts.
Capacity expansion/archive/backup policy requires explicit operational setup.

The separately authorized `emergencyStop(context)` is an idempotent, monotonic
global deny latch in one fixed row. It works even when append-only request/audit
quotas are full or audit insertion fails. Its first actor hash/time/epoch remain
the durable stop record. Repeated stop returns that same record; ordinary access
changes cannot reopen communication. There is intentionally no emergency-resume
API yet. Missing authoritative stop state denies rather than creating an unlocked
replacement. If the DB cannot persist a stop, stop the serving process/route and
reconcile it through the later operational recovery procedure. Do not restore an
old backup online and thereby resurrect revoked grants or a cleared stop latch.

Normal audit contains only fixed operation codes, a management actor HMAC, opaque
object ID, time and epoch. No address, principal claims, message body, credential,
raw exception or actual conversation is recorded there. Registration receipts
contain the necessary local non-secret names/IDs. Unexpected DB errors normalize
to a fixed registry error; the HTTP MCP boundary retains its existing redaction.

## Verification and remaining work

```sh
node --test test/hab-*.test.js
```

The 31 tests cover naming, immutable/permanent reservations, concurrent enrollment
from independent workers, idempotent restart, explicit activation, separate admin
authority, principal tuple separation, binding rotation/revocation, CAS epochs,
operation/kind/block policy, escaped grants, rollback, private/schema/key guards,
capacity and durable emergency stop. Three native loopback HTTP cases connect
registered mock Grok/dot/Hermes labels to private durable journals, send/reply/ACK,
check foreign receipt refusal and deny cached resolution after stop. A second
registry connection is unable to revoke in the Relay authorization/commit gap.

This is local mock evidence, **not real product identity verification or completed
G1/full initial release**. MCP address-resolution exposure, human enrollment
workflow, per-individual fairness/quotas, managed attachments, automatic-reply
budgets, operational activation and complete failure/restore coverage remain.
No real product is enrolled or contacted. New credential issuance, public routes,
paid contracts, background activation and real connections require their separate
approved endpoint/scope/data/stop plan; this module grants none of those actions.
