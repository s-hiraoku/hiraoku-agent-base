# Inventory preparation before provisioning

The manual CLI now runs read-only preparation before reading worker-token stdin.
The dedicated entry repeats it before creating its Hub database or listener. The
factory repeats it before local-key entropy, artifact preparation, child launch
or worker connection. The checks use the real Inspector's existing ownership,
private-profile/config, immutable tree/import-closure and pinned-file primitives.
They reject nonempty working directories, config/hash drift, writable code,
inconclusive EPERM and existing runtime artifacts. No auth store is opened.

Two input snapshots must agree. Preparation has no PID or runtime key and returns
no isolation attestation or worker grant. The structural placeholder metadata used
to construct the existing policy schema is neither persisted nor presented as live
evidence. A successful preparation is only permission to proceed to provisioning;
it is not proof that a child, model or authenticated Hub round trip works.

The original post-start Inspector remains mandatory: it checks the owned child,
exact command/listener/commit, actual marker and DB identities, measured inputs
predating process startup, and repeated fresh observations. Python's independent
bootstrap/import guard also remains unchanged. Later drift can still reject a
launch and leave artifacts for reconciliation. Nothing rolls back audit records
or automatically retries a task. A factory rejection after an already admitted
Hub request can still leave its task/audit state; "zero effects" means no key,
runtime artifact, child or worker/model activation from the rejected preparation.
An initial entry rejection additionally precedes its Hub DB/listener creation.

The trusted `checkPreparation` dependency exists only for in-process synthetic
fixtures, like the existing child/entropy/probe seams. It is not a JSON setting,
MCP argument, JWT claim or production switch. The ordinary entry always uses the
real checks. Tests prove preparation refusal precedes side effects, including the
default real checker, and that EPERM is still rejected.

## Why the isolation requirements exist

| MVP guarantee                                 | Required evidence                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| No arbitrary task, shell, path or destination | Strict fixed request/result, exactly one metadata tool, runtime tool/transport guards                                               |
| No personal context or Desktop fallback       | Dedicated profile, isolated history, disabled memory/context/extensions and locked provider                                         |
| No unchecked executable imports               | Full reviewed source/dependency/native closure, hashes, no-site bootstrap and actual nonwritability                                 |
| One owned bounded execution                   | Authenticated subject/client/scope, fresh runner binding, lease/fencing, idempotent receipts, deadline and confirmed/uncertain stop |
| No unverified paid route                      | Read-only existing Codex route plus separately confirmed entitlement/remaining included allowance; stop if $0 is not established    |

The immutable input boundary prevents changed code, import hooks or dependencies
from running before the tool restrictions can protect the task. A "read-only"
prompt or mode bits alone are not this evidence. Current access(W_OK) accepts only
EACCES; EPERM cannot establish whether the runtime is unable to write or the probe
itself is forbidden. Preparation does not resolve the current real EPERM.

## Separately reviewed OS-isolation option

A stronger future design could use an operator-owned, OS-enforced read-only
runtime image and a dedicated execution identity unable to modify or replace the
image or its parent paths. It would need an explicit attestation of mount/device,
ownership/ACLs, import/native closure, hashes and child identity. Merely running
the denied probe as another user or on another path is not such a design.

This is not plug-compatible with the current contract: profile/code ownership and
the observed child UID are tied to the executing Hub UID. A different runtime UID
and operator-owned image need a separately reviewed identity/ownership contract
and TS/Python agreement, not an EPERM exception. The new identity also cannot read
the existing user's private OAuth store. Any scoped credential broker/handoff
would need explicit review and approval; do not copy an auth store or loosen its
permissions to make it work.

Necessary changes: provision the execution identity and private work/profile paths;
build/sign and read-only mount the reviewed closure; approve the limited existing
OAuth handoff; bind expected ownership/process identities; and test denial,
credential handling, teardown and reconciliation. Updates require rebuilding and
reviewing new image hashes and namespaces. Operational burden includes image/disk
management, identity lifecycle and broker maintenance. No new public endpoint or
automatic service is required by the concept.

Existing local-lab/Desktop/Dashboard/Serve/Funnel can remain in the user's current
identity and are not changed by this option. Existing Hub artifacts must be
preserved/reconciled when moving to a new namespace. None of these OS changes is
implemented or authorized by this preparation patch. If the current contract
cannot produce valid evidence in the permitted environment, live MVP admission
remains blocked rather than silently lowering the guarantee.
