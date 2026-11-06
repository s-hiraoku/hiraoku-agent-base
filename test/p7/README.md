# P7 source profiles

`source-pin.json` retains the original 218-input acceptance record. The historical profile reconstructs changed predecessor files from hash-checked compressed fixtures. Neither source verification nor reconstructed historical fixtures require producer Git objects.

The current profile applies the explicitly reviewed `successor-source-pin.json` delta. Its canonical digest is fixed in `scripts/lib/p7-provenance.mjs`. CI never regenerates expected source hashes.

To prepare a successor, first commit the feature source, then run:

```sh
node scripts/pin-p7-successor.mjs --source-ref <full-commit-sha> --write \
  --include test/new-feature.test.js
```

Review the manifest and predecessor archive, set the printed `successorManifestSha256` in `scripts/lib/p7-provenance.mjs`, rerun verification, and commit the pin update separately. Inputs come from the specified committed Git blobs, not uncommitted working files.

The generation command and its regression fixture need the historical baseline commit `028b3754175f47668cc3f787a0a149926351f752`. A depth-one checkout does not provide it. CI therefore uses `actions/checkout` with `fetch-depth: 0`; local shallow clones must explicitly fetch the missing history before generation. The command refuses missing history before writing either output. The runner verifies this refusal and successful generation after fetching the fixture's complete local history.

Owned process groups are closed before scratch removal. If a zero-signal group liveness probe returns `EPERM`, the runner uses read-only numeric group evidence from `/bin/ps`; it does not bypass a denied termination signal. Both unavailable liveness methods fail verification.

The mandatory `broker-startup` group uses the verifier-staged official binary to test signal termination, delayed authenticated readiness, the finite readiness deadline, spawn failure, and nonzero exit. Its fixed catalog is `packages/relay-nats/test/startup/startup-cases.js`. The existing 55-case producer catalog is unchanged. Startup failure diagnostics survive scratch cleanup in TAP and omit credentials, URLs, paths, raw errors, and broker output.
