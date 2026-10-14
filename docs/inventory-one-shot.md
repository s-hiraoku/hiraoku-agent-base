# Explicit inventory one-shot factory

`runInventoryOnce` in `src/inventory-factory.ts` implements trusted local
composition. It is not an MCP tool, CLI, daemon or default startup. Importing it
does not provision anything; calling it requires separate live authorization.

The caller supplies reviewed pins and a trusted `worker` callback returning an
already authenticated `HubClient` and verified principal bound to the fresh
runner scope. An authenticated SDK client can use the existing `MCPHubClient`.
Transport/authentication setup and server enrollment must already be approved.
The separate [dedicated entrypoint](inventory-end-to-end.md) composes the fixed
authenticated HTTP path; the ordinary runtime still rejects inventory grants.
The factory performs no OAuth login, issuance, credential discovery, exposure or
permissive Hub fallback. Principal arguments do not replace server authentication.

The real path:

Before the steps below, [read-only preparation](inventory-preparation.md) must pass
without issuing a key or creating runtime artifacts. The manual entry also checks
before consuming token stdin or creating its Hub database/listener. Preparation
does not replace the post-start Inspector or establish live readiness.

1. Uses `LocalHermesKey` for a single-use, at-most-120-second in-memory API bearer.
   Persists fingerprint/lifecycle metadata, never the bearer.
2. Refuses existing manifest, marker, PID, stores and SQLite sidecars. Exclusively
   creates private manifest/marker bytes and fresh SQLite stores in the prepared
   private profile, captures actual identities and rejects config drift. Partial
   preparations remain for reconciliation.
3. Spawns the reviewed interpreter with `-I -S`, fixed wrapper, private cwd and
   explicit environment. No shell, inherited environment or output logs. The
   bearer is supplied only to this child and the loopback Runs client.
4. Waits at most 15 seconds for this child's private PID marker. Binds the real
   Inspector probe to that PID; the real Runs connector checks fresh isolation,
   authentication and capabilities before claim. Missing/inconclusive evidence
   fails closed; an existing listener is never used as a substitute.
5. Checks inventory-only worker policy and scope, opens the durable worker journal
   and follows one receipt with the existing Adapter until terminal completion,
   without claiming another job. Existing Hub authentication,
   leases, fencing, receipt and replay checks remain authoritative.
6. Aborts adapter work and stops only the owned child with SIGTERM and bounded
   SIGKILL if needed. Records `revoked` only after both boundaries confirm stop;
   unsettled work/stop failure records `stop_failed`. Pending tasks retain the
   journal until settlement so late claims can be recorded for reconciliation.
   Artifacts and receipts are not automatically deleted or reused.

Test dependencies are trusted in-process seams, never request arguments. Tests
use synthetic entropy, temporary profiles, mock Runs/children and one harmless
real Node child. They cover actual writes/SQLite, Adapter/Hub completion, default
Inspector rejection, PID mismatch and deferred worker/claim cleanup. They do not
read installed OAuth or start Hermes. Mock evidence is not live evidence.

This opt-in composition is implemented. Live use still requires reviewed bridge
deployment, an actual passing Inspector under the authorized execution policy,
approved authenticated Hub enrollment/client setup, safe existing OAuth access
inside the dedicated child, and a supervised model invocation. Fixed routing does
not prove included allowance or $0 billing. A crashed/hung parent cannot guarantee
cleanup; the Python launcher has its separate lifetime guard and uncertain state
requires reconciliation. This is not an OS sandbox against hostile same-user
code changing paths between filesystem operations.
