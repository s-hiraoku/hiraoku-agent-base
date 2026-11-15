# Optional source-bound native launch claim

`SQLiteSourceLaunchJournal` in `src/owner-integrations/source-launch-journal.ts` is an
owner-local deduplication seam for an explicitly composed recipient workflow. It does not
receive, send, create a native session, invoke a model, create a Task or acquire an owner.
No normal host, agent SDK or receive-supervisor path imports it. It is not installed.

## Why a separate claim

The answer journal starts after the recipient has chosen an answer. A process can fail after
native creation or model admission but before `answer_prepare`, leaving no answer intent to
reconcile. Re-running a model just because the answer journal is empty could repeat work.
The launch claim conservatively closes this local gap: persist one source claim before any
native `create` or prompt, and never automatically launch again for an existing claim.

This is not a native admission receipt, durable model result, permission grant or Task state.
ACP has no universal read-only exact-key admission inspection. An unknown native outcome
remains unknown. A claim can exist even when no native call happened at all; safety may require
manual, independently authorized reconciliation instead of automatic retry.

## Existing authority and source contracts

The trusted composition supplies:

- The actual `SQLiteInbox` for the recipient and its existing limits.
- An existing `RecipientAuthorization` callback for `handoff` and `inspect`, deriving the
  current recipient, actor and authority epoch from a verified local context. Default is deny.
- A synchronous `checkOwner` callback that checks the already-held host's ownership and current
  lifecycle. It must not attach/acquire another owner or be replaced with a no-op in production.
- A stable approved `policy_id`, private HMAC key, recipient identity and finite record cap.

These inputs are deployment obligations, not native identities created by the journal. Agent
names, source arguments, Registry rows, session IDs and the returned launch ID are not proof of
those obligations. The native verifier and approval policy still need to authorize the actual
creation, model route, effective participants and later actions at their own boundaries.

For a new claim, `SQLiteInbox.withEntry` authenticates the actual saved message and ACK receipt.
The journal requires that exact source, receipt confirmation, intended recipient and `question`
kind, a null reply reference and text-only parts, preserving the existing initial-text admission
scope. Notices, answers, execution results, structured data and continuation questions cannot
become new launch claims. It never passes
message text to an owner prompt. The current actor, authority epoch and held-owner guard are
rechecked through the local commit. Asynchronous, changed or revoked policy fails closed.

## API and uncertain outcomes

Construction opens only the dedicated private journal. `migrate()` explicitly initializes or
verifies schema and binding while the existing host owner is held. It does not migrate any
inbox, control, budget or deployed runtime.

- `claim(context, source)` returns `{newly_claimed, record}`. Only a newly committed record can
  be considered for one native launch, subject to all current native permissions. An existing
  claim always returns `newly_claimed: false`, including after reopen, response loss or inbox
  body release. Never treat the returned ID as an approval token.
- `inspect(context, source)` reads that exact source's claim under current inspect authority.
  It neither creates a claim nor authorizes a new launch.
- `record` contains only source, a stable local `launch_id` and `claimed_at`. It reports no native
  state, answer, admission, delivery, ACK or success. The record and returned source are frozen.
- `close()` closes this journal only. It does not close/release a host or cancel native work.

The caller must commit the claim before creating a native session, not merely before prompting
an already-created session. If creation or prompt response is lost, stop and retain the original
source allocation. Do not remove the claim, reset a budget, create a new namespace or generate a
new ID to retry. There is deliberately no release, expiry, lease takeover, retry, reset, deletion
or success-marking API. A crashed process before the native call may therefore conservatively
leave the source blocked. Product-specific exact-key reconciliation is separate work.

When the original answer already exists, reuse `AnswerIntents.inspect`, `enqueueOnce` and the
original outbox ID under current authority. Delivery recovery need not run a model. This journal
does not perform that recovery or conflate `end_turn` with an answer or delivery receipt.

## Persistence and bounds

The absolute path must be a regular single-link file with mode0600 and unchanged inode; symlinks
and replacements are refused. SQLite uses synchronous FULL and secure_delete. Schema1 binds the
recipient, policy, limits and record cap to the private key. Records contain HMAC comparison
fingerprints, not the source body, authority plaintext, credentials or model output. The key is
not stored in the DB. Every MAC includes the immutable agent/policy/limits/cap context. The meta
seal authenticates ordered row membership, not just count/time; signed values from another
context or a same-count row substitution are refused. Exact schema objects/table definitions
are checked on every read and before commit. INSERT and metadata UPDATE must each affect one
row, and the sealed candidate is reread before returning a new claim. Post-migration ignored-write
triggers cannot produce an undurable permission to launch.

The cap is 1–10000 records. A full journal refuses new work instead of evicting an unknown claim.
No automatic GC is implemented. Corrupt/unknown schema or mismatched key/policy is not adopted.
Commit-response loss that leaves rollback uncertain poisons the instance; explicit reopen and
verification can observe the original committed claim but cannot authorize relaunch. An actual
precommit rollback permits a later first claim. Clock regression before a new claim is refused.

HMAC is not encryption, a sandbox or rollback protection against restoring an entire older valid
snapshot. Backup/restore must preserve a consistent owner/source/answer/outbox generation. Do
not restore or replace the journal alone. Protect the DB/key using the user's approved storage.

## Runtime ownership remains a separate handoff

Every host for a local identity must share its existing exclusive owner DB. `SQLiteHostOwner`
attaches once per object, even after release. A receiver-to-reply handoff requires stopped and
fully drained intake, old host release/close, reopening the same owner DB and reacquiring it for
one new source-bound host. There is no parallel second owner or fresh identity owner here.
Preserve the real shared reply budget and policy; do not reset per question or per day. The
running receive-only release and its immutable one-record budget need a reviewed migration or
cutover before daily reply operation. This component does not touch that runtime.

## Offline evidence and limits

`node --test test/source-launch.test.js` covers actual temporary SQLite/inbox/held-host checks,
private storage binding, exact question/ACK/context/source authorization, actor/epoch/owner loss,
capacity and tampering, duplicate/reopen, precommit failure and lost commit response. An owned
synthetic child is killed after claim and before native creation, then the same claim is observed
on reopen. Two worker threads use independent SQLite connections and synchronously ask the
parent's actual held host to check ownership before every guard; only one issues a new claim.

These are synthetic authorities and local logical durability tests, not real native admission,
power/media durability, OAuth, live store migration, all effective native tools/participants,
unattended residency or production conversations. No actual model or product session is started.
