# Source-only HAB handoff experiments

Status: **review archive, not integrated, not deployment-ready**. A normal PR is requested for review; it is not a readiness signal. No product entry point, CI hook, package script or deployed service activates these files. No live credentials, profile selections, deployment manifests or runtime observations are included.

## Coverage and provenance

- `single-owner-runtime/`: finite one-source runtime, production-root constructor, sequence orchestration, cutover plan, fail-closed example, private native/materializer/outbox helpers and synthetic tests.
- `hermes-owner-binding/`: journal-bound native transport factory, client, stdio and deployment verifier, Python native receive/peer/outbound-scope implementations and fixtures/tests. The alternative frozen receive-native copy is intentionally omitted; the current `hermes_bridge/receive_native.py` is preserved.
- `hermes-oauth/`: scoped metadata hook patch and separate untested existing-credentials extension. No Hermes checkout is vendored and nothing is published to Hermes upstream.
- `reply-budget/`: historical V1 and narrower V2 empty-only proposal. V2 supersedes V1. Both require a separately accepted design amendment; neither changes normative policy.

HAB baseline: `4c4663e42acc2fb27ffbe640531c0f5e5cfec1c9`. The original runtime snapshot composed owner activation/source claims, ACP fixed-wake and managed transport changes. Review alongside PRs #161, #162, #163 and the managed-transport PR; these dependencies are not merged by this archive. Native opener wiring, lifecycle/cleanup guarantees, current authorization and supported existing-credential custody remain incomplete.

Publication-only edits replace private sibling snapshot imports with repository-relative `src/` and `test/` imports, use the package `zod` import, replace synthetic fixture profile labels, remove observed deployment identity from the cutover plan and remove private absolute paths. A template-dependent helper uses `/synthetic/REQUIRES_REVIEWED_FIXTURE` deliberately: it is not a usable deployment. Old pin manifests/checksums cannot authenticate these repackaged bytes. Re-establish full independently reviewed closure pins before any later integration.

## Reproduction without live state

Use a disposable HAB checkout at the baseline and explicitly review/apply the dependent PRs above. Do not copy an installed runtime, real deployment manifest, HOME or credential files. Use the repository-pinned Node version and lockfile dependencies. The source imports now resolve from this checkout; missing dependent APIs are expected until composition is reviewed.

Static packaging checks (no source execution):

```sh
git diff --check
python3 -B - <<'PYTHON'
import ast
from pathlib import Path
for path in Path('experiments/source-handoff').rglob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
PYTHON
```

The `single-owner-runtime/test/materializer-verifier.mjs` helper and the template-dependent case in `single-owner-runtime/test/materializer.test.mjs` still requires a newly generated synthetic template and full synthetic closure pins. It must not be pointed at a live deployment. Do not run all tests indiscriminately. Before any execution, inspect every fixture and command for side effects and provide an isolated synthetic HOME, no inherited credentials, and a deny-network harness. Synthetic success cannot prove native model, OAuth or deployment readiness.

## Verification status

Current publication: scoped-file inventory, textual private-data scan, Python AST parse, Git whitespace checks, and sequential patch applicability checks in a minimal disposable source sandbox. Unified patch context intentionally contains single-space blank lines; scoped Git attributes preserve valid patch syntax. No runtime tests, aggregate HAB suite, native model, OAuth flow, network or deployment checks were run for these repackaged bytes. Historical results are not current passes. The metadata-hook source artifact reports 50 passing synthetic tests on Python 3.11.3 / MCP 2.0.0; that historical run was not repeated here. The existing-credentials extension is untested and has unresolved known risks listed beside its patch.

Review follow-up (Issue #167): the production-root test now reads the repository-root `src/` driver/owner instead of the excluded nested `hab/src` snapshot; the shipped-manifest case that read an excluded `reference-deployment.json` is removed from the deployment verifier test; the synthetic scope fixture rejects unknown modes instead of widening to the outbound scope; the receive peer cancels and observes its reader even when native close raises (one new synthetic Python test); and extension 2 normalizes the trailing `/` on both sides of the saved client issuer comparison. Hunk headers were recounted; the patch was not re-applied to a Hermes checkout. The materializer template gap and every other limit above remain. These four archive documents are registered as review context in the design contract, not as accepted policy.

Excluded: node_modules, the nested HAB snapshot, full Hermes source archives, raw logs/evidence, actual deployment/reference manifests, runtime observations/diagnostics, personal profile selections, credentials and local absolute paths. Original local artifacts remain untouched.
