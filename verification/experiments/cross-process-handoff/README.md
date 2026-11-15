# Cross-process handoff: shared transaction authority experiment

Status: design proposal and executable synthetic reference model only. Not a
`RecipientMessagePort` implementation, production schema, receiver, native
adapter, or deployment instruction. Import and test execution make no network
requests and read no product profile, credentials, history or running service.

## Decision and unchanged requirements

Keep the existing synchronous in-process contract unchanged. In particular,
`src/recipient-messages/contract.ts` requires the caller check at native input
commit and CURRENT native reply permission at guarded outbox commit. The
`synchronous()` checks in `messages.ts` intentionally reject asynchronous ports.
References: `docs/receiver/recipient-messages.md`, `docs/receiver/answer-intents.md`,
`docs/receiver/recipient-stdio.md`, `docs/receiver/receive-supervisor.md`, ADR-015 and the adopted
scope reconciliation in `verification/design/conflicts.md`.

Ordinary messaging remains independent of Tasks and product-specific runners.
The receive-only supervisor remains model-free. A receipt, body, bot-author
label, signature or reply-ready status cannot create authority. Existing
product approval rules apply; ordinary permitted replies do not acquire a new
mandatory human approval step. This does not reinstate closed PR #132.

One candidate serialization design for the background push path is a single
effective transaction authority for admission,
permission/owner generations, exact reply, reply budget and dispatch eligibility.
It is product-neutral; native integrations use their own supported APIs and
must enroll all effective permission writers in this serialization boundary.
An RPC return or signature is evidence, not the transaction authority.

Rejected alternatives:

- `async withReply` alone: revocation can occur between RPC response and enqueue.
- Cached or signed permission: authentic old permission is still stale.
- Irrevocable grant decided before outbox commit: changes the existing CURRENT
  permission guarantee; not adopted here.
- Independent 2PC participants: could provide equivalent serialization but
  require durable prepared records, blocked revocation and coordinator recovery.
  Timeout cannot safely release an uncertain participant. Larger than this
  reference experiment, and not implemented.

## What must be atomic, and who owns it

### Smaller path: an existing user conversation using standard MCP

This is one option for cross-process background dispatch that must retain the
strict native/outbox commit guarantees. It is NOT a prerequisite for all ordinary
conversation. In an already active authorized native conversation, the agent can
use the existing dedicated recipient stdio MCP tools to receive/read a permitted
source, decide a reply under its current native policy, prepare a durable answer
intent, enqueue it and send. The existing single-source composition binds the
source and requires paused, owned startup plus explicit owner grant/resume. It
does not itself authenticate a native session or consume native approvals.

That smaller path needs a trusted launch binding and proof that the recipient's
tool use observes current native policy; it cannot claim native approval solely
from the HAB host grant. Source changes require owner-side pause/drain and new
binding, not model-supplied allow-all. It does not wake an idle conversation or
automatically accept every future source. Neither routine inbox reading nor a
receive ACK proves background model execution. Where an active conversation and
an exact source suffice, evaluate this supported smaller path before building
the distributed extension below. No background model startup is implied by a
request for practical daily messaging.

### Proposed background dispatch boundary

The receiving product's trusted integration is the policy decision maker. The
shared authority is the sole *effective* permission/owner writer and transaction
executor. An outside policy change is not synchronized by merely sending an
event later. A product unable to route every relevant policy change, stop and
owner transfer through this authority is unsupported. The model provides no
integration that establishes this premise in Hermes or any other product.

1. Source binding is obtained from authenticated local composition and verified
   saved/ACK-confirmed input, never external text. Only an explicitly allowed
   new text question is in the proposed first production scope. Notice, answer,
   execution requests and continued conversation are not model dispatch inputs.
2. Authority-queue acceptance atomically checks source permission and epoch,
   binds source to exact input fingerprint, and reserves the bounded processing
   budget. Unique source identity prevents repeat reservation. This is NOT native
   product acceptance or a model call.
3. A worker records a fixed execution-attempt identity before calling the native
   API. Actual native acceptance requires a durable unique-key native inbox and
   exact-key query. Until independently observed, it remains dispatch intent or
   outcome-unknown, not native accepted. A queue lease expiring is not permission
   to call again. No new attempt, ID or refund after an uncertain call.
4. Native processing uses existing native policy, tools and approval machinery,
   with explicit external origin and the approved context/budget limits. The
   finalizer must check the current source permission and owner epoch at its
   commit, not just at worker claim. Native uncertainty must remain uncertainty.
5. The exact reply is fixed durably before handoff. Its destination, source,
   thread, ID, initial timestamp and expiry cannot be replaced. For a reply the
   verified original sender determines destination; any address-resolution
   result for a separate new send must be durably bound BEFORE send. Unknown
   never permits re-resolution or a new destination/envelope.
6. In one authority transaction, recheck current permission/epoch, validate
   exact reply and current native approval, reserve existing reply budget once,
   and commit handoff/outbox state. Revocation and enqueue have one serial order:
   revocation first prevents enqueue; enqueue first records an authorized
   handoff but does not imply permission to send after subsequent revocation.
7. Sending remains a distinct authorized operation. A network request already
   emitted before revocation may have committed remotely and cannot be undone by
   a local fence. Reconcile its original ID rather than claiming cancellation.

Owner turnover increments the authority generation, denies future work, and
retains nonterminal/unknown records. Resume cannot erase the source identity,
restore grants, or start an old attempt. Input acceptance, reply finalization,
outbox commit and send admission each need their own sink-side fence checks.
Backup rollback of the authority requires an independently anchored generation
and explicit reconciliation; this experiment does not solve rollback detection.

## Failure matrix

| Boundary | Retained state and permitted recovery |
| --- | --- |
| Permission denied / unconfigured | No admission, budget reservation or model call. |
| Crash before admission commit | Transaction rolls back; exact source may be admitted after current revalidation. |
| Admission committed, response lost | Query original source/hash; one reservation, no fresh identity. |
| Dispatch intent committed, native outcome unknown | Hold attempt; exact native receipt query only. No retry from missing local response. |
| Native accepted, result response lost | Query native durable attempt; do not infer a failed or absent model run. |
| Revocation before finalization/enqueue | Current authority check refuses; retained draft/intent is not sent. |
| Enqueue before revocation | Retain exact handoff; later send admission must reject. Already emitted remote work stays uncertain until reconciled. |
| Crash before outbox transaction commit | Reply-ready remains; neither handoff receipt nor model outbox row commits. |
| Outbox commit, response lost | Both records persist; same exact envelope lookup/replay, not new model work. |
| Stop/owner change with in-flight work | New epoch; hold outcome unknown; old worker writes rejected at each sink. |
| Two producers with same identity | Unique source and serialized transaction; changed fingerprint/reply conflicts. |
| Backup restores old permission/records | Unsupported without independent fencing and external-outcome reconciliation. |

## Reference model and its limits

Run from the repository root:

    python3 -B -m unittest discover -s verification/experiments/cross-process-handoff -p 'test_*.py' -v

`model.py` uses temporary real SQLite transactions and two connections. Its
`admitted` means authority-queued; `running` means an execution-attempt intent,
NOT evidence of native admission/model start. `stop()` parks that attempt as
unknown. `inspect()` is an internal test observer, not an unauthenticated API.
The synthetic owner methods are trusted test fixtures, not exposed RPC methods.

The model's `outbox` is NOT the existing `SQLiteOutbox`. Its atomic state changes
are a demonstration of a co-located design, not proof that today's separate
HAB stores are already atomic. A future export into the existing SQLiteOutbox
would be an exact-envelope idempotent projection with reconciliation, not this
atomic commit. It must preserve current source authority at actual commit and
send boundaries; the existing shared-outbox `send` permission cannot silently
be treated as source-scoped. No such export is implemented here.

This model deliberately does not validate the HAB wire envelope, receipt ACK,
native approvals, address resolution, TTL, transport, owner leases, identity,
tools, context isolation, hard model cost limits, provider idempotency, backup,
native durable inbox, or full threat model. The production contract must reuse
existing validators/budget/owner components and prove those boundaries rather
than promoting these simplified tables into runtime code. Its scalar budget is
only the pre-dispatch processing reservation, not the existing reply budget.

No product code, dependency, schema or service configuration is changed. The
experiment does not establish native interoperability or automatic conversation.
Before implementing a public adapter: review this authority placement, identify
a real native API that can enroll its permission writers, specify the transport
and identity binding, then test the actual commit and failure boundaries. This
proposal requires a separate design review; no deployment is authorized by it.
