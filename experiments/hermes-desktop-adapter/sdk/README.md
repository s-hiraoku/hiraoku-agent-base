# Generic conversation-scoped plugin SDK patch

Base: `b189f28f7462e1cbb568db6878f096277048c079` (the existing Desktop source).
Patch SHA-256: `559a9107a7b158e78628d8f08e96697fdc2f9eb51015f51323510287505862c5`.

Eight files, 240 additions / 2 deletions. No HAB business logic, icons, application
packaging, credentials, or private author metadata. This is not the discarded upstream
integration or the earlier external-message companion.

- `usePluginComposerContext()` returns the rendered saved session and its explicit
  connection/profile, or null outside a supported bound conversation.
- `ctx.rest` accepts an explicit immutable owner. Omitted owner retains legacy behavior
  for other plugins; invalid explicit owner is rejected rather than falling back.
- `PLUGIN_REST_OWNER_SUPPORTED` lets runtime plugins fail closed on older hosts.

Apply only to an independent checkout of the base, review, then use the operator's
normal app build/install process. No live application has been patched or relaunched.
Both forward application against the exact base and reverse application against the
isolated modified tree were checked.

Verification: 5 focused SDK tests (including the real main-chat ownership provider),
full Desktop typecheck, scoped lint. Canonical `scripts/check --base <base>` passes
13 of 14 checks; `footguns` reports four pre-existing encoding omissions in unchanged
`scripts/prove-external-message-reader.py` at the base. SDK health has zero findings.
This pre-existing check failure is not hidden or waived. No native UI or end-to-end
HAB exchange was exercised.
