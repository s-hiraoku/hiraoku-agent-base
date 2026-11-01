# Prepare a verified NATS executable input

The delivery lab accepts an explicit local NATS Server file for a controlled input-handoff check. This preparation does not start the file, start a broker, register a backend, contact a server, or satisfy a migration requirement. Existing backend skips remain.

Run the normal baseline without a server input.

```sh
npm run test:delivery-lab
```

To verify an existing official executable, pass its absolute path.

```sh
npm run test:delivery-lab -- --nats-server /absolute/path/to/nats-server
```

The accepted file is the exact official NATS Server 2.15.2 executable for Darwin or Linux on x64 or arm64. The runner uses the checked-in [release pins](../../scripts/lib/nats-server-pins.json). Archive hashes, executable hashes, and executable sizes are distinct fields. The parent task derived the executable identities without execution after matching all four archive hashes against the [official release metadata](https://api.github.com/repos/nats-io/nats-server/releases/tags/v2.15.2). The runner performs no download or extraction. A locally rebuilt, re-signed, or modified executable fails even if it prints the same version.

The CLI accepts only `--full`, `--release`, and one `--nats-server` value. Relative paths, missing values, duplicate flags, positionals, server URLs, credentials, configuration files, caller checksums, and caller manifests are rejected with fixed refusal codes. An inherited `HAB_NATS_SERVER` does not request preparation.

The verifier opens the leaf without following a symlink and without blocking on a FIFO. It checks a regular file and the exact pinned length, reads bounded bytes from the opened descriptor, and compares SHA256. It writes those same verified bytes to a newly created private run directory. The staged file has mode `0500`; the original file and its permissions remain unchanged. The verifier never asks the candidate to report its version. Replacing the source path after preparation does not change the staged bytes.

Only the dedicated `nats-input-handoff` Node probe receives the private copy as `HAB_NATS_SERVER`. That probe reads the file and checks its identity, mode, cwd, and sanitized environment. It does not execute NATS. Ordinary Relay test groups retain their existing repository cwd and environment. The probe cwd is private because the future NATS fixture writes `.runtime` relative to cwd rather than TMPDIR. Its entry file is absolute.

Each report records `nats_input.state`, release and platform, archive and executable SHA256, copied path, private fixture cwd, `handoff`, and `backend_executed: false`. A refused file creates a FAIL report before test groups run. Argument errors exit with code 2 before creating a run. The run removes its private copy during normal teardown and retains JSON and TAP evidence.

## Verification boundary

The focused tests use fixed inert bytes only at the low-level copy/hash seam. They do not claim an inert file passed the official public verifier. The public CLI test uses an executable-shaped file of the official expected size and confirms rejection, no sentinel side effect, and no launched test group. Other cases cover malformed arguments, same-size corruption, nonregular files, source replacement, unchanged source mode, failed staging, and actual sanitized Node-child handoff. A public positive case with the official native artifact belongs to the parent integration check.

Model the Domain separates an unverified path from a verified private input record. Prove It Works requires actual file and child observations in addition to helper return values. The selected pstack design is candidate B with structured rejection and CI timeout from C. Independent design contexts used the configured native inherit-parent model; they do not add model-family diversity.

A private copy protects the handoff from source-path replacement. It is not an OS sandbox against another process running as the same user. Environment filtering is not a network sandbox. The separate NATS package launchers keep their own behavior until their owner adopts this boundary. Real broker loopback enforcement, credentials, stop/close evidence, group/epoch authorization, host selection, and final-SHA backend integration remain separate work.

## Local CI preparation

The unpublished workflow now reads the exact Node version from `.node-version` and runs `npm run test:delivery-lab -- --full`, which builds and runs the full existing JS suite plus nested lab tests. It preserves the static and Python checks and has a 15-minute job timeout. Default CI does not download or start NATS.

An `always()` artifact step retains only report JSON, source inventories, TAP, and build logs under `.lab/run-*`. Hidden-file inclusion is explicit. Private tmp directories, staged executables, broker configuration, stores, and credentials do not match the upload patterns. The added official artifact action is pinned to commit `cf430e030ddbb5b0abf93d22962f4752f3646cd9`, resolved by the parent from its official v7 tag. No hosted workflow or Linux functional run has been performed by this local preparation.
