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

`resolve(context,address)` is a local host API, also exposed by the optional HAB
MCP adapter below. It requires both
resolve and submit grants. It returns only the immutable recipient ID, exact
address and normalization version. Unknown, inactive and blocked targets share
`forbidden`. Malformed syntax has a fixed validation error. Save the resolved ID
in the durable outbox before sending; retries use that stored ID and never
re-resolve or redirect it. Acceptance still checks current state, so a cached
resolution cannot bypass a later stop. The standalone Relay catalog remains
four tools. The separate human management workflow below adds no MCP tool.

## Human enrollment workflow

`./enrollment.ts` implements the finite, host-composed `runHabEnrollment` workflow:

1. Select a product from the approved management catalog, then enter only `bot_name`.
2. Preview `<bot_name>@<agent_name>.hab` and explicitly confirm its permanent reservation.
3. Select a host-verified exclusive connection and separately confirm its binding.
4. Choose operation grants and explicitly confirm activation.

`./enrollment-terminal.ts` renders these steps through supplied terminal IO. Each
confirmation requires typing the exact proposed address; a generic `yes` does
not confirm. EOF/refusal pauses. Before reservation, nothing is created. After
reservation, pausing leaves the same permanent individual waiting for connection,
or bound without communication rights; it never frees names or revokes an
already confirmed binding as an implicit cleanup action. To stop/retire an
individual, use the existing explicitly authorized management operations.

The flow uses required `EnrollmentHost` ports: registry, durable checkpoint
journal, UI, current management context and verified individual connection
selection. There is no `--admin` flag, claims/token paste, credential issuer,
self-registration, endpoint discovery or production configuration loader. The
host must authenticate a separate management actor and attest individual
connections, including their human-readable selection labels. Terminal IO
does not establish either authority. The host also owns input buffering/size,
idle/overall lifetime limits and a private store directory. The flow's schema
limits are applied after that host input boundary. It has no background loop
or automatic retry; a saved flow advances at most six stages per invocation.

New management reads remain local host APIs: `catalog(context,{limit,after?})`
has a 1–100 product page cap, keyset cursor and separate `catalog` permission;
`inspectBinding` requires `inspect`. The flow selects from 50-item pages, with
explicit next-page input and a finite catalog traversal limit. It requires
current catalog authority before exposing a saved checkpoint to the UI, even
on resume. A production policy must grant those reads separately. Product
creation remains an administrator operation outside this flow; nothing
automatically populates the production catalog.

`inspectConnection` requires management `bind` authority and a freshly verified
individual context. It returns only a keyed comparison digest of the existing
versioned principal tuple. The checkpoint stores that digest, not raw claims,
labels or credentials. `bindVerified` takes the expected digest plus another
current host context, checks management and fresh identity under the registry
lock, then compares the tuple before the idempotent mutation. A changed
connection is refused even when no earlier binding committed. The digest is
not a credential and never authorizes its holder. Missing, stale, throwing or
asynchronous authority ports deny; rejected promises are consumed. The existing
low-level `bind` port remains trusted-host-only and is not a terminal/MCP API.

`./sqlite-enrollment-journal.ts` is a dedicated private, explicit-migration
SQLite store (schema 1), independent of the existing schema-1 registry and Relay
DBs. New files are 0600; symlinks, loose permissions, foreign/schema-version
databases and malformed/foreign-field checkpoints are refused. The host must
protect its parent, sidecars and backups. Explicit session capacity bounds
growth; old sessions are not automatically deleted. Revision CAS rejects
concurrent/stale writers. Neither importing the modules nor constructing the
UI opens a listener or modifies any existing runtime.

Use a stable, host-selected `flow_id` (canonical opaque ID, at most 96 characters)
and the **same private journal, registry/key and management actor** when resuming.
Every pending operation, confirmed selection and original expected epoch are
saved durably **before** the registry call. Request IDs are deterministically
`enroll:<flow_id>`, `bind:<flow_id>` and `activate:<flow_id>`. A lost registry or
journal response is uncertain: reopen the stores and run that same flow; do not
choose a new flow ID, connection or suffix. If binding was pending, the host
must reverify the original exclusive connection matching the saved digest.
Receipt replay cannot replace current authority. The flow checks live agent and
binding state/epochs after replay, so a later stop, revocation, retirement or
policy change requires review and is never silently resumed/re-enabled. A
completed checkpoint is re-inspected rather than replaying activation. Review
errors require explicit management reconciliation; no automatic repair is run.

The standalone demonstration uses only synthetic temporary stores/identities:

```sh
npm run demo:hab-enrollment -- --simulate
npm run demo:hab-enrollment -- --interactive
```

Simulation reserves and binds, pauses before activation, closes/reopens both DBs
and explicitly simulates activation confirmation. Interactive mode requires a
TTY and times out each question after 60 seconds. Both remove their temporary
data on normal exit and accept no production paths, credential references or
endpoint arguments. They do not establish real product capabilities. For a
production host, connect the required verification, UI input and private-store
ports explicitly after the endpoint/subject/scope/data/stop plan is approved;
there is no real enrollment launcher in this change. Workflow completion means
registry activation, not live reachability, G0, delivery success or removal of
the global emergency-stop latch.

## Optional managed upload authorization

`./attachment-uploads.ts` composes `HabAttachmentUploads` with the separate
[upload backend](../../docs/managed-attachments.md). Its begin/status/chunk/finalize/cancel
operations require the current verified individual binding, active local state
and submit grant. They derive the owner from that binding and check the saved
recipient, kind allowlist and directional block. Knowing an attachment ID gives
no foreign owner access. Exact retries also recheck policy; missing or expired
identity, revocation, stop and the emergency latch deny.

Each call holds the registry write guard before the upload transaction and
through its COMMIT, using the same lock order as Relay: **registry → upload DB**.
The SQLite upload store rechecks each current authorization decision immediately
before COMMIT. Policy revocation therefore serializes with the operation, and
an expired scoped decision cannot become a reusable upload grant. Callbacks
must be synchronous and side-effect-free; multiple checks are intentional.
Never acquire the upload write lock and then try to enter the registry guard.

All five upload operations use submit authority, including owner status/cancel;
receipt-only rights do not grant this port. A stopped or blocked peer denies
those operations too; no drain exception is implied. Partial bytes remain subject
to the separately authorized upload maintenance/expiry path. This class exposes
no maintenance or download operation, grants no new registry rights, adds no
MCP tool or HTTP route and starts no service. It does not enable message attachment
acceptance, receiver download/ACK or production credential binding.

The 14 additional tests cover ownership, false identity arguments, foreign IDs,
current submit/kind policy, owner/peer stop, block, revoked or expired binding,
emergency stop, a second registry connection attempting revocation before
upload commit, escaped authorization and rollback on a decision changed before
COMMIT. Only synthetic temporary databases and contexts are used.

## Optional managed attachment acceptance

`./attachment-acceptance.ts` composes `HabAttachmentAcceptance` with the independent
[durable reservation and acceptance coordinator](../../docs/managed-attachments.md).
It exposes only submit and sender-owned status as host APIs. The host must also
explicitly configure the Relay store's prepared-reference admission; constructing
this class does not enable attachment delivery or mount any MCP/HTTP route.

One registry write guard surrounds **registry → upload prepare → Relay acceptance
→ upload confirm**. Each storage transaction commits separately; the registry
guard stays held throughout. A competing stop/block/revoke serializes before or
after the operation, including the gap between its separate DB commits. Never
hold an upload or Relay write transaction and then enter the registry guard.
These DBs have no shared SQL schema and no distributed rollback guarantee.

Submit uses the current individual binding, submit grant, active recipient, kind
and directional block. Exact retry may reconcile its own original receipt under
submit authority without a status grant; the public status method requires its
separate status grant and retains ordinary sender-only receipt visibility.
Prepared reference identity comes from the verified host context, never a supplied
agent name. Scoped callbacks cannot be reused after the registry action exits.

If Relay fails after prepare, or context expires after Relay commit but before
confirmation, earlier commits and pins remain durable. Fresh authorization can
reconcile the same original ID/intent/expiry; registry rollback must not be treated
as rollback of other DBs. Current policy still applies to every attempt. Attached
messages remain withheld from poll/ACK unless the host separately supplies the
explicit Relay delivery policy and verified receiver-byte admission described in
[attachment delivery and deletion](../../docs/attachment-deletion.md).
This class adds no maintenance, read, confirm or credential authority.

Fourteen additional synthetic SQLite tests cover authority separation, foreign
receipt/ref refusal, stop/block/kind/revocation, missing or expired identity,
emergency stop, all three inter-DB revocation gaps, escaped decisions, actual
short-context expiry after Relay commit and same-intent recovery. These are host
composition checks, not real product binding or production transfer evidence.

## Optional managed receiver reads

`./attachment-read.ts` provides `HabAttachmentRead` as a read-only host facade over
the independent chunk service. It requires current **poll** authority for the
verified receiver, checks the stored sender/kind and original directional block,
and holds **registry → Relay → upload DB** guards through the bounded chunk read.
Status rights, sender identity or knowing the attachment ID grant no download.
Stop/revocation and reads serialize under the same registry lock.

Every chunk rechecks the live message deadline/state, original fingerprint,
confirmed per-message references, manifest and chunk integrity. Both the scoped
registry authorization and live Relay proof expire when their callbacks exit.
If context expires after bytes are looked up, the call refuses to return them;
fresh verified context can retry the same saved offset without extending expiry.
Previously returned bytes belong to the receiver and cannot be retracted by stop.

Thirteen additional SQLite tests cover verified-recipient reads, authority and
individual separation, sender/receiver stop, directional block, binding
revocation, missing/expired identity, emergency stop, another connection attempting
revocation at all read stages, escaped decisions/proof, context expiry after
byte lookup and current kind policy. The shared attachment fixture also retains
the fourteen existing acceptance tests.

This class exposes only `read`. It adds no route, MCP tool, credential, lease,
receiver journal, ACK or deletion authority. An explicit Relay host composition now
supports attachment poll/ACK and terminal cleanup, while defaults still withhold
attachments. Twenty additional in-process tests combine actual HAB leases and ACKs,
durable receiver bytes, stopped/blocked peers and the separately authorized deletion
worker. They do not expose attachment HTTP/MCP routes or prove real product binding.

## Optional HAB MCP/HTTP and client

`./mcp.ts` provides `createHabMcpServer`: exactly the four Relay tools plus
`relay_resolve`. Its strict input is `{address}` using the shared version-1 HAB
grammar, including a published JSON Schema pattern. It accepts no sender,
principal, mailbox, recipient selector or alternative URL. The result contains
only `{recipient_id,address,normalization_version:1}`. Lookup is read-only and
idempotent as a query; hints never replace current authorization. Registration,
binding, activation, maintenance, Task, arbitrary shell and subscriptions are
absent. Importing the generic Relay factory still exposes exactly four tools,
even when the supplied service also implements the HAB directory interface.

The explicit `HabHttpGateway` in `./http.ts` selects that catalog using host-code
composition hooks in the existing gateway. It inherits the same mandatory
verification-before-protocol, fixed resource/Host/Origin checks, input/response
byte limits, deadline, active/rate limits and audit. The common MCP executor
rechecks the gate after async context resolution and before the synchronous
operation. A late/stalled verifier or audit cannot dispatch lookup after timeout
or release admission early. Missing verification is all-deny; no fallback to an
anonymous or different catalog is installed. Construction starts no listener,
edits no runtime and provisions no credentials. The optional Node callback works
with this gateway; the activating host still owns its TCP/header/proxy/TLS bounds.

`HabMcpClient` in `./mcp-client.ts` adds the fixed `resolve(address)` operation to
`RelayMcpClient`. The protected host-subclass transport hook carries no HAB naming
policy into reusable Relay code. It shares that client's fixed endpoint, existing
credential port, JSON/SSE decoding, response limits, deadline and active counter
with submit/status/poll/ACK. No generic tool-call MCP API, arbitrary destination,
OAuth flow, implicit send or automatic retry is added. Input is validated before
network IO; output must match the exact requested canonical address, known
normalization version and opaque-ID syntax, with no unknown fields. Unexpected
results/errors fail with fixed codes and no raw private details.

After configuring private stores and a verified connection, host code explicitly
resolves once and persists the ID before sending:

```ts
const target = await habClient.resolve("research@grok-bot.hab");
sender.enqueue({ ...preparedSubmission, recipient_id: target.recipient_id });
await sender.sendOnce();
```

`preparedSubmission` carries the already fixed message ID and original deadline.
Further attempts call `sendOnce()` against the journal, without another lookup.
Reopening a client/outbox after a lost acceptance response preserves that same
ID/recipient and recovers the original receipt. Lookup itself creates no message,
reservation or durable send intent; if its response is lost, nothing is sent and
the caller owns any finite retry/earlier intent persistence. A cached lookup gives
no delivery guarantee: acceptance always rechecks current state. Wire address
resolution is locally tested, not enabled on an existing production endpoint.

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

The 108 HAB tests cover naming, immutable/permanent reservations, concurrent enrollment
from independent workers, idempotent restart, explicit activation, separate admin
authority, principal tuple separation, binding rotation/revocation, CAS epochs,
operation/kind/block policy, escaped grants, rollback, private/schema/key guards,
capacity and durable emergency stop. Four native loopback HTTP cases connect
registered mock Grok/dot/Hermes labels to MCP lookup and private durable journals,
send/reply/ACK, recover lost acceptance after journal/client restart without
re-resolution, check foreign receipt refusal, deny cached resolution after stop
and retry a lost lookup without creating a message. A second
registry connection is unable to revoke in the Relay authorization/commit gap.
Catalog/contract/client tests also cover separation from standalone Relay,
malformed/foreign arguments, revoked/missing context, unknown/blocked targets,
redacted failures, JSON/SSE, byte/concurrency limits and stalled audit admission.
The 33 human-management tests additionally cover separate confirmations,
bounded catalog selection, durable checkpoint/CAS/capacity, lost registry and
journal responses, store reopen, connection substitution, current authority,
stale activation, stop/revocation during resume, private/redacted storage,
terminal confirmation and the synthetic pause/reopen demonstration.

`npm run test:hab-integration` runs 17 additional native-HTTP journeys starting
at human enrollment, including all six directions between three synthetic
products and two individuals of one product. These combine offline receipt,
server/database/client reopen, lost submit/ACK responses, inbox save failure,
lease fencing, stop/block/revocation, explicit rotation, unchanged deadlines,
passive body handling and durable application handoff. Stop during uncertain
acceptance or ACK quarantines the journal without dropping the local body or
creating a replacement message. The [integration matrix](../../docs/hab-relay-integration.md)
records injection methods and limits: same-process reopen, synthetic identity
ports and accelerated retry/lease state are not production cold-start, real
identity proof, reply budgets, managed attachment or backup/restore acceptance.

This is local mock evidence, **not real product identity verification or completed
G1/full initial release**. Production management/connection wiring,
per-individual fairness/quotas, managed attachments, automatic-reply
budgets, operational activation and complete failure/restore coverage remain.
No real product is enrolled or contacted. New credential issuance, public routes,
paid contracts, background activation and real connections require their separate
approved endpoint/scope/data/stop plan; this module grants none of those actions.

## Optional attachment MCP catalog

The explicit `HabAttachmentHttpGateway` adds six owner-upload/receiver-read tools
to the HAB catalog (11 total), retaining the verified context, registry guards,
audit and HTTP byte/concurrency/rate/deadline limits. Default factories retain
five tools. Upload admission, confirmed delivery policy and acceptance coordinator
are separate host injections. See [the version-1 wire contract](../../docs/attachment-transport.md)
for canonical bounded base64, uncertainty recovery and the 18 gateway/SDK tests.
No maintenance or credential tool, runtime route or real-agent connection is added.

The optional `HabAttachmentMcpClient` extends the attachment client with directory
resolution while sharing the same admission and credential provider. Nineteen
native temporary-loopback tests cover mixed parts, two files, durable receiver
save before ACK, uncertain upload/ACK responses and restart. The sender intent
is explicitly saved by the fixture; an attachment sender journal and receiver
orchestration are still separate work. Production credentials and product
bindings remain unverified.


## Optional shared authentication groups

The default remains one verified connection per legacy individual. Explicitly setting
`RegistryOptions.authentication_groups: true` and calling `migrate()` adds the group
schema and upgrades registry version 1 to 2. Existing individual IDs, addresses and
bindings are preserved. Older runtimes reject version 2; an already-open pre-upgrade
instance also fails closed after the schema changes. Do not rewrite the version for
rollback; restore a pre-migration backup while the service is stopped.

A separately authorized administrator creates a group, binds a freshly verified
connection, attaches registered addresses, and grants group/address operations.
`selectAddress(context, address)` creates an opaque selection; `withRelay` checks
its verified group's membership under the same write guard used for Relay commit.
Group members may use one another's names. Foreign-group names, inactive members,
ambiguous omitted selection and stale/revoked credentials are denied. A single-member
group and existing one-to-one bindings can omit selection.

Group and address permissions intersect. Group stop or final binding revocation
stops every member; stopping one address leaves its siblings usable. Group identity
and selected address are recorded separately in bounded authorization records,
without raw claims or credentials. This is authorization provenance, not proof of
which Bot ran or a substitute for delivery receipts.

See [the adopted design and current limits](../../docs/relay-auth-groups.md).
The standard MCP selector, normal service configuration, OAuth refresh and live
connections are not wired by this registry extension. Tests use synthetic verified
contexts and temporary databases only:

```sh
node --test test/hab-auth-groups.test.js test/hab-registry.test.js test/hab-authorization.test.js
```
