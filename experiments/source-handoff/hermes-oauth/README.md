# Hermes OAuth source patches

For review only. Do not install or activate either patch in a real runtime.

Base Hermes revision: `6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7`.

1. `metadata-client-hook.patch`: reviewed v2 candidate adding a guarded per-operation metadata client factory; its historical artifact reports 50 passing synthetic tests. It is **not** an existing-credentials-only gate and does not itself prohibit registration or login.
2. `existing-credentials-extension.patch`: delta from the metadata-hook source to the unfinished existing-credentials candidate, covering only `tools/mcp_oauth_manager.py` and scoped tests. Apply after patch 1, never as a standalone patch. It is **untested**; a prior edit/test action was blocked and was not repeated for publication.

## Known unresolved risks in extension 2

- Public builder may have storage side effects before the strict existing-credentials gate.
- Ambiguous provider refresh failure may be retried.
- Lock cleanup errors may be suppressed, obscuring unsettled ownership.
- Saved client/token pair can be stale or inconsistent after refresh-lock waiting.

No safety or readiness claim is made for this candidate. Independent review and fixes with a deny-network synthetic harness are prerequisites even for later integration testing. Do not exercise existing credentials, discovery, refresh, registration, login or a live model to validate this archive.

## Static patch reproduction

In a disposable checkout of the exact Hermes base, with no real HOME/config/credentials, use `git apply --check /path/to/metadata-client-hook.patch`, then apply that patch to the disposable source only. Next use `git apply --check /path/to/existing-credentials-extension.patch` before applying extension 2. These source operations do not authorize executing it. Never apply to the user's installed Hermes runtime or push to Hermes upstream.

Current packaging verified sequential patch applicability using a minimal disposable copy of the baseline manager source. This is a static source check, not an OAuth test pass. Applicability and tests must still be reverified independently at the intended exact integration revision. No original private test wrappers or runtime paths are needed or published.
