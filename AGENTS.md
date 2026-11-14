# Agent notes for hiraoku-agent-base

## Design verification gate (read before changing documents)

The `Design verification` workflow runs `hirastack audit`, a staleness gate over
the design documents and citations tracked in
`verification/design/source-review.json`.

If your change touches any tracked document (anything under `docs/`, the root
`README.md`, `.claude/skills/**`, `.agents/skills/**`, or
`verification/design/**`), the same PR must also refresh the review record:

1. Run the audit locally (see "Run" in `verification/design/README.md`) and read
   every finding.
2. Reread each changed document in full — do not just re-hash. Where excerpts
   moved or changed, update the citations in
   `verification/design/contract.json` / `design-principles.md`.
3. Update `verification/design/source-review.json` with the new hashes and
   review entries, and append a dated entry to
   `verification/design/document-review.md` describing what you reread and what
   still holds.
4. Re-run the audit; it must report `"status": "current"` before the PR is
   ready.

Never merge a PR whose audit is `stale`. If the audit fails in CI, the findings
are printed in the workflow run summary — fix them in the same PR instead of
opening a follow-up.
