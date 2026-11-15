# Hermes one-shot Python import boundary

This is an offline launch contract, not evidence of a live API or model run.
Existing Hermes profiles, packages and authentication remain unchanged. No package
installer, network fetch, API call or daemon is added by this change.

The inspected command is exactly the pinned interpreter followed by `-I -S` and
the pinned wrapper. The Python guard also requires isolated mode, no automatic
`site` initialization, no loaded `site` module and the standard built-in, frozen
and path finders. `-I` alone is rejected: Python can execute site `.pth` files
before wrapper code gets an opportunity to validate them. An editable finder
sentinel is therefore not an exception to approve.

## Fixed dependencies and import roots

The approved policy and manifest require `pythonIsolation: "isolated-no-site-v1"`
and an absolute `dependencyRoot`. Its exact code tree must declare
`fixedDependencies: true`, be separately reviewed, hashed and immutable, and have
no overlap with the source, wrapper or system runtime trees. Use a dedicated
`dependencies` directory, not an existing venv or shared `site-packages`.

Populate that directory only in a separately authorized preparation step from
reviewed noneditable wheels with pinned versions and verified artifact hashes.
Preserve the lock/artifact provenance for review. This patch does not install or
resolve real dependencies. The approved tree digest pins all files in the prepared
bundle; changing a version or file requires a new approved digest. Executable
`.pth`, `.egg-link`, `__editable__*` files and `direct_url.json` are rejected at any
depth. The latter is conservatively refused rather than trusting editable/local
source installation metadata.

The guard measures code before adding the exact dependency, wrapper and source
roots to `sys.path`. It never calls `site.addsitedir`. Implicit/relative paths,
unmeasured roots, shared/user `site-packages` and the editable sentinel are refused.
`-I` suppresses the current working directory, `PYTHONPATH` and user site inputs;
`-S` prevents system/venv site initialization. The standard import finder list and
paths are checked again before the official adapter is instantiated.

A root-owned measured system `lib` tree may declare exactly
`excludedSystemSitePackages: "python3.<minor>/site-packages"`. Both TypeScript and
Python hash the same exclusion marker. No declared tree, alias target or allowed
import path can reintroduce that subtree. This exclusion is valid only with the
no-site launch contract and separately measured fixed dependencies. It is not a
blanket exception for arbitrary directories.

Per-root 1 GiB, total declared 2 GiB, per-file 64 MiB and entry-count limits remain.
Do not increase them merely to admit a shared package installation. The large
shared package tree is unnecessary for this one-task executor. Whole official
source verification proves snapshot provenance; minimizing that source package
can be a later reviewed change and is not needed to enable this import boundary.

## Failures and remaining live gates

A write probe succeeds only as evidence of writable code (rejected). Only EACCES
establishes denied write access. EPERM and other inconclusive errors remain blocked
in both implementations. This does not change or bypass the execution environment.

Old/pending manifests without the new fields fail closed. A prepared fixed bundle,
complete interpreter/stdlib/native-runtime closure, approved manifest, runtime
key binding, ordinary execution policy and confirmed included model allowance are
still required for a supervised run. No live dependencies, key or API/model have
been provisioned by these tests. These checks pin reviewed code and import inputs;
they do not constitute an OS sandbox against arbitrary trusted-code behavior.

Tests use temporary public fixtures only. They verify TS/Python contract agreement,
unchanged limits, exclusion/alias reintroduction refusal, loader rejection and EPERM
handling. A synthetic venv proves its harmless `.pth`/editable hook executes under
`-I`, while `-I -S` prevents it; no real package is installed or external call made.
